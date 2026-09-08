import { untilAborted } from "@oh-my-pi/pi-utils";
import type { Page } from "puppeteer-core";
import { throwIfAborted } from "../tool-errors";
import popupPolicy from "./popup-policy.js.txt" with { type: "text" };
import type { DiscoveredChromeTab } from "./relay/managed-tabs";

interface PopupRequest {
	id: string;
	runId: string;
	url?: string;
	error?: string;
}

/** A task-operation policy, not a replacement for WindowProxy or named windows. */
export class ManagedPopupPolicy {
	#page: Page;
	#binding = `__ompPopup_${crypto.randomUUID().replaceAll("-", "")}`;
	#script?: string;
	#configuration: Promise<void> = Promise.resolve();
	#signal?: AbortSignal;
	#runId?: string;
	#accepted = new Set<string>();
	#pending = new Set<Promise<void>>();
	#errors: unknown[] = [];
	#created: DiscoveredChromeTab[] = [];
	#create: (url: string, signal: AbortSignal) => Promise<DiscoveredChromeTab>;

	constructor(page: Page, create: (url: string, signal: AbortSignal) => Promise<DiscoveredChromeTab>) {
		this.#page = page;
		this.#create = create;
	}

	async install(): Promise<void> {
		await this.#page.exposeFunction(this.#binding, (request: PopupRequest) => this.#accept(request));
		await this.#configure(0);
	}

	async begin(signal: AbortSignal, timeoutMs: number): Promise<void> {
		this.#errors = [];
		this.#created = [];
		this.#runId = crypto.randomUUID();
		this.#accepted.clear();
		this.#signal = signal;
		await untilAborted(signal, () => this.#configure(Date.now() + timeoutMs));
		throwIfAborted(signal);
	}

	async finish(options?: { pageBlocked?: boolean }): Promise<DiscoveredChromeTab[]> {
		// Stop page admission, then recover requests emitted before a newly navigated
		// context had its exposed binding. Request identity prevents double creation.
		try {
			if (!options?.pageBlocked && !this.#page.isClosed()) {
				await this.#configure(0);
				const queues = await Promise.allSettled(
					this.#page
						.frames()
						.map(frame =>
							frame
								.mainRealm()
								.evaluate(`globalThis[${JSON.stringify(this.#binding + "Policy")}]?.requests.splice(0) ?? []`),
						),
				);
				for (const queue of queues) {
					if (queue.status === "fulfilled")
						for (const request of queue.value as PopupRequest[]) this.#accept(request);
				}
			}
		} catch (error) {
			// Closing the target ends its page policy too. It may close while the
			// cleanup command is in flight; still drain accepted child work below.
			if (!this.#page.isClosed()) throw error;
		} finally {
			this.#signal = undefined;
		}
		await Promise.allSettled(this.#pending);
		if (this.#errors.length) throw new Error(`Background popup: ${String(this.#errors[0])}`);
		return [...this.#created];
	}

	#accept(request: PopupRequest): Promise<void> | undefined {
		const signal = this.#signal;
		if (!signal || signal.aborted || request.runId !== this.#runId || this.#accepted.has(request.id)) return;
		this.#accepted.add(request.id);
		const pending = (async () => {
			if (request.error) throw new Error(request.error);
			if (typeof request.url !== "string") throw new Error("Invalid background popup URL");
			throwIfAborted(signal);
			this.#created.push(await this.#create(request.url, signal));
		})().catch(error => {
			this.#errors.push(error);
		});
		this.#pending.add(pending);
		void pending.finally(() => this.#pending.delete(pending));
		return pending;
	}

	async dispose(): Promise<void> {
		this.#signal = undefined;
		try {
			if (this.#page.isClosed()) return;
			if (this.#script) await this.#page.removeScriptToEvaluateOnNewDocument(this.#script);
			await Promise.allSettled(
				this.#page
					.frames()
					.map(frame =>
						frame.mainRealm().evaluate(`globalThis[${JSON.stringify(this.#binding + "Policy")}]?.dispose()`),
					),
			);
			await this.#page.removeExposedFunction(this.#binding);
		} catch (error) {
			if (!this.#page.isClosed()) throw error;
		}
	}

	#configure(deadline: number): Promise<void> {
		const configured = this.#configuration.catch(() => undefined).then(() => this.#apply(deadline));
		this.#configuration = configured;
		return configured;
	}

	async #apply(deadline: number): Promise<void> {
		const source = `(${popupPolicy})(${JSON.stringify(this.#binding)}, ${deadline}, ${JSON.stringify(this.#runId ?? null)})`;
		// Main-world installation is required: page.evaluate defaults to OMP's isolated realm.
		if (this.#script) await this.#page.removeScriptToEvaluateOnNewDocument(this.#script);
		this.#script = undefined;
		this.#script = (await this.#page.evaluateOnNewDocument(source)).identifier;
		const results = await Promise.allSettled(this.#page.frames().map(frame => frame.mainRealm().evaluate(source)));
		for (const result of results) {
			if (result.status === "rejected" && !/detached|destroyed|Cannot find context/.test(String(result.reason)))
				throw result.reason;
		}
	}
}
