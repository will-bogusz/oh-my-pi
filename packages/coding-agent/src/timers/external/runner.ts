/** Command runners for the estate scan: this host, or a POSIX host over omp's shared ssh connection. */
import { ptree } from "@oh-my-pi/pi-utils";
import {
	buildRemoteCommand,
	ensureConnection,
	ensureHostInfo,
	type SSHConnectionTarget,
	type SSHHostOs,
} from "../../ssh/connection-manager";
import { wrapInPosixShell } from "../../ssh/utils";
import { quotePosixArgv } from "../../utils/shell-quote";
import type { CommandResult, CommandRunner } from "./types";

/** Listing commands are cheap; a hung `launchctl` or unreachable host must not hang `omp timer ls`. */
const COMMAND_TIMEOUT_MS = 30_000;

async function capture(argv: string[]): Promise<CommandResult> {
	try {
		const result = await ptree.exec(argv, { allowNonZero: true, allowAbort: true, timeout: COMMAND_TIMEOUT_MS });
		return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
	} catch (error) {
		// Spawn failures (binary missing) surface as a failed command, like a shell would report them.
		return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
}

export const localRunner: CommandRunner = capture;

export interface RemoteRunner {
	run: CommandRunner;
	os: SSHHostOs;
}

/** Opens (or reuses) the ssh ControlMaster for `target` and runs argv under its verified POSIX shell. */
export async function connectRemoteRunner(target: SSHConnectionTarget): Promise<RemoteRunner> {
	await ensureConnection(target);
	const info = await ensureHostInfo(target);
	const shell = info.transferShell ?? info.compatShell;
	return {
		os: info.os,
		run: async argv => {
			const command = quotePosixArgv(argv);
			return capture([
				"ssh",
				...(await buildRemoteCommand(target, shell ? wrapInPosixShell(shell, command) : command)),
			]);
		},
	};
}
