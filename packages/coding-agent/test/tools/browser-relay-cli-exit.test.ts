import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { findFreeCdpPort } from "../../src/tools/browser/attach";
import { probeRelayServer, RelayPairingLease } from "../../src/tools/browser/relay/daemon";

const cli = path.resolve(import.meta.dir, "../../src/cli.ts");

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await Bun.sleep(30);
	}
	return condition();
}

async function fixture() {
	// Keep the real Unix broker socket path beneath macOS's sockaddr_un limit.
	const config = `.omp-bcli-${crypto.randomUUID().slice(0, 8)}`;
	const root = path.join(os.homedir(), config);
	const runtimeDir = path.join(root, "run", "daemons", "global", "browser-relay");
	const port = await findFreeCdpPort();
	const endpoint = `http://127.0.0.1:${port}`;
	await fs.mkdir(root, { recursive: true });
	const env = {
		...process.env,
		PI_CONFIG_DIR: config,
		PI_CODING_AGENT_DIR: path.join(root, "agent"),
		OMP_PROFILE: "",
		PI_PROFILE: "",
		XDG_DATA_HOME: "",
		XDG_STATE_HOME: "",
		XDG_CACHE_HOME: "",
		OMP_DAEMON_IDLE_GRACE_MS: "100",
	};
	return {
		root,
		runtimeDir,
		port,
		endpoint,
		spawn(args: string[], finite = true) {
			return Bun.spawn([process.execPath, cli, "browser-relay", ...args, "--port", String(port)], {
				cwd: root,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: finite ? 15_000 : undefined,
				killSignal: "SIGKILL",
			});
		},
		async command(args: string[]) {
			const child = this.spawn(args);
			const [code, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return { code, stdout, stderr, signal: child.signalCode };
		},
		async close() {
			const rescue = await createDaemonBrokerClient(runtimeDir, { runtimeDir, idleGraceMs: 100 });
			try {
				await rescue.request({ op: "shutdown" });
			} catch {
				// An already idle test broker may have finished shutting down.
			} finally {
				rescue.close();
				await fs.rm(root, { recursive: true, force: true });
			}
		},
	};
}

describe("finite browser setup commands", () => {
	it("exits naturally after list, pair, and rejected unpair without stopping an external serve", async () => {
		const scope = await fixture();
		const serve = scope.spawn(["serve"], false);
		const serveOut = new Response(serve.stdout).text();
		const serveErr = new Response(serve.stderr).text();
		try {
			expect(await waitUntil(() => probeRelayServer(scope.endpoint), 15_000)).toBeTrue();
			const listed = await scope.command(["list"]);
			expect(listed).toEqual({ code: 0, stdout: "[]\n", stderr: "", signal: null });

			const rejected = await scope.command(["unpair", "--id", "missing-profile"]);
			expect(rejected.code).toBe(1);
			expect(rejected.signal).toBeNull();
			expect(rejected.stderr).toContain("Unknown paired browser");

			const paired = await scope.command(["pair"]);
			expect(paired.code, paired.stderr).toBe(0);
			expect(paired.signal).toBeNull();
			expect(paired.stdout).toContain("Pairing code:");
			await Bun.sleep(350);
			expect(serve.exitCode).toBeNull();
			expect(await probeRelayServer(scope.endpoint)).toBeTrue();
		} finally {
			serve.kill();
			await Promise.all([serve.exited, serveOut, serveErr]);
			await scope.close();
		}
	}, 60_000);

	it("keeps an automatically started service available for code entry after pair exits", async () => {
		const scope = await fixture();
		try {
			const paired = await scope.command(["pair"]);
			expect(paired.code, paired.stderr).toBe(0);
			expect(paired.signal).toBeNull();
			expect(paired.stdout).toContain("Pairing code:");
			// Longer than this fixture broker's last-client grace. The finite CLI
			// has exited; only the service's bounded setup lease can keep it alive.
			await Bun.sleep(350);
			expect(await probeRelayServer(scope.endpoint)).toBeTrue();
			const listed = await scope.command(["list"]);
			expect(listed).toEqual({ code: 0, stdout: "[]\n", stderr: "", signal: null });
		} finally {
			await scope.close();
		}
	}, 40_000);

	it("expires an extended setup lease without dropping an independent consumer", async () => {
		const scope = await fixture();
		const setup = new RelayPairingLease(scope.runtimeDir);
		const consumer = await createDaemonBrokerClient(scope.runtimeDir, {
			runtimeDir: scope.runtimeDir,
			idleGraceMs: 100,
		});
		const marker = path.join(scope.root, "peer.pid");
		try {
			await consumer.request({ op: "ping" });
			await consumer.request({
				op: "start",
				spec: {
					name: "setup-peer",
					application: process.execPath,
					args: [
						"-e",
						'await Bun.write(process.argv[1], String(process.pid)); console.log("ready"); setInterval(() => {}, 1000);',
						marker,
					],
					env: {},
					cwd: scope.root,
					pty: false,
					ready: { log: "ready", timeoutMs: 5000 },
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			const pid = Number(await Bun.file(marker).text());
			const alive = () => {
				try {
					process.kill(pid, 0);
					return true;
				} catch {
					return false;
				}
			};
			await setup.holdUntil(Date.now() + 250);
			await setup.holdUntil(Date.now() + 700);
			consumer.close();
			await Bun.sleep(450);
			expect(alive()).toBeTrue();
			const independent = await createDaemonBrokerClient(scope.runtimeDir, {
				runtimeDir: scope.runtimeDir,
				idleGraceMs: 100,
			});
			try {
				await independent.request({ op: "ping" });
				await Bun.sleep(450);
				expect(alive()).toBeTrue();
			} finally {
				independent.close();
			}
			expect(await waitUntil(() => !alive(), 5000)).toBeTrue();
		} finally {
			consumer.close();
			await setup.close();
			await scope.close();
		}
	}, 20_000);
});
