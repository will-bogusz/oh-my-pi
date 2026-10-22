/**
 * Per-session mailbox with maildir semantics: `tmp/` → `new/` (published) →
 * `cur/` (claimed by exactly one consumer via rename) → `done/` (the message
 * reached the session transcript).
 *
 * A claim is not delivery: a consumer that dies between claim and transcript
 * append leaves the file in `cur/`, and the next consumer of that session
 * re-delivers it unless the transcript already carries its stable mail id.
 * Each re-delivery is counted in the file itself, so a message that keeps
 * failing stops after {@link MAX_MAIL_ATTEMPTS} across every process.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { tryAcquireSessionLease } from "../session/session-storage";
import { listSessionPresence } from "./mailbox-presence";
import { mailDir } from "./paths";
import type { TimerMail } from "./types";

/** Injection attempts per message, summed over every consumer that claimed it. */
export const MAX_MAIL_ATTEMPTS = 3;

export function newMailId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

function mailFileName(id: string): string {
	return `${id}.json`;
}

/** Publish a message atomically: readers only ever see complete files in `new/`. */
export async function postMail(mail: TimerMail): Promise<string> {
	const dir = mailDir(mail.sessionId);
	const name = mailFileName(mail.id);
	const tmp = path.join(dir, "tmp", name);
	await Bun.write(tmp, JSON.stringify(mail));
	await fs.promises.mkdir(path.join(dir, "new"), { recursive: true });
	const target = path.join(dir, "new", name);
	await fs.promises.rename(tmp, target);
	return target;
}

function listDirSync(dir: string): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter(name => name.endsWith(".json"))
			.sort();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

export function listNewMail(sessionId: string): string[] {
	return listDirSync(path.join(mailDir(sessionId), "new"));
}

/** Claimed but not yet confirmed in the transcript (a consumer may have died). */
export function listClaimedMail(sessionId: string): string[] {
	return listDirSync(path.join(mailDir(sessionId), "cur"));
}

function readMailSync(file: string): TimerMail | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as TimerMail;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** Read an unclaimed message without claiming it (to decide whether to claim). */
export function peekNewMail(sessionId: string, name: string): TimerMail | undefined {
	return readMailSync(path.join(mailDir(sessionId), "new", name));
}

export function readClaimedMail(sessionId: string, name: string): TimerMail | undefined {
	return readMailSync(path.join(mailDir(sessionId), "cur", name));
}

/**
 * Claim one message: rename `new/<name>` → `cur/<name>`. Exactly one caller
 * wins, across threads and processes; the rest get `undefined`. Synchronous so
 * a claim can happen inside a prompt's synchronous setup.
 */
export function claimMail(sessionId: string, name: string): TimerMail | undefined {
	const dir = mailDir(sessionId);
	const cur = path.join(dir, "cur", name);
	fs.mkdirSync(path.dirname(cur), { recursive: true });
	try {
		fs.renameSync(path.join(dir, "new", name), cur);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	return readMailSync(cur);
}

/**
 * Count one injection attempt on a claimed message (atomic rewrite in `cur/`).
 * Returns the new count, or `undefined` when the message is no longer claimed.
 */
export function recordMailAttempt(sessionId: string, name: string): number | undefined {
	const cur = path.join(mailDir(sessionId), "cur", name);
	const mail = readMailSync(cur);
	if (!mail) return undefined;
	const attempts = (mail.attempts ?? 0) + 1;
	const tmp = `${cur}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ ...mail, attempts }));
	fs.renameSync(tmp, cur);
	return attempts;
}

/** The message is in the transcript: move `cur/` → `done/`. */
export function completeMail(sessionId: string, name: string): void {
	const dir = mailDir(sessionId);
	fs.mkdirSync(path.join(dir, "done"), { recursive: true });
	try {
		fs.renameSync(path.join(dir, "cur", name), path.join(dir, "done", name));
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/** Whether a message for `timerId` is still unclaimed (overlap: the session hasn't taken the last one). */
export function hasPendingMailForTimer(sessionId: string, timerId: string): boolean {
	return listNewMail(sessionId).some(name => name.startsWith(`${timerId}#`));
}

/** Whether `mailId` is still waiting in `new/` or claimed and unconfirmed in `cur/`. */
export function isMailOutstanding(sessionId: string, mailId: string): boolean {
	const name = mailFileName(mailId);
	return listNewMail(sessionId).includes(name) || listClaimedMail(sessionId).includes(name);
}

/** Whether `mailId` reached the session's transcript (its file sits in `done/`). */
export function isMailDone(sessionId: string, mailId: string): boolean {
	return fs.existsSync(path.join(mailDir(sessionId), "done", mailFileName(mailId)));
}

/**
 * Where mail for a session goes now:
 * - `live`: a process with the session open delivers it (mail only);
 * - `held`: the session is open in a process that does not deliver mail (an
 *   SDK host, `OMP_TIMER_MAILBOX=0`, a watcher that does not own the session),
 *   or an older omp without presence holds its write lease. Mail waits for the
 *   next process that opens the session; never resume it headless, which would
 *   leave the turn on a branch that process does not see;
 * - `free`: nobody has it open; resume it headless or hold, per the timer.
 */
export type DeliveryTarget =
	| { kind: "live"; pid: number; host: string }
	| { kind: "held"; reason: "no-watcher"; pid: number; host: string }
	| { kind: "held"; reason: "foreign-owner" }
	| { kind: "free" };

export function deliveryTarget(sessionId: string): DeliveryTarget {
	const present = listSessionPresence(sessionId);
	const deliverer = present.find(record => record.delivers);
	if (deliverer) return { kind: "live", pid: deliverer.pid, host: deliverer.host };
	const holder = present[0];
	if (holder) return { kind: "held", reason: "no-watcher", pid: holder.pid, host: holder.host };
	// Probed only when no process announced itself: an older omp that wrote the
	// session holds the write lease without presence.
	const lease = tryAcquireSessionLease(sessionId);
	if (!lease) return { kind: "held", reason: "foreign-owner" };
	lease.release();
	return { kind: "free" };
}

/** One line for CLI output and ledger details. */
export function describeDeliveryTarget(target: DeliveryTarget): string {
	switch (target.kind) {
		case "live":
			return `open in a live omp (${target.host}, pid ${target.pid}) that delivers it now`;
		case "held":
			return target.reason === "no-watcher"
				? `open in an omp process that does not deliver timer mail (${target.host}, pid ${target.pid})`
				: "open in an omp process without timer support";
		case "free":
			return "not open in any omp process";
	}
}
