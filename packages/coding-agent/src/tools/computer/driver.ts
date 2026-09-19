import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { getNativesDir, isEnoent } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { ToolAbortError, throwIfAborted } from "../tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { cachedCuaDriver, sha256Hex } from "./driver-cache";
import { vendoredDriver } from "./vendored";

/** MCP tool reply from the driver, flattened to what the session consumes. */
export interface CuaToolResult {
	text: string;
	images: { dataBase64: string; mimeType: string }[];
	structuredJson?: string;
	isError: boolean;
	errorCode?: string;
}

/** One `cua-driver mcp --direct` process, or a test double standing in for it. */
export interface CuaDriver {
	readonly version: string;
	readonly pid: number;
	/** False once the process has exited for any reason. */
	readonly alive: boolean;
	/**
	 * Invoke one driver tool. Aborting `signal` cancels the in-flight call
	 * cooperatively; the promise then settles with the driver's own answer
	 * (`cancelled` or completion), bounded by the cancel grace period.
	 */
	callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaToolResult>;
	/** End the process. Graceful (stdin EOF, admitted work drains) unless `force`. */
	kill(options?: { force?: boolean }): Promise<void>;
}

export type CuaDriverFactory = () => Promise<CuaDriver>;

/** `process.platform-process.arch`, the vendored driver directory key. */
export const DRIVER_PLATFORM = `${process.platform}-${process.arch}`;

const MCP_PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_TIMEOUT_MS = 15_000;
/** A cancelled call that still has not answered after this long marks the child unresponsive. */
const CANCEL_GRACE_MS = 10_000;
/** Graceful exit budget after stdin EOF before SIGKILL. */
const EXIT_TIMEOUT_MS = 5_000;
const STDERR_TAIL_BYTES = 4_096;
const CANCEL_OPERATION_TOOL = "cancel_operation";

const RpcEnvelope = type({
	"id?": "number | string | null",
	"result?": "unknown",
	"error?": { "code?": "number", "message?": "string" },
	"method?": "string",
});

const ToolsList = type({ tools: type({ name: "string" }).array() });

const McpToolResult = type({
	"content?": type({ "type?": "string", "text?": "string", "data?": "string", "mimeType?": "string" }).array(),
	"isError?": "boolean",
	"structuredContent?": "unknown",
});

interface RpcReply {
	result?: unknown;
	error?: { code?: number; message?: string };
}

interface PendingRequest {
	resolve(reply: RpcReply): void;
	reject(reason: unknown): void;
	cancelDeadline?: Timer;
}

function toolNames(result: unknown): string[] {
	const listed = ToolsList(result);
	return listed instanceof type.errors ? [] : listed.tools.map(tool => tool.name);
}

/** Thrown when the driver process is gone; the session respawns on its next call. */
export class CuaDriverExitedError extends ToolError {
	constructor(message: string) {
		super(message);
		this.name = "CuaDriverExitedError";
	}
}

/**
 * The installed executable for this host, copied into the natives cache the
 * first time (or after a driver update) from the embedded copy in a compiled
 * binary, else from the download cache, which fetches the manifest's release
 * asset when it has nothing. The path is fixed rather than content-addressed
 * for macOS: TCC keys an unbundled binary's grants by path, so replacing the
 * file in place keeps the grant record stable. Other hosts share the layout;
 * it costs them nothing. `manifest.json` beside it names the installed sha256.
 */
export async function installCuaDriver(platform: string = DRIVER_PLATFORM): Promise<string> {
	const vendored = await vendoredDriver(platform);
	if (!vendored)
		throw new ToolError(
			`Native computer control is unavailable on ${platform}: no cua-driver is vendored for this platform.`,
		);
	const directory = path.join(getNativesDir(), "cua-driver");
	const installed = path.join(directory, "cua-driver");
	const manifestPath = path.join(directory, "manifest.json");
	try {
		const current: unknown = await Bun.file(manifestPath).json();
		if (current && typeof current === "object" && "sha256" in current && current.sha256 === vendored.sha256) {
			await fs.access(installed, fs.constants.X_OK);
			return installed;
		}
	} catch (error) {
		if (!isEnoent(error) && !(error instanceof SyntaxError)) throw error;
	}
	const executable = vendored.filePath ?? (await cachedCuaDriver(vendored));
	const bytes = await Bun.file(executable).bytes();
	const digest = sha256Hex(bytes);
	if (digest !== vendored.sha256)
		throw new ToolError(
			`cua-driver ${vendored.version} at ${executable} does not match its manifest (sha256 ${digest}); refusing to install it.`,
		);
	await fs.mkdir(directory, { recursive: true });
	const staging = `${installed}.${process.pid}.${crypto.randomUUID()}`;
	await Bun.write(staging, bytes);
	await fs.chmod(staging, 0o755);
	await fs.rename(staging, installed);
	const { filePath: _filePath, ...manifest } = vendored;
	await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	logger.info("Installed cua-driver", {
		version: vendored.version,
		sha256: vendored.sha256,
		path: installed,
	});
	return installed;
}

/** Spawn the vendored driver for this host, installing it first when needed. */
export async function spawnVendoredCuaDriver(): Promise<CuaDriver> {
	return CuaDriverChild.spawn([await installCuaDriver()]);
}

export interface CuaDriverSpawnOptions {
	env?: Record<string, string | undefined>;
	/** Bounds the MCP handshake (initialize, tools/list, get_config). */
	handshakeTimeoutMs?: number;
	/** How long a cancelled call may stay unanswered before the child is killed. */
	cancelGraceMs?: number;
}

/**
 * Supervises one `cua-driver mcp --direct` child over newline-delimited
 * JSON-RPC on stdio. Every request carries its own id; cancellation names that
 * id (`notifications/cancelled`, plus the `cancel_operation` tool when the
 * driver advertises it). A cancelled call that never answers within the grace
 * period is the only abort path that kills the child.
 */
export class CuaDriverChild implements CuaDriver {
	readonly pid: number;
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #exited: Promise<void>;
	readonly #cancelGraceMs: number;
	#version = "unknown";
	#nextId = 0;
	#alive = true;
	#exitDescription = "cua-driver exited";
	#stderrTail = "";
	#supportsCancelTool = false;

	private constructor(proc: Bun.Subprocess<"pipe", "pipe", "pipe">, cancelGraceMs: number) {
		this.#proc = proc;
		this.pid = proc.pid;
		this.#cancelGraceMs = cancelGraceMs;
		this.#exited = proc.exited.then(code => {
			this.#alive = false;
			const signal = proc.signalCode;
			this.#exitDescription = `cua-driver ${this.#version} (pid ${this.pid}) exited (${signal ? `signal ${signal}` : `code ${code}`})`;
			const tail = this.#stderrTail.trim();
			const failure = new CuaDriverExitedError(tail ? `${this.#exitDescription}: ${tail}` : this.#exitDescription);
			for (const pending of this.#pending.values()) {
				clearTimeout(pending.cancelDeadline);
				pending.reject(failure);
			}
			this.#pending.clear();
		});
	}

	/** `command` is the executable plus any leading arguments; `mcp --direct` is appended. */
	static async spawn(command: readonly string[], options: CuaDriverSpawnOptions = {}): Promise<CuaDriverChild> {
		const proc = Bun.spawn([...command, "mcp", "--direct"], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...options.env },
		});
		const child = new CuaDriverChild(proc, options.cancelGraceMs ?? CANCEL_GRACE_MS);
		const handshake = (): AbortSignal => AbortSignal.timeout(options.handshakeTimeoutMs ?? INITIALIZE_TIMEOUT_MS);
		void child.#readStdout();
		void child.#readStderr();
		try {
			const initialized = await child.#request(
				"initialize",
				{
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "oh-my-pi", version: "1" },
				},
				handshake(),
			);
			if (initialized.error) throw new ToolError(`cua-driver initialize failed: ${initialized.error.message}`);
			child.#notify("notifications/initialized");
			const listed = await child.#request("tools/list", {}, handshake());
			child.#supportsCancelTool = toolNames(listed.result).includes(CANCEL_OPERATION_TOOL);
			const config = await child.callTool("get_config", {}, handshake());
			const version: unknown = JSON.parse(config.structuredJson ?? "{}");
			if (version && typeof version === "object" && "version" in version && typeof version.version === "string")
				child.#version = version.version;
			return child;
		} catch (error) {
			await child.kill({ force: true });
			if (error instanceof ToolError) throw error;
			throw new ToolError(
				`cua-driver did not complete its MCP handshake: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	get version(): string {
		return this.#version;
	}

	get alive(): boolean {
		return this.#alive;
	}

	get supportsCancelTool(): boolean {
		return this.#supportsCancelTool;
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CuaToolResult> {
		const reply = await this.#request("tools/call", { name, arguments: args }, signal);
		if (reply.error) throw new ToolError(`cua-driver ${name}: ${reply.error.message ?? "request failed"}`);
		const payload = McpToolResult(reply.result ?? {});
		if (payload instanceof type.errors)
			throw new ToolError(`cua-driver ${name}: malformed reply (${payload.summary})`);
		const structured =
			payload.structuredContent &&
			typeof payload.structuredContent === "object" &&
			!Array.isArray(payload.structuredContent)
				? (payload.structuredContent as Record<string, unknown>)
				: undefined;
		const code = typeof structured?.code === "string" ? structured.code : undefined;
		if (code === "cancelled") {
			const partial = structured?.partial;
			throw new ToolAbortError(
				`Computer action ${name} cancelled${partial === undefined ? "" : `; partial: ${JSON.stringify(partial)}`}`,
				{ cause: signal?.reason },
			);
		}
		const text: string[] = [];
		const images: CuaToolResult["images"] = [];
		for (const part of payload.content ?? []) {
			if (part.type === "text") text.push(part.text ?? "");
			else if (part.type === "image" && part.data !== undefined)
				images.push({ dataBase64: part.data, mimeType: part.mimeType ?? "image/png" });
		}
		return {
			text: text.join("\n"),
			images,
			structuredJson: structured ? JSON.stringify(structured) : undefined,
			isError: payload.isError === true,
			errorCode: code,
		};
	}

	async kill(options: { force?: boolean } = {}): Promise<void> {
		if (!this.#alive) return this.#exited;
		if (options.force) {
			this.#proc.kill("SIGKILL");
			return this.#exited;
		}
		try {
			this.#proc.stdin.end();
		} catch {
			// Already closed by an earlier failure; the exit wait below is authoritative.
		}
		const exit = setTimeout(() => {
			if (this.#alive) {
				logger.warn("cua-driver did not exit after stdin EOF; killing", { pid: this.pid });
				this.#proc.kill("SIGKILL");
			}
		}, EXIT_TIMEOUT_MS);
		try {
			await this.#exited;
		} finally {
			clearTimeout(exit);
		}
	}

	#write(message: unknown): void {
		this.#proc.stdin.write(`${JSON.stringify(message)}\n`);
		this.#proc.stdin.flush();
	}

	#notify(method: string, params?: unknown): void {
		if (!this.#alive) return;
		try {
			this.#write({ jsonrpc: "2.0", method, params });
		} catch (error) {
			logger.debug("cua-driver notify failed", {
				method,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #request(method: string, params: unknown, signal?: AbortSignal): Promise<RpcReply> {
		throwIfAborted(signal);
		if (!this.#alive) throw new CuaDriverExitedError(this.#exitDescription);
		const id = ++this.#nextId;
		const { promise, resolve, reject } = Promise.withResolvers<RpcReply>();
		const pending: PendingRequest = { resolve, reject };
		this.#pending.set(id, pending);
		try {
			this.#write({ jsonrpc: "2.0", id, method, params });
		} catch (error) {
			this.#pending.delete(id);
			throw new CuaDriverExitedError(
				`cua-driver request could not be written: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const onAbort = (): void => this.#cancel(id, pending, signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await promise;
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.#pending.delete(id);
		}
	}

	#cancel(id: number, pending: PendingRequest, reason: unknown): void {
		if (!this.#pending.has(id) || !this.#alive) return;
		const text = reason instanceof Error ? reason.message : undefined;
		this.#notify("notifications/cancelled", { requestId: id, ...(text ? { reason: text } : {}) });
		if (this.#supportsCancelTool) {
			const cancelId = ++this.#nextId;
			const cancel = Promise.withResolvers<RpcReply>();
			this.#pending.set(cancelId, { resolve: cancel.resolve, reject: cancel.reject });
			cancel.promise.catch(() => undefined).finally(() => this.#pending.delete(cancelId));
			try {
				this.#write({
					jsonrpc: "2.0",
					id: cancelId,
					method: "tools/call",
					params: { name: CANCEL_OPERATION_TOOL, arguments: { request_id: id } },
				});
			} catch {
				this.#pending.delete(cancelId);
			}
		}
		pending.cancelDeadline = setTimeout(() => {
			if (!this.#pending.has(id) || !this.#alive) return;
			logger.warn("cua-driver ignored cancellation; killing the unresponsive child", {
				pid: this.pid,
				requestId: id,
				graceMs: CANCEL_GRACE_MS,
			});
			void this.kill({ force: true });
		}, this.#cancelGraceMs);
	}

	async #readStdout(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of this.#proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				newline = buffer.indexOf("\n");
				if (line.trim()) this.#dispatch(line);
			}
		}
	}

	#dispatch(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			logger.debug("cua-driver emitted a non-JSON line", { line: line.slice(0, 200) });
			return;
		}
		const envelope = RpcEnvelope(message);
		if (envelope instanceof type.errors || typeof envelope.id !== "number") return;
		const pending = this.#pending.get(envelope.id);
		if (!pending) return;
		clearTimeout(pending.cancelDeadline);
		this.#pending.delete(envelope.id);
		pending.resolve({ result: envelope.result, error: envelope.error });
	}

	async #readStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#proc.stderr) {
			this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
		}
	}
}
