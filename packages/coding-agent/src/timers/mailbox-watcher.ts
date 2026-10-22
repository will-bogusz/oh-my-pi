/**
 * A session's mailbox in the process that has the session open.
 *
 * Every persisted session announces presence from the moment it opens (see
 * `mailbox-presence.ts`), so the timer engine never resumes it headless while
 * it is open here. A process opened with `deliver` also injects the mail:
 *
 * - idle: the message starts a turn, also after Esc (timer fires are standing
 *   user intent);
 * - streaming: it joins the running turn at its next step boundary, without
 *   interrupting the tool batch in flight;
 * - `omp poke` mail that arrives while an Esc still holds the session stays
 *   unclaimed until the user's next prompt, which carries it in ahead of the
 *   user's message (`omp poke --force` delivers at once).
 *
 * The process delivers only while it owns the session (the write lease), so
 * two processes on one session id never both inject, and a delivery never
 * forks the session into a sibling file. Claimed mail leaves `cur/` only once
 * the transcript shows its id; mail claimed by a process that died, or dropped
 * by an interrupt before it reached the transcript, is delivered again.
 */
import * as fs from "node:fs";
import { $env, logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { CustomMessage } from "../session/messages";
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";
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
	MAX_MAIL_ATTEMPTS,
	peekNewMail,
	readClaimedMail,
	recordMailAttempt,
} from "./mailbox";
import { claimSessionPresence, type SessionPresence } from "./mailbox-presence";
import { TIMER_HEADLESS_RUN_ENV, TIMER_MAILBOX_ENV } from "./paths";
import { appendLedger, readTimerSpec } from "./store";
import type { TimerMail } from "./types";

const POLL_MS = 1000;
/** An injected message that is neither running, queued, nor in the transcript this long after its send settled was dropped. */
const STALL_MS = 15_000;

export interface SessionMailboxOptions {
	/** Inject mail as turns. Without it the process only announces presence, so mail is held for it. */
	deliver: boolean;
	/** Process kind recorded with the presence entry (`interactive`, `rpc`, `print`, `acp`, `sdk`, …). */
	host: string;
}

interface InFlight {
	sessionId: string;
	/** `sendCustomMessage` has not settled yet: the message is still being admitted or its turn runs. */
	pending: boolean;
	/** When the send settled (or the message was handed to a prompt). */
	since: number;
}

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

function messageFor(
	mail: TimerMail,
	via: TimerDeliveryVia,
	tz: string | undefined,
): CustomMessage<TimerMessageDetails> {
	return {
		role: "custom",
		customType: mail.kind === "poke" ? SESSION_POKE_MESSAGE_TYPE : TIMER_FIRE_MESSAGE_TYPE,
		content: renderTimerMail(mail, via, Date.now(), tz),
		display: true,
		details: {
			mailId: mail.id,
			kind: mail.kind,
			timerId: mail.fire?.timerId,
			runId: mail.fire?.runId,
			via,
		},
		attribution: "agent",
		timestamp: Date.now(),
	};
}

export class SessionMailbox {
	readonly #sessionManager: SessionManager;
	readonly #host: string;
	readonly #deliver: boolean;
	readonly #via: TimerDeliveryVia;
	#presence: SessionPresence | undefined;
	#session: AgentSession | undefined;
	#interval: NodeJS.Timeout | undefined;
	#polling = false;
	#stopped = false;
	readonly #inFlight = new Map<string, InFlight>();
	/** Mail ids already logged as waiting (held by Esc, out of attempts), to log each once. */
	readonly #noted = new Set<string>();
	#refusalLogged: string | undefined;

	/** Claims presence for the manager's current session immediately. */
	constructor(sessionManager: SessionManager, options: SessionMailboxOptions) {
		this.#sessionManager = sessionManager;
		this.#host = options.host;
		this.#deliver = options.deliver && $env[TIMER_MAILBOX_ENV] !== "0";
		this.#via = $env[TIMER_HEADLESS_RUN_ENV] ? "headless" : "live";
		this.#syncPresence();
	}

	/** Session id this process currently announces, if any. */
	get sessionId(): string | undefined {
		return this.#presence?.sessionId;
	}

	/** Follow the session through `/new`, `/resume`, forks and sibling moves, and start delivering when enabled. */
	bind(session: AgentSession): void {
		this.#session = session;
		session.registerSessionChangeCallback(() => this.#syncPresence());
		const unsubscribeNotices = this.#sessionManager.onPersistenceNotice(() => this.#syncPresence());
		session.addDisposer(unsubscribeNotices);
		session.onClosed(() => this.stop());
		if (!this.#deliver) return;
		session.setHeldMailProvider(() => this.#takeHeldMail());
		this.#interval = setInterval(() => {
			if (this.#polling) return;
			this.#polling = true;
			this.#poll()
				.catch(error => logger.warn("timer mailbox poll failed", { error: String(error) }))
				.finally(() => {
					this.#polling = false;
				});
		}, POLL_MS);
		this.#interval.unref();
	}

	/** Withdraw presence and stop delivering. Idempotent. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		clearInterval(this.#interval);
		this.#session?.setHeldMailProvider(undefined);
		this.#presence?.release();
		this.#presence = undefined;
	}

	#syncPresence(): void {
		if (this.#stopped) return;
		const sessionId = this.#sessionManager.getSessionId();
		const persisted = this.#sessionManager.getSessionFile() !== undefined;
		if (persisted && this.#presence?.sessionId === sessionId) return;
		this.#presence?.release();
		this.#presence = undefined;
		if (!persisted) return;
		try {
			this.#presence = claimSessionPresence(sessionId, { host: this.#host });
		} catch (error) {
			logger.warn("could not announce session presence", { sessionId, error: String(error) });
			return;
		}
		// Take the write lease at open: a timer then mails this process instead
		// of resuming the session headless, and a second process that opens the
		// same session moves to a sibling on its first write as it would anyway.
		if (this.#deliver) this.#ensureOwnership(false);
	}

	/**
	 * Whether this process may inject into its session now, i.e. it owns the
	 * session's write lease. A session that was never written has no file and
	 * nobody else can open it, so it is only claimed once mail is waiting.
	 */
	#ensureOwnership(mailWaiting: boolean): boolean {
		const presence = this.#presence;
		if (!presence) return false;
		const file = this.#sessionManager.getSessionFile();
		if (!mailWaiting && (!file || !fs.existsSync(file))) {
			presence.setDelivers(true);
			return false;
		}
		const owned = this.#sessionManager.claimOwnership();
		presence.setDelivers(owned);
		if (!owned && this.#refusalLogged !== presence.sessionId) {
			this.#refusalLogged = presence.sessionId;
			logger.warn("timer mail waiting: another omp process owns this session", { sessionId: presence.sessionId });
		}
		return owned;
	}

	async #poll(): Promise<void> {
		const session = this.#session;
		if (!session || this.#stopped || session.isDisposed) return;
		this.#syncPresence();
		const sessionId = this.#presence?.sessionId;
		if (!sessionId) return;
		const fresh = listNewMail(sessionId);
		const claimed = listClaimedMail(sessionId);
		if (!this.#ensureOwnership(fresh.length + claimed.length > 0)) return;
		if (fresh.length + claimed.length === 0) return;
		await this.#reconcileClaimed(session, sessionId, claimed);
		for (const name of fresh) {
			const peeked = peekNewMail(sessionId, name);
			if (!peeked || this.#heldByInterrupt(session, peeked)) continue;
			const mail = claimMail(sessionId, name);
			if (mail) await this.#inject(session, sessionId, name, mail);
		}
	}

	/** Poke mail waits out an Esc until the user's next prompt (or `--force`); timer fires do not. */
	#heldByInterrupt(session: AgentSession, mail: TimerMail): boolean {
		if (mail.kind !== "poke" || mail.poke?.force || !session.interruptLatched) return false;
		if (!this.#noted.has(mail.id)) {
			this.#noted.add(mail.id);
			logger.debug("poke held until the next prompt (session interrupted)", { mailId: mail.id });
		}
		return true;
	}

	/**
	 * Claimed mail leaves `cur/` only once the transcript carries its id. Mail
	 * in `cur/` that is not in the transcript and not on its way in this
	 * process was claimed by a consumer that died, or dropped by an interrupt:
	 * deliver it again, up to {@link MAX_MAIL_ATTEMPTS} attempts in total.
	 */
	async #reconcileClaimed(session: AgentSession, sessionId: string, claimed: string[]): Promise<void> {
		if (claimed.length === 0) return;
		const seen = new Set<string>();
		for (const entry of session.sessionManager.getEntries()) {
			const id = mailIdOf(entry);
			if (id) seen.add(id);
		}
		for (const name of claimed) {
			const mail = readClaimedMail(sessionId, name);
			if (!mail) continue;
			if (seen.has(mail.id)) {
				completeMail(sessionId, name);
				this.#inFlight.delete(mail.id);
				this.#noted.delete(mail.id);
				continue;
			}
			const flight = this.#inFlight.get(mail.id);
			if (flight && !this.#stalled(session, flight)) continue;
			if ((mail.attempts ?? 0) >= MAX_MAIL_ATTEMPTS) {
				if (!this.#noted.has(mail.id)) {
					this.#noted.add(mail.id);
					logger.warn("timer mail not delivered after every attempt; left in cur/", {
						sessionId,
						mailId: mail.id,
					});
				}
				continue;
			}
			logger.warn("re-delivering claimed timer mail missing from the transcript", { sessionId, mailId: mail.id });
			await this.#inject(session, sessionId, name, mail);
		}
	}

	#stalled(session: AgentSession, flight: InFlight): boolean {
		return (
			!flight.pending &&
			Date.now() - flight.since > STALL_MS &&
			!session.isStreaming &&
			session.queuedMessageCount === 0
		);
	}

	async #inject(session: AgentSession, sessionId: string, name: string, mail: TimerMail): Promise<void> {
		const attempt = recordMailAttempt(sessionId, name);
		if (attempt === undefined) return;
		const flight: InFlight = { sessionId, pending: true, since: Date.now() };
		this.#inFlight.set(mail.id, flight);
		const tz = mail.fire ? (await readTimerSpec(mail.fire.timerId))?.tz : undefined;
		if (mail.fire) {
			await appendLedger(mail.fire.timerId, {
				type: "delivery",
				runId: mail.fire.runId,
				at: new Date().toISOString(),
				state: this.#via === "headless" ? "resumed-headless" : "delivered-live",
				session: sessionId,
				detail: attempt > 1 ? `re-delivery attempt ${attempt}` : undefined,
			});
		}
		const { role: _role, timestamp: _timestamp, ...message } = messageFor(mail, this.#via, tz);
		// Streaming: join the running turn at its next step boundary. Idle: start
		// a turn (a follow-up only if a turn began in between). Not awaited: an
		// idle session's send resolves only when the whole turn ends.
		const options = session.isStreaming
			? ({ deliverAs: "aside" } as const)
			: ({ triggerTurn: true, deliverAs: "followUp" } as const);
		logger.debug("timer mail delivered", { sessionId, mailId: mail.id, via: this.#via, attempt });
		void session
			.sendCustomMessage<TimerMessageDetails>(message, options)
			.catch(error => logger.warn("timer mail injection failed", { mailId: mail.id, error: String(error) }))
			.finally(() => {
				flight.pending = false;
				flight.since = Date.now();
			});
	}

	/**
	 * Called synchronously by a user-authored prompt: claim the pokes an Esc
	 * held back so they enter context ahead of the user's message.
	 */
	#takeHeldMail(): CustomMessage[] {
		const sessionId = this.#presence?.sessionId;
		if (!sessionId || this.#stopped || !this.#ensureOwnership(true)) return [];
		const messages: CustomMessage[] = [];
		for (const name of listNewMail(sessionId)) {
			if (peekNewMail(sessionId, name)?.kind !== "poke") continue;
			const mail = claimMail(sessionId, name);
			if (!mail || recordMailAttempt(sessionId, name) === undefined) continue;
			this.#inFlight.set(mail.id, { sessionId, pending: false, since: Date.now() });
			messages.push(messageFor(mail, this.#via, undefined));
		}
		return messages;
	}
}
