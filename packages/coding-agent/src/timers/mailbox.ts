/**
 * Per-session mailbox with maildir semantics: `tmp/` → `new/` (published) →
 * `cur/` (claimed by exactly one consumer via rename) → `done/` (the message
 * reached the session transcript).
 *
 * A claim is not delivery: a consumer that dies between claim and transcript
 * append leaves the file in `cur/`, and the next consumer of that session
 * re-delivers it unless the transcript already carries its stable mail id.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type FileLockHandle, isEnoent, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { tryAcquireSessionLease } from "../session/session-storage";
import { mailDir, mailLivePath } from "./paths";
import type { TimerMail } from "./types";

export function newMailId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Publish a message atomically: readers only ever see complete files in `new/`. */
export async function postMail(mail: TimerMail): Promise<string> {
	const dir = mailDir(mail.sessionId);
	const name = `${mail.id}.json`;
	const tmp = path.join(dir, "tmp", name);
	await Bun.write(tmp, JSON.stringify(mail));
	await fs.promises.mkdir(path.join(dir, "new"), { recursive: true });
	const target = path.join(dir, "new", name);
	await fs.promises.rename(tmp, target);
	return target;
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return (await fs.promises.readdir(dir)).filter(name => name.endsWith(".json")).sort();
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

export function listNewMail(sessionId: string): Promise<string[]> {
	return listDir(path.join(mailDir(sessionId), "new"));
}

/** Claimed but not yet confirmed in the transcript (a consumer may have died). */
export function listClaimedMail(sessionId: string): Promise<string[]> {
	return listDir(path.join(mailDir(sessionId), "cur"));
}

/**
 * Claim one message: rename `new/<name>` → `cur/<name>`. Exactly one caller
 * wins; the rest get `undefined`.
 */
export async function claimMail(sessionId: string, name: string): Promise<TimerMail | undefined> {
	const dir = mailDir(sessionId);
	const cur = path.join(dir, "cur", name);
	await fs.promises.mkdir(path.dirname(cur), { recursive: true });
	try {
		await fs.promises.rename(path.join(dir, "new", name), cur);
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
	return (await Bun.file(cur).json()) as TimerMail;
}

export async function readClaimedMail(sessionId: string, name: string): Promise<TimerMail | undefined> {
	try {
		return (await Bun.file(path.join(mailDir(sessionId), "cur", name)).json()) as TimerMail;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

/** The message is in the transcript: move `cur/` → `done/`. */
export async function completeMail(sessionId: string, name: string): Promise<void> {
	const dir = mailDir(sessionId);
	await fs.promises.mkdir(path.join(dir, "done"), { recursive: true });
	try {
		await fs.promises.rename(path.join(dir, "cur", name), path.join(dir, "done", name));
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/** Whether a message for `timerId` is still unclaimed (overlap: the session hasn't taken the last one). */
export function hasPendingMailForTimer(sessionId: string, timerId: string): boolean {
	let names: string[];
	try {
		names = fs.readdirSync(path.join(mailDir(sessionId), "new"));
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
	return names.some(name => name.startsWith(`${timerId}#`));
}

/** Take the live-consumer lease for a session's mailbox; `null` while another process holds it. */
export function tryAcquireMailboxLease(sessionId: string): FileLockHandle | null {
	const file = mailLivePath(sessionId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	return tryAcquireFileLock(file);
}

/** Whether some live process consumes this session's mailbox (probe: take and release the lease). */
export function hasLiveMailboxConsumer(sessionId: string): boolean {
	const lease = tryAcquireMailboxLease(sessionId);
	if (!lease) return true;
	lease.release();
	return false;
}

/**
 * Who can take a fire for this session right now. Engine-branch stub of the
 * Delivery worker's presence-based `deliveryTarget` (same shape); the merge
 * takes the Delivery implementation.
 */
export type DeliveryTarget =
	| { kind: "live"; pid?: number }
	| { kind: "held"; reason: "no-watcher" | "foreign-owner"; pid?: number }
	| { kind: "free" };

export function deliveryTarget(sessionId: string): DeliveryTarget {
	if (hasLiveMailboxConsumer(sessionId)) return { kind: "live" };
	const lease = tryAcquireSessionLease(sessionId);
	if (!lease) return { kind: "held", reason: "no-watcher" };
	lease.release();
	return { kind: "free" };
}
