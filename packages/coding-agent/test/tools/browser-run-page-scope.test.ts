import { expect, it } from "bun:test";
import { createRunPageScope } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import type { Page } from "puppeteer-core";

/** The four page methods the scope wraps, plus the interception switch. */
function stubPage(interception: { calls: boolean[]; fail?: boolean }): Page {
	const page = {
		on: () => page,
		off: () => page,
		once: () => page,
		removeAllListeners: () => page,
		async setRequestInterception(value: boolean): Promise<void> {
			interception.calls.push(value);
			// A page that never intercepted anything is exactly where the real
			// `Fetch.disable` fan-out stalled past the cleanup budget.
			if (interception.fail) await Promise.withResolvers<void>().promise;
		},
	};
	return page as unknown as Page;
}

it("clears request interception only for a run that turned it on", async () => {
	const interception = { calls: [] as boolean[] };
	const page = stubPage(interception);
	await createRunPageScope(page).cleanup();
	expect(interception.calls).toEqual([]);
	const used = createRunPageScope(page);
	await used.page.setRequestInterception(true);
	await used.cleanup();
	expect(interception.calls).toEqual([true, false]);
	// A run that switched interception back off itself needs no cleanup call.
	const restored = createRunPageScope(page);
	await restored.page.setRequestInterception(true);
	await restored.page.setRequestInterception(false);
	await restored.cleanup();
	expect(interception.calls).toEqual([true, false, true, false]);
});

it("does not make a run that never intercepted wait out the cleanup budget", async () => {
	const interception = { calls: [] as boolean[], fail: true };
	const started = Date.now();
	await createRunPageScope(stubPage(interception)).cleanup();
	expect(interception.calls).toEqual([]);
	expect(Date.now() - started).toBeLessThan(400);
});
