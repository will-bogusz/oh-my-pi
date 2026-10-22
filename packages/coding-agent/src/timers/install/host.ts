import * as fs from "node:fs/promises";
import * as os from "node:os";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export interface HostCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Every OS effect the installer has. Tests pass a fake; `dryRun` runs, writes and removes nothing. */
export interface TimerHost {
	/** "darwin" | "linux"; anything else is unsupported. */
	platform: NodeJS.Platform;
	/** Unit files live under this HOME. */
	home: string;
	uid: number;
	user: string;
	/** Commands, writes and removals are recorded or skipped; checks that need a real answer report "not checked". */
	dryRun?: boolean;
	run(argv: string[]): Promise<HostCommandResult>;
	/** `undefined` on ENOENT. */
	readFile(file: string): Promise<string | undefined>;
	/** Creates parent directories. */
	writeFile(file: string, content: string): Promise<void>;
	/** `mkdir -p`. */
	makeDir(dir: string): Promise<void>;
	/** `false` on ENOENT. */
	removeFile(file: string): Promise<boolean>;
	exists(file: string): Promise<boolean>;
	/** A regular file this user may execute. */
	isExecutable(file: string): Promise<boolean>;
}

/**
 * Real host. With `dryRun` nothing on disk or in launchd/systemd changes: `run()` records argv in
 * `.commands` and returns a successful "(dry run)" result, writes and directory creation are skipped,
 * and `removeFile()` only reports whether the file exists. Reads still happen.
 */
export function createTimerHost(
	options: { dryRun?: boolean; home?: string } = {},
): TimerHost & { commands: string[][] } {
	const commands: string[][] = [];
	const dryRun = options.dryRun ?? false;
	const info = os.userInfo();
	const exists = async (file: string): Promise<boolean> => {
		try {
			await fs.stat(file);
			return true;
		} catch (err) {
			if (isEnoent(err)) return false;
			throw err;
		}
	};
	return {
		platform: process.platform,
		home: options.home ?? process.env.HOME ?? os.homedir(),
		uid: process.getuid?.() ?? info.uid,
		user: info.username,
		commands,
		dryRun,
		async run(argv) {
			commands.push([...argv]);
			if (dryRun) return { exitCode: 0, stdout: "", stderr: "(dry run)" };
			try {
				const result = await $`${argv}`.quiet().nothrow();
				return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
			} catch (err) {
				return { exitCode: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
			}
		},
		async readFile(file) {
			try {
				return await Bun.file(file).text();
			} catch (err) {
				if (isEnoent(err)) return undefined;
				throw err;
			}
		},
		async writeFile(file, content) {
			if (!dryRun) await Bun.write(file, content);
		},
		async makeDir(dir) {
			if (!dryRun) await fs.mkdir(dir, { recursive: true });
		},
		async removeFile(file) {
			if (dryRun) return exists(file);
			try {
				await fs.rm(file);
				return true;
			} catch (err) {
				if (isEnoent(err)) return false;
				throw err;
			}
		},
		exists,
		async isExecutable(file) {
			try {
				if (!(await fs.stat(file)).isFile()) return false;
				await fs.access(file, fs.constants.X_OK);
				return true;
			} catch {
				return false;
			}
		},
	};
}
