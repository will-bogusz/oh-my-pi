import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { TabDownloadMonitor } from "@oh-my-pi/pi-coding-agent/tools/browser/downloads";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it.skipIf(!CHROMIUM_AVAILABLE)(
	"observes page-scoped completion and cancellation without changing download settings, and refuses stale state after detach",
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
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const control = await browser.target().createCDPSession();
			await control.send("Browser.setDownloadBehavior", {
				behavior: "allow",
				downloadPath: directory,
				eventsEnabled: true,
			});
			const page = await browser.newPage();
			const other = await browser.newPage();
			await page.goto(`http://127.0.0.1:${server.port}/`);
			await other.goto(page.url());
			const monitor = await TabDownloadMonitor.connect(page);
			const otherMonitor = await TabDownloadMonitor.connect(other);
			try {
				await other.emulateFocusedPage(true);
				await other.click("a");
				await otherMonitor.wait(AbortSignal.timeout(5000));
				await other.emulateFocusedPage(false);
				expect(monitor.list()).toEqual([]);
				await page.emulateFocusedPage(true);
				await page.click("a");
				const completed = await monitor.wait(AbortSignal.timeout(5000));
				expect(completed).toEqual({
					suggestedFilename: "receipt.txt",
					url: `http://127.0.0.1:${server.port}/file`,
					bytes: new TextEncoder().encode("download verified — café Ω").length,
				});
				expect(await Bun.file(path.join(directory, "receipt.txt")).text()).toBe("download verified — café Ω");
				completed.bytes = 0;
				expect(monitor.list()[0]!.bytes).toBeGreaterThan(0);
				await page.$eval("a", element => element.setAttribute("href", "/slow"));
				const began = new Promise<string>(resolve =>
					control.once("Browser.downloadWillBegin", event => resolve(event.guid)),
				);
				const canceled = monitor.wait(AbortSignal.timeout(5000)).then(
					() => "completed",
					(error: Error) => error.message,
				);
				await page.click("a");
				await control.send("Browser.cancelDownload", { guid: await began });
				expect(await canceled).toContain("Download canceled");
				expect(await Bun.file(path.join(directory, "pending.txt")).exists()).toBe(false);
				expect(monitor.list()).toHaveLength(1);
				await monitor.session.detach();
				expect(() => monitor.list()).toThrow("disconnected");
			} finally {
				await monitor.close();
				await otherMonitor.close();
			}
		} finally {
			await browser.close();
			server.stop(true);
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
	15000,
);
