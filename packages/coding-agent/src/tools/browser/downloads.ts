import type { CDPSession, Page } from "puppeteer-core";
import { ToolError } from "../tool-errors";
import type { DownloadFileLookup, DownloadFileQuery } from "./relay/protocol";

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
	files?: DownloadFileLookup;
}

interface DownloadFileTransport {
	send(method: string, params: Record<string, unknown>): Promise<unknown>;
}

function isFileLookup(value: unknown, queries: DownloadFileQuery[]): value is DownloadFileLookup {
	if (!value || typeof value !== "object") return false;
	const lookup = value as DownloadFileLookup;
	if (lookup.available === false) return typeof lookup.reason === "string";
	if (lookup.available !== true || lookup.correlation !== "url-and-time-candidates" || !Array.isArray(lookup.matches))
		return false;
	const valid = lookup.matches.every(match => {
		if (
			!match ||
			typeof match !== "object" ||
			!queries.some(query => query.id === match.id) ||
			typeof match.truncated !== "boolean" ||
			!Array.isArray(match.candidates) ||
			match.candidates.length > 100
		)
			return false;
		return match.candidates.every(
			file =>
				file &&
				typeof file === "object" &&
				Number.isSafeInteger(file.id) &&
				typeof file.path === "string" &&
				typeof file.url === "string" &&
				typeof file.finalUrl === "string" &&
				typeof file.referrer === "string" &&
				Number.isFinite(file.startedAt) &&
				["in_progress", "complete", "interrupted"].includes(file.state) &&
				Number.isFinite(file.bytesReceived) &&
				Number.isFinite(file.totalBytes) &&
				typeof file.exists === "boolean",
		);
	});
	return (
		valid &&
		lookup.matches.length === queries.length &&
		new Set(lookup.matches.map(match => match.id)).size === queries.length
	);
}

/** Optional extension capability: unsupported services must not invent saved paths. */
export async function lookupDownloadFiles(
	transport: DownloadFileTransport,
	queries: DownloadFileQuery[],
): Promise<DownloadFileLookup> {
	let response: unknown;
	try {
		response = await transport.send("OMP.downloadFiles", { queries });
	} catch (error) {
		return {
			available: false,
			reason: `Saved-path lookup failed. Check the OMP browser service and extension versions: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const lookup = response && typeof response === "object" && "lookup" in response ? response.lookup : undefined;
	return isFileLookup(lookup, queries)
		? lookup
		: {
				available: false,
				reason:
					"Saved-path lookup is unavailable or returned an invalid response. Update both the OMP browser service and this profile's OMP extension.",
			};
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

	async snapshotWithFiles(): Promise<TabDownloads> {
		const snapshot = this.snapshot();
		const files = await lookupDownloadFiles(
			this.session as unknown as DownloadFileTransport,
			snapshot.entries.map(({ id, url, startedAt }) => ({ id, url, startedAt })),
		);
		this.snapshot(); // Do not return file matches from a disconnected acquisition.
		return { ...snapshot, files };
	}

	async dispose(): Promise<void> {
		this.#disconnected = true;
		this.session.removeAllListeners();
		if (!this.session.detached) await this.session.detach();
	}
}
