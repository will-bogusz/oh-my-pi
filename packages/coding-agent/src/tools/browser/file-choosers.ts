import type { Protocol } from "devtools-protocol";
import * as fs from "node:fs/promises";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { CDPSession, Page } from "puppeteer-core";
import { DialogStop } from "./dialog-stop";
import { type DialogState, describeAnswer, describeWaiting } from "./dialogs";

/** Longest anything waits to describe a caught chooser's input; a page stopped in a dialog never answers. */
const DESCRIBE_TIMEOUT_MS = 500;
/** Longest an input waits for the page to have asked for any chooser it opened. */
const SYNC_TIMEOUT_MS = 250;

interface InputDescription {
	accept: string;
	webkitdirectory: boolean;
}

/** A file chooser the page opened while omp held choosers, in place of the OS file dialog. */
export interface CaughtFileChooser {
	/** The `<input type=file>` waiting for files; absent for a File System Access picker, which Chrome cancels. */
	backendNodeId?: number;
	/** The frame the input is in. */
	frameId: string;
	multiple: boolean;
	/** True when it opened while no omp call was running (a page timer, or the user in their own browser). */
	betweenCalls: boolean;
	/** The input's `accept` filter and folder flag, read once when it was caught; undefined when unreadable. */
	input: Promise<InputDescription | undefined>;
}

/** The state `tab.dialog()` reports for a chooser. */
function chooserState(chooser: CaughtFileChooser, input: InputDescription | undefined): DialogState {
	return {
		open: true,
		type: "file-chooser",
		multiple: chooser.multiple,
		...(input?.accept ? { accept: input.accept } : {}),
		...(input?.webkitdirectory ? { folder: true } : {}),
	};
}

/**
 * Holds the file choosers a tab opens while it is armed, so Chrome shows no OS file dialog: the page keeps waiting
 * on its `<input type=file>` until omp fills or cancels it. One CDP session owns the tab's interception for the
 * worker's life, so it never ends with one call and swallows nothing it does not report.
 */
export class FileChooserCatcher {
	readonly #session: CDPSession;
	readonly #onHeld = new Set<(state: DialogState) => void>();
	/** Whether choosers should be held now. */
	#wanted = false;
	/** What the page was last told; it catches up with {@link #wanted} once no dialog stops it. */
	#armed = false;
	#disarmTimer: NodeJS.Timeout | undefined;
	/** The release tail that came due while a dialog stopped the page; it starts again once the dialog closes. */
	#releaseAfterDialog: number | undefined;
	readonly #stop: DialogStop;
	/** A call that opens a chooser itself (`uploadFile`) takes the next one before it is held. */
	#claim: ((chooser: CaughtFileChooser) => boolean) | undefined;
	#held: CaughtFileChooser | undefined;
	/** Raw Puppeteer `page.waitForFileChooser()` calls waiting: the chooser they get is theirs to fill or cancel. */
	#rawWaits = 0;
	#unreported: CaughtFileChooser[] = [];
	#inCall = false;
	/** Choosers an answer is filling now: their late held report is not a new wait for the answering call. */
	readonly #answering = new Set<CaughtFileChooser>();

	private constructor(session: CDPSession) {
		this.#session = session;
		session.on("Page.fileChooserOpened", this.#onOpened);
		session.on("Page.frameNavigated", this.#onNavigated);
		this.#stop = new DialogStop(session);
		this.#stop.onClose(this.#onDialogClosed);
	}

	static async attach(page: Page): Promise<FileChooserCatcher> {
		const session = await page.createCDPSession();
		try {
			await session.send("Page.enable");
		} catch (error) {
			await session.detach().catch(() => undefined);
			throw error;
		}
		return new FileChooserCatcher(session);
	}

	/** Hold choosers from now on; marks an omp call as running until {@link endCall}. */
	async beginCall(): Promise<void> {
		this.#inCall = true;
		// Reported by no call yet, so they opened between calls; one that opens a moment after a click returned,
		// before that call's notes are read, still belongs to that call.
		for (const chooser of this.#unreported) chooser.betweenCalls = true;
		await this.arm();
	}

	/** The omp call ended; `releaseAfterMs` disarms after that tail (the user's browser), undefined keeps it armed. */
	endCall(releaseAfterMs: number | undefined): void {
		this.#inCall = false;
		if (releaseAfterMs === undefined) return;
		clearTimeout(this.#disarmTimer);
		this.#disarmTimer = setTimeout(() => {
			this.#disarmTimer = undefined;
			if (this.#inCall) return;
			// A dialog that opened while choosers were held returns into code that may open one at once; keep
			// holding until the tail after it closes.
			if (this.#stop.open) {
				this.#releaseAfterDialog = releaseAfterMs;
				return;
			}
			this.#wanted = false;
			void this.#apply().catch(() => undefined);
		}, releaseAfterMs);
	}

	async arm(): Promise<void> {
		clearTimeout(this.#disarmTimer);
		this.#disarmTimer = undefined;
		this.#releaseAfterDialog = undefined;
		this.#wanted = true;
		await this.#apply();
	}

	/** Tells the page whether to hold choosers, unless a dialog stops it: then the page is told once that closes. */
	async #apply(): Promise<void> {
		const enabled = this.#wanted;
		if (this.#armed === enabled || this.#stop.open) return;
		const previous = this.#armed;
		this.#armed = enabled;
		const sent = this.#session.send("Page.setInterceptFileChooserDialog", { enabled });
		sent.catch(() => {
			this.#armed = previous;
		});
		await this.#stop.settle(sent);
	}

	readonly #onDialogClosed = (): void => {
		void this.#apply().catch(() => undefined);
		const tail = this.#releaseAfterDialog;
		this.#releaseAfterDialog = undefined;
		if (tail !== undefined && !this.#inCall) this.endCall(tail);
	};

	/** Call `listener` when a chooser starts waiting for files; returns the unsubscribe. */
	onHeld(listener: (state: DialogState) => void): () => void {
		this.#onHeld.add(listener);
		return () => this.#onHeld.delete(listener);
	}

	/**
	 * Wait until the page has asked for any chooser an input already sent opened: the renderer answers this only
	 * after the input's handlers ran, so the request reaches this session first.
	 */
	async sync(signal: AbortSignal | undefined): Promise<void> {
		if (!this.#armed || this.#stop.open) return;
		const answered = this.#session.send("Runtime.evaluate", { expression: "0" }).catch(() => undefined);
		await untilAborted(signal, () => Promise.race([answered, Bun.sleep(SYNC_TIMEOUT_MS)]));
	}

	/**
	 * Arm and take the next chooser before it is held or reported, run `act` (the click that should open one), and
	 * wait up to `ms` from the start of `act` for it. Resolves null when none opened.
	 */
	async claimDuring(
		act: () => Promise<void>,
		ms: number,
		label: string,
		signal: AbortSignal | undefined,
	): Promise<CaughtFileChooser | null> {
		// Each claim takes the page's next chooser, so overlapping ones would both take the first.
		if (this.#claim) {
			throw new ToolError(`${label} cannot run while another uploadFile on this tab waits for its file chooser`);
		}
		const { promise, resolve } = Promise.withResolvers<CaughtFileChooser | null>();
		let open = true;
		// A chooser after the wait ended is held like any other, not dropped by a claim nobody reads.
		this.#claim = chooser => {
			if (!open) return false;
			open = false;
			resolve(chooser);
			return true;
		};
		let timer: NodeJS.Timeout | undefined;
		try {
			await untilAborted(signal, () => this.arm());
			// The wait covers the click, so a target that only becomes clickable later counts as a drop zone.
			timer = setTimeout(() => {
				open = false;
				resolve(null);
			}, ms);
			await act();
			return await untilAborted(signal, () => promise);
		} finally {
			open = false;
			clearTimeout(timer);
			this.#claim = undefined;
		}
	}

	/**
	 * Leave the choosers a raw Puppeteer `page.waitForFileChooser()` waits for to it: Chrome tells this session about
	 * them too, and Puppeteer fills or cancels them without this catcher knowing. Returns `waiting`. Puppeteer turns
	 * interception on for the page's own session and never off, so `release` turns it off once the last raw wait
	 * settles; this catcher holds choosers on a session of its own, which that leaves alone.
	 */
	leaveTo<T>(waiting: Promise<T>, release: () => Promise<unknown>): Promise<T> {
		this.#rawWaits++;
		// The chooser reaches this session a moment after Puppeteer's; it is still theirs then.
		void waiting
			.then(
				() => this.sync(undefined),
				() => undefined,
			)
			.finally(() => {
				this.#rawWaits--;
				if (this.#rawWaits === 0) void release().catch(() => undefined);
			});
		return waiting;
	}

	/**
	 * Keep a claimed chooser waiting after its upload failed, so a corrected answer can still fill it; false when its
	 * input is no longer a file input (the page replaced it), which nothing could answer.
	 */
	async holdIfWaiting(chooser: CaughtFileChooser): Promise<boolean> {
		const backendNodeId = chooser.backendNodeId;
		if (backendNodeId === undefined) return false;
		// Bounded like the input's description: a page stopped in a dialog answers nothing.
		const check = this.#onInput(backendNodeId, undefined, async objectId => {
			const { result } = await this.#session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: "function () { return this.localName === 'input' && this.type === 'file'; }",
				returnByValue: true,
			});
			return result.value === true;
		}).catch(() => false);
		const waiting = await Promise.race([check, Bun.sleep(DESCRIBE_TIMEOUT_MS).then(() => false)]);
		if (waiting) this.#holdUntilAnswered(chooser, backendNodeId);
		return waiting;
	}

	/** The newest chooser still waiting for files. */
	get held(): CaughtFileChooser | undefined {
		return this.#held;
	}

	/** The held chooser as `tab.dialog()` reports it; undefined when none waits. */
	async heldState(): Promise<DialogState | undefined> {
		const held = this.#held;
		if (!held) return undefined;
		return chooserState(held, await held.input);
	}

	/**
	 * One line per chooser caught since the last call that still waits, or File System Access picker Chrome
	 * cancelled, each reported once: what happened and how to answer.
	 */
	async takeNotices(): Promise<string[]> {
		const caught = this.#unreported.filter(chooser => chooser.backendNodeId === undefined || chooser === this.#held);
		this.#unreported = [];
		return await Promise.all(caught.map(chooser => this.#describe(chooser)));
	}

	/** Forget the notices of a call that failed: a chooser still held is named by the next call that touches the page. */
	dropNotices(): void {
		this.#unreported = [];
	}

	/** Refuse files a caught chooser cannot take: a File System Access picker, or more than its input accepts. */
	async check(chooser: CaughtFileChooser, absolutePaths: string[], label: string): Promise<void> {
		if (chooser.backendNodeId === undefined) {
			throw new ToolError(
				`${label} opened a File System Access picker (showOpenFilePicker), which automation cannot fill; upload through the page's <input type=file> or drop zone instead`,
			);
		}
		const input = await chooser.input;
		if (input?.webkitdirectory) {
			const isFolder =
				absolutePaths.length === 1 && (await fs.stat(absolutePaths[0]!).catch(() => null))?.isDirectory();
			if (!isFolder) throw new ToolError(`${label}: the file chooser picks a folder; give one folder path`);
		} else if (absolutePaths.length > 1 && !chooser.multiple) {
			throw new ToolError("Multiple file uploads only work with <input type=file multiple>");
		}
	}

	/** Mark `chooser` as being filled until the returned release runs. */
	answering(chooser: CaughtFileChooser): () => void {
		this.#answering.add(chooser);
		return () => this.#answering.delete(chooser);
	}

	/** A chooser's input got its files; it no longer waits. */
	answered(chooser: CaughtFileChooser): void {
		if (this.#held === chooser) this.#held = undefined;
	}

	/** Answer the held chooser with no files: the page gets `cancel`, as when a user closes the dialog. */
	async cancelHeld(signal: AbortSignal | undefined): Promise<void> {
		const held = this.#held;
		if (held?.backendNodeId === undefined) return;
		this.#held = undefined;
		await this.#onInput(held.backendNodeId, signal, async objectId => {
			await this.#session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration: "function () { this.dispatchEvent(new Event('cancel', { bubbles: true })); }",
			});
		});
	}

	async dispose(): Promise<void> {
		clearTimeout(this.#disarmTimer);
		this.#session.off("Page.fileChooserOpened", this.#onOpened);
		this.#session.off("Page.frameNavigated", this.#onNavigated);
		this.#onHeld.clear();
		// The relay keeps interception on for the tab while any session asks for it, so switch it off explicitly; a page
		// stopped in a dialog takes it once the dialog closes, so closing the tab does not wait for that.
		if (this.#armed) {
			const off = this.#session.send("Page.setInterceptFileChooserDialog", { enabled: false });
			await this.#stop.settle(off.catch(() => undefined));
		}
		this.#armed = false;
		this.#stop.dispose();
		await this.#session.detach().catch(() => undefined);
	}

	async #describe(chooser: CaughtFileChooser): Promise<string> {
		const when = chooser.betweenCalls ? "after the previous browser call returned" : "during this call";
		if (chooser.backendNodeId === undefined) {
			return `The page opened a File System Access file picker ${when}. omp cannot fill those pickers, so Chrome cancelled it (the page got an AbortError) and no dialog appeared on screen. Use the page's <input type=file> or drop zone with tab.uploadFile(selector, path) instead.`;
		}
		const state = chooserState(chooser, await chooser.input);
		return `The page opened ${describeWaiting(state)} ${when}. omp is holding it, so no file dialog appeared on screen; the page is waiting for files. ${describeAnswer(state)}`;
	}

	readonly #onOpened = (event: Protocol.Page.FileChooserOpenedEvent): void => {
		const backendNodeId = event.backendNodeId;
		const chooser: CaughtFileChooser = {
			backendNodeId,
			frameId: event.frameId,
			multiple: event.mode === "selectMultiple",
			betweenCalls: false,
			input: backendNodeId === undefined ? Promise.resolve(undefined) : this.#readInput(backendNodeId),
		};
		if (this.#claim?.(chooser) || this.#rawWaits > 0) return;
		this.#unreported.push(chooser);
		if (backendNodeId === undefined) return;
		this.#holdUntilAnswered(chooser, backendNodeId);
		void chooser.input.then(input => {
			if (this.#held !== chooser || this.#answering.has(chooser)) return;
			const state = chooserState(chooser, input);
			for (const listener of this.#onHeld) listener(state);
		});
	};

	readonly #onNavigated = (event: Protocol.Page.FrameNavigatedEvent): void => {
		if (event.frame.parentId !== undefined) return;
		this.#held = undefined;
		this.#unreported = [];
	};

	/**
	 * Holds `chooser` until something answers its input: this catcher, or another that Chrome told about it too
	 * (another attachment to the page, raw Puppeteer), which this one would otherwise never hear of.
	 */
	#holdUntilAnswered(chooser: CaughtFileChooser, backendNodeId: number): void {
		this.#held = chooser;
		void this.#onInput(backendNodeId, undefined, objectId =>
			this.#session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration:
					"function () { return new Promise(answered => { this.addEventListener('change', answered, { once: true }); this.addEventListener('cancel', answered, { once: true }); }); }",
				awaitPromise: true,
			}),
		).then(
			() => {
				if (this.#held === chooser) this.#held = undefined;
			},
			() => undefined,
		);
	}

	/** The input's `accept` filter and folder flag, bounded so a page stopped in a dialog cannot hold it up. */
	#readInput(backendNodeId: number): Promise<InputDescription | undefined> {
		const read = this.#onInput(backendNodeId, undefined, async objectId => {
			const { result } = await this.#session.send("Runtime.callFunctionOn", {
				objectId,
				functionDeclaration:
					"function () { return { accept: this.accept || '', webkitdirectory: !!this.webkitdirectory }; }",
				returnByValue: true,
			});
			return result.value as InputDescription;
		}).catch(() => undefined);
		return Promise.race([read, Bun.sleep(DESCRIBE_TIMEOUT_MS).then(() => undefined)]);
	}

	/** Run `use` on the input's remote object, then release it. */
	async #onInput<T>(
		backendNodeId: number,
		signal: AbortSignal | undefined,
		use: (objectId: string) => Promise<T>,
	): Promise<T> {
		const { object } = await untilAborted(signal, () => this.#session.send("DOM.resolveNode", { backendNodeId }));
		const objectId = object.objectId;
		if (!objectId) throw new ToolError("The file chooser's input is gone");
		try {
			return await untilAborted(signal, () => use(objectId));
		} finally {
			void this.#session.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
		}
	}
}
