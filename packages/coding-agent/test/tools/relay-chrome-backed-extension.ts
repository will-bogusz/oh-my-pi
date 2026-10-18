import { DISCARDED_TABS_PROTOCOL_VERSION } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { isRecord } from "@oh-my-pi/pi-utils";

const TAB_ID = 1;
/** Chrome's refusal while another extension's frame is in the tab. */
const FOREIGN_FRAME_REFUSAL = "Cannot access a chrome-extension:// URL of different extension";
/** A call that stays in flight until something ends it; its evaluation names `ompHang`, so the test can tell it apart. */
export const HANG = { code: "await page.evaluate(() => new Promise(function ompHang() {}));", timeout: 30 };

/**
 * The relay extension's side of the wire, played over a real headless Chromium's CDP endpoint: `attach`,
 * `send` and `detach` drive one page target the way `chrome.debugger` drives a tab. {@link chromeDetach}
 * does what Chrome does when another extension's frame loads in the tab: it ends the attachment, fails the
 * command in flight, and reports the detach.
 */
export class ChromeBackedExtension {
	readonly #relay: WebSocket;
	readonly #chrome: WebSocket;
	#seq = 0;
	readonly #replies = new Map<number, (message: Record<string, unknown>) => void>();
	/** The page target's flat session while "chrome.debugger" is attached. */
	#root: string | undefined;
	/** Chrome command id → relay RPC id of in-flight `send`s, answered with Chrome's error when the attachment ends. */
	readonly #inFlight = new Map<number, number>();
	/** Resolved by the next forwarded command each one matches. */
	readonly #sendWaiters = new Set<{ method: string; match: (params: unknown) => boolean; resolve: () => void }>();
	/** Held back from Chrome: the next forwarded command each one matches reaches Chrome once its gate opens. */
	readonly #holds = new Set<{
		method: string;
		match: (params: unknown) => boolean;
		arrived: () => void;
		gate: Promise<void>;
	}>();
	/** Answer attaches with Chrome's refusal, as while a foreign extension frame is in the tab. */
	refuseAttach = false;
	/** `attach` and `detach` requests the relay made. */
	attaches = 0;
	detaches = 0;

	private constructor(
		relay: WebSocket,
		chrome: WebSocket,
		readonly targetId: string,
	) {
		this.#relay = relay;
		this.#chrome = chrome;
		chrome.addEventListener("message", event => this.#onChrome(JSON.parse(String(event.data))));
		relay.addEventListener("message", event => void this.#onRelay(JSON.parse(String(event.data))));
	}

	static async connect(
		relayPort: number,
		chromeWs: string,
		targetId: string,
		url: string,
	): Promise<ChromeBackedExtension> {
		const chrome = new WebSocket(chromeWs);
		const relay = new WebSocket(`ws://127.0.0.1:${relayPort}/ext`);
		await Promise.all(
			[chrome, relay].map(socket => {
				const { promise, resolve, reject } = Promise.withResolvers<void>();
				socket.addEventListener("open", () => resolve(), { once: true });
				socket.addEventListener("error", () => reject(new Error("socket failed")), { once: true });
				return promise;
			}),
		);
		const extension = new ChromeBackedExtension(relay, chrome, targetId);
		relay.send(
			JSON.stringify({
				t: "hello",
				instanceId: "chrome-backed",
				userAgent: "test",
				browserVersion: "Chrome/151.0.0.0",
				discardedTabsProtocol: DISCARDED_TABS_PROTOCOL_VERSION,
				tabs: [
					{
						tabId: TAB_ID,
						url,
						title: "Sign in",
						active: true,
						discarded: false,
						windowId: 1,
						pinned: false,
						groupId: -1,
					},
				],
				attachedTabIds: [],
			}),
		);
		return extension;
	}

	#chromeSend(method: string, params: Record<string, unknown>, sessionId?: string) {
		const id = ++this.#seq;
		const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
		this.#replies.set(id, resolve);
		this.#chrome.send(JSON.stringify({ id, method, params, sessionId }));
		return { id, promise };
	}

	#onChrome(message: Record<string, unknown>): void {
		if (typeof message.id === "number") {
			this.#replies.get(message.id)?.(message);
			this.#replies.delete(message.id);
			return;
		}
		const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
		if (!sessionId || this.#root === undefined) return;
		this.#relay.send(
			JSON.stringify({
				t: "cdpEvent",
				tabId: TAB_ID,
				sessionId: sessionId === this.#root ? undefined : sessionId,
				method: message.method,
				params: message.params,
			}),
		);
	}

	#reply(id: number, outcome: { result: unknown } | { error: string }): void {
		this.#relay.send(
			JSON.stringify(
				"error" in outcome
					? { t: "rpcResult", id, ok: false, error: outcome.error }
					: { t: "rpcResult", id, ok: true, result: outcome.result ?? {} },
			),
		);
	}

	async #onRelay(message: Record<string, unknown>): Promise<void> {
		if (message.t !== "rpc" || typeof message.id !== "number") return;
		const id = message.id;
		switch (message.op) {
			case "attach": {
				this.attaches++;
				if (this.refuseAttach) return this.#reply(id, { error: FOREIGN_FRAME_REFUSAL });
				const answer = await this.#chromeSend("Target.attachToTarget", { targetId: this.targetId, flatten: true })
					.promise;
				const result = answer.result;
				if (!isRecord(result) || typeof result.sessionId !== "string")
					return this.#reply(id, { error: "attach failed" });
				this.#root = result.sessionId;
				return this.#reply(id, { result: {} });
			}
			case "detach": {
				this.detaches++;
				const root = this.#root;
				this.#root = undefined;
				// `chrome.debugger.detach` fails the extension's commands still in flight, as Chrome's own detach does.
				for (const rpcId of this.#inFlight.values())
					this.#reply(rpcId, { error: "Detached while handling command." });
				this.#inFlight.clear();
				if (root) await this.#chromeSend("Target.detachFromTarget", { sessionId: root }).promise;
				this.#relay.send(
					JSON.stringify({ t: "detached", tabId: TAB_ID, reason: "target_closed", relayInitiated: true }),
				);
				return this.#reply(id, { result: {} });
			}
			case "send": {
				const method = String(message.method);
				for (const hold of this.#holds) {
					if (hold.method !== method || !hold.match(message.params)) continue;
					this.#holds.delete(hold);
					hold.arrived();
					await hold.gate;
					break;
				}
				const root = this.#root;
				if (!root) return this.#reply(id, { error: "Debugger is not attached to the tab with id: 1." });
				const sent = this.#chromeSend(
					method,
					isRecord(message.params) ? message.params : {},
					typeof message.sessionId === "string" ? message.sessionId : root,
				);
				this.#inFlight.set(sent.id, id);
				for (const waiter of this.#sendWaiters) {
					if (waiter.method !== method || !waiter.match(message.params)) continue;
					this.#sendWaiters.delete(waiter);
					waiter.resolve();
				}
				const answer = await sent.promise;
				// Chrome already answered this RPC when the attachment ended under it.
				if (!this.#inFlight.delete(sent.id)) return;
				if (isRecord(answer.error)) return this.#reply(id, { error: String(answer.error.message) });
				return this.#reply(id, { result: answer.result });
			}
			default:
				return this.#reply(id, { result: {} });
		}
	}

	/** Resolves once the relay forwards a command of `method` whose params `match` accepts to the tab. */
	nextSend(method: string, match: (params: unknown) => boolean = () => true): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#sendWaiters.add({ method, match, resolve });
		return promise;
	}

	/**
	 * Hold the next command of `method` whose params `match` accepts before it reaches Chrome: `arrived` resolves once
	 * the relay forwards it, and Chrome gets it, on the attachment as it is then, when `release` is called.
	 */
	holdSend(
		method: string,
		match: (params: unknown) => boolean = () => true,
	): { arrived: Promise<void>; release: () => void } {
		const arrived = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		this.#holds.add({ method, match, arrived: arrived.resolve, gate: gate.promise });
		return { arrived: arrived.promise, release: gate.resolve };
	}

	/**
	 * Resolves once the relay forwards the evaluation of {@link HANG}. omp itself also evaluates in the page between
	 * and before calls (holding the page's `print()`), so any `Runtime.callFunctionOn` is not yet the call's code.
	 */
	hanging(): Promise<void> {
		return this.nextSend(
			"Runtime.callFunctionOn",
			params => isRecord(params) && String(params.functionDeclaration).includes("ompHang"),
		);
	}

	/** The tab's URL changed in Chrome (`chrome.tabs.onUpdated`). */
	urlChanged(url: string): void {
		this.#relay.send(
			JSON.stringify({
				t: "tabUpdated",
				tab: {
					tabId: TAB_ID,
					url,
					title: "Sign in",
					active: true,
					discarded: false,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			}),
		);
	}

	/** Chrome ends the attachment by itself: the command in flight fails, then `onDetach` fires. */
	async chromeDetach(reason: string): Promise<void> {
		const root = this.#root;
		this.#root = undefined;
		for (const rpcId of this.#inFlight.values()) this.#reply(rpcId, { error: "Detached while handling command." });
		this.#inFlight.clear();
		if (root) await this.#chromeSend("Target.detachFromTarget", { sessionId: root }).promise;
		this.#relay.send(JSON.stringify({ t: "detached", tabId: TAB_ID, reason }));
	}

	/** Whether "chrome.debugger" is attached to the tab. */
	get attached(): boolean {
		return this.#root !== undefined;
	}

	close(): void {
		this.#relay.close();
		this.#chrome.close();
	}
}
