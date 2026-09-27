import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/** Responses that never finish: a server that never answers, and an interstitial whose body never ends. */
let server: Server<unknown> | undefined;
const hanging: Array<() => void> = [];
/** Called when the no-answer page is requested: the navigation is under way. */
let onNoAnswer: (() => void) | undefined;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(request) {
			const html = { "content-type": "text/html; charset=utf-8" };
			switch (new URL(request.url).pathname) {
				case "/spin":
					return new Response("<!doctype html><title>Spinning</title><script>for (;;) {}</script>", { headers: html });
				case "/ready":
					return new Response("<!doctype html><title>Ready page</title><h1>Ready</h1>", { headers: html });
				case "/no-answer":
					onNoAnswer?.();
					return new Promise<Response>(resolve =>
						hanging.push(() => resolve(new Response("late", { headers: html }))),
					);
				case "/unfinished":
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(
									new TextEncoder().encode(
										`<!doctype html><title>Checking your browser</title><h1>Access check in progress</h1>${" ".repeat(4096)}`,
									),
								);
								hanging.push(() => controller.close());
							},
						}),
						{ headers: html },
					);
				default:
					return new Response("not found", { status: 404 });
			}
		},
	});
});

afterAll(async () => {
	for (const release of hanging.splice(0)) {
		try {
			release();
		} catch {
			// Chrome already dropped that response.
		}
	}
	await server?.stop(true);
});

function makeSession(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.relay": false,
			"browser.cmux": false,
		}),
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the open to throw");
}

describe("browser.open on a page that outlasts its timeout", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the tab on what loaded, fresh or reused, names where the load stopped, and closes it on the caller's abort",
		async () => {
			const origin = `http://127.0.0.1:${server!.port}`;
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: Record<string, unknown>, signal?: AbortSignal) =>
				prelude.invoke(parameters, { session, toolCallId: `slow-${crypto.randomUUID()}`, signal });
			const listed = async () =>
				((await invoke({ action: "tabs" })).details as { value: Array<{ name: string; url: string; title: string }> })
					.value;
			const fresh = `slow-${crypto.randomUUID().slice(0, 8)}`;
			const blank = `slow-${crypto.randomUUID().slice(0, 8)}`;
			const reused = `slow-${crypto.randomUUID().slice(0, 8)}`;
			const aborted = `slow-${crypto.randomUUID().slice(0, 8)}`;
			try {
				// A fresh open on an interstitial whose body never ends.
				const started = performance.now();
				const unfinished = await refusal(invoke({ action: "open", name: fresh, url: `${origin}/unfinished`, timeout: 6 }));
				expect(performance.now() - started).toBeLessThan(6_000);
				expect(unfinished).toContain(`${origin}/unfinished`);
				expect(unfinished).toContain("readyState: loading");
				expect(unfinished).toContain(`browser.tab(${JSON.stringify(fresh)})`);
				expect(unfinished).toContain("Checking your browser");
				expect(await listed()).toContainEqual(
					expect.objectContaining({ name: fresh, url: `${origin}/unfinished`, title: "Checking your browser" }),
				);
				const observed = await invoke({ action: "call", name: fresh, chain: [{ method: "observe", args: [] }] });
				expect(JSON.stringify(observed.content)).toContain("Access check in progress");

				// With the browser up, the shortest open a caller can ask for still
				// loads a page that answers.
				await invoke({ action: "open", name: `quick-${fresh}`, url: `${origin}/ready`, timeout: 1 });

				// A fresh open on a server that never answers: the tab is kept all the same.
				const noAnswer = await refusal(invoke({ action: "open", name: blank, url: `${origin}/no-answer`, timeout: 4 }));
				expect(noAnswer).toContain(`browser.tab(${JSON.stringify(blank)})`);
				expect((await listed()).map(tab => tab.name)).toContain(blank);

				// A reuse reports the same way, and browser.tabs() follows the page it stopped on.
				await invoke({ action: "open", name: reused, url: `${origin}/ready` });
				const again = await refusal(invoke({ action: "open", name: reused, url: `${origin}/unfinished`, timeout: 4 }));
				expect(again).toStartWith(`Reused tab ${JSON.stringify(reused)}`);
				expect(again).toContain(`browser.tab(${JSON.stringify(reused)})`);
				expect(await listed()).toContainEqual(
					expect.objectContaining({ name: reused, url: `${origin}/unfinished`, title: "Checking your browser" }),
				);

				// The caller's own abort still gives the open's tab up.
				const controller = new AbortController();
				onNoAnswer = () => controller.abort();
				await refusal(invoke({ action: "open", name: aborted, url: `${origin}/no-answer`, timeout: 20 }, controller.signal));
				// Opens of one name queue behind each other, so the next one sees what the
				// aborted open left: nothing to reuse.
				const next = await invoke({ action: "open", name: aborted, url: `${origin}/ready` });
				expect(JSON.stringify(next.content)).toContain(`Opened tab ${JSON.stringify(aborted).replaceAll('"', '\\"')}`);

				// A short open whose page stops answering altogether: the deadline beats
				// goto's own report, and the error still names the tab it kept. Last,
				// because the spinning renderer serves every later page of this site.
				const spinning = `slow-${crypto.randomUUID().slice(0, 8)}`;
				const spun = await refusal(invoke({ action: "open", name: spinning, url: `${origin}/spin`, timeout: 1 }));
				expect(spun).toContain(`browser.tab(${JSON.stringify(spinning)})`);
				expect((await listed()).map(tab => tab.name)).toContain(spinning);
			} finally {
				await invoke({ action: "close", all: true }).catch(() => undefined);
			}
		},
		60_000,
	);
});
