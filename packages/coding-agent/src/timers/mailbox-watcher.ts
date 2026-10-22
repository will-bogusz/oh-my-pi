/**
 * Live delivery: a top-level session (interactive, RPC, print) polls its own
 * mailbox and injects each message as a custom message that starts a turn when
 * the session is idle and queues as a follow-up while it streams.
 *
 * Holding the mailbox lease is how this process tells the ticker "I deliver
 * for this session id": the tick then mails instead of resuming headless.
 * Before claiming, the watcher takes the session's ownership lease eagerly,
 * because a write from a non-owner silently forks the session to a sibling.
 */
import { $env, type FileLockHandle, logger } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "../session/session-entries";
import type { AgentSession } from "../session/agent-session";
import {
	renderTimerMail,
	SESSION_POKE_MESSAGE_TYPE,
	TIMER_FIRE_MESSAGE_TYPE,
	type TimerDeliveryVia,
	type TimerMessageDetails,
} from "./fire-message";
import {
	claimMail,
	completeMail,
	listClaimedMail,
	listNewMail,
	readClaimedMail,
	tryAcquireMailboxLease,
} from "./mailbox";
import { TIMER_HEADLESS_RUN_ENV, TIMER_MAILBOX_ENV } from "./paths";
import { readTimerSpec, recordDelivery } from "./store";
import type { TimerMail } from "./types";

const POLL_MS = 1000;
const MAX_ATTEMPTS = 3;

function mailIdOf(entry: SessionEntry): string | undefined {
	const details =
		entry.type === "custom_message"
			? entry.details
			: entry.type === "message" && entry.message.role === "custom"
				? entry.message.details
				: undefined;
	if (!details || typeof details !== "object" || !("mailId" in details)) return undefined;
	return typeof details.mailId === "string" ? details.mailId : undefined;
}

export interface TimerMailboxWatcher {
	stop(): void;
}

/** Start the watcher for `session`. No-op handle when disabled (`OMP_TIMER_MAILBOX=0`). */
export function watchTimerMailbox(session: AgentSession): TimerMailboxWatcher {
	if ($env[TIMER_MAILBOX_ENV] === "0") return { stop: () => {} };
	const headlessRun = $env[TIMER_HEADLESS_RUN_ENV];
	const via: TimerDeliveryVia = headlessRun ? "headless" : "live";
	let lease: FileLockHandle | null = null;
	let leaseSessionId: string | undefined;
	let busy = false;
	let stopped = false;
	/** Mail handed to the session in this process and not yet seen in the transcript. */
	const inFlight = new Set<string>();
	/** Injection attempts per mail id; a mail that keeps failing is left in `cur/` for a later process. */
	const attempts = new Map<string, number>();
	const refused = new Set<string>();

	const release = (): void => {
		lease?.release();
		lease = null;
		leaseSessionId = undefined;
	};

	const deliver = async (sessionId: string, mail: TimerMail): Promise<void> => {
		const tries = (attempts.get(mail.id) ?? 0) + 1;
		if (tries > MAX_ATTEMPTS) return;
		attempts.set(mail.id, tries);
		inFlight.add(mail.id);
		const tz = mail.fire ? (await readTimerSpec(mail.fire.timerId))?.tz : undefined;
		const details: TimerMessageDetails = {
			mailId: mail.id,
			kind: mail.kind,
			timerId: mail.fire?.timerId,
			runId: mail.fire?.runId,
			via,
		};
		if (mail.fire) {
			recordDelivery(mail.fire.timerId, {
				runId: mail.fire.runId,
				at: new Date().toISOString(),
				state: headlessRun ? "resumed-headless" : "delivered-live",
				session: sessionId,
				detail: tries > 1 ? `re-delivery attempt ${tries}` : undefined,
			});
		}
		logger.debug("timer mail delivered", { sessionId, mailId: mail.id, via });
		// Not awaited: an idle session's prompt resolves only when the whole turn ends.
		void session
			.sendCustomMessage<TimerMessageDetails>(
				{
					customType: mail.kind === "poke" ? SESSION_POKE_MESSAGE_TYPE : TIMER_FIRE_MESSAGE_TYPE,
					content: renderTimerMail(mail, via, Date.now(), tz),
					display: true,
					details,
					attribution: "agent",
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			)
			.catch(error => {
				// Retried from `cur/` on the next poll, bounded by MAX_ATTEMPTS.
				inFlight.delete(mail.id);
				logger.warn("timer mail injection failed", { mailId: mail.id, error: String(error) });
			});
	};

	/**
	 * Claimed mail leaves `cur/` only once the transcript carries its id. Mail
	 * in `cur/` that is neither in the transcript nor in flight here was claimed
	 * by a consumer that died (or failed to inject): deliver it again.
	 */
	const reconcileClaimed = async (sessionId: string): Promise<void> => {
		const claimed = await listClaimedMail(sessionId);
		if (claimed.length === 0) return;
		const seen = new Set<string>();
		for (const entry of session.sessionManager.getEntries()) {
			const id = mailIdOf(entry);
			if (id) seen.add(id);
		}
		for (const name of claimed) {
			const mail = await readClaimedMail(sessionId, name);
			if (!mail) continue;
			if (seen.has(mail.id)) {
				await completeMail(sessionId, name);
				inFlight.delete(mail.id);
				attempts.delete(mail.id);
				continue;
			}
			if (inFlight.has(mail.id)) continue;
			logger.warn("re-delivering claimed timer mail missing from the transcript", { sessionId, mailId: mail.id });
			await deliver(sessionId, mail);
		}
	};

	const poll = async (): Promise<void> => {
		if (stopped || session.isDisposed) {
			stop();
			return;
		}
		const sessionId = session.sessionManager.getSessionId();
		if (!session.sessionManager.getSessionFile()) return;
		if (leaseSessionId !== sessionId) {
			release();
			lease = tryAcquireMailboxLease(sessionId);
			if (!lease) return; // another live process consumes this session's mail
			leaseSessionId = sessionId;
		}
		const names = await listNewMail(sessionId);
		const claimed = await listClaimedMail(sessionId);
		if (names.length === 0 && claimed.length === 0) return;
		if (!session.sessionManager.claimOwnership()) {
			if (!refused.has(sessionId)) {
				refused.add(sessionId);
				logger.warn("timer mail waiting: session is owned by another omp process", { sessionId });
			}
			return;
		}
		await reconcileClaimed(sessionId);
		for (const name of names) {
			const mail = await claimMail(sessionId, name);
			if (mail) await deliver(sessionId, mail);
		}
	};

	const timer = setInterval(() => {
		if (busy) return;
		busy = true;
		poll()
			.catch(error => logger.warn("timer mailbox poll failed", { error: String(error) }))
			.finally(() => {
				busy = false;
			});
	}, POLL_MS);
	timer.unref();

	function stop(): void {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		release();
	}
	return { stop };
}
