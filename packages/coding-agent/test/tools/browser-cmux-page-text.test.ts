import { describe, expect, it, spyOn } from "bun:test";
import { CmuxTab } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/cmux-tab";
import { CmuxSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/cmux/socket-client";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

describe.skipIf(!CHROMIUM_AVAILABLE)("cmux page reads", () => {
	it("read the page body without a selector, keep empty rendered text empty, and wait only for rendered scoped text", async () => {
		const browserHandle = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
		if (!("browser" in browserHandle)) throw new Error("Expected a Puppeteer browser");
		const page = await browserHandle.browser.newPage();
		// cmux evaluates its scripts in the page; Chromium stands in for the surface.
		const request = spyOn(CmuxSocketClient.prototype, "request").mockImplementation(
			async (_method: string, params?: Record<string, unknown>) => ({
				value: await page.evaluate(String(params?.script)),
			}),
		);
		try {
			const tab = new CmuxTab({
				client: new CmuxSocketClient({ socketPath: "/tmp/unused-cmux-page-text.sock" }),
				surfaceId: "page-text",
			});
			await page.setContent("<p>Hello <b>page</b></p>");
			expect(await tab.text()).toBe("Hello page");
			expect(await tab.html()).toBe("<p>Hello <b>page</b></p>");
			// Only script and hidden text: the rendered text is empty, and so is the read.
			await page.setContent('<script>var source = "inline";</script><div hidden>secret</div>');
			expect(await tab.text()).toBe("");
			// A scoped wait finds no text in an element the page does not render.
			await page.setContent('<div id="x" hidden>secret</div><p id="y">shown</p>');
			const refused = (await rejectionOf(tab.waitForText("secret", { selector: "#x", timeout: 300 }))) as Error;
			expect(refused.message).toContain("timed out");
			await tab.waitForText("shown", { selector: "#y" });
		} finally {
			request.mockRestore();
			await page.close().catch(() => undefined);
			if (browserHandle.browser.connected) await releaseBrowser(browserHandle, { kill: true });
		}
	}, 30_000);
});
