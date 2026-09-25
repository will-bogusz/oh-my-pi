import { expect, it } from "bun:test";
import { DownloadAttribution } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/downloads";
import type { DownloadSnapshot } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";

function item(overrides: Partial<DownloadSnapshot>): DownloadSnapshot {
	return {
		id: 1,
		url: "https://console.example/export",
		finalUrl: "https://cdn.example/export.json",
		filename: "",
		state: "in_progress",
		bytesReceived: 0,
		totalBytes: 10,
		...overrides,
	};
}

function recorder() {
	const events: { tabKey: string; method: string; params: Record<string, unknown> }[] = [];
	const attribution = new DownloadAttribution((tabKey, method, params) => events.push({ tabKey, method, params }));
	return { attribution, events };
}

it("pairs an item that arrives before the tab's start event, by its redirected URL", () => {
	const { attribution, events } = recorder();
	attribution.item(item({}));
	attribution.began("a:1", { guid: "g1", url: "https://cdn.example/export.json", suggestedFilename: "export.json" });
	attribution.item(item({ state: "complete", bytesReceived: 10, filename: "/Users/me/Downloads/export.json" }));
	expect(events.map(event => [event.tabKey, event.method, event.params.state])).toEqual([
		["a:1", "Browser.downloadWillBegin", undefined],
		["a:1", "Browser.downloadProgress", "completed"],
	]);
	expect(events[1]!.params).toMatchObject({
		guid: "g1",
		receivedBytes: 10,
		filePath: "/Users/me/Downloads/export.json",
	});
});

it("reports an interrupted item as canceled once, and never reports a download no tab started", () => {
	const { attribution, events } = recorder();
	attribution.item(
		item({ id: 7, url: "https://elsewhere.example/a.zip", finalUrl: "https://elsewhere.example/a.zip" }),
	);
	attribution.began("a:1", { guid: "g1", url: "https://console.example/export" });
	attribution.item(item({ state: "interrupted" }));
	attribution.progressed({ guid: "g1", state: "canceled", receivedBytes: 0 });
	attribution.item(item({ id: 7, url: "https://elsewhere.example/a.zip", state: "complete", filename: "/x/a.zip" }));
	expect(events.filter(event => event.method === "Browser.downloadProgress").map(event => event.params.state)).toEqual(
		["canceled"],
	);
	expect(events.every(event => event.params.guid === "g1")).toBe(true);
});
