import type { ComputerWorkerTransport } from "./protocol";
import { type ComputerBackendFactory, ComputerWorkerCore } from "./worker";

/** Starts only through explicit CLI subprocess dispatch or a test transport. */
export function startComputerWorker(
	transport: Omit<ComputerWorkerTransport, "close">,
	createSession?: ComputerBackendFactory,
): void {
	new ComputerWorkerCore(
		{
			// Advanced subprocess serialization copies ArrayBuffers; no transfer list
			// detaches screenshot data before the IPC channel has serialized it.
			send: message => transport.send(message),
			onMessage: handler => transport.onMessage(handler),
			// Core acknowledges closed only after backend close/drain. The supervisor
			// then kills and observes OS exit, avoiding native finalizer hangs here.
			close: () => {},
		},
		createSession,
	);
}
