/**
 * The DevTools route for Chromium and Electron windows on Wayland.
 *
 * Wayland gives an agent no background keyboard, wheel, drag or hover for another client's window, and
 * Chromium-based apps do not join AT-SPI while the desktop's accessibility switch is off. Their pages do
 * answer the Chrome DevTools Protocol inside the renderer, without the user's physical pointer or keyboard.
 * Browser presses can still request compositor activation; those requests are guarded or refused below.
 *
 * Reach is the hard part, not the input. An endpoint exists only when the app was started with
 * `--remote-debugging-port`, and a running instance cannot be given one: `apps.open` adds the flag when it
 * launches a Chromium-family browser or an Electron app ({@link launchKind}), finds the port the process
 * listens on ({@link findNewEndpoint}), and only those endpoints (or, under the `running` setting, ones the
 * user opened themselves) are driven.
 *
 * Identity: CDP lists pages, not windows. `Browser.getWindowForTarget` groups pages into browser windows; the
 * one page of a window that reports `visibilityState === "visible"` is its front tab. A window whose front tab
 * cannot be told apart has no route. Such a window is matched to a desktop-listed window of the same process
 * by title, else listed on its own as `devtools:<pid>:<windowId>`.
 *
 * Coordinates: a routed window's frame is its page viewport. Its screenshot is `Page.captureScreenshot` of the
 * front tab, and pointer positions on that image map to viewport CSS pixels by the ratio of the image to the
 * viewport's CSS size (`innerWidth`×`innerHeight`), which already folds in the device scale factor, fractional
 * scaling and page zoom. The
 * browser's own tabs and toolbar are outside that frame.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { DesktopWindow, DesktopWindowOpened } from "@oh-my-pi/pi-natives";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { isChromiumBrowserExecutable, probeCdpResponse } from "../browser/attach";

/** `computer.devtools`: which Chromium and Electron windows the DevTools route may drive. */
export type DevToolsMode = "launched" | "running" | "off";

export interface DevToolsFocusGuardHandle {
	readonly kind: string;
	readonly compositor: string | null | undefined;
	finish(): Promise<DesktopWindowOpened[]>;
}

/** Native protection and outcome reporting for a complete DevTools press sequence. */
export interface DevToolsFocusGuards {
	/** Monotonic milliseconds; guard age includes asynchronous acquisition. */
	now(): number;
	beginFocusGuard(pid: number): Promise<DevToolsFocusGuardHandle>;
	report(opened: DesktopWindowOpened[]): void;
}

/** The sole switch lifting activation refusal; socket watchers cannot prevent stolen keys. */
export function canGuardDevToolsPress(
	onHyprland: boolean,
	kind: string,
	compositor: string | null | undefined,
): boolean {
	return onHyprland && kind === "compositorHook" && compositor === "hyprland";
}

interface PressQueue {
	tail: Promise<void>;
}

/** Call-scoped state: unrelated hover and scroll calls never borrow a press sequence's guard. */
interface PressGuard {
	readonly guarded: boolean;
	beforeInput(activation: boolean): Promise<void>;
	inputSent(): void;
}

/** The launch flag `apps.open` adds: an ephemeral loopback port, published in the process's listening sockets. */
export const DEVTOOLS_LAUNCH_ARGS = ["--remote-debugging-port=0"];

const CALL_TIMEOUT_MS = 10_000;
const PORT_WAIT_MS = 15_000;
const PORT_POLL_MS = 150;
/** CSS pixels one wheel step of `scroll`'s `dx`/`dy` moves: Chromium's own per-notch distance on Windows and in DevTools. */
export const WHEEL_STEP_PX = 100;
/** A drag interpolates its segments in steps of about this many CSS pixels, so pages see a moving pointer. */
const DRAG_STEP_PX = 12;
/** Renew before the native hook's fixed 15 s lifetime can expire. */
const FOCUS_GUARD_RENEW_MS = 13_000;
/**
 * How long a mouse event may wait for its answer before the route draws a frame for it. Chromium holds pointer moves
 * (and moves with a button down) until the page's next frame, and a covered or hidden Wayland window gets no frame
 * callbacks, so each would wait out Chromium's 5 s input timeout; a 1×1 capture draws that frame.
 */
const FRAME_WAIT_MS = 40;
const CHROMIUM_FILES = ["resources.pak", "chrome_100_percent.pak", "v8_context_snapshot.bin"];

export type LaunchKind = "chromium" | "electron";

/** The first word of a desktop entry's `Exec`, skipping an `env VAR=value` prefix. */
function execProgram(entry: string): string | undefined {
	let inMain = false;
	for (const line of entry.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("[")) {
			inMain = trimmed === "[Desktop Entry]";
			continue;
		}
		if (!inMain || !trimmed.startsWith("Exec=")) continue;
		const words = trimmed.slice(5).match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? [];
		let index = 0;
		if (words[index] === "env") {
			index++;
			while (words[index]?.includes("=")) index++;
		}
		const word = words[index];
		return word?.startsWith('"') ? word.slice(1, -1) : word;
	}
	return undefined;
}

async function isChromiumRuntimeDir(directory: string): Promise<boolean> {
	for (const file of CHROMIUM_FILES) {
		if (await Bun.file(path.join(directory, file)).exists()) return true;
	}
	return false;
}

/** What a resolved executable runs: Chromium, Electron, or neither (a script is followed one level). */
async function executableKind(executable: string, depth = 0): Promise<LaunchKind | undefined> {
	const base = path.basename(executable);
	if (isChromiumBrowserExecutable(base)) return "chromium";
	if (/^electron\d*$/i.test(base)) return "electron";
	const real = await fs.realpath(executable).catch(() => executable);
	if (isChromiumBrowserExecutable(path.basename(real))) return "chromium";
	if (await isChromiumRuntimeDir(path.dirname(real))) return "electron";
	if (depth > 0) return undefined;
	const stat = await fs.stat(real).catch(() => null);
	if (!stat?.isFile() || stat.size > 65_536) return undefined;
	const text = await Bun.file(real)
		.text()
		.catch(() => "");
	if (!text.startsWith("#!")) return undefined;
	// A launcher script: Arch's `electronNN` wrappers, VS Code's `bin/code`, distro chromium scripts.
	if (/\belectron\d*\b/.test(text)) return "electron";
	for (const match of text.matchAll(/(?:^|\s)(\/[\w./+-]+)/g)) {
		const kind = await executableKind(match[1]!, depth + 1);
		if (kind) return kind;
	}
	return undefined;
}

/**
 * Whether the desktop entry at `desktopPath` launches a Chromium-family browser or an Electron app, so its
 * launch can take {@link DEVTOOLS_LAUNCH_ARGS}. Anything else is left alone: a GTK or Qt app may exit on an
 * unknown switch. Flatpak and Snap entries launch a sandbox runner and are not recognised.
 */
export async function launchKind(desktopPath: string): Promise<LaunchKind | undefined> {
	const entry = await Bun.file(desktopPath)
		.text()
		.catch(() => "");
	const program = execProgram(entry);
	if (!program) return undefined;
	const executable = program.includes("/") ? program : Bun.which(program);
	return executable ? executableKind(executable) : undefined;
}

interface ListeningSocket {
	port: number;
	inode: string;
}

/** Loopback TCP listeners of this user's view of the network namespace. */
async function loopbackListeners(): Promise<ListeningSocket[]> {
	const sockets: ListeningSocket[] = [];
	for (const [file, loopback] of [
		["/proc/net/tcp", "0100007F"],
		["/proc/net/tcp6", "00000000000000000000000001000000"],
	] as const) {
		const text = await Bun.file(file)
			.text()
			.catch(() => "");
		for (const line of text.split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 10 || fields[3] !== "0A") continue;
			const [address, port] = fields[1]!.split(":");
			if (address !== loopback) continue;
			sockets.push({ port: Number.parseInt(port!, 16), inode: fields[9]! });
		}
	}
	return sockets;
}

/** The pid holding socket `inode`, among this user's processes; `pids` narrows the scan when known. */
async function socketOwner(inode: string, pids?: number[]): Promise<number | undefined> {
	const target = `socket:[${inode}]`;
	const candidates =
		pids ?? (await fs.readdir("/proc").catch(() => [] as string[])).filter(name => /^\d+$/.test(name)).map(Number);
	for (const pid of candidates) {
		const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
		for (const fd of fds) {
			if ((await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "")) === target) return pid;
		}
	}
	return undefined;
}

interface VersionInfo {
	browser: string;
	webSocketDebuggerUrl: string;
}

async function devToolsVersion(port: number, signal?: AbortSignal): Promise<VersionInfo | undefined> {
	const response = await probeCdpResponse(`http://127.0.0.1:${port}/json/version`, { timeoutMs: 1500, signal });
	if (response?.status !== 200) return undefined;
	try {
		const body = JSON.parse(response.body) as Record<string, unknown>;
		if (typeof body.webSocketDebuggerUrl !== "string") return undefined;
		const agent = typeof body["User-Agent"] === "string" ? body["User-Agent"] : "";
		const electron = /Electron\/[\d.]+/.exec(agent)?.[0];
		return {
			browser: electron ?? (typeof body.Browser === "string" ? body.Browser : "Chromium"),
			webSocketDebuggerUrl: body.webSocketDebuggerUrl,
		};
	} catch {
		return undefined;
	}
}

/** The loopback ports listening right now, so a launch can tell its own new port apart. */
export async function listeningPorts(): Promise<Set<number>> {
	return new Set((await loopbackListeners()).map(socket => socket.port));
}

export interface FoundEndpoint {
	port: number;
	pid: number;
	browser: string;
	webSocketDebuggerUrl: string;
}

/**
 * The DevTools endpoint a just-launched app opened: a loopback port absent from `before` that answers
 * `/json/version`, with the pid that holds it. Undefined when none appears within the wait (Chrome ignores the
 * flag on its default profile, or a running instance took the launch over).
 */
export async function findNewEndpoint(before: Set<number>, signal?: AbortSignal): Promise<FoundEndpoint | undefined> {
	const deadline = performance.now() + PORT_WAIT_MS;
	const probed = new Set<number>();
	while (performance.now() < deadline) {
		signal?.throwIfAborted();
		for (const socket of await loopbackListeners()) {
			if (before.has(socket.port) || probed.has(socket.port)) continue;
			const version = await devToolsVersion(socket.port, signal);
			if (!version) {
				probed.add(socket.port);
				continue;
			}
			const pid = await socketOwner(socket.inode);
			if (pid !== undefined) return { port: socket.port, pid, ...version };
		}
		await Bun.sleep(PORT_POLL_MS);
	}
	return undefined;
}

/** The DevTools endpoint process `pid` listens on itself, if it was started with one. */
export async function endpointOfProcess(pid: number, signal?: AbortSignal): Promise<FoundEndpoint | undefined> {
	const inodes = new Set<string>();
	for (const fd of await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
		const link = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
		const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
		if (inode) inodes.add(inode);
	}
	for (const socket of await loopbackListeners()) {
		if (!inodes.has(socket.inode)) continue;
		const version = await devToolsVersion(socket.port, signal);
		if (version) return { port: socket.port, pid, ...version };
	}
	return undefined;
}

/** Endpoints of running Chromium and Electron processes of this user: the `running` setting's discovery. */
async function runningEndpoints(signal?: AbortSignal): Promise<FoundEndpoint[]> {
	const found: FoundEndpoint[] = [];
	const listeners = await loopbackListeners();
	if (listeners.length === 0) return found;
	const owners = new Map<string, number>();
	const pids = (await fs.readdir("/proc").catch(() => [] as string[])).filter(name => /^\d+$/.test(name));
	const wanted = new Set(listeners.map(socket => socket.inode));
	for (const pid of pids) {
		for (const fd of await fs.readdir(`/proc/${pid}/fd`).catch(() => [] as string[])) {
			const inode = /^socket:\[(\d+)\]$/.exec(await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => ""))?.[1];
			if (inode && wanted.has(inode)) owners.set(inode, Number(pid));
		}
	}
	for (const socket of listeners) {
		const pid = owners.get(socket.inode);
		if (pid === undefined) continue;
		const exe = await fs.readlink(`/proc/${pid}/exe`).catch(() => "");
		if (!exe || !(await executableKind(exe))) continue;
		const version = await devToolsVersion(socket.port, signal);
		if (version) found.push({ port: socket.port, pid, ...version });
	}
	return found;
}

type CdpParams = Record<string, unknown>;
/** A CDP event's parameters: the protocol's JSON object, read by the one listener that knows the event. */
type CdpEventParams = Record<string, unknown>;
type CdpListener = (method: string, params: CdpEventParams, sessionId?: string) => void;
interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** One browser-level CDP WebSocket with flat page sessions. */
class CdpConnection {
	readonly #socket: WebSocket;
	readonly #pending = new Map<number, Pending>();
	readonly #listeners = new Set<CdpListener>();
	#next = 1;
	closed = false;

	private constructor(socket: WebSocket) {
		this.#socket = socket;
		socket.addEventListener("message", event => this.#receive(String(event.data)));
		socket.addEventListener("close", () => this.#fail(new Error("the DevTools connection closed")));
		socket.addEventListener("error", () => this.#fail(new Error("the DevTools connection failed")));
	}

	static open(url: string): Promise<CdpConnection> {
		const { promise, resolve, reject } = Promise.withResolvers<CdpConnection>();
		const socket = new WebSocket(url);
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error(`timed out connecting to ${url}`));
		}, CALL_TIMEOUT_MS);
		socket.addEventListener("open", () => {
			clearTimeout(timer);
			resolve(new CdpConnection(socket));
		});
		socket.addEventListener("error", () => {
			clearTimeout(timer);
			reject(new Error(`cannot connect to ${url}`));
		});
		return promise;
	}

	/** `T` is the protocol's documented result shape for `method`; CDP answers are trusted like the browser itself. */
	send<T = unknown>(method: string, params: CdpParams = {}, sessionId?: string): Promise<T> {
		if (this.closed) return Promise.reject(new Error("the DevTools connection is closed"));
		const id = this.#next++;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			reject(new Error(`${method} got no answer within ${CALL_TIMEOUT_MS} ms`));
		}, CALL_TIMEOUT_MS);
		this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer });
		this.#socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
		return promise;
	}

	on(listener: CdpListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		this.closed = true;
		this.#socket.close();
	}

	#receive(data: string): void {
		const message = JSON.parse(data) as {
			id?: number;
			result?: unknown;
			error?: { message: string };
			method?: string;
			params?: CdpEventParams;
			sessionId?: string;
		};
		if (message.id !== undefined) {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) pending.reject(new Error(message.error.message));
			else pending.resolve(message.result);
			return;
		}
		if (!message.method) return;
		for (const listener of this.#listeners) listener(message.method, message.params ?? {}, message.sessionId);
	}

	#fail(error: Error): void {
		this.closed = true;
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

interface PageInfo {
	targetId: string;
	title: string;
	url: string;
}

/** A browser window as CDP sees it: its pages, and the front one when it can be told. */
export interface DevToolsWindow {
	endpoint: Endpoint;
	windowId: number;
	pages: PageInfo[];
	/** The page in front: the window's only page, or the one tab reporting itself visible. */
	front?: PageInfo;
	bounds: { left: number; top: number; width: number; height: number };
}

/** A pointer frame: the front tab a routed window's last full screenshot pictured, and its scale. */
interface Frame {
	targetId: string;
	/** Image pixels per viewport CSS pixel. */
	scaleX: number;
	scaleY: number;
	cssWidth: number;
	cssHeight: number;
}

export class Endpoint {
	readonly port: number;
	readonly pid: number;
	readonly app: string;
	readonly browser: string;
	readonly launched: boolean;
	/** An Electron app rather than a Chromium browser: its presses ask for no window activation. */
	readonly electron: boolean;
	readonly #url: string;
	#connection?: Promise<CdpConnection>;
	readonly #sessions = new Map<string, Promise<string>>();
	/** Electron's stand-in window ids, one per page, stable while the page lives. */
	readonly #pageWindows = new Map<string, number>();

	constructor(found: FoundEndpoint, app: string, launched: boolean) {
		this.port = found.port;
		this.pid = found.pid;
		this.browser = found.browser;
		this.app = app;
		this.launched = launched;
		this.electron = found.browser.startsWith("Electron/");
		this.#url = found.webSocketDebuggerUrl;
	}

	async connection(): Promise<CdpConnection> {
		const current = this.#connection && (await this.#connection.catch(() => undefined));
		if (current && !current.closed) return current;
		this.#sessions.clear();
		this.#connection = CdpConnection.open(this.#url).then(connection => {
			connection.on((method, params) => {
				if (method === "Target.detachedFromTarget") {
					for (const [targetId, session] of this.#sessions) {
						void session.then(id => id === params.sessionId && this.#sessions.delete(targetId)).catch(() => {});
					}
				}
			});
			return connection;
		});
		return this.#connection;
	}

	/**
	 * A flat session on page `targetId`. No focus emulation: a background page takes inserted text and keys
	 * without it, and `Emulation.setFocusEmulationEnabled` would make every tab it touches report itself
	 * visible, which is how the front tab of a window is told apart.
	 */
	session(targetId: string): Promise<string> {
		let session = this.#sessions.get(targetId);
		if (!session) {
			session = (async () => {
				const connection = await this.connection();
				const { sessionId } = await connection.send<{ sessionId: string }>("Target.attachToTarget", {
					targetId,
					flatten: true,
				});
				return sessionId;
			})();
			session.catch(() => this.#sessions.delete(targetId));
			this.#sessions.set(targetId, session);
		}
		return session;
	}

	async send<T = unknown>(targetId: string, method: string, params: CdpParams = {}): Promise<T> {
		const connection = await this.connection();
		return connection.send<T>(method, params, await this.session(targetId));
	}

	/** The process's browser windows, each with its pages and front tab. */
	async windows(): Promise<DevToolsWindow[]> {
		const connection = await this.connection();
		const { targetInfos } = await connection.send<{ targetInfos: Array<PageInfo & { type: string }> }>(
			"Target.getTargets",
		);
		const byWindow = new Map<number, DevToolsWindow>();
		for (const info of targetInfos) {
			if (info.type !== "page" || info.url.startsWith("devtools://")) continue;
			let located = await connection
				.send<{ windowId: number; bounds: Record<string, number> }>("Browser.getWindowForTarget", {
					targetId: info.targetId,
				})
				.catch(() => undefined);
			if (!located && this.electron) {
				// `Browser.getWindowForTarget` lives in Chrome's browser layer, which Electron does not ship: there a
				// page is taken as its own BrowserWindow (a window holding several WebContentsViews lists them apart).
				let windowId = this.#pageWindows.get(info.targetId);
				if (windowId === undefined) {
					windowId = this.#pageWindows.size + 1;
					this.#pageWindows.set(info.targetId, windowId);
				}
				const size = await this.send<{ result: { value?: unknown } }>(info.targetId, "Runtime.evaluate", {
					expression: "[outerWidth, outerHeight]",
					returnByValue: true,
				}).catch(() => undefined);
				const [width = 0, height = 0] = Array.isArray(size?.result.value) ? (size.result.value as number[]) : [];
				located = { windowId, bounds: { width, height } };
			}
			if (!located) continue;
			let window = byWindow.get(located.windowId);
			if (!window) {
				const { left = 0, top = 0, width = 0, height = 0 } = located.bounds;
				window = { endpoint: this, windowId: located.windowId, pages: [], bounds: { left, top, width, height } };
				byWindow.set(located.windowId, window);
			}
			window.pages.push({ targetId: info.targetId, title: info.title, url: info.url });
		}
		for (const window of byWindow.values()) {
			if (window.pages.length === 1) {
				window.front = window.pages[0];
				continue;
			}
			const visible: PageInfo[] = [];
			for (const page of window.pages) {
				const state = await this.send<{ result: { value?: unknown } }>(page.targetId, "Runtime.evaluate", {
					expression: "document.visibilityState",
					returnByValue: true,
				}).catch(() => undefined);
				if (state?.result.value === "visible") visible.push(page);
			}
			if (visible.length === 1) window.front = visible[0];
		}
		return [...byWindow.values()];
	}

	close(): void {
		void this.#connection?.then(connection => connection.close()).catch(() => {});
	}
}

const MODIFIER_BITS: Record<string, number> = {
	alt: 1,
	option: 1,
	opt: 1,
	ctrl: 2,
	control: 2,
	cmd: 4,
	command: 4,
	meta: 4,
	super: 4,
	win: 4,
	shift: 8,
};

interface KeyDefinition {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
	enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", keyCode: 9 },
	escape: { key: "Escape", code: "Escape", keyCode: 27 },
	esc: { key: "Escape", code: "Escape", keyCode: 27 },
	backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	delete: { key: "Delete", code: "Delete", keyCode: 46 },
	del: { key: "Delete", code: "Delete", keyCode: 46 },
	space: { key: " ", code: "Space", keyCode: 32, text: " " },
	up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	home: { key: "Home", code: "Home", keyCode: 36 },
	end: { key: "End", code: "End", keyCode: 35 },
	pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
	pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

function keyDefinition(name: string, shift: boolean): KeyDefinition {
	const lower = name.toLowerCase();
	const named = NAMED_KEYS[lower];
	if (named) return named;
	const fkey = /^f([1-9]|1[0-2])$/.exec(lower);
	if (fkey) return { key: `F${fkey[1]}`, code: `F${fkey[1]}`, keyCode: 111 + Number(fkey[1]) };
	if (/^[a-z]$/.test(lower)) {
		const key = shift ? lower.toUpperCase() : lower;
		return { key, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0), text: key };
	}
	if (/^[0-9]$/.test(lower)) return { key: lower, code: `Digit${lower}`, keyCode: lower.charCodeAt(0), text: lower };
	if ([...name].length === 1) return { key: name, code: "", keyCode: 0, text: name };
	throw new ToolError(`press: no key named ${JSON.stringify(name)} on the DevTools route`);
}

const BUTTON_BITS: Record<string, number> = { left: 1, right: 2, middle: 4 };

export function modifierBits(names: readonly string[] | undefined): number {
	let bits = 0;
	for (const name of names ?? []) {
		const bit = MODIFIER_BITS[name.toLowerCase()];
		if (bit === undefined) throw new ToolError(`no modifier named ${JSON.stringify(name)}`);
		bits |= bit;
	}
	return bits;
}

function pngSize(data: Uint8Array): { width: number; height: number } {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface PageCapture {
	data: Uint8Array;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
	cssWidth: number;
	cssHeight: number;
}

/**
 * Input and capture for one routed window. Every call re-reads the window's front tab: a pointer position read
 * off a screenshot of another tab names nothing on this one.
 */
export class DevToolsRoute {
	readonly window: DevToolsWindow;
	readonly #endpoint: Endpoint;
	readonly #frames: Map<string, Frame>;
	readonly #id: string;
	/** Why a press would take the user's keyboard here (see {@link activationGrant}); unset where it would not. */
	readonly #pressTakesFocus: string | undefined;
	readonly #presses: PressQueue;

	constructor(
		id: string,
		window: DevToolsWindow,
		frames: Map<string, Frame>,
		pressTakesFocus: string | undefined,
		presses: PressQueue = { tail: Promise.resolve() },
	) {
		this.#id = id;
		this.window = window;
		this.#endpoint = window.endpoint;
		this.#frames = frames;
		this.#pressTakesFocus = window.endpoint.electron ? undefined : pressTakesFocus;
		this.#presses = presses;
	}

	#refusePress(what: string, inputSent = false): never {
		throw new ToolError(
			`BackgroundUnavailable: ${what} in window ${this.#id}: every mouse or touch press makes the Chromium browser ask the desktop to activate its window, and ${this.#pressTakesFocus}, which would take the user's keyboard; ${inputSent ? "the next press was not sent (earlier input was sent)" : "nothing was sent"}. In the background this window takes move (hover), scroll, type, press and screenshots, and a plain click on a text field focuses it`,
		);
	}

	async #guardPress<T>(
		guards: DevToolsFocusGuards | undefined,
		send: (guard: PressGuard | undefined) => Promise<T>,
	): Promise<T> {
		const onHyprland = !!process.env.HYPRLAND_INSTANCE_SIGNATURE;
		if (!onHyprland || !guards) return send(undefined);
		const previous = this.#presses.tail;
		const { promise, resolve: release } = Promise.withResolvers<void>();
		this.#presses.tail = promise;
		await previous;
		let watch: DevToolsFocusGuardHandle | undefined;
		let started = 0;
		let inputSent = false;
		const finish = async () => {
			const current = watch;
			watch = undefined;
			if (current) guards.report(await current.finish());
		};
		const arm = async () => {
			// Native guards have external ownership: settle and report before acquiring the next one.
			await finish();
			started = guards.now();
			watch = await guards.beginFocusGuard(this.#endpoint.pid);
			if (
				canGuardDevToolsPress(onHyprland, watch.kind, watch.compositor) &&
				guards.now() - started >= FOCUS_GUARD_RENEW_MS
			) {
				throw new ToolError(
					`BackgroundUnavailable: focus protection for window ${this.#id} took too long to arm; ${inputSent ? "the next input event was not sent (earlier input was sent)" : "nothing was sent"}`,
				);
			}
		};
		const guard: PressGuard = {
			get guarded() {
				return !!watch && canGuardDevToolsPress(onHyprland, watch.kind, watch.compositor);
			},
			beforeInput: async activation => {
				if (activation || guards.now() - started >= FOCUS_GUARD_RENEW_MS) await arm();
				if (activation && this.#pressTakesFocus !== undefined && !guard.guarded) {
					this.#refusePress("the next press", inputSent);
				}
			},
			inputSent: () => {
				inputSent = true;
			},
		};
		try {
			// Preserve the browser's no-input refusal and editable-focus fallback before any pointer event.
			await arm();
			return await send(guard);
		} finally {
			try {
				await finish();
			} finally {
				release();
			}
		}
	}

	#front(): PageInfo {
		const front = this.window.front;
		if (front) return front;
		const tabs = this.window.pages.map(page => `- ${JSON.stringify(page.title)} ${page.url}`).join("\n");
		throw new ToolError(
			`window ${this.#id} has ${this.window.pages.length} tabs and none reports itself as the one in front, so the DevTools route cannot tell which page the window shows; nothing was sent. Its tabs:\n${tabs}`,
		);
	}

	/**
	 * The viewport as the capture pictures it: its document offset and its CSS size scroll bars included
	 * (`innerWidth`/`innerHeight`; `cssVisualViewport` leaves the bars out, which would skew every position by
	 * their width).
	 */
	async #viewport(targetId: string): Promise<{ pageX: number; pageY: number; width: number; height: number }> {
		const read = await this.#endpoint.send<{ result: { value?: unknown } }>(targetId, "Runtime.evaluate", {
			expression: "[visualViewport.pageLeft, visualViewport.pageTop, innerWidth, innerHeight]",
			returnByValue: true,
		});
		const value = read.result.value;
		if (!Array.isArray(value) || value.length !== 4 || !value.every(item => typeof item === "number")) {
			throw new ToolError(`window ${this.#id}: its page did not report its viewport; nothing was captured`);
		}
		const [pageX, pageY, width, height] = value as number[];
		return { pageX: pageX!, pageY: pageY!, width: width!, height: height! };
	}

	/** A PNG of `clip` (document CSS pixels) at `scale` image pixels per CSS pixel, or of the viewport as rendered. */
	async #shot(targetId: string, clip?: CdpParams): Promise<Buffer> {
		const shot = await this.#endpoint.send<{ data: string }>(targetId, "Page.captureScreenshot", {
			format: "png",
			fromSurface: true,
			...(clip ? { clip } : {}),
		});
		return Buffer.from(shot.data, "base64");
	}

	async capture(caps: { maxWidth: number; maxHeight: number }): Promise<PageCapture> {
		const front = this.#front();
		const viewport = await this.#viewport(front.targetId);
		let data = await this.#shot(front.targetId);
		const source = pngSize(data);
		const scale = Math.min(1, caps.maxWidth / source.width, caps.maxHeight / source.height);
		let size = source;
		if (scale < 1) {
			data = await this.#shot(front.targetId, {
				x: viewport.pageX,
				y: viewport.pageY,
				width: viewport.width,
				height: viewport.height,
				scale: (scale * source.width) / viewport.width,
			});
			size = pngSize(data);
		}
		this.#frames.set(this.#id, {
			targetId: front.targetId,
			scaleX: size.width / viewport.width,
			scaleY: size.height / viewport.height,
			cssWidth: viewport.width,
			cssHeight: viewport.height,
		});
		return {
			data,
			width: size.width,
			height: size.height,
			sourceWidth: source.width,
			sourceHeight: source.height,
			cssWidth: viewport.width,
			cssHeight: viewport.height,
		};
	}

	/** `region` of the last full screenshot, at up to twice its pixels, within `caps`. */
	async captureRegion(
		region: { x: number; y: number; width: number; height: number },
		caps: { maxWidth: number; maxHeight: number },
	): Promise<PageCapture> {
		const frame = this.#frames.get(this.#id);
		const front = this.#front();
		if (!frame || frame.targetId !== front.targetId) {
			throw new ToolError(
				`InvalidCoordinateFrame: zoom takes a region of the last full screenshot of ${this.#id}, and there is none of the tab it shows; take a screenshot first`,
			);
		}
		const viewport = await this.#viewport(front.targetId);
		const width = region.width / frame.scaleX;
		const height = region.height / frame.scaleY;
		const scale = Math.min(2 * frame.scaleX, caps.maxWidth / width, caps.maxHeight / height);
		const data = await this.#shot(front.targetId, {
			x: viewport.pageX + region.x / frame.scaleX,
			y: viewport.pageY + region.y / frame.scaleY,
			width,
			height,
			scale,
		});
		const size = pngSize(data);
		return {
			data,
			width: size.width,
			height: size.height,
			sourceWidth: size.width,
			sourceHeight: size.height,
			cssWidth: frame.cssWidth,
			cssHeight: frame.cssHeight,
		};
	}

	/** Viewport CSS pixels of `x, y` on the last full screenshot of this window. */
	#css(x: number, y: number): { x: number; y: number } {
		const frame = this.#frames.get(this.#id);
		if (!frame) {
			throw new ToolError(
				`InvalidCoordinateFrame: no screenshot of ${this.#id} yet; take one first: pointer input is in pixels of that screenshot`,
			);
		}
		if (frame.targetId !== this.#front().targetId) {
			throw new ToolError(
				`InvalidCoordinateFrame: window ${this.#id} shows another tab than its last screenshot; take a new screenshot; nothing was sent`,
			);
		}
		const css = { x: x / frame.scaleX, y: y / frame.scaleY };
		if (css.x < 0 || css.y < 0 || css.x >= frame.cssWidth || css.y >= frame.cssHeight) {
			throw new ToolError(
				`InvalidCoordinateFrame: (${x}, ${y}) is outside the page in the last screenshot of ${this.#id}; nothing was sent`,
			);
		}
		return css;
	}

	async #mouse(
		type: string,
		point: { x: number; y: number },
		extra: CdpParams = {},
		guard?: PressGuard,
	): Promise<void> {
		const targetId = this.#front().targetId;
		await guard?.beforeInput(type === "mousePressed");
		guard?.inputSent();
		const sent = this.#endpoint.send(targetId, "Input.dispatchMouseEvent", {
			type,
			x: point.x,
			y: point.y,
			...extra,
		});
		const answered = await Promise.race([sent.then(() => true), Bun.sleep(FRAME_WAIT_MS).then(() => false)]);
		if (answered) return;
		await this.#endpoint.send(targetId, "Page.captureScreenshot", {
			format: "png",
			clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
		});
		await sent;
	}

	/**
	 * The CSS position the call acted at, for its output line; `focused` when the click focused a text field
	 * without a press, because a press would take the user's keyboard ({@link activationGrant}).
	 */
	async click(
		x: number,
		y: number,
		button = "left",
		count = 1,
		modifiers = 0,
		guards?: DevToolsFocusGuards,
	): Promise<{ x: number; y: number; focused?: true }> {
		const point = this.#css(x, y);
		const bit = BUTTON_BITS[button];
		if (bit === undefined) throw new ToolError(`no mouse button named ${JSON.stringify(button)}`);
		return this.#guardPress<{ x: number; y: number; focused?: true }>(guards, async guard => {
			if (this.#pressTakesFocus !== undefined && !guard?.guarded) {
				if (button !== "left" || count !== 1 || modifiers !== 0) this.#refusePress("this click");
				// What the click would do to a text field, minus the press: focus it (as `DOM.focus` would).
				const focused = await this.#endpoint.send<{ result: { value?: unknown } }>(
					this.#front().targetId,
					"Runtime.evaluate",
					{
						expression: `((x, y) => { let e = document.elementFromPoint(x, y); while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; } if (!e || !(e.isContentEditable || e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !['button','checkbox','radio','range','submit','reset','file','color','image','hidden'].includes(e.type)))) return false; e.focus(); return e.getRootNode().activeElement === e; })(${point.x}, ${point.y})`,
						returnByValue: true,
					},
				);
				if (focused.result.value !== true) this.#refusePress("a click here (not on a text field)");
				return { ...point, focused: true };
			}
			await this.#mouse("mouseMoved", point, { modifiers }, guard);
			for (let click = 1; click <= count; click++) {
				await this.#mouse("mousePressed", point, { button, buttons: bit, clickCount: click, modifiers }, guard);
				await this.#mouse("mouseReleased", point, { button, buttons: 0, clickCount: click, modifiers }, guard);
			}
			return point;
		});
	}

	async move(x: number, y: number, modifiers = 0): Promise<{ x: number; y: number }> {
		const point = this.#css(x, y);
		await this.#mouse("mouseMoved", point, { modifiers });
		return point;
	}

	async scroll(x: number, y: number, dx: number, dy: number, modifiers = 0): Promise<{ x: number; y: number }> {
		const point = this.#css(x, y);
		await this.#mouse("mouseWheel", point, {
			deltaX: dx * WHEEL_STEP_PX,
			deltaY: dy * WHEEL_STEP_PX,
			modifiers,
		});
		return point;
	}

	/**
	 * A left-button drag through `points`. A page that starts an HTML drag-and-drop gets it as DevTools drag
	 * events: Chromium would otherwise hand the drag to the compositor, which on Wayland has no pointer grab
	 * for synthetic input and would tie the drop to the user's real pointer.
	 */
	async drag(
		points: Array<[number, number]>,
		modifiers = 0,
		guards?: DevToolsFocusGuards,
	): Promise<"pointer" | "html"> {
		if (points.length < 2) throw new ToolError("drag needs at least two points");
		const path = points.map(([x, y]) => this.#css(x, y));
		return this.#guardPress<"pointer" | "html">(guards, async guard => {
			if (this.#pressTakesFocus !== undefined && !guard?.guarded) this.#refusePress("a drag");
			const targetId = this.#front().targetId;
			const connection = await this.#endpoint.connection();
			const sessionId = await this.#endpoint.session(targetId);
			let dragData: unknown;
			const off = connection.on((method, params, from) => {
				if (method === "Input.dragIntercepted" && from === sessionId) dragData = params.data;
			});
			const intercepting = await this.#endpoint
				.send(targetId, "Input.setInterceptDrags", { enabled: true })
				.then(() => true)
				.catch(() => false);
			try {
				await this.#mouse("mouseMoved", path[0]!, { modifiers }, guard);
				await this.#mouse(
					"mousePressed",
					path[0]!,
					{ button: "left", buttons: 1, clickCount: 1, modifiers },
					guard,
				);
				let at = path[0]!;
				for (const next of path.slice(1)) {
					const steps = Math.max(2, Math.ceil(Math.hypot(next.x - at.x, next.y - at.y) / DRAG_STEP_PX));
					for (let step = 1; step <= steps; step++) {
						const point = {
							x: at.x + ((next.x - at.x) * step) / steps,
							y: at.y + ((next.y - at.y) * step) / steps,
						};
						if (dragData !== undefined) {
							await this.#dragInput(
								targetId,
								{
									type: "dragOver",
									...point,
									data: dragData,
									modifiers,
								},
								guard,
							);
						} else {
							await this.#mouse("mouseMoved", point, { button: "left", buttons: 1, modifiers }, guard);
							if (intercepting) await Bun.sleep(0);
							if (dragData !== undefined) {
								await this.#dragInput(
									targetId,
									{
										type: "dragEnter",
										...point,
										data: dragData,
										modifiers,
									},
									guard,
								);
							}
						}
					}
					at = next;
				}
				if (dragData === undefined && intercepting) await Bun.sleep(30);
				if (dragData !== undefined) {
					await this.#dragInput(
						targetId,
						{
							type: "drop",
							...at,
							data: dragData,
							modifiers,
						},
						guard,
					);
				}
				await this.#mouse("mouseReleased", at, { button: "left", buttons: 0, clickCount: 1, modifiers }, guard);
				return dragData === undefined ? "pointer" : "html";
			} finally {
				off();
				if (intercepting)
					await this.#endpoint.send(targetId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
			}
		});
	}

	async #dragInput(targetId: string, params: CdpParams, guard?: PressGuard): Promise<void> {
		await guard?.beforeInput(false);
		guard?.inputSent();
		await this.#endpoint.send(targetId, "Input.dispatchDragEvent", params);
	}

	/**
	 * Inserts `text` at the page's focused field (newlines as Enter presses). A page whose focus is on no
	 * editable element refuses: the text would vanish while the call looked successful.
	 */
	async type(text: string): Promise<void> {
		const { targetId } = this.#front();
		const focus = await this.#endpoint.send<{ result: { value?: unknown } }>(targetId, "Runtime.evaluate", {
			expression:
				"(() => { const e = document.activeElement; if (!e || e === document.body) return 'none'; if (e.tagName === 'IFRAME') return 'frame'; return e.isContentEditable || (e.tagName === 'TEXTAREA') || (e.tagName === 'INPUT' && !['button','checkbox','radio','range','submit','reset','file','color','image'].includes(e.type)) ? 'editable' : e.tagName.toLowerCase(); })()",
			returnByValue: true,
		});
		const state = String(focus.result.value);
		if (state !== "editable" && state !== "frame") {
			throw new ToolError(
				`the page in window ${this.#id} has no text field focused (focus is on ${state === "none" ? "nothing" : `a ${state}`}); click the field first; nothing was typed`,
			);
		}
		const lines = text.split("\n");
		for (const [index, line] of lines.entries()) {
			if (index > 0) await this.press(["enter"]);
			if (line) await this.#endpoint.send(targetId, "Input.insertText", { text: line });
		}
	}

	async press(keys: string[]): Promise<void> {
		const { targetId } = this.#front();
		const names = keys.map(key => key.toLowerCase());
		const modifierNames = names.slice(0, -1);
		const modifiers = modifierBits(modifierNames);
		const definition = keyDefinition(keys.at(-1)!, (modifiers & 8) !== 0);
		// Text only for unmodified or shifted keys: a Ctrl or Cmd chord is a command, not a character.
		const text = modifiers & ~8 ? undefined : definition.text;
		const base = {
			key: definition.key,
			code: definition.code,
			windowsVirtualKeyCode: definition.keyCode,
			nativeVirtualKeyCode: definition.keyCode,
			modifiers,
		};
		await this.#endpoint.send(targetId, "Input.dispatchKeyEvent", {
			type: text ? "keyDown" : "rawKeyDown",
			...base,
			...(text ? { text, unmodifiedText: text } : {}),
		});
		await this.#endpoint.send(targetId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
	}
}

/**
 * Why a press in a Chromium browser window would take the user's keyboard on this desktop, or undefined where
 * it would not. Chromium (the browser, not Electron) asks for its window's activation on every mouse or touch
 * press it is sent, DevTools ones included; whether that moves the user's focus is the compositor's call.
 * Hyprland grants it under `misc:focus_on_activate` (Omarchy turns it on); GNOME's focus-stealing prevention and
 * sway's default (`focus_on_window_activation urgent`) only mark the window. Elsewhere it is unknown, so it
 * counts as granted.
 */
function activationGrant(): string | undefined {
	if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
		const option = Bun.spawnSync(["hyprctl", "-j", "getoption", "misc:focus_on_activate"]).stdout.toString();
		let parsed: unknown;
		try {
			parsed = JSON.parse(option);
		} catch {
			return "Hyprland's misc:focus_on_activate could not be read, so it may grant it";
		}
		// Hyprland 0.56 (Lua config) reports `bool`; older releases `int`.
		if (
			parsed &&
			typeof parsed === "object" &&
			(("bool" in parsed && parsed.bool === false) || ("int" in parsed && parsed.int === 0))
		)
			return undefined;
		return "this Hyprland grants it (misc:focus_on_activate is on)";
	}
	if ((process.env.XDG_CURRENT_DESKTOP ?? "").toUpperCase().split(":").includes("GNOME")) return undefined;
	if (process.env.SWAYSOCK) return undefined;
	return `this desktop (${process.env.XDG_CURRENT_DESKTOP || "unidentified"}) may grant it`;
}

/** Per-worker registry of DevTools endpoints and the routes they give desktop windows. */
export class DevToolsBridge {
	readonly #endpoints = new Map<number, Endpoint>();
	readonly #frames = new Map<string, Frame>();
	readonly #presses: PressQueue = { tail: Promise.resolve() };
	#routes = new Map<string, DevToolsWindow>();
	#runningScan?: { at: number; found: FoundEndpoint[] };
	/** {@link activationGrant}, read when the first window is routed; the compositor setting rarely changes. */
	#pressTakesFocus?: { reason: string | undefined };

	register(found: FoundEndpoint, app: string, launched: boolean): Endpoint {
		const existing = this.#endpoints.get(found.pid);
		if (existing && existing.port === found.port) return existing;
		existing?.close();
		const endpoint = new Endpoint(found, app, launched);
		this.#endpoints.set(found.pid, endpoint);
		return endpoint;
	}

	endpointOf(pid: number): Endpoint | undefined {
		return this.#endpoints.get(pid);
	}

	/**
	 * `windows` with the DevTools route merged in: each browser window of a known endpoint takes over the
	 * desktop-listed window of its process whose title it explains, or is listed on its own when the desktop
	 * does not list it (Wayland with the accessibility switch off lists no Chromium window at all).
	 */
	async merge(windows: DesktopWindow[], mode: DevToolsMode, signal?: AbortSignal): Promise<DesktopWindow[]> {
		this.#routes = new Map();
		if (mode === "off") return windows;
		if (mode === "running") await this.#adoptRunning(signal);
		const merged = [...windows];
		for (const [pid, endpoint] of this.#endpoints) {
			let found: DevToolsWindow[];
			try {
				found = await endpoint.windows();
			} catch {
				// The app quit or closed its port: its windows lose the route, nothing else changes.
				endpoint.close();
				this.#endpoints.delete(pid);
				continue;
			}
			for (const window of found) {
				const title = window.front?.title;
				// A desktop titles a Chromium window by its front tab, with the browser's name appended.
				const candidates =
					title === undefined
						? []
						: windows.filter(
								desktop =>
									desktop.pid === pid && (desktop.title === title || desktop.title.startsWith(`${title} - `)),
							);
				if (candidates.length === 1) {
					this.#routes.set(candidates[0]!.id, window);
					continue;
				}
				const id = `devtools:${pid}:${window.windowId}`;
				this.#routes.set(id, window);
				merged.push({
					id,
					app: endpoint.app,
					title: title ?? `${window.pages.length} tabs`,
					pid,
					x: window.bounds.left,
					y: window.bounds.top,
					width: window.bounds.width,
					height: window.bounds.height,
					focused: false,
				} as DesktopWindow);
			}
		}
		return merged;
	}

	async #adoptRunning(signal?: AbortSignal): Promise<void> {
		const now = performance.now();
		if (!this.#runningScan || now - this.#runningScan.at > 2_000) {
			this.#runningScan = { at: now, found: await runningEndpoints(signal) };
		}
		for (const found of this.#runningScan.found) {
			if (this.#endpoints.has(found.pid)) continue;
			const exe = await fs.readlink(`/proc/${found.pid}/exe`).catch(() => "");
			this.register(found, path.basename(exe) || found.browser, false);
		}
	}

	/** The route of window `id` from the latest {@link merge}. */
	route(id: string): DevToolsRoute | undefined {
		const window = this.#routes.get(id);
		if (!window) return undefined;
		this.#pressTakesFocus ??= { reason: activationGrant() };
		return new DevToolsRoute(id, window, this.#frames, this.#pressTakesFocus.reason, this.#presses);
	}

	close(): void {
		for (const endpoint of this.#endpoints.values()) endpoint.close();
		this.#endpoints.clear();
	}
}
