import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	copyToClipboard,
	type AxNode,
	type DesktopCapture,
	type DesktopSession,
	type DesktopWindow,
} from "@oh-my-pi/pi-natives";
import { createDesktopSession } from "@oh-my-pi/pi-natives/desktop";
import { getNativesDir, withFileLock } from "@oh-my-pi/pi-utils";
import { resizeImage } from "../../utils/image-resize";
import { ToolError, throwIfAborted } from "../tool-errors";
import type {
	ActionOptions,
	ComputerActionResult,
	ComputerBounds,
	ComputerElementSnapshot,
	ComputerImage,
	ComputerLaunchOptions,
	ComputerObservation,
	ComputerTarget,
	ComputerWindowIdentity,
	ComputerOperationContext,
	ObserveOptions,
	WindowSelector,
} from "./types";

import { SEMANTIC_ACTION_ALIASES } from "./semantic-actions";

type Context = ComputerOperationContext;
type NativeElement = ComputerElementSnapshot & {
	nativeRole: string;
	normalizedRole: string;
	focused: boolean;
	description?: string;
	actions: readonly string[];
};
interface Binding {
	window: ComputerWindowIdentity;
	token: string;
	element: NativeElement;
}
interface Frame {
	window: ComputerWindowIdentity;
	width: number;
	height: number;
	nativeWidth: number;
	nativeHeight: number;
}
interface DesktopFrame {
	width: number;
	height: number;
	nativeWidth: number;
	nativeHeight: number;
	topology: string;
}

function immutableWindow(window: ComputerWindowIdentity): ComputerWindowIdentity {
	return Object.freeze({ ...window, bounds: Object.freeze({ ...window.bounds }) });
}
function sameBounds(a: ComputerBounds, b: ComputerBounds): boolean {
	return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
function result(delivery: string, route = "omp-native", evidence: unknown = null): ComputerActionResult {
	return {
		text: "Native request completed; observe the target to verify its effect.",
		effect: "unverifiable",
		evidence,
		route,
		delivery,
	};
}
function keys(chord: string | string[]): string[] {
	const parts = Array.isArray(chord) ? chord : chord.split("+").map(key => key.trim());
	if (!parts.length || parts.some(key => !key)) throw new ToolError("Invalid key chord");
	return parts;
}
function nodeBounds(node: AxNode): ComputerBounds | undefined {
	if (node.x === undefined || node.y === undefined || node.width === undefined || node.height === undefined)
		return undefined;
	return Object.freeze({ x: node.x, y: node.y, width: node.width, height: node.height });
}
function nodeLabel(node: AxNode): string {
	return node.title || node.description || "";
}
function advertised(node: AxNode, action: string): string {
	const match = node.actions?.find(
		candidate => candidate === action || SEMANTIC_ACTION_ALIASES[action]?.includes(candidate),
	);
	if (!match)
		throw new ToolError(
			`Unsupported AX action '${action}'; advertised actions: ${JSON.stringify(node.actions ?? [])}`,
		);
	return match;
}
type VerificationStatus = "satisfied" | "unsatisfied" | "unknown";
interface PredicateOutcome {
	index: number;
	status: VerificationStatus;
	unknown_reason: string | null;
	observed_json: string | null;
}
interface VerificationResult {
	status: VerificationStatus;
	stable: boolean;
	elapsed_ms: number;
	samples: number;
	predicates: PredicateOutcome[];
}
interface StatePredicate {
	window?: { exists?: boolean; bounds?: ComputerBounds & { tolerance_px?: number } };
	element?: {
		selector: { role?: string; label_contains?: string };
		exists?: boolean;
		value_equals?: string;
		enabled?: boolean;
		selected?: boolean;
	};
}
function predicateObject(value: unknown, fields: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !fields.includes(key))
	)
		throw new ToolError("Invalid verify predicate fields");
	return value as Record<string, unknown>;
}
function normalizedRole(role: string): string {
	const normalized = role
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.replace(/^ax/, "");
	return normalized === "pushbutton"
		? "button"
		: normalized === "pagetab" || normalized === "tabitem"
			? "tab"
			: normalized;
}

/** Native session state stays in the worker; public refs never encode an element index. */
export class NativeComputerSession {
	readonly #native: DesktopSession;
	readonly #generation = crypto.randomUUID();
	readonly #frames = new Map<string, Frame>();
	readonly #elements = new Map<string, Binding>();
	readonly #inputLock: string;
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;
	#closing?: Promise<void>;
	#desktopFrame?: DesktopFrame;
	readonly metadata = Object.freeze({
		driverVersion: "omp-native",
		contractVersion: "native-session-1",
		toolsListSchemaVersion: "not-applicable",
		capabilityVersion: "native-session-1",
		mcpProtocolVersion: "not-applicable",
		pid: process.pid,
		embedded: true,
	});

	private constructor(native: DesktopSession, inputLock: string) {
		this.#native = native;
		this.#inputLock = inputLock;
	}

	static async create(options: { display?: string } = {}): Promise<NativeComputerSession> {
		const inputLock = path.join(getNativesDir(), "computer-input");
		await fs.mkdir(path.dirname(inputLock), { recursive: true });
		const native = createDesktopSession({ display: options.display ?? "all" });
		try {
			if (typeof native.pinWindow !== "function" || typeof native.invokeMenu !== "function") {
				throw new ToolError(
					"Native desktop addon is out of date; rebuild the addon or reinstall the matching OMP release",
				);
			}
			return new NativeComputerSession(native, inputLock);
		} catch (error) {
			await native.close();
			throw error;
		}
	}

	get capabilities() {
		const native = this.#native.capabilities;
		return {
			...native,
			driver: this.metadata,
			permissions: {
				capture: native.capturePermission,
				input: native.inputPermission,
				accessibility: native.axPermission,
			},
			native,
			applicationsScope: "window-owning applications from native listWindows",
			windowVisibility: "not reported by native roster",
			elementRole: "nativeRole (normalizedRole is separately available)",
			elementRefLifetime:
				"Immutable snapshots are not liveness guarantees. Re-observing or element-verifying the same window invalidates its public refs; any AX traversal can also evict refs from the session-wide 5,000-entry native registry. StaleRef requires a fresh observation.",
			clipboardTextRead: process.platform === "darwin",
			launch: process.platform === "darwin",
			verification: {
				predicates: ["window.exists", "window.bounds", "element.exists", "element.value_equals", "element.enabled"],
				selected: "unknown: native AX does not report selected",
				absence: "unknown unless the AX walk is complete",
			},
			scroll:
				"Element/page/untargeted scroll requires a unique advertised directional AX action; pixel line scrolling uses wheel deltas",
			dragDuration: "unsupported: native drag has no duration control",
			elementKeyboard:
				"Background typing requires AXSelectedText; background chords require existing focus. Foreground delivery may focus the element explicitly.",
		};
	}

	#guard(context: Context): void {
		throwIfAborted(context.signal);
		if (this.#closed) throw new ToolError("Computer session closed");
	}
	async #schedule<T>(context: Context, name: string, mutation: boolean, dispatch: () => Promise<T>): Promise<T> {
		if (mutation && context.readOnly) throw new ToolError(`read-only run: '${name}' requires read_only: false`);
		this.#guard(context);
		const run = () =>
			withFileLock(this.#inputLock, async () => {
				this.#guard(context);
				const value = await dispatch();
				throwIfAborted(context.signal);
				return value;
			});
		const pending = this.#tail.then(run, run);
		this.#tail = pending.catch(() => undefined);
		return pending;
	}

	async #windows(selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		return (await this.#native.listWindows())
			.filter((row): row is DesktopWindow & { pid: number } => row.pid !== undefined)
			.map(row =>
				immutableWindow({
					id: row.id,
					pid: row.pid,
					app: row.app,
					title: row.title,
					bounds: { x: row.x, y: row.y, width: row.width, height: row.height },
				}),
			)
			.filter(
				window =>
					(selector.id === undefined || window.id === selector.id) &&
					(selector.pid === undefined || window.pid === selector.pid) &&
					(selector.app === undefined || window.app.toLowerCase().includes(selector.app.toLowerCase())) &&
					(selector.title === undefined || window.title.toLowerCase().includes(selector.title.toLowerCase())),
			);
	}
	async #window(selector: string | WindowSelector, pin = true): Promise<ComputerWindowIdentity> {
		const matches = await this.#windows(typeof selector === "string" ? { id: selector } : selector);
		if (matches.length !== 1)
			throw new ToolError(
				`${matches.length ? "Ambiguous" : "Missing"} computer window ${JSON.stringify(selector)}: ${JSON.stringify(matches)}`,
			);
		const window = matches[0]!;
		if (pin) await this.#native.pinWindow(window.id, window.pid);
		return window;
	}
	#current(window: ComputerWindowIdentity) {
		return this.#window({ id: window.id, pid: window.pid }, false);
	}
	windows(context: Context, selector: WindowSelector = {}): Promise<ComputerWindowIdentity[]> {
		return this.#schedule(context, "windows", false, () => this.#windows(selector));
	}
	window(context: Context, selector: string | WindowSelector): Promise<ComputerWindowIdentity> {
		return this.#schedule(context, "window", false, () => this.#window(selector));
	}
	apps(context: Context): Promise<unknown> {
		return this.#schedule(context, "apps", false, async () => {
			const apps = new Map<number, { pid: number; name: string; windowIds: string[] }>();
			for (const window of await this.#windows()) {
				const app = apps.get(window.pid) ?? { pid: window.pid, name: window.app, windowIds: [] };
				app.windowIds.push(window.id);
				apps.set(window.pid, app);
			}
			return { scope: "window-owning applications", apps: [...apps.values()] };
		});
	}
	displays(context: Context) {
		return this.#schedule(context, "displays", false, () => this.#native.listDisplays());
	}
	focusedWindow(context: Context): Promise<ComputerWindowIdentity | null> {
		return this.#schedule(context, "focusedWindow", false, async () => {
			const matches = (await this.#native.listWindows()).filter(window => window.focused);
			if (!matches.length) return null;
			if (matches.length !== 1 || matches[0]!.pid === undefined)
				throw new ToolError("Cannot resolve an exact focused window identity");
			return this.#window({ id: matches[0]!.id, pid: matches[0]!.pid });
		});
	}

	#invalidate(window: Pick<ComputerWindowIdentity, "id">): void {
		for (const [ref, binding] of this.#elements) if (binding.window.id === window.id) this.#elements.delete(ref);
	}
	#binding(ref: string, window?: ComputerWindowIdentity): Binding {
		if (this.#closed) throw new ToolError("Computer session is closed");
		const binding = this.#elements.get(ref);
		if (!binding) throw new ToolError("StaleRef: observe the target window again and use its current element ref");
		if (window && (window.id !== binding.window.id || window.pid !== binding.window.pid))
			throw new ToolError("InvalidTarget: element belongs to a different window");
		return binding;
	}
	element(ref: string, window?: ComputerWindowIdentity): ComputerElementSnapshot {
		return this.#binding(ref, window).element;
	}
	elementWindow(ref: string): ComputerWindowIdentity {
		return this.#binding(ref).window;
	}
	async #node(window: ComputerWindowIdentity, ref: string): Promise<{ binding: Binding; node: AxNode }> {
		await this.#current(window);
		const binding = this.#binding(ref, window);
		return { binding, node: await this.#native.axNode(binding.token) };
	}
	observe(
		context: Context,
		window: ComputerWindowIdentity,
		options: ObserveOptions = {},
	): Promise<ComputerObservation> {
		return this.#schedule(context, "observe", false, () => this.#observe(context, window, options));
	}
	async #observe(
		context: Context,
		window: ComputerWindowIdentity,
		options: ObserveOptions,
	): Promise<ComputerObservation> {
		const current = await this.#current(window);
		this.#invalidate(window);
		const snapshot = await this.#native.axSnapshot(window.id, {
			all: true,
			maxDepth: options.maxDepth ?? 128,
			maxNodes: options.maxElements ?? 10000,
		});
		const after = await this.#current(window);
		if (!sameBounds(current.bounds, after.bounds))
			throw new ToolError("StaleRef: window geometry changed during observation");
		const snapshotId = crypto.randomUUID();
		const refs = new Map<string, string>();
		const elements = snapshot.nodes.map(node => {
			const ref = `${this.#generation}/${window.pid}/${window.id}/${snapshotId}/${node.ref}`;
			const element: NativeElement = Object.freeze({
				ref,
				pid: window.pid,
				windowId: window.id,
				role: node.nativeRole || node.role,
				nativeRole: node.nativeRole,
				normalizedRole: node.role,
				label: nodeLabel(node),
				description: node.description,
				value: node.value,
				enabled: node.enabled,
				focused: node.focused,
				bounds: nodeBounds(node),
				actions: Object.freeze([...(node.actions ?? [])]),
			});
			refs.set(node.ref, ref);
			this.#elements.set(ref, { window: current, token: node.ref, element });
			return element;
		});
		// Retain tree structure, but render public roles and full, unmodified values from the same walk.
		const nodes = new Map(snapshot.nodes.map(node => [node.ref, node]));
		const tree = snapshot.text
			.split("\n")
			.map(line => {
				const token = /\[ref=([^\]]+)\]/.exec(line)?.[1];
				const node = token ? nodes.get(token) : undefined;
				if (!node || !token) return line;
				return `${/^\s*/.exec(line)?.[0] ?? ""}- ${node.nativeRole || node.role} ${JSON.stringify(nodeLabel(node))} [ref=${refs.get(token)}]${node.value === undefined ? "" : ` value=${JSON.stringify(node.value)}`}${node.enabled === false ? " (disabled)" : ""}${node.focused ? " (focused)" : ""}`;
			})
			.join("\n");
		const query = options.query?.toLowerCase();
		const observation: ComputerObservation = {
			snapshotId,
			window: current,
			tree,
			elements: query
				? elements.filter(element =>
						[element.role, element.label, element.value ?? ""].some(value => value.toLowerCase().includes(query)),
					)
				: elements,
			complete: !snapshot.truncated && snapshot.skipped === 0 && !query,
			backgroundInput: {
				supported: this.#native.capabilities.backgroundWindowInput,
				effect: "application-dependent; dispatch is not proof of effect",
			},
		};
		if (options.screenshot !== false) {
			try {
				observation.screenshot = await this.#captureWindow(context, current, options, current.bounds);
			} catch (error) {
				this.#frames.delete(window.id);
				throwIfAborted(context.signal);
				if (error instanceof Error && error.name === "AbortError") throw error;
				observation.screenshotError = error instanceof Error ? error.message : String(error);
			}
		}
		return observation;
	}

	captureWindow(
		context: Context,
		window: ComputerWindowIdentity,
		options: { silent?: boolean } = {},
	): Promise<ComputerImage> {
		return this.#schedule(context, "captureWindow", false, () => this.#captureWindow(context, window, options));
	}

	async #captureWindow(
		context: Context,
		window: ComputerWindowIdentity,
		options: { silent?: boolean },
		expectedBounds?: ComputerBounds,
	): Promise<ComputerImage> {
		this.#frames.delete(window.id);
		const current = await this.#current(window);
		if (expectedBounds && !sameBounds(expectedBounds, current.bounds))
			throw new ToolError("StaleFrame: window geometry changed before capture");
		const capture = await this.#native.capture(window.id, {
			maxWidth: context.maxWidth,
			maxHeight: context.maxHeight,
		});
		if (!sameBounds(current.bounds, (await this.#current(window)).bounds))
			throw new ToolError("StaleFrame: window geometry changed during capture");
		const image = await this.#saveImage(
			context,
			capture,
			options.silent === true,
			`${current.app}: ${current.title || "Untitled window"}`,
		);
		this.#frames.set(window.id, {
			window: current,
			width: image.width,
			height: image.height,
			nativeWidth: capture.width,
			nativeHeight: capture.height,
		});
		return image;
	}

	async #saveImage(context: Context, frame: DesktopCapture, silent: boolean, label?: string): Promise<ComputerImage> {
		const resized = await resizeImage(
			{ type: "image", data: Buffer.from(frame.data).toString("base64"), mimeType: "image/png" },
			{ maxWidth: context.maxWidth, maxHeight: context.maxHeight, minDimension: 1, excludeWebP: true },
		);
		if (resized.decodeFailed)
			throw new ToolError("Screenshot cannot be decoded; refusing an ungrounded coordinate frame");
		const destination = path.join(
			os.tmpdir(),
			`omp-computer-${crypto.randomUUID()}.${resized.mimeType === "image/png" ? "png" : "jpg"}`,
		);
		await Bun.write(destination, resized.buffer);
		throwIfAborted(context.signal);
		const image = Object.freeze({
			path: destination,
			width: resized.width,
			height: resized.height,
			sourceWidth: frame.sourceWidth,
			sourceHeight: frame.sourceHeight,
			target: frame.target,
			...(label ? { label } : {}),
		});
		context.emitImage(image, { type: "image", data: resized.data, mimeType: resized.mimeType }, silent);
		return image;
	}
	async #point(window: ComputerWindowIdentity, point: [number, number]) {
		const current = await this.#current(window);
		const frame = this.#frames.get(window.id);
		if (!frame || frame.window.pid !== window.pid)
			throw new ToolError("MissingFrame: capture this window before using pixels");
		if (!sameBounds(frame.window.bounds, current.bounds))
			throw new ToolError("StaleFrame: window geometry changed; capture it again");
		const [x, y] = point;
		if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height)
			throw new ToolError("InvalidCoordinates: point is outside the observed window image");
		return { x: (x * frame.nativeWidth) / frame.width, y: (y * frame.nativeHeight) / frame.height };
	}
	async #action(
		context: Context,
		name: string,
		dispatch: () => Promise<unknown>,
		delivery = "background",
	): Promise<ComputerActionResult> {
		return this.#schedule(context, name, true, async () => {
			await dispatch();
			return result(delivery);
		});
	}
	click(
		context: Context,
		window: ComputerWindowIdentity,
		target: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "click", true, async () => {
			if (typeof target === "string") {
				const { binding } = await this.#node(window, target);
				this.#guard(context);
				await this.#native.axClick(binding.token, {
					button: options.button,
					count: options.count,
					modifiers: options.modifiers,
					deliveryMode: options.delivery ?? "background",
				});
			} else {
				const point = await this.#point(window, target);
				this.#guard(context);
				await this.#native.click(window.id, point.x, point.y, {
					button: options.button,
					count: options.count,
					modifiers: options.modifiers,
					deliveryMode: options.delivery ?? "background",
				});
			}
			return result(options.delivery ?? "background", "omp-native-pointer");
		});
	}
	type(
		context: Context,
		window: ComputerWindowIdentity,
		text: string,
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"type",
			async () => {
				if (typeof target === "string") {
					const { binding } = await this.#node(window, target);
					if (options.delivery === "foreground") {
						this.#guard(context);
						await this.#native.axFocus(binding.token);
						if (!(await this.#native.axNode(binding.token)).focused)
							throw new ToolError("Element focus was not verified; no keyboard input dispatched");
						this.#guard(context);
						await this.#native.typeText(window.id, text, { deliveryMode: "foreground" });
					} else {
						this.#guard(context);
						await this.#native.axInsertText(binding.token, text);
					}
				} else {
					if (target !== undefined) {
						const point = await this.#point(window, target);
						this.#guard(context);
						await this.#native.click(window.id, point.x, point.y, {
							deliveryMode: options.delivery ?? "background",
						});
					}
					await this.#current(window);
					this.#guard(context);
					await this.#native.typeText(window.id, text, { deliveryMode: options.delivery ?? "background" });
				}
			},
			typeof target === "string" && options.delivery !== "foreground"
				? "semantic"
				: (options.delivery ?? "background"),
		);
	}
	setValue(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		value: string,
	): Promise<ComputerActionResult> {
		return this.#schedule(context, "setValue", true, async () => {
			const { binding, node: before } = await this.#node(window, ref);
			this.#guard(context);
			await this.#native.axSetValue(binding.token, value);
			await this.#current(window);
			const after = await this.#native.axNode(binding.token);
			if (after.value !== value)
				throw new ToolError(
					"AXValue write was not verified by exact raw readback; no retry or typing fallback was attempted",
				);
			return {
				text: "AXValue matches the requested value in raw readback.",
				effect: before.value === value ? "unchanged" : "verified",
				evidence: { before: before.value, after: after.value },
				route: "omp-native-ax-value",
				delivery: "semantic",
			};
		});
	}
	press(
		context: Context,
		window: ComputerWindowIdentity,
		chord: string | string[],
		target?: ComputerTarget,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"press",
			async () => {
				if (typeof target === "string") {
					const { binding, node } = await this.#node(window, target);
					if (!node.focused) {
						if (options.delivery !== "foreground")
							throw new ToolError(
								"BackgroundUnavailable: element keyboard delivery requires existing focus; request foreground delivery to focus it",
							);
						this.#guard(context);
						await this.#native.axFocus(binding.token);
						if (!(await this.#native.axNode(binding.token)).focused)
							throw new ToolError("Element focus was not verified; no key chord dispatched");
					}
				} else if (target !== undefined) {
					const point = await this.#point(window, target);
					this.#guard(context);
					await this.#native.click(window.id, point.x, point.y, {
						deliveryMode: options.delivery ?? "background",
					});
				}
				await this.#current(window);
				this.#guard(context);
				await this.#native.keyChord(window.id, keys(chord), { deliveryMode: options.delivery ?? "background" });
			},
			options.delivery ?? "background",
		);
	}
	perform(
		context: Context,
		window: ComputerWindowIdentity,
		ref: string,
		action: string,
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"perform",
			async () => {
				const { binding, node } = await this.#node(window, ref);
				this.#guard(context);
				await this.#native.axPerform(binding.token, advertised(node, action));
			},
			"semantic",
		);
	}
	hover(
		context: Context,
		window: ComputerWindowIdentity,
		x: number,
		y: number,
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"hover",
			async () => {
				const point = await this.#point(window, [x, y]);
				this.#guard(context);
				await this.#native.moveMouse(window.id, point.x, point.y, {
					deliveryMode: options.delivery ?? "background",
				});
			},
			options.delivery ?? "background",
		);
	}
	drag(
		context: Context,
		window: ComputerWindowIdentity,
		from: [number, number],
		to: [number, number],
		options: ActionOptions & { durationMs?: number; steps?: number } = {},
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"drag",
			async () => {
				if (options.durationMs !== undefined)
					throw new ToolError("Unsupported: native drag has no duration control; omit durationMs");
				const steps = options.steps ?? 1;
				if (!Number.isInteger(steps) || steps < 1 || steps > 1000)
					throw new ToolError("Drag steps must be an integer from 1 to 1000");
				const start = await this.#point(window, from);
				const end = await this.#point(window, to);
				const points = Array.from({ length: steps + 1 }, (_, i) => ({
					x: start.x + ((end.x - start.x) * i) / steps,
					y: start.y + ((end.y - start.y) * i) / steps,
				}));
				this.#guard(context);
				await this.#native.drag(window.id, points, {
					button: options.button,
					modifiers: options.modifiers,
					deliveryMode: options.delivery ?? "background",
				});
			},
			options.delivery ?? "background",
		);
	}
	scroll(
		context: Context,
		window: ComputerWindowIdentity,
		direction: "up" | "down" | "left" | "right",
		target?: ComputerTarget,
		options: ActionOptions & { amount?: number; by?: "line" | "page" } = {},
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"scroll",
			async () => {
				if (!["up", "down", "left", "right"].includes(direction)) throw new ToolError("Invalid scroll direction");
				if (options.by !== undefined && options.by !== "line" && options.by !== "page")
					throw new ToolError("Invalid scroll unit");
				const semantic = typeof target === "string" || target === undefined || options.by === "page";
				const amount = options.amount ?? (semantic ? 1 : 3);
				if (!Number.isFinite(amount) || amount < 0 || (semantic && (!Number.isInteger(amount) || amount > 100)))
					throw new ToolError("Invalid scroll amount: semantic actions require an integer from 0 to 100");
				if (semantic) {
					if (options.modifiers?.length)
						throw new ToolError(
							"Unsupported: semantic AX scroll actions do not accept modifiers; use pixel line scrolling",
						);
					const action = `AXScroll${direction[0]!.toUpperCase()}${direction.slice(1)}By${options.by === "page" ? "Page" : "Line"}`;
					let node: AxNode;
					if (typeof target === "string") node = (await this.#node(window, target)).node;
					else if (target) {
						await this.#point(window, target);
						const frame = this.#frames.get(window.id)!;
						const hit = await this.#native.axElementAt(
							window.id,
							frame.window.bounds.x + (target[0] * frame.window.bounds.width) / frame.width,
							frame.window.bounds.y + (target[1] * frame.window.bounds.height) / frame.height,
						);
						if (!hit) throw new ToolError("Unsupported: no AX element at the grounded scroll point");
						node = hit;
						const seen = new Set<string>();
						while (!node.actions?.includes(action)) {
							if (seen.has(node.ref) || seen.size >= 128)
								throw new ToolError("Unsupported: cyclic or excessive AX ancestry while finding scroll target");
							if (normalizedRole(node.nativeRole || node.role) === "window")
								throw new ToolError(`Unsupported: window-scoped ancestry does not advertise ${action}`);
							seen.add(node.ref);
							const parent = await this.#native.axParent(node.ref);
							if (!parent) throw new ToolError(`Unsupported: target ancestry does not advertise ${action}`);
							node = parent;
						}
					} else {
						await this.#current(window);
						this.#invalidate(window);
						const snapshot = await this.#native.axSnapshot(window.id, {
							all: true,
							maxDepth: 128,
							maxNodes: 5000,
						});
						const matches = snapshot.nodes.filter(candidate => candidate.actions?.includes(action));
						if (snapshot.truncated || snapshot.skipped !== 0 || matches.length !== 1)
							throw new ToolError(
								`MissingTarget: cannot prove a unique ${action} target; provide an element ref or grounded pixels`,
							);
						node = matches[0]!;
					}
					const nativeAction = advertised(node, action);
					for (let i = 0; i < amount; i++) {
						await this.#current(window);
						this.#guard(context);
						await this.#native.axPerform(node.ref, nativeAction);
					}
					return;
				}
				const point = await this.#point(window, target as [number, number]);
				const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
				const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
				this.#guard(context);
				await this.#native.scroll(window.id, point.x, point.y, dx, dy, {
					deliveryMode: options.delivery ?? "background",
					modifiers: options.modifiers,
				});
			},
			typeof target === "string" || target === undefined || options.by === "page"
				? "semantic"
				: (options.delivery ?? "background"),
		);
	}
	setFrame(context: Context, window: ComputerWindowIdentity, frame: ComputerBounds): Promise<ComputerActionResult> {
		return this.#schedule(context, "setFrame", true, async () => {
			if (
				![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
				frame.width <= 0 ||
				frame.height <= 0
			)
				throw new ToolError("Invalid window geometry");
			await this.#current(window);
			this.#frames.delete(window.id);
			this.#invalidate(window);
			this.#guard(context);
			await this.#native.setWindowFrame(window.id, frame.x, frame.y, frame.width, frame.height);
			const after = await this.#current(window);
			if (!sameBounds(frame, after.bounds))
				throw new ToolError("Window geometry did not match exact requested frame after native setWindowFrame");
			return {
				text: "Window geometry verified by native readback.",
				effect: "verified",
				evidence: { bounds: after.bounds },
				route: "omp-native-frame",
				delivery: "background",
			};
		});
	}
	menu(
		context: Context,
		window: ComputerWindowIdentity,
		menuPath: string[],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"menu",
			async () => {
				if (options.delivery !== "foreground")
					throw new ToolError("Menu invocation requires explicit delivery: 'foreground'");
				if (!menuPath.length || menuPath.some(label => !label))
					throw new ToolError("Menu path must contain exact nonempty labels");
				await this.#current(window);
				// Application menus have their own native PID scope, not forged window refs.
				this.#invalidate(window);
				this.#guard(context);
				await this.#native.invokeMenu(window.id, menuPath, { deliveryMode: "foreground" });
			},
			"foreground",
		);
	}
	verify(
		context: Context,
		window: Pick<ComputerWindowIdentity, "id" | "pid">,
		expect: Record<string, unknown>[],
		options: { timeoutMs?: number; stableSamples?: number } = {},
	): Promise<VerificationResult> {
		return this.#schedule(context, "verify", false, async () => {
			if (!window || typeof window.id !== "string" || !window.id || !Number.isInteger(window.pid))
				throw new ToolError("verify requires an exact window id and PID");
			// Preserve the three-state predicate result: satisfied, unsatisfied, unknown.
			const timeout = options.timeoutMs ?? 5000;
			const required = options.stableSamples ?? (timeout === 0 ? 1 : 2);
			if (
				!Number.isInteger(timeout) ||
				timeout < 0 ||
				timeout > 10000 ||
				!Number.isInteger(required) ||
				required < 1 ||
				required > 5 ||
				(timeout === 0 && required !== 1)
			)
				throw new ToolError(
					"verify requires timeoutMs 0..10000 and stableSamples 1..5; timeoutMs:0 permits one sample only",
				);
			if (!Array.isArray(expect) || expect.length < 1 || expect.length > 8)
				throw new ToolError("verify requires one to eight ANDed predicates");
			for (const raw of expect) {
				const predicate = predicateObject(raw, ["window", "element"]);
				if (predicate.window != null) {
					const windowPredicate = predicateObject(predicate.window, ["exists", "bounds"]);
					if (windowPredicate.exists != null && typeof windowPredicate.exists !== "boolean")
						throw new ToolError("window.exists must be boolean");
					if (windowPredicate.bounds != null) {
						const bounds = predicateObject(windowPredicate.bounds, ["x", "y", "width", "height", "tolerance_px"]);
						if (
							["x", "y", "width", "height"].some(
								key => typeof bounds[key] !== "number" || !Number.isFinite(bounds[key]),
							)
						)
							throw new ToolError("window.bounds requires finite x, y, width and height");
						if (
							bounds.tolerance_px != null &&
							(typeof bounds.tolerance_px !== "number" ||
								!Number.isFinite(bounds.tolerance_px) ||
								bounds.tolerance_px < 0 ||
								bounds.tolerance_px > 100)
						)
							throw new ToolError("bounds.tolerance_px must be between 0 and 100");
					}
				}
				if (predicate.element != null) {
					const element = predicateObject(predicate.element, [
						"selector",
						"exists",
						"value_equals",
						"enabled",
						"selected",
					]);
					const selector = predicateObject(element.selector, ["role", "label_contains"]);
					for (const field of ["role", "label_contains"])
						if (
							selector[field] != null &&
							(typeof selector[field] !== "string" || !(selector[field] as string).trim())
						)
							throw new ToolError("Element selectors must be nonempty strings");
					if (element.exists != null && element.exists !== true)
						throw new ToolError("element.exists only supports true: AX absence is not universally exhaustive");
					if (element.value_equals != null && typeof element.value_equals !== "string")
						throw new ToolError("element.value_equals must be a string");
					for (const field of ["enabled", "selected"])
						if (element[field] != null && typeof element[field] !== "boolean")
							throw new ToolError(`element.${field} must be boolean`);
				}
			}
			const predicates = expect as StatePredicate[];
			const started = performance.now();
			let samples = 0;
			let consecutive = 0;
			let outcomes: PredicateOutcome[] = [];
			let status: VerificationStatus = "unknown";
			while (true) {
				this.#guard(context);
				samples++;
				let current: ComputerWindowIdentity | undefined;
				let nodes: AxNode[] = [];
				let complete = false;
				const untrusted = new Set<string>();
				let observationError: string | undefined;
				let elementError: string | undefined;
				try {
					current = (await this.#windows({ id: window.id, pid: window.pid }))[0];
					if (current) await this.#native.pinWindow(current.id, current.pid);
				} catch (error) {
					observationError = error instanceof Error ? error.message : String(error);
				}
				if (current && predicates.some(predicate => predicate.element)) {
					try {
						this.#guard(context);
						this.#invalidate(window);
						const snapshot = await this.#native.axSnapshot(window.id, {
							all: true,
							maxDepth: 128,
							maxNodes: 5000,
						});
						await this.#current(current);
						nodes = snapshot.nodes;
						complete = !snapshot.truncated && snapshot.skipped === 0;
						// Web/document descendants are untrusted semantic evidence.
						const byRef = new Map(nodes.map(node => [node.ref, node]));
						let webDepth: number | undefined;
						for (const line of snapshot.text.split("\n")) {
							const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
							const node = ref ? byRef.get(ref) : undefined;
							if (!node || !ref) continue;
							const depth = /^\s*/.exec(line)![0].length;
							if (webDepth !== undefined && depth <= webDepth) webDepth = undefined;
							const role = normalizedRole(node.nativeRole || node.role);
							if (role.includes("webarea") || role.includes("document") || role === "embedded")
								webDepth ??= depth;
							if (webDepth !== undefined) untrusted.add(ref);
						}
					} catch (error) {
						elementError = error instanceof Error ? error.message : String(error);
					}
				}
				this.#guard(context);
				outcomes = predicates.map((predicate, index): PredicateOutcome => {
					let outcome: VerificationStatus = "unknown";
					let reason: string | null = null;
					let observed: unknown = null;
					if (observationError) {
						reason = "observation_unavailable";
						observed = { error: observationError };
					} else if (Boolean(predicate.window) === Boolean(predicate.element)) reason = "invalid_predicate";
					else if (predicate.window) {
						const expected = predicate.window;
						observed = { exists: Boolean(current), ...(current ? { bounds: current.bounds } : {}) };
						if (expected.exists == null && !expected.bounds) reason = "invalid_predicate";
						else if (expected.exists != null && expected.exists !== Boolean(current)) outcome = "unsatisfied";
						else if (!current) {
							if (expected.exists === false && !expected.bounds) outcome = "satisfied";
							else reason = "target_missing";
						} else if (
							expected.bounds &&
							(["x", "y", "width", "height"] as const).some(
								key =>
									Math.abs(current!.bounds[key] - expected.bounds![key]) >
									(expected.bounds!.tolerance_px ?? 0),
							)
						)
							outcome = "unsatisfied";
						else outcome = "satisfied";
					} else if (predicate.element) {
						const expected = predicate.element;
						if (!expected.selector.role && !expected.selector.label_contains) reason = "invalid_predicate";
						else if (!current) {
							reason = "target_missing";
							observed = { window: { exists: false } };
						} else if (elementError) {
							reason = "observation_unavailable";
							observed = { error: elementError };
						} else {
							const matches = nodes.filter(
								node =>
									(!expected.selector.role ||
										normalizedRole(node.nativeRole || node.role) ===
											normalizedRole(expected.selector.role)) &&
									(!expected.selector.label_contains ||
										nodeLabel(node).toLowerCase().includes(expected.selector.label_contains.toLowerCase())),
							);
							const trusted = matches.filter(node => !untrusted.has(node.ref));
							observed = { matches: matches.length, elements_complete: complete };
							if (!matches.length) {
								if (untrusted.size) reason = "untrusted_source";
								else if (!complete) reason = "observation_unavailable";
								else if (expected.exists === true) outcome = "unsatisfied";
								else reason = "target_missing";
							} else if (!trusted.length) reason = "untrusted_source";
							else if (
								trusted.length > 1 &&
								(expected.value_equals != null || expected.enabled != null || expected.selected != null)
							)
								reason = "multi_match";
							else if (
								!complete &&
								(expected.value_equals != null || expected.enabled != null || expected.selected != null)
							)
								reason = "observation_unavailable";
							else {
								const node = trusted[0]!;
								observed =
									trusted.length > 1
										? { matches: trusted.length }
										: {
												role: node.nativeRole || node.role,
												label: nodeLabel(node),
												value: node.value,
												enabled: node.enabled,
												frame: nodeBounds(node),
											};
								outcome = "satisfied";
								for (const [actual, desired] of [
									[node.value, expected.value_equals],
									[node.enabled, expected.enabled],
									[undefined, expected.selected],
								]) {
									if (desired == null) continue;
									if (actual === undefined) {
										outcome = "unknown";
										reason = "unsupported_predicate";
										break;
									}
									if (actual !== desired) {
										outcome = "unsatisfied";
										break;
									}
								}
							}
						}
					}
					const encoded = observed === null ? null : JSON.stringify(observed);
					return {
						index,
						status: outcome,
						unknown_reason: reason,
						observed_json: encoded && encoded.length > 2000 ? `${encoded.slice(0, 1997)}...` : encoded,
					};
				});
				status = outcomes.some(outcome => outcome.status === "unsatisfied")
					? "unsatisfied"
					: outcomes.some(outcome => outcome.status === "unknown")
						? "unknown"
						: "satisfied";
				consecutive = status === "satisfied" ? consecutive + 1 : 0;
				if (consecutive >= required || performance.now() - started >= timeout) break;
				await delay(Math.min(100, Math.max(0, timeout - (performance.now() - started))), undefined, {
					signal: context.signal,
				});
			}
			const stable = consecutive >= required;
			if (status === "satisfied" && !stable) {
				status = "unknown";
				for (const outcome of outcomes)
					if (outcome.status === "satisfied") {
						outcome.status = "unknown";
						outcome.unknown_reason = "stability_unproven";
					}
			}
			return { status, stable, elapsed_ms: Math.floor(performance.now() - started), samples, predicates: outcomes };
		});
	}
	raise(context: Context, window: ComputerWindowIdentity): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"raise",
			async () => {
				await this.#current(window);
				this.#guard(context);
				await this.#native.raiseWindow(window.id);
			},
			"foreground",
		);
	}

	async #topology(): Promise<string> {
		return JSON.stringify(await this.#native.listDisplays());
	}
	screenshot(context: Context, options: { silent?: boolean } = {}): Promise<ComputerImage> {
		return this.#schedule(context, "screenshot", false, async () => {
			this.#desktopFrame = undefined;
			const topology = await this.#topology();
			const frame = await this.#native.capture("desktop", {
				maxWidth: context.maxWidth,
				maxHeight: context.maxHeight,
			});
			if (topology !== (await this.#topology()))
				throw new ToolError("StaleFrame: desktop display topology changed during capture");
			const image = await this.#saveImage(context, frame, options.silent === true);
			this.#desktopFrame = {
				width: image.width,
				height: image.height,
				nativeWidth: frame.width,
				nativeHeight: frame.height,
				topology,
			};
			return image;
		});
	}
	#foreground(options: ActionOptions): void {
		if (options.delivery !== "foreground")
			throw new ToolError("Desktop-global input requires explicit delivery: 'foreground'");
	}
	async #desktopPoint(x: number, y: number) {
		const frame = this.#desktopFrame;
		if (!frame) throw new ToolError("MissingFrame: capture the desktop before using desktop pixels");
		if (frame.topology !== (await this.#topology()))
			throw new ToolError("StaleFrame: desktop display topology changed; capture it again");
		if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height)
			throw new ToolError("InvalidCoordinates: point is outside the observed desktop image");
		return { x: (x * frame.nativeWidth) / frame.width, y: (y * frame.nativeHeight) / frame.height };
	}
	desktopClick(context: Context, x: number, y: number, options: ActionOptions = {}): Promise<ComputerActionResult> {
		this.#foreground(options);
		return this.#action(
			context,
			"desktopClick",
			async () => {
				const point = await this.#desktopPoint(x, y);
				this.#guard(context);
				await this.#native.click("desktop", point.x, point.y, {
					button: options.button,
					count: options.count,
					modifiers: options.modifiers,
					deliveryMode: "foreground",
				});
			},
			"foreground",
		);
	}
	desktopMove(context: Context, x: number, y: number, options: ActionOptions = {}): Promise<ComputerActionResult> {
		this.#foreground(options);
		return this.#action(
			context,
			"desktopMove",
			async () => {
				const point = await this.#desktopPoint(x, y);
				this.#guard(context);
				await this.#native.moveMouse("desktop", point.x, point.y, { deliveryMode: "foreground" });
			},
			"foreground",
		);
	}
	desktopDrag(
		context: Context,
		points: [number, number][],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		this.#foreground(options);
		return this.#action(
			context,
			"desktopDrag",
			async () => {
				if (points.length < 2) throw new ToolError("Desktop drag requires at least two points");
				const nativePoints = [];
				for (const point of points) nativePoints.push(await this.#desktopPoint(point[0], point[1]));
				this.#guard(context);
				await this.#native.drag("desktop", nativePoints, {
					button: options.button,
					modifiers: options.modifiers,
					deliveryMode: "foreground",
				});
			},
			"foreground",
		);
	}
	desktopScroll(
		context: Context,
		x: number,
		y: number,
		options: { dx?: number; dy?: number; delivery?: "background" | "foreground" } = {},
	): Promise<ComputerActionResult> {
		this.#foreground(options);
		return this.#action(
			context,
			"desktopScroll",
			async () => {
				const point = await this.#desktopPoint(x, y);
				this.#guard(context);
				await this.#native.scroll("desktop", point.x, point.y, options.dx ?? 0, options.dy ?? 0, {
					deliveryMode: "foreground",
				});
			},
			"foreground",
		);
	}
	desktopType(context: Context, text: string, options: ActionOptions = {}): Promise<ComputerActionResult> {
		this.#foreground(options);
		return this.#action(
			context,
			"desktopType",
			() => this.#native.typeText("desktop", text, { deliveryMode: "foreground" }),
			"foreground",
		);
	}
	desktopPress(
		context: Context,
		chord: string | string[],
		options: ActionOptions = {},
	): Promise<ComputerActionResult> {
		this.#foreground(options);
		return this.#action(
			context,
			"desktopPress",
			() => this.#native.keyChord("desktop", keys(chord), { deliveryMode: "foreground" }),
			"foreground",
		);
	}
	async #exec(application: string, args: string[]): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		execFile(
			application,
			args,
			{ timeout: 10000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error)
					reject(
						new ToolError(`Native helper failed (${error.code ?? "unknown"}): ${stderr.trim() || error.message}`),
					);
				else resolve(stdout);
			},
		);
		return promise;
	}
	clipboardRead(context: Context): Promise<string> {
		return this.#schedule(context, "clipboardRead", false, async () => {
			if (process.platform !== "darwin")
				throw new ToolError(
					"Unsupported: native text clipboard read is currently implemented only with macOS pbpaste",
				);
			return this.#exec("/usr/bin/pbpaste", ["-Prefer", "txt"]);
		});
	}
	clipboardWrite(context: Context, text: string): Promise<ComputerActionResult> {
		return this.#action(
			context,
			"clipboardWrite",
			async () => {
				copyToClipboard(text);
			},
			"clipboard",
		);
	}
	launch(context: Context, options: ComputerLaunchOptions): Promise<ComputerActionResult> {
		return this.#schedule(context, "launch", true, async () => {
			if (!options.bundleId && !options.name) throw new ToolError("launch requires bundleId or name");
			if (process.platform !== "darwin")
				throw new ToolError(
					"Unsupported: native background application launch is currently implemented only on macOS",
				);
			const args = ["-g", ...(options.bundleId ? ["-b", options.bundleId] : ["-a", options.name!])];
			if (options.newInstance) args.push("-n");
			args.push("--", ...(options.urls ?? []));
			await this.#exec("/usr/bin/open", args);
			return {
				text: "Background launch requested; the application may still request activation. Observe to verify its effect.",
				effect: "unverifiable",
				evidence: null,
				route: "os-open",
				delivery: "background",
			};
		});
	}
	/** Wait for admitted native operations without cancelling their underlying dispatch. */
	async drain(): Promise<void> {
		await this.#tail;
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		this.#closed = true;
		this.#closing = (async () => {
			await this.#tail;
			try {
				await withFileLock(this.#inputLock, () => this.#native.close());
			} finally {
				this.#elements.clear();
				this.#frames.clear();
				this.#desktopFrame = undefined;
			}
		})();
		return this.#closing;
	}
}
