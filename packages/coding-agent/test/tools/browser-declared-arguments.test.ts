import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser, releaseBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { acquireTab, releaseTab, runInTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({ "browser.enabled": true }),
	};
}

// `observe({ print: false })` used to be ignored and print the whole tree
// anyway. An option the declarations do not name is refused, and the refusal
// names the options they do.
describe("undeclared browser options", () => {
	it("are refused on prelude verbs before any browser work", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "undeclared-options" };
		// With no relay configured, a discover that got through would fail on the relay instead.
		await expect(prelude.invoke({ action: "discover", print: false }, context)).rejects.toThrow(
			/"print"[^]*\bbrowserId\b/,
		);
		await expect(prelude.invoke({ action: "create", observation: { print: false } }, context)).rejects.toThrow(
			/"print"[^]*\bdisplay\b/,
		);
		await expect(
			prelude.invoke({ action: "claim", selector: { title: "Mail", name: "Inbox" } }, context),
		).rejects.toThrow(/"name"[^]*\btitle\b/);
		await expect(prelude.invoke({ action: "run", name: "x", code: "return 1", retries: 2 }, context)).rejects.toThrow(
			/"retries"[^]*\btimeout\b/,
		);
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"are refused on tab helpers and on the element handles they return",
		async () => {
			const browser = await acquireBrowser({ kind: "headless", headless: true }, { cwd: process.cwd() });
			if (!("browser" in browser)) throw new Error("Expected a Puppeteer browser");
			const name = `declared-arguments-${process.pid}-${crypto.randomUUID()}`;
			try {
				await acquireTab(name, browser, {
					url: `data:text/html,${encodeURIComponent("<button>Go</button>")}`,
					timeoutMs: 30_000,
				});
				const result = await runInTab(name, {
					code: `
						const outcome = async call => {
							try {
								await call();
								return "accepted";
							} catch (error) {
								return error.message;
							}
						};
						const { elements } = await tab.observe({ display: false });
						const go = elements.find(element => element.name === "Go");
						return {
							observe: await outcome(() => tab.observe({ print: false })),
							element: await outcome(async () => (await tab.ref(go.ref)).click({ force: true })),
							back: await outcome(() => tab.back({ waitUntil: "load" })),
							declared: await outcome(() => tab.observe({ display: false, compact: true })),
						};
					`,
					timeoutMs: 15_000,
					session: makeSession(),
				});
				const outcomes = result.returnValue as Record<string, string>;
				expect(outcomes.observe).toMatch(/"print"[^]*\bdisplay\b/);
				expect(outcomes.element).toMatch(/"force"[^]*\bcount\b/);
				// back() takes no options: an object past its parameters is refused, not ignored.
				expect(outcomes.back).toMatch(/"waitUntil"[^]*\bnone\b/);
				expect(outcomes.declared).toBe("accepted");
				// The refused observe never ran, so it printed no tree.
				expect(result.displays).toEqual([]);
			} finally {
				await releaseTab(name, { kill: true });
				if (browser.browser.connected) await releaseBrowser(browser, { kill: true });
			}
		},
		45_000,
	);
});
