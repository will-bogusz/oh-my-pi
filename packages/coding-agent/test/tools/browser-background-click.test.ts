import { expect, it } from "bun:test";
import { clickNode } from "@oh-my-pi/pi-coding-agent/tools/browser/cdp";
import { readPageMetrics } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type CDPSession } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

const BOX = { content: [0, 0, 40, 0, 40, 20, 0, 20], border: [0, 0, 40, 0, 40, 20, 0, 20] };

// An action that outran its deadline must be over: a scroll that only finishes
// afterwards may not go on to dispatch the click the caller already gave up on.
it("does not dispatch a timed-out click when scrolling later completes", async () => {
	const started = Promise.withResolvers<void>();
	const scroll = Promise.withResolvers<void>();
	const finished = Promise.withResolvers<void>();
	const sent: string[] = [];
	const session = {
		send: async (method: string) => {
			sent.push(method);
			if (method === "DOM.scrollIntoViewIfNeeded") {
				started.resolve();
				await scroll.promise;
				finished.resolve();
				return {};
			}
			if (method === "DOM.getBoxModel") return { model: BOX };
			return {};
		},
	} as unknown as CDPSession;
	const deadline = new AbortController();
	const pending = clickNode({ session, backendNodeId: 7, label: "e1" }, 1, deadline.signal);
	await started.promise;
	deadline.abort(new Error("quiet click deadline"));
	await expect(pending).rejects.toThrow("quiet click deadline");
	scroll.resolve();
	await finished.promise;
	await Promise.resolve();
	expect(sent).toEqual(["DOM.scrollIntoViewIfNeeded"]);
});

// A node that is there but has no box is a different failure from a node the
// page dropped, and neither may be reported as a click that happened.
it("refuses to click a node with no box and names the ref", async () => {
	const session = {
		send: async (method: string) => {
			if (method === "DOM.getBoxModel") throw new Error("Could not compute box model.");
			if (method === "DOM.resolveNode") return { object: { objectId: "1" } };
			if (method === "Runtime.callFunctionOn") return { result: { value: true } };
			return {};
		},
	} as unknown as CDPSession;
	await expect(clickNode({ session, backendNodeId: 7, label: "e12" }, 1)).rejects.toThrow(
		"e12 has no box to act on",
	);
});

// Cancellation is re-checked after the geometry read: a lease released while
// the box was being measured must not still land a click.
it("checks cancellation again after geometry and before trusted pointer input", async () => {
	const deadline = new AbortController();
	const sent: string[] = [];
	const session = {
		send: async (method: string) => {
			sent.push(method);
			if (method === "DOM.getBoxModel") {
				deadline.abort(new Error("lease released"));
				return { model: BOX };
			}
			return {};
		},
	} as unknown as CDPSession;
	await expect(clickNode({ session, backendNodeId: 7, label: "e1" }, 1, deadline.signal)).rejects.toThrow(
		"lease released",
	);
	expect(sent).toEqual(["DOM.scrollIntoViewIfNeeded", "DOM.getBoxModel"]);
});

// Opt-in real Chromium regression, without a visible browser or user profile.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"clicks with trusted input while real Puppeteer waits on a suspended intersection observer",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
			defaultViewport: null,
			args: ["--window-size=1000,900"],
		});
		try {
			const page = await browser.newPage();
			expect(page.viewport()).toBeNull();
			expect((await readPageMetrics(page)).viewport.width).toBe(1000);
			await page.setContent(
				'<div style="height:1800px"></div><input type="checkbox" data-events="" onclick="this.dataset.events += event.isTrusted + String.fromCharCode(44)">',
			);
			const handle = await page.$("input");
			if (!handle) throw new Error("missing test checkbox");
			// Puppeteer's action decorators transfer the handle into its utility world.
			const utility = (
				page.mainFrame() as unknown as { isolatedRealm(): { evaluate(script: string): Promise<unknown> } }
			).isolatedRealm();
			await utility.evaluate(
				"globalThis.observerWaits=0; globalThis.IntersectionObserver=class { observe(){globalThis.observerWaits++} disconnect(){} }",
			);
			let originalFinished = false;
			void handle.click().then(
				() => {
					originalFinished = true;
				},
				() => {},
			);
			for (let i = 0; i < 100; i++) {
				if ((await utility.evaluate("globalThis.observerWaits")) === 1) break;
				await Bun.sleep(10);
			}
			expect(await utility.evaluate("globalThis.observerWaits")).toBe(1);
			expect(originalFinished).toBe(false);
			expect(await page.evaluate("document.querySelector('input').dataset.events")).toBe("");
			const session = page.mainFrame().client;
			const described = await session.send("DOM.describeNode", { objectId: handle.id! });
			await clickNode(
				{ session, backendNodeId: described.node.backendNodeId, label: "e1" },
				1,
				AbortSignal.timeout(2000),
			);
			expect(await page.evaluate("document.querySelector('input').checked")).toBe(true);
			expect(await page.evaluate("document.querySelector('input').dataset.events")).toBe("true,");
			expect(originalFinished).toBe(false);
			expect(await utility.evaluate("globalThis.observerWaits")).toBe(1);
		} finally {
			await browser.close();
		}
	},
	15_000,
);
