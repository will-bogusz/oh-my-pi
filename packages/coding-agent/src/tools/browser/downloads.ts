import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Completed download metadata returned by tab download helpers. */
export interface BrowserDownload {
	/** Absolute path of the saved file; absent in the user's Chrome, which saves into its own download folder. */
	path?: string;
	suggestedFilename: string;
	url: string;
	bytes: number;
}

/** What a tab's `downloads()` / `waitForDownload()` read from. */
export interface TabDownloadSource {
	/** Wait for the next unclaimed completed download. */
	wait(signal?: AbortSignal): Promise<BrowserDownload>;
	/** Return every completed download for this tab. */
	list(): BrowserDownload[];
	/** Detach event listeners and reject outstanding waits. */
	close(): Promise<void>;
}

interface DownloadStarted {
	guid: string;
	url: string;
	suggestedFilename: string;
}

interface DownloadProgress {
	guid: string;
	state: "inProgress" | "completed" | "canceled";
	receivedBytes: number;
}

interface PendingDownload extends DownloadStarted {
	receivedBytes: number;
}

interface DownloadWaiter {
	resolve(value: BrowserDownload): void;
	reject(error: unknown): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

/**
 * Completion bookkeeping both sources share: completed downloads in arrival
 * order, the ones no wait has claimed yet, and the waits in line for the next.
 */
class DownloadQueue {
	readonly #completed: BrowserDownload[] = [];
	readonly #unclaimed: BrowserDownload[] = [];
	readonly #waiters: DownloadWaiter[] = [];

	list(): BrowserDownload[] {
		return this.#completed.map(download => ({ ...download }));
	}

	async next(signal?: AbortSignal): Promise<BrowserDownload> {
		const ready = this.#unclaimed.shift();
		if (ready) return { ...ready };
		if (signal?.aborted) throw signal.reason;
		return await new Promise<BrowserDownload>((resolve, reject) => {
			const waiter: DownloadWaiter = { resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					this.#removeWaiter(waiter);
					reject(signal.reason);
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.#waiters.push(waiter);
		});
	}

	complete(download: BrowserDownload): void {
		this.#completed.push(download);
		const waiter = this.#waiters.shift();
		if (!waiter) {
			this.#unclaimed.push(download);
			return;
		}
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.resolve({ ...download });
	}

	rejectNext(error: ToolError): void {
		const waiter = this.#waiters.shift();
		if (!waiter) return;
		if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
		waiter.reject(error);
	}

	rejectAll(error: ToolError): void {
		for (const waiter of this.#waiters.splice(0)) {
			if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.reject(error);
		}
	}

	#removeWaiter(waiter: DownloadWaiter): void {
		const index = this.#waiters.indexOf(waiter);
		if (index >= 0) this.#waiters.splice(index, 1);
	}
}

/** Owns tab-scoped Chromium download behavior and completion events. */
export class DownloadManager implements TabDownloadSource {
	readonly #browser: Browser;
	readonly #page: Page;
	readonly #defaultDirectory: string;
	#directory?: string;
	#session?: CDPSession;
	#frameId?: string;
	readonly #pending = new Map<string, PendingDownload>();
	readonly #queue = new DownloadQueue();
	#willBegin?: (event: DownloadStarted & { frameId?: string }) => void;
	#progress?: (event: DownloadProgress) => void;

	constructor(browser: Browser, page: Page, tabId: string) {
		this.#browser = browser;
		this.#page = page;
		this.#defaultDirectory = path.join(os.tmpdir(), `omp-downloads-${tabId}`);
	}

	/** Enable downloads into an absolute directory, replacing the previous destination. */
	async enable(directory?: string): Promise<void> {
		const resolved = path.resolve(directory ?? this.#defaultDirectory);
		await fs.mkdir(resolved, { recursive: true });
		if (!this.#session) await this.#attach();
		const context = this.#page.browserContext() as { id?: string };
		await this.#session!.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: resolved,
			eventsEnabled: true,
			...(context.id ? { browserContextId: context.id } : {}),
		});
		this.#directory = resolved;
	}

	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		if (!this.#session) await this.enable();
		return await this.#queue.next(signal);
	}

	list(): BrowserDownload[] {
		return this.#queue.list();
	}

	async close(): Promise<void> {
		const session = this.#session;
		if (!session) return;
		if (this.#willBegin) session.off("Browser.downloadWillBegin", this.#willBegin);
		if (this.#progress) session.off("Browser.downloadProgress", this.#progress);
		this.#queue.rejectAll(new ToolError("Tab closed while waiting for a download"));
		this.#session = undefined;
		await session.detach().catch(() => undefined);
	}

	async #attach(): Promise<void> {
		const pageSession = await this.#page.createCDPSession();
		try {
			const tree = (await pageSession.send("Page.getFrameTree")) as { frameTree?: { frame?: { id?: string } } };
			this.#frameId = tree.frameTree?.frame?.id;
		} finally {
			await pageSession.detach().catch(() => undefined);
		}
		const session = await this.#browser.target().createCDPSession();
		this.#willBegin = event => {
			if (this.#frameId && event.frameId && event.frameId !== this.#frameId) return;
			this.#pending.set(event.guid, { ...event, receivedBytes: 0 });
		};
		this.#progress = event => {
			const pending = this.#pending.get(event.guid);
			if (!pending) return;
			pending.receivedBytes = event.receivedBytes;
			if (event.state === "inProgress") return;
			this.#pending.delete(event.guid);
			if (event.state === "canceled") {
				this.#queue.rejectNext(new ToolError(`Download canceled: ${pending.url}`));
				return;
			}
			void this.#complete(pending);
		};
		session.on("Browser.downloadWillBegin", this.#willBegin);
		session.on("Browser.downloadProgress", this.#progress);
		this.#session = session;
	}

	async #complete(pending: PendingDownload): Promise<void> {
		const directory = this.#directory ?? this.#defaultDirectory;
		const downloadPath = path.join(directory, pending.suggestedFilename);
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				await fs.stat(downloadPath);
				break;
			} catch {
				await Bun.sleep(10);
			}
		}
		this.#queue.complete({
			path: downloadPath,
			suggestedFilename: pending.suggestedFilename,
			url: pending.url,
			bytes: pending.receivedBytes,
		});
	}
}

/**
 * Downloads of a tab in the user's own Chrome, read from page-scoped events.
 * Passive: it never changes the browser's download settings, so files land
 * wherever the user's Chrome puts them and no path is reported.
 */
export class TabDownloadMonitor implements TabDownloadSource {
	readonly #pending = new Map<string, PendingDownload>();
	readonly #queue = new DownloadQueue();
	#disconnected = false;

	static async connect(page: Page): Promise<TabDownloadMonitor> {
		const session = await page.createCDPSession();
		const monitor = new TabDownloadMonitor(session);
		try {
			await session.send("Page.enable");
			return monitor;
		} catch (error) {
			await monitor.close().catch(() => undefined);
			throw error;
		}
	}

	constructor(readonly session: CDPSession) {
		session.on("Page.downloadWillBegin", event => {
			if (this.#pending.has(event.guid)) return;
			this.#pending.set(event.guid, {
				guid: event.guid,
				url: event.url,
				suggestedFilename: event.suggestedFilename,
				receivedBytes: 0,
			});
		});
		session.on("Page.downloadProgress", event => {
			const pending = this.#pending.get(event.guid);
			if (!pending) return;
			pending.receivedBytes = event.receivedBytes;
			if (event.state === "inProgress") return;
			this.#pending.delete(event.guid);
			if (event.state === "canceled") {
				this.#queue.rejectNext(new ToolError(`Download canceled: ${pending.url}`));
				return;
			}
			this.#queue.complete({
				suggestedFilename: pending.suggestedFilename,
				url: pending.url,
				bytes: pending.receivedBytes,
			});
		});
	}

	async wait(signal?: AbortSignal): Promise<BrowserDownload> {
		this.#assertConnected();
		return await this.#queue.next(signal);
	}

	list(): BrowserDownload[] {
		this.#assertConnected();
		return this.#queue.list();
	}

	async close(): Promise<void> {
		this.#disconnected = true;
		this.session.removeAllListeners();
		this.#queue.rejectAll(new ToolError("Tab closed while waiting for a download"));
		if (!this.session.detached) await this.session.detach();
	}

	#assertConnected(): void {
		if (this.#disconnected || this.session.detached)
			throw new ToolError("Download observation disconnected. Completion of ongoing downloads is unknown.");
	}
}
