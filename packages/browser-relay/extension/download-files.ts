import { type DownloadFileCandidate, type DownloadFileLookup, type DownloadFileQuery, isDownloadFileQueries } from "../../coding-agent/src/tools/browser/relay/protocol";

interface DownloadItem {
	id: number;
	filename: string;
	url: string;
	finalUrl: string;
	referrer: string;
	startTime: string;
	state: "in_progress" | "complete" | "interrupted";
	bytesReceived: number;
	totalBytes: number;
	exists: boolean;
}

export interface DownloadFilesApi {
	permissions: { contains(request: { permissions: string[] }): Promise<boolean> };
	downloads: { search(query: { startedAfter: string; startedBefore: string; limit: number; orderBy: string[] }): Promise<DownloadItem[]> };
}

/** Bounded read-only correlation. Neither a filename nor a time match proves tab ownership. */
export async function findDownloadFiles(queries: DownloadFileQuery[], api: DownloadFilesApi): Promise<DownloadFileLookup> {
	if (!isDownloadFileQueries(queries)) throw new Error("Invalid observed-download queries");
	if (!(await api.permissions.contains({ permissions: ["downloads"] })))
		return { available: false, reason: "Saved download paths are not enabled. In this OMP extension's settings, choose Enable download file lookup and approve Chrome's permission prompt." };
	const matches: Array<{ id: string; truncated: boolean; candidates: DownloadFileCandidate[] }> = [];
	for (const query of queries) {
		const lower = Math.max(0, query.startedAt - 5000), upper = query.startedAt + 5000;
		const rows = await api.downloads.search({ startedAfter: new Date(lower).toISOString(), startedBefore: new Date(upper).toISOString(), limit: 101, orderBy: ["-startTime"] });
		const candidates = rows.slice(0, 100).filter(row => {
			const at = Date.parse(row.startTime);
			return Number.isFinite(at) && at >= lower && at <= upper && (row.url === query.url || row.finalUrl === query.url);
		}).map(row => ({ id: row.id, path: row.filename, url: row.url, finalUrl: row.finalUrl, referrer: row.referrer, startedAt: Date.parse(row.startTime), state: row.state, bytesReceived: row.bytesReceived, totalBytes: row.totalBytes, exists: row.exists }));
		matches.push({ id: query.id, truncated: rows.length > 100, candidates });
	}
	return { available: true, correlation: "url-and-time-candidates", matches };
}
