import type { DownloadSnapshot } from "./protocol";

/** Emits a synthesized CDP event onto every page session of one tab. */
export type EmitTabEvent = (
	tabKey: string,
	method: "Browser.downloadWillBegin" | "Browser.downloadProgress",
	params: Record<string, unknown>,
) => void;

interface TabDownload {
	tabKey: string;
	guid: string;
	url: string;
	/** Paired `chrome.downloads` item id. */
	itemId?: number;
	receivedBytes: number;
	totalBytes: number;
	/** Bytes in the last in-progress report; both sources repeat themselves. */
	reportedBytes: number;
	done: boolean;
	/** Armed when the debugger reported completion before any item paired. */
	grace?: NodeJS.Timeout;
}

/** `chrome.downloads` items no tab has claimed yet, kept for a start event that is still on its way. */
const UNPAIRED_LIMIT = 64;
/**
 * How long a debugger-reported completion waits for its `chrome.downloads`
 * item before it is reported without a path. Both travel the same extension
 * socket and the item is created first, so this only matters for an extension
 * build without `chrome.downloads`.
 */
const ITEM_GRACE_MS = 1_000;

function text(params: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = params?.[key];
	return typeof value === "string" ? value : undefined;
}

function count(params: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = params?.[key];
	return typeof value === "number" ? value : undefined;
}

function sameUrl(item: DownloadSnapshot, url: string): boolean {
	return item.finalUrl === url || item.url === url;
}

/**
 * Pairs one browser's downloads with the tab that started them, and reports
 * them to that tab's page sessions as CDP's own `Browser.downloadWillBegin` /
 * `Browser.downloadProgress` (with `filePath` on completion).
 *
 * `chrome.debugger` names the tab (`Page.downloadWillBegin`, on the tab's root
 * or a child-frame session) but never the saved file; `chrome.downloads` names
 * the file and its final state but never the tab. They meet on the download
 * URL. A running download's progress events are tab traffic, so the idle detach
 * never drops the debugger under one. Downloads no leased tab's debugger saw
 * (another tab, or one started while detached) never pair and are never
 * reported.
 */
export class DownloadAttribution {
	readonly #emit: EmitTabEvent;
	readonly #byGuid = new Map<string, TabDownload>();
	readonly #byItem = new Map<number, TabDownload>();
	/** Latest snapshot of every unpaired item, oldest first. */
	readonly #unpaired = new Map<number, DownloadSnapshot>();

	constructor(emit: EmitTabEvent) {
		this.#emit = emit;
	}

	/** `Page.downloadWillBegin` from any debugger session of `tabKey`. */
	began(tabKey: string, params: Record<string, unknown> | undefined): void {
		const guid = text(params, "guid");
		const url = text(params, "url");
		if (!guid || url === undefined || this.#byGuid.has(guid)) return;
		const download: TabDownload = {
			tabKey,
			guid,
			url,
			receivedBytes: 0,
			totalBytes: 0,
			reportedBytes: 0,
			done: false,
		};
		this.#byGuid.set(guid, download);
		this.#emit(tabKey, "Browser.downloadWillBegin", {
			frameId: text(params, "frameId") ?? "",
			guid,
			url,
			suggestedFilename: text(params, "suggestedFilename") ?? "",
		});
		for (const item of this.#unpaired.values()) {
			if (!sameUrl(item, url)) continue;
			this.#unpaired.delete(item.id);
			this.#pair(download, item);
			return;
		}
	}

	/** `Page.downloadProgress` from any debugger session. */
	progressed(params: Record<string, unknown> | undefined): void {
		const download = this.#byGuid.get(text(params, "guid") ?? "");
		if (!download || download.done) return;
		download.receivedBytes = count(params, "receivedBytes") ?? download.receivedBytes;
		download.totalBytes = count(params, "totalBytes") ?? download.totalBytes;
		const state = text(params, "state");
		if (state === "canceled") {
			this.#finish(download, "canceled");
			return;
		}
		if (state === "completed") {
			// The saved path comes from the item; its `complete` finishes this one.
			if (download.itemId === undefined && !download.grace)
				download.grace = setTimeout(() => this.#finish(download, "completed"), ITEM_GRACE_MS);
			return;
		}
		this.#progress(download);
	}

	/** A `chrome.downloads` item was created or changed. */
	item(item: DownloadSnapshot): void {
		const paired = this.#byItem.get(item.id);
		if (paired) {
			this.#apply(paired, item);
			return;
		}
		for (const download of this.#byGuid.values()) {
			if (download.itemId !== undefined || download.done || !sameUrl(item, download.url)) continue;
			this.#pair(download, item);
			return;
		}
		this.#unpaired.delete(item.id);
		this.#unpaired.set(item.id, item);
		if (this.#unpaired.size > UNPAIRED_LIMIT) this.#unpaired.delete(this.#unpaired.keys().next().value!);
	}

	/** The tab is gone: nobody is left to report its downloads to. */
	forgetTab(tabKey: string): void {
		for (const download of this.#byGuid.values()) {
			if (download.tabKey !== tabKey) continue;
			clearTimeout(download.grace);
			this.#byGuid.delete(download.guid);
			if (download.itemId !== undefined) this.#byItem.delete(download.itemId);
		}
	}

	#pair(download: TabDownload, item: DownloadSnapshot): void {
		download.itemId = item.id;
		this.#byItem.set(item.id, download);
		this.#apply(download, item);
	}

	#apply(download: TabDownload, item: DownloadSnapshot): void {
		if (download.done) return;
		download.receivedBytes = Math.max(download.receivedBytes, item.bytesReceived);
		if (item.totalBytes > 0) download.totalBytes = item.totalBytes;
		if (item.state === "complete") this.#finish(download, "completed", item.filename);
		else if (item.state === "interrupted") this.#finish(download, "canceled");
		else this.#progress(download);
	}

	#progress(download: TabDownload): void {
		if (download.reportedBytes === download.receivedBytes) return;
		download.reportedBytes = download.receivedBytes;
		this.#emit(download.tabKey, "Browser.downloadProgress", {
			guid: download.guid,
			totalBytes: download.totalBytes,
			receivedBytes: download.receivedBytes,
			state: "inProgress",
		});
	}

	#finish(download: TabDownload, state: "completed" | "canceled", filePath?: string): void {
		if (download.done) return;
		download.done = true;
		clearTimeout(download.grace);
		this.#byGuid.delete(download.guid);
		if (download.itemId !== undefined) this.#byItem.delete(download.itemId);
		this.#emit(download.tabKey, "Browser.downloadProgress", {
			guid: download.guid,
			totalBytes: download.totalBytes,
			receivedBytes: download.receivedBytes,
			state,
			...(filePath ? { filePath } : {}),
		});
	}
}
