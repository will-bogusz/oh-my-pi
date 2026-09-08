import { expect, it } from "bun:test";
import {
	acquireBrowser,
	getBrowsersMapForTest,
	releaseBrowser,
} from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, getTab, releaseTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

it.skipIf(!(await chromiumAvailable()))(
	"a failed preserving-release callback still drains the worker and browser hold",
	async () => {
		const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: import.meta.dir });
		const name = `recovery-cleanup-${crypto.randomUUID()}`;
		let callbacks = 0;
		try {
			await acquireTab(name, browser, {
				timeoutMs: 5000,
				onRelease: async () => {
					callbacks++;
					throw new Error("Remote recovery unconfirmed");
				},
			});
			await expect(releaseTab(name)).rejects.toThrow("Remote recovery unconfirmed");
			expect(callbacks).toBe(1);
			expect(getTab(name)).toBeUndefined();
			expect(getBrowsersMapForTest().has(browser.key)).toBe(false);
			if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
			expect(browser.browser.connected).toBe(false);
			await releaseTab(name);
			expect(callbacks).toBe(1);
		} finally {
			await releaseTab(name).catch(() => undefined);
			await releaseBrowser(browser, { kill: false });
		}
	},
	15000,
);
