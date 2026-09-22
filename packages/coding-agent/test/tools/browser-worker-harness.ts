import type {
	ReadyInfo,
	SessionSnapshot,
	Transport,
	WorkerInbound,
	WorkerInitPayload,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";

export type WorkerResult = Extract<WorkerOutbound, { type: "result" }>;

export interface WorkerHarness {
	/** Deliver one host→worker message the way the supervisor's transport does. */
	send(message: WorkerInbound): void;
	/** Init the worker; resolves with its ready info and rejects on `init-failed`. */
	init(payload: WorkerInitPayload): Promise<ReadyInfo>;
	/** Run one cell and resolve with the result message it produced. */
	run(cell: {
		code: string;
		timeoutMs: number;
		name?: string;
		id?: string;
		session?: SessionSnapshot;
	}): Promise<WorkerResult>;
	/** Ask the worker to close and wait for it to say it did. */
	close(): Promise<void>;
}

/**
 * One real {@link WorkerCore} over an in-process transport: the same message
 * shape the tab supervisor gives it, without the worker thread. Every browser
 * test that drives a real worker against a real Chromium needs exactly this,
 * and nothing here reaches into the worker's internals.
 *
 * `onMessage` observes the raw outbound stream for the few tests that care
 * about messages other than ready/result/closed (`page-created`, `log`).
 */
export function startWorker(opts: { onMessage?: (message: WorkerOutbound) => void } = {}): WorkerHarness {
	const ready = Promise.withResolvers<ReadyInfo>();
	const closed = Promise.withResolvers<void>();
	let pending = Promise.withResolvers<WorkerResult>();
	let receive: (message: WorkerInbound) => void = () => {};
	let cell = 0;
	const transport: Transport = {
		send(message) {
			if (message.type === "ready") ready.resolve(message.info);
			if (message.type === "init-failed") ready.reject(new Error(message.error.message));
			if (message.type === "result") pending.resolve(message);
			if (message.type === "closed") closed.resolve();
			opts.onMessage?.(message as WorkerOutbound);
		},
		onMessage(handler) {
			receive = handler;
			return () => {};
		},
		close() {},
	};
	new WorkerCore(transport, false);
	return {
		send: message => receive(message),
		init: payload => {
			receive({ type: "init", payload });
			return ready.promise;
		},
		run: ({ code, timeoutMs, name, id, session }) => {
			// Re-armed per cell: a worker outlives many runs, and each caller
			// awaits the result of the run it just sent.
			pending = Promise.withResolvers<WorkerResult>();
			const settled = pending.promise;
			receive({
				type: "run",
				id: id ?? `cell-${++cell}`,
				name: name ?? "test cell",
				code,
				timeoutMs,
				session: session ?? { cwd: process.cwd() },
			});
			return settled;
		},
		close: () => {
			receive({ type: "close" });
			return closed.promise;
		},
	};
}
