import {
	declareWorkerHostEntry,
	installWorkerInbox,
	WORKER_HOST_SELECTOR_PREFIX,
} from "@oh-my-pi/pi-utils/worker-host";
import { COMPUTER_WORKER_ARG, type ComputerWorkerInbound } from "../../src/tools/computer/protocol";
import { smokeTestComputerWorker } from "../../src/tools/computer/supervisor";
import { startComputerWorker } from "../../src/tools/computer/worker-entry";

const STATS_WORKER_ARG = `${WORKER_HOST_SELECTOR_PREFIX}stats_sync`;

declare const self: Worker & {
	onmessage: ((event: MessageEvent<{ kind: "ping" }>) => void) | null;
};

declareWorkerHostEntry();
const selector = process.argv.find(arg => arg.startsWith(WORKER_HOST_SELECTOR_PREFIX));
if (selector === COMPUTER_WORKER_ARG) {
	if (!process.send || !Bun.isMainThread) throw new Error("compiled computer fixture requires process IPC");
	const inbox = installWorkerInbox(process);
	startComputerWorker({
		send: message => {
			process.send!(message);
		},
		onMessage: handler => inbox.bind(message => handler(message as ComputerWorkerInbound)),
	});
	setInterval(() => {}, 2 ** 30);
	process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
} else if (Bun.isMainThread) {
	const worker = new Worker(Bun.main, { type: "module", argv: [STATS_WORKER_ARG] });
	const response = Promise.withResolvers<unknown>();
	worker.addEventListener("message", event => response.resolve(event.data));
	worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
	worker.postMessage({ kind: "ping" });
	try {
		const result = await response.promise;
		await smokeTestComputerWorker();
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} finally {
		worker.terminate();
	}
} else {
	if (selector === STATS_WORKER_ARG) {
		self.onmessage = (_event: MessageEvent<{ kind: "ping" }>) => {
			self.postMessage({ ok: true, kind: "pong" });
		};
	} else {
		throw new Error(`unknown worker selector: ${selector}`);
	}
}
