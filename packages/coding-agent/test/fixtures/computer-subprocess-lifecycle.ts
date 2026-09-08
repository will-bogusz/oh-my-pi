import { installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { ComputerWorkerInbound, ComputerWorkerOutbound } from "../../src/tools/computer/protocol";
import type { ComputerOperationContext } from "../../src/tools/computer/types";
import type { ComputerBackend } from "../../src/tools/computer/worker";
import { startComputerWorker } from "../../src/tools/computer/worker-entry";

if (!process.send) throw new Error("Lifecycle fixture requires process IPC");
const send = (message: ComputerWorkerOutbound): void => {
	process.send!(message);
};
const release = Promise.withResolvers<void>();
let active: Promise<void> | undefined;
const implementation = {
	requiresReacquisition: false,
	capabilities: {
		backend: "fixture",
		displayServer: "fixture",
		capture: true,
		input: false,
		ax: false,
		capturePermission: "granted",
		inputPermission: "denied",
		axPermission: "denied",
		displayCount: 1,
	},
	async apps() {
		active = release.promise;
		send({ type: "pong", id: "operation-started" });
		await active;
		return [];
	},
	async screenshot(context: ComputerOperationContext) {
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		context.emitImage(
			{ path: "/fixture.png", width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, target: "fixture" },
			{ type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
			false,
		);
		return { bytes: png, buffer: png.buffer };
	},
	async drain() {
		await active;
	},
	async close() {
		await active;
		send({ type: "pong", id: "backend-closed" });
	},
};
// This native-free fixture only implements operations exercised below. Any
// unexpected backend use fails, instead of pretending to have desktop support.
const backend = new Proxy(implementation, {
	get(target, property, receiver) {
		if (property === "then") return undefined;
		if (!(property in target)) throw new Error(`Unexpected backend operation: ${String(property)}`);
		return Reflect.get(target, property, receiver);
	},
}) as unknown as ComputerBackend;
const inbox = installWorkerInbox(process);
startComputerWorker(
	{
		send,
		onMessage: handler =>
			inbox.bind(raw => {
				const message = raw as ComputerWorkerInbound;
				if (message.type === "ping" && message.id === "spawn-installer") {
					// Like runRuntimeInstall, this child owns NEW pipes: it does not
					// keep the worker's inherited stderr alive after the worker exits.
					const installer = Bun.spawn({
						cmd: [process.execPath, "-e", 'process.send?.("ready"); setInterval(() => {}, 1000);'],
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
						ipc() {
							send({ type: "pong", id: `installer:${installer.pid}` });
						},
					});
					return;
				}
				if (message.type === "ping" && message.id === "exit-leader") process.exit(0);
				if (message.type === "ping" && message.id === "release") {
					release.resolve();
					return;
				}
				if (message.type === "ping" && message.id === "wedge") {
					send({ type: "pong", id: "wedged" });
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
					return;
				}
				handler(message);
			}),
	},
	async () => backend,
);
setInterval(() => {}, 2 ** 30);
process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
