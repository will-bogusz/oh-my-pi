import { expect, it } from "bun:test";
import { type DownloadFilesApi, findDownloadFiles } from "../extension/download-files";

const startedAt = 1788751000000;
const query = { id: "observed-guid", url: "https://example.com/receipt", startedAt };
function item(id: number, overrides: Record<string, unknown> = {}) {
	return {
		id,
		filename: `/downloads/receipt (${id}).txt`,
		url: query.url,
		finalUrl: query.url,
		referrer: "https://example.com/review",
		startTime: new Date(startedAt).toISOString(),
		state: "complete" as const,
		bytesReceived: 127,
		totalBytes: 127,
		exists: true,
		...overrides,
	};
}

it("reports missing permission without reading records or asking for permission", async () => {
	let searches = 0;
	const result = await findDownloadFiles([query], {
		permissions: { contains: async () => false },
		downloads: {
			search: async () => {
				searches++;
				return [];
			},
		},
	});
	expect(result).toMatchObject({ available: false, reason: expect.stringContaining("extension's settings") });
	expect(searches).toBe(0);
});

it("keeps ambiguous actual filenames and excludes unrelated URL or time records", async () => {
	const requests: unknown[] = [];
	const api: DownloadFilesApi = {
		permissions: { contains: async () => true },
		downloads: {
			search: async request => {
				requests.push(request);
				return [
					item(1),
					item(2, { url: "https://example.com/redirect" }),
					item(3, { finalUrl: "https://unrelated.com/", url: "https://unrelated.com/" }),
					item(4, { startTime: new Date(startedAt - 6000).toISOString() }),
				];
			},
		},
	};
	const result = await findDownloadFiles([query], api);
	if (!result.available) throw new Error(result.reason);
	expect(result.correlation).toBe("url-and-time-candidates");
	expect(result.matches[0]!.candidates.map(candidate => candidate.path)).toEqual([
		"/downloads/receipt (1).txt",
		"/downloads/receipt (2).txt",
	]);
	expect(requests).toEqual([
		{
			startedAfter: new Date(startedAt - 5000).toISOString(),
			startedBefore: new Date(startedAt + 5000).toISOString(),
			limit: 101,
			orderBy: ["-startTime"],
		},
	]);
});

it("reports truncated searches as incomplete even when no returned row matches", async () => {
	const result = await findDownloadFiles([query], {
		permissions: { contains: async () => true },
		downloads: {
			search: async () =>
				Array.from({ length: 101 }, (_, id) =>
					item(id, { url: "https://unrelated.com/", finalUrl: "https://unrelated.com/" }),
				),
		},
	});
	expect(result).toMatchObject({ available: true, matches: [{ id: query.id, truncated: true, candidates: [] }] });
});
