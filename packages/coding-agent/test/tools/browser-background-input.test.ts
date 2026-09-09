import { expect, it } from "bun:test";
import {
	fillInBackground,
	prepareBackgroundPage,
	withBackgroundInput,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it("keeps a page prepared through selection and serialized inputs, draining before restoration", async () => {
	const events: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const page = {
		isClosed: () => false,
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
		},
	} as unknown as Page;
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

it("restores late page preparation after cancellation and rejects reuse after failed restoration", async () => {
	const events: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const page = {
		isClosed: () => false,
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
			if (!enabled) throw new Error("connection lost");
			entered.resolve();
			await finish.promise;
		},
	} as unknown as Page;
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
	expect(() => prepareBackgroundPage(page)).toThrow("could not be restored");
	await expect(withBackgroundInput(page, undefined, async () => events.push("retry"))).rejects.toThrow(
		"could not be restored",
	);
	expect(events).toEqual(["enable", "restore"]);
});

it("finishes preparation cleanup when the target closed during the run", async () => {
	const events: boolean[] = [];
	let closed = false;
	const page = {
		isClosed: () => closed,
		emulateFocusedPage: async (enabled: boolean) => {
			if (closed) throw new Error("Target closed");
			events.push(enabled);
		},
	} as unknown as Page;
	const scope = prepareBackgroundPage(page);
	await scope.ready;
	closed = true;
	await scope.close();
	expect(events).toEqual([true]);
});

it("keeps input serialized when a waiting action is cancelled", async () => {
	const events: string[] = [];
	const entered = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const page = {
		isClosed: () => false,
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
		},
	} as unknown as Page;
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
	expect(events).toEqual(["enable", "first", "restore", "enable", "third", "restore"]);
});

it("restores a late focus enable after cancellation without dispatching input", async () => {
	const events: string[] = [];
	const started = Promise.withResolvers<void>();
	const enabled = Promise.withResolvers<void>();
	const page = {
		isClosed: () => false,
		emulateFocusedPage: async (value: boolean) => {
			events.push(value ? "enable" : "restore");
			if (value) {
				started.resolve();
				await enabled.promise;
			}
		},
	} as unknown as Page;
	const cancelled = new AbortController();
	const pending = withBackgroundInput(page, cancelled.signal, async () => events.push("input"));
	const rejected = pending.catch((error: unknown) => String(error));
	await started.promise;
	cancelled.abort(new Error("input cancelled"));
	await Promise.resolve();
	expect(events).toEqual(["enable"]);
	enabled.resolve();
	expect(await rejected).toContain("input cancelled");
	expect(events).toEqual(["enable", "restore"]);
});

it("refuses subsequent input if focus restoration failed", async () => {
	const events: string[] = [];
	const page = {
		isClosed: () => false,
		emulateFocusedPage: async (enabled: boolean) => {
			events.push(enabled ? "enable" : "restore");
			if (!enabled) throw new Error("connection lost");
		},
	} as unknown as Page;
	await expect(withBackgroundInput(page, undefined, async () => events.push("input"))).rejects.toThrow(
		"could not be restored",
	);
	await expect(withBackgroundInput(page, undefined, async () => events.push("retry"))).rejects.toThrow(
		"could not be restored",
	);
	expect(events).toEqual(["enable", "input", "restore"]);
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
			const input = await page.$("input");
			const editor = await page.$("div");
			if (!input || !editor) throw new Error("missing editable fixture");
			await fillInBackground(input, "ASCII Ω café", AbortSignal.timeout(2000));
			expect(await page.$eval("input", el => el.getAttribute("data-model"))).toBe("ASCII Ω café");
			expect(await page.$eval("input", el => el.getAttribute("data-events"))).toBe("beforeinputtrue,inputtrue,");
			await fillInBackground(input, "", AbortSignal.timeout(2000));
			expect(await page.$eval("input", el => el.getAttribute("data-model"))).toBe("");
			expect(await page.$eval("input", el => el.getAttribute("data-events"))).toBe(
				"beforeinputtrue,inputtrue,beforeinputtrue,inputtrue,",
			);
			await fillInBackground(editor, "Replaced Ω", AbortSignal.timeout(2000));
			expect(await page.$eval("div", el => el.textContent)).toBe("Replaced Ω");
			await fillInBackground(editor, "", AbortSignal.timeout(2000));
			expect(await page.$eval("div", el => el.textContent)).toBe("");
		} finally {
			await browser.close();
		}
	},
	15_000,
);
