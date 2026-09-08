import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	lookupDownloadFiles,
	TabDownloadMonitor,
	type TabDownload,
} from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import puppeteer from "puppeteer-core";

async function waitForDownload(monitor: TabDownloadMonitor, state: TabDownload["state"]): Promise<TabDownload> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const entry = monitor.snapshot().entries.find(entry => entry.state === state);
		if (entry) return entry;
		await Bun.sleep(20);
	}
	throw new Error(`No ${state} download: ${JSON.stringify(monitor.snapshot())}`);
}

it.skipIf(!process.env.PI_BROWSER_TEST_EXECUTABLE)(
	"observes page-scoped completion and cancellation by GUID, and refuses stale state after detach",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-download-test-"));
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/slow")
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new Uint8Array(65536).fill(65));
							},
						}),
						{
							headers: {
								"content-type": "text/plain",
								"content-length": "1000000",
								"content-disposition": 'attachment; filename="pending.txt"',
							},
						},
					);
				return new URL(request.url).pathname === "/file"
					? new Response("download verified — café Ω", {
							headers: {
								"content-type": "text/plain",
								"content-disposition": 'attachment; filename="receipt.txt"',
							},
						})
					: new Response('<a href="/file" download>Download</a>', { headers: { "content-type": "text/html" } });
			},
		});
		const browser = await puppeteer.launch({
			executablePath: process.env.PI_BROWSER_TEST_EXECUTABLE,
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const control = await browser.target().createCDPSession();
			await control.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
			const page = await browser.newPage();
			const other = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await other.goto(page.url());
			const monitor = await TabDownloadMonitor.connect(page);
			const otherMonitor = await TabDownloadMonitor.connect(other);
			try {
				await other.emulateFocusedPage(true);
				await other.click("a");
				await waitForDownload(otherMonitor, "completed");
				await other.emulateFocusedPage(false);
				expect(monitor.snapshot().entries).toEqual([]);
				await page.emulateFocusedPage(true);
				await page.click("a");
				const completed = await waitForDownload(monitor, "completed");
				expect(completed.id).not.toBe(otherMonitor.snapshot().entries[0]!.id);
				expect(completed.suggestedFilename).toBe("receipt.txt");
				expect(completed.receivedBytes).toBe(new TextEncoder().encode("download verified — café Ω").length);
				expect(await Bun.file(path.join(directory, "receipt.txt")).text()).toBe("download verified — café Ω");
				completed.state = "canceled";
				expect(monitor.snapshot().entries[0]!.state).toBe("completed");
				await page.$eval("a", element => element.setAttribute("href", "/slow"));
				await page.click("a");
				const pending = await waitForDownload(monitor, "inProgress");
				await control.send("Browser.cancelDownload", { guid: pending.id });
				const canceled = await waitForDownload(monitor, "canceled");
				expect(canceled.id).toBe(pending.id);
				expect(await Bun.file(path.join(directory, "pending.txt")).exists()).toBe(false);
				expect(monitor.snapshot().entries[0]!.state).toBe("completed");
				await monitor.session.detach();
				expect(() => monitor.snapshot()).toThrow("disconnected");
			} finally {
				await monitor.dispose();
				await otherMonitor.dispose();
			}
		} finally {
			await browser.close();
			server.stop(true);
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	15000,
);

it("reports old, malformed, or mismatched file lookup responses without inventing destinations", async () => {
	const queries = [{ id: "owned", url: "https://example.com/file", startedAt: 123 }];
	for (const response of [
		undefined,
		{},
		{ lookup: { available: true, correlation: "url-and-time-candidates", matches: [null] } },
		{
			lookup: {
				available: true,
				correlation: "url-and-time-candidates",
				matches: [{ id: "other", truncated: false, candidates: [] }],
			},
		},
	]) {
		expect(await lookupDownloadFiles({ send: async () => response }, queries)).toMatchObject({ available: false });
	}
	const unavailable = await lookupDownloadFiles(
		{
			send: async () => {
				throw new Error("Method not found");
			},
		},
		queries,
	);
	expect(unavailable).toMatchObject({ available: false, reason: expect.stringContaining("Method not found") });
});
