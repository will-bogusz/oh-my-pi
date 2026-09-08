import type { ComputerWorkerOutbound } from "../../src/tools/computer/protocol";

const pong = Promise.withResolvers<ComputerWorkerOutbound>();
const closed = Promise.withResolvers<void>();
const child = Bun.spawn(
	[process.execPath, "--no-addons", new URL("../../src/cli.ts", import.meta.url).pathname, "__omp_worker_computer"],
	{
		stdout: "ignore",
		stderr: "inherit",
		serialization: "advanced",
		ipc(message: ComputerWorkerOutbound) {
			if (message.type === "pong") pong.resolve(message);
			if (message.type === "closed") closed.resolve();
		},
	},
);
const timeout = setTimeout(() => {
	child.kill("SIGKILL");
	pong.reject(new Error("Computer IPC timed out"));
	closed.reject(new Error("Computer close timed out"));
}, 5_000);
let result: ComputerWorkerOutbound;
try {
	child.send({ type: "ping", id: "computer-cli-selector" });
	result = await pong.promise;
	child.send({ type: "close" });
	await closed.promise;
} finally {
	clearTimeout(timeout);
	child.kill("SIGKILL");
	await child.exited;
}
if (child.pid === process.pid) throw new Error("Computer worker did not use a child process");
try {
	process.kill(child.pid, 0);
	throw new Error("Computer process survived termination");
} catch (error) {
	if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
}
process.stdout.write(`${JSON.stringify(result)}\n`);
