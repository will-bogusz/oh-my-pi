import type { CDPSession, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

export interface TabDownload {
	id: string;
	url: string;
	frameId: string;
	suggestedFilename: string;
	startedAt: number;
	state: "started" | "inProgress" | "completed" | "canceled";
	receivedBytes?: number;
	totalBytes?: number;
}

export interface TabDownloads {
	/** Events before this acquisition are not observed. */
	since: number;
	omitted: number;
	entries: TabDownload[];
}

/** Passive page-scoped events; never changes a browser's download settings. */
export class TabDownloadMonitor {
	readonly #since = Date.now();
	readonly #entries = new Map<string, TabDownload>();
	#omitted = 0;
	#disconnected = false;

	static async connect(page: Page): Promise<TabDownloadMonitor> {
		const session = await page.createCDPSession();
		const monitor = new TabDownloadMonitor(session);
		try {
			await session.send("Page.enable");
			return monitor;
		} catch (error) {
			await monitor.dispose().catch(() => undefined);
			throw error;
		}
	}

	constructor(readonly session: CDPSession) {
		session.on("Page.downloadWillBegin", event => {
			if (this.#entries.has(event.guid)) return;
			if (this.#entries.size >= 256) {
				this.#entries.delete(this.#entries.keys().next().value!);
				this.#omitted++;
			}
			this.#entries.set(event.guid, {
				id: event.guid,
				url: event.url,
				frameId: event.frameId,
				suggestedFilename: event.suggestedFilename,
				startedAt: Date.now(),
				state: "started",
			});
		});
		session.on("Page.downloadProgress", event => {
			const download = this.#entries.get(event.guid);
			if (!download || download.state === "completed" || download.state === "canceled") return;
			download.state = event.state;
			download.receivedBytes = event.receivedBytes;
			download.totalBytes = event.totalBytes;
		});
	}

	snapshot(): TabDownloads {
		if (this.#disconnected || this.session.detached)
			throw new ToolError("Download observation disconnected. Completion of ongoing downloads is unknown.");
		return {
			since: this.#since,
			omitted: this.#omitted,
			entries: [...this.#entries.values()].map(entry => ({ ...entry })),
		};
	}

	async dispose(): Promise<void> {
		this.#disconnected = true;
		this.session.removeAllListeners();
		if (!this.session.detached) await this.session.detach();
	}
}
