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

				// A short open whose page stops answering altogether, from a caller with
				// no signal of its own: the deadline beats goto's own report, and the
				// error still names the tab it kept. Last, because the spinning renderer
				// serves every later page of this site.
				const spinning = `slow-${crypto.randomUUID().slice(0, 8)}`;
				const spun = await refusal(invoke({ action: "open", name: spinning, url: `${origin}/spin`, timeout: 1 }));
				expect(spun).toContain(`browser.tab(${JSON.stringify(spinning)})`);
				// An open of the same name queues behind that open's own cleanup, so it
				// sees whether the tab outlived it.
				const after = await invoke({ action: "open", name: spinning });
				expect(JSON.stringify(after.content)).toContain(`Reused tab ${JSON.stringify(spinning).replaceAll('"', '\\"')}`);
			} finally {
				await invoke({ action: "close", all: true }).catch(() => undefined);
			}
		},
		60_000,
	);

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"keeps the tab when the deadline beats goto's report, with or without a caller signal, and stops its load",
		async () => {
			// Another site than the first case's spinning renderer.
			const origin = `http://localhost:${server!.port}`;
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const invoke = (parameters: Record<string, unknown>, signal?: AbortSignal) =>
				prelude.invoke(parameters, { session, toolCallId: `late-${crypto.randomUUID()}`, signal });
			// With the browser up, the open's deadline is spent on its navigation.
			await invoke({ action: "open", name: `warm-${crypto.randomUUID().slice(0, 8)}`, url: "about:blank" });
			// The worker thread gets the open's navigation late, and every message
			// after it in order, as a busy thread would: the deadline fires before
			// goto can report, and the abort reaches goto mid-navigation. A real
			// delay: the open's deadline is a wall-clock timeout.
			const post = Worker.prototype.postMessage;
			const inboxes = new Map<Worker, Promise<void>>();
			Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
				const gotoRun =
					message !== null &&
					typeof message === "object" &&
					"type" in message &&
					message.type === "run" &&
					"code" in message &&
					typeof message.code === "string" &&
					message.code.includes("tab.goto(");
				const inbox = inboxes.get(this);
				if (!gotoRun && !inbox) return Reflect.apply(post, this, [message, ...rest]);
				const delivered = (inbox ?? Promise.resolve())
					.then(() => (gotoRun ? Bun.sleep(600) : undefined))
					.then(() => Reflect.apply(post, this, [message, ...rest]))
					.catch(() => undefined);
				inboxes.set(this, delivered);
			};
			try {
				for (const signal of [undefined, new AbortController().signal]) {
					const name = `late-${crypto.randomUUID().slice(0, 8)}`;
					const refused = await refusal(
						invoke({ action: "open", name, url: `${origin}/no-answer`, timeout: 1 }, signal),
					);
					expect(refused).toContain(`browser.tab(${JSON.stringify(name)})`);
					// Queued behind that open's own cleanup: it sees whether the tab outlived it.
					const after = await invoke({ action: "open", name });
					expect(JSON.stringify(after.content)).toContain(`Reused tab ${JSON.stringify(name).replaceAll('"', '\\"')}`);
				}
				// The kept tabs' abandoned loads were stopped: a new tab still opens in
				// well under a second, where a load left pending made each attach wait 5 s.
				await invoke({ action: "open", name: `after-${crypto.randomUUID().slice(0, 8)}`, timeout: 3 });
			} finally {
				Worker.prototype.postMessage = post;
				await invoke({ action: "close", all: true }).catch(() => undefined);
			}
		},
		60_000,
	);
});
