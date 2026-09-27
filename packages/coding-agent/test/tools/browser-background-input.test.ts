import { expect, it } from "bun:test";
import { fillNode } from "@oh-my-pi/pi-coding-agent/tools/browser/cdp";
import { prepareBackgroundPage, withBackgroundInput } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

declare const document: { hasFocus(): boolean };

/** Puppeteer `Page` stub; the focus restore also watches the page's navigation events. */
function fakePage(overrides: {
	isClosed?: () => boolean;
	emulateFocusedPage: (enabled: boolean) => Promise<void>;
}): Page {
	return { isClosed: () => false, on: () => undefined, off: () => undefined, ...overrides } as unknown as Page;
}

it("keeps a page prepared through selection and serialized inputs, draining before restoration", async () => {
	const events: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const page = fakePage({
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
		},
	});
	const scope = prepareBackgroundPage(page);
	await scope.ready;
	events.push("lookup");
	const first = withBackgroundInput(page, undefined, async () => {
		events.push("first");
		entered.resolve();
		await finish.promise;
		events.push("finished");
	});
	await entered.promise;
	const queued = withBackgroundInput(page, undefined, async () => events.push("too late"));
	const rejected = queued.catch((error: unknown) => String(error));
	const closing = scope.close();
	await Promise.resolve();
	expect(events).toEqual(["enable", "lookup", "first"]);
	finish.resolve();
	await Promise.all([first, closing]);
	expect(await rejected).toContain("operation ended");
	expect(events).toEqual(["enable", "lookup", "first", "finished", "restore"]);
	await scope.close();
	const next = prepareBackgroundPage(page);
	await next.ready;
	await withBackgroundInput(page, undefined, async () => events.push("next"));
	await next.close();
	expect(events.slice(-3)).toEqual(["enable", "next", "restore"]);
});

it("restores late page preparation after cancellation and retries a failed restoration before the next run", async () => {
	const events: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let restoreFails = true;
	const page = fakePage({
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
			if (!enabled) {
				if (restoreFails) throw new Error("connection lost");
				return;
			}
			entered.resolve();
			await finish.promise;
		},
	});
	const cancelled = new AbortController();
	const scope = prepareBackgroundPage(page, cancelled.signal);
	const rejected = scope.ready.catch((error: unknown) => String(error));
	await entered.promise;
	cancelled.abort(new Error("cancelled preparation"));
	expect(await rejected).toContain("cancelled preparation");
	const closing = scope.close().catch((error: unknown) => String(error));
	await Promise.resolve();
	expect(events).toEqual(["enable"]);
	finish.resolve();
	expect(await closing).toContain("could not be restored");
	// A restore that keeps failing refuses the next run, naming the retry, and
	// neither enables focus emulation nor restores what was never enabled.
	const refused = prepareBackgroundPage(page);
	expect(await refused.ready.catch((error: unknown) => String(error))).toContain(
		"retrying it before this call failed too",
	);
	await refused.close();
	expect(events).toEqual(["enable", "restore", "restore"]);
	await expect(withBackgroundInput(page, undefined, async () => events.push("input"))).rejects.toThrow(
		"could not be restored",
	);
	// Once the restore goes through, the page is usable again and stays so.
	restoreFails = false;
	const recovered = prepareBackgroundPage(page);
	await recovered.ready;
	await withBackgroundInput(page, undefined, async () => events.push("input"));
	await recovered.close();
	const next = prepareBackgroundPage(page);
	await next.ready;
	await next.close();
	expect(events.slice(3)).toEqual(["restore", "enable", "input", "restore", "enable", "restore"]);
});

it("stops waiting for a restore retry when the run is cancelled, keeping the failure recorded", async () => {
	const events: string[] = [];
	const stalled = Promise.withResolvers<void>();
	let restores = 0;
	const page = fakePage({
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
			// The run's restore fails; the retry hangs like a busy renderer.
			if (!enabled && ++restores === 1) throw new Error("connection lost");
			if (!enabled) await stalled.promise;
		},
	});
	const scope = prepareBackgroundPage(page);
	await scope.ready;
	await scope.close().catch(() => undefined);
	const cancelled = new AbortController();
	const retrying = prepareBackgroundPage(page, cancelled.signal);
	const rejected = retrying.ready.catch((error: unknown) => String(error));
	const cancelledAt = Date.now();
	cancelled.abort(new Error("cancelled retry"));
	expect(await rejected).toContain("cancelled retry");
	// Close neither waits out the hung retry's 3 s bound (the run's result would
	// miss the supervisor's grace) nor restores what it never enabled.
	await retrying.close();
	expect(Date.now() - cancelledAt).toBeLessThan(1_000);
	expect(events).toEqual(["enable", "restore", "restore"]);
	await expect(withBackgroundInput(page, undefined, async () => undefined)).rejects.toThrow("could not be restored");
	stalled.resolve();
});

it("finishes preparation cleanup when the target closed during the run", async () => {
	const events: boolean[] = [];
	let closed = false;
	const page = fakePage({
		isClosed: () => closed,
		emulateFocusedPage: async (enabled: boolean) => {
			if (closed) throw new Error("Target closed");
			events.push(enabled);
		},
	});
	const scope = prepareBackgroundPage(page);
	await scope.ready;
	closed = true;
	await scope.close();
	expect(events).toEqual([true]);
});

it("keeps input serialized inside a run scope when a waiting action is cancelled", async () => {
	const events: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const page = fakePage({
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
		},
	});
	const scope = prepareBackgroundPage(page);
	await scope.ready;
	const first = withBackgroundInput(page, undefined, async () => {
		events.push("first");
		entered.resolve();
		await finish.promise;
	});
	await entered.promise;
	const cancelled = new AbortController();
	const second = withBackgroundInput(page, cancelled.signal, async () => events.push("second"));
	const rejected = second.catch((error: unknown) => String(error));
	cancelled.abort(new Error("cancel queued action"));
	expect(await rejected).toContain("cancel queued action");
	const third = withBackgroundInput(page, undefined, async () => events.push("third"));
	await Promise.resolve();
	expect(events).toEqual(["enable", "first"]);
	finish.resolve();
	await Promise.all([first, third]);
	await scope.close();
	// One enable and one restore for the whole run, whatever happens inside it.
	expect(events).toEqual(["enable", "first", "third", "restore"]);
});

it.skipIf(!CHROMIUM_AVAILABLE)(
	"replaces and clears framework-observed text through trusted browser input",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		try {
			const page = await browser.newPage();
			await page.setContent(
				'<input value="old" data-model="old" data-events="" onbeforeinput="this.dataset.events += event.type + String(event.isTrusted) + String.fromCharCode(44)" oninput="this.dataset.model=this.value;this.dataset.events += event.type + String(event.isTrusted) + String.fromCharCode(44)"><div contenteditable="true">previous</div>',
			);
			const session = page.mainFrame().client;
			const node = async (selector: string) => {
				const document = await session.send("DOM.getDocument", { depth: 0 });
				const found = await session.send("DOM.querySelector", { nodeId: document.root.nodeId, selector });
				const described = await session.send("DOM.describeNode", { nodeId: found.nodeId });
				return { session, backendNodeId: described.node.backendNodeId, label: selector };
			};
			const input = await node("input");
			const editor = await node("div");
			await withBackgroundInput(page, undefined, () => fillNode(input, "ASCII Ω café", AbortSignal.timeout(2000)));
			expect(await page.$eval("input", el => el.getAttribute("data-model"))).toBe("ASCII Ω café");
			expect(await page.$eval("input", el => el.getAttribute("data-events"))).toBe("beforeinputtrue,inputtrue,");
			await withBackgroundInput(page, undefined, () => fillNode(input, "", AbortSignal.timeout(2000)));
			expect(await page.$eval("input", el => el.getAttribute("data-model"))).toBe("");
			expect(await page.$eval("input", el => el.getAttribute("data-events"))).toBe(
				"beforeinputtrue,inputtrue,beforeinputtrue,inputtrue,",
			);
			await withBackgroundInput(page, undefined, () => fillNode(editor, "Replaced Ω", AbortSignal.timeout(2000)));
			expect(await page.$eval("div", el => el.textContent)).toBe("Replaced Ω");
			await withBackgroundInput(page, undefined, () => fillNode(editor, "", AbortSignal.timeout(2000)));
			expect(await page.$eval("div", el => el.textContent)).toBe("");
		} finally {
			await browser.close();
		}
	},
	15_000,
);

it.skipIf(!CHROMIUM_AVAILABLE)(
	"retries a focus restore that timed out on a busy renderer instead of refusing the page forever",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 20_000,
		});
		try {
			const page = await browser.newPage();
			await page.setContent("<p>background</p>");
			// Another page in front, so `document.hasFocus()` shows focus emulation.
			await (await browser.newPage()).bringToFront();
			const hasFocus = () => page.evaluate(() => document.hasFocus());
			const scope = prepareBackgroundPage(page);
			await scope.ready;
			expect(await hasFocus()).toBe(true);
			// A long synchronous script holds the renderer, so Chrome answers no focus
			// command until it ends. Real time is the point: the restore bound is a
			// wall-clock 3 s. The busy span outlasts the failed close (3 s restore plus
			// the 1 s navigation confirmation) and one 3 s retry, with ~3 s to spare.
			const busy = page.evaluate(() => {
				const end = Date.now() + 10_000;
				while (Date.now() < end);
			});
			// A failed assertion closes the browser mid-script; that rejection is not the finding.
			busy.catch(() => undefined);
			expect(await scope.close().catch((error: unknown) => String(error))).toContain("could not be restored");
			// Still busy: the next run pays a real retry and is refused with a reason naming it.
			const refused = prepareBackgroundPage(page);
			const retryStarted = Date.now();
			expect(await refused.ready.catch((error: unknown) => String(error))).toContain(
				"retrying it before this call failed too",
			);
			expect(Date.now() - retryStarted).toBeGreaterThanOrEqual(2_900);
			const closeStarted = Date.now();
			await refused.close();
			expect(Date.now() - closeStarted).toBeLessThan(1_000);
			// The renderer settles: the next run retries, clears the failure, and works.
			await busy;
			const recovered = prepareBackgroundPage(page);
			await recovered.ready;
			expect(await withBackgroundInput(page, undefined, hasFocus)).toBe(true);
			await recovered.close();
			expect(await hasFocus()).toBe(false);
			// Nothing stays recorded against the page.
			expect(await withBackgroundInput(page, undefined, hasFocus)).toBe(false);
		} finally {
			await browser.close();
		}
	},
	30_000,
);
