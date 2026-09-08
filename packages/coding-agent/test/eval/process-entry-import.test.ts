import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { spawnComputerWorker } from "../../src/tools/computer/supervisor";

it("imports the CLI entry graph without loading dotenv before profile bootstrap", async () => {
	using tempDir = TempDir.createSync("@omp-js-process-import-");
	await Bun.write(path.join(tempDir.path(), ".env"), "OMP_PROCESS_ENTRY_ENV_PROBE=loaded-too-early\n");
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	delete env.OMP_PROCESS_ENTRY_ENV_PROBE;
	env.HOME = tempDir.path();
	const fixture = path.resolve(import.meta.dir, "../fixtures/js-process-entry-import.ts");
	const proc = Bun.spawn([process.execPath, fixture], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode).toBe(0);
	expect(stdout).toBe("");
	expect(stderr).toBe("");
});

async function pingComputerWorker(entry: string, id: string): Promise<unknown> {
	const worker = spawnComputerWorker({ cmd: [process.execPath, entry, "__omp_worker_computer"] });
	const response = Promise.withResolvers<unknown>();
	worker.onMessage(message => {
		if (message.type === "pong" && message.id === id) response.resolve(message);
	});
	worker.onError(error => response.reject(error));
	worker.send({ type: "ping", id });
	try {
		return await response.promise;
	} finally {
		await worker.terminate();
	}
}

it("starts ordinary CLI paths without loading the native computer addon", async () => {
	const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");
	for (const args of [
		["--no-addons", cliPath, "--version"],
		[cliPath, "--help"],
	]) {
		const proc = Bun.spawn([process.execPath, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode, `${args.at(-1)}: ${stderr}`).toBe(0);
	}
	// Two cold CLI spawns (`--version`, `--help`) per run; the assertion is the exit
	// code, not the wall time.
}, 30_000);

it("dispatches the computer worker through the CLI host selector in a child process", async () => {
	const fixture = path.resolve(import.meta.dir, "../fixtures/computer-worker-cli-selector.ts");
	const proc = Bun.spawn([process.execPath, "--no-addons", fixture], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"type":"pong","id":"computer-cli-selector"}\n');
});

it("dispatches the computer worker from a single npm-style host bundle", async () => {
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outDir = fs.mkdtempSync(path.join(packageDir, ".computer-worker-bundle-"));
	try {
		const external = [
			"@oh-my-pi/pi-natives",
			"@huggingface/transformers",
			"fastembed",
			"onnxruntime-node",
			"omp-legacy-pi-modules",
			"puppeteer-core",
			"@babel/parser",
		];
		// A fresh build process uses the distribution resolver rather than sharing
		// Bun test's already-evaluated module graph and negative resolution cache.
		const build = Bun.spawn(
			[
				process.execPath,
				"build",
				path.join(packageDir, "src/cli.ts"),
				"--target=bun",
				`--outdir=${outDir}`,
				'--define=process.env.PI_BUNDLED="true"',
				...external.map(name => `--external=${name}`),
			],
			{ cwd: packageDir, stdout: "ignore", stderr: "pipe" },
		);
		const [buildExitCode, buildStderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
		expect(buildExitCode, buildStderr).toBe(0);
		const response = await pingComputerWorker(path.join(outDir, "cli.js"), "computer-npm-bundle");
		expect(response).toEqual({ type: "pong", id: "computer-npm-bundle" });
	} finally {
		fs.rmSync(outDir, { recursive: true, force: true });
	}
});

it("dispatches computer subprocess and other selectors from one compiled worker host", async () => {
	using tempDir = TempDir.createSync("@omp-compiled-worker-selector-");
	const packageDir = path.resolve(import.meta.dir, "../..");
	const outfile = path.join(tempDir.path(), process.platform === "win32" ? "worker-host.exe" : "worker-host");
	const build = Bun.spawn(
		[
			process.execPath,
			"build",
			"--compile",
			"--target=bun",
			`--outfile=${outfile}`,
			path.join(packageDir, "test/fixtures/compiled-worker-selector-host.ts"),
		],
		{ cwd: packageDir, stdout: "pipe", stderr: "pipe" },
	);
	const [buildExitCode, buildStderr] = await Promise.all([build.exited, new Response(build.stderr).text()]);
	expect(buildExitCode, buildStderr).toBe(0);
	const proc = Bun.spawn([outfile], {
		cwd: packageDir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	expect(exitCode, stderr).toBe(0);
	expect(stdout).toBe('{"ok":true,"kind":"pong"}\n');
	// Compiles a standalone binary with `bun build --compile` before running it, so
	// this needs the same headroom as the other compile-backed tests.
}, 60_000);
