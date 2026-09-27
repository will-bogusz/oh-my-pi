import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

/**
 * The page is served on 127.0.0.1 and its iframe on localhost, a different
 * site, so Chrome runs the frame out of process: a frame whose renderer is
 * stuck in script answers none of the reads an observation sends it.
 */
let server: Server<unknown> | undefined;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			const frameOrigin = `http://localhost:${server!.port}`;
			const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
			switch (pathname) {
				case "/stuck-parent":
					return html(
						`<!doctype html><title>Sign in</title><h1>Sign in</h1><label>Email <input></label><button>Continue</button><iframe title="challenge" src="${frameOrigin}/stuck"></iframe>`,
					);
				case "/stuck":
					return html(`<!doctype html><p>Checking</p><script>setTimeout(() => { for (;;) {} });</script>`);
				case "/busy-parent":
					return html(
						`<!doctype html><title>Busy frame</title><h1>Account</h1><iframe title="widget" src="${frameOrigin}/busy"></iframe><script>addEventListener("message", event => { document.title = event.data; });</script>`,
					);
				case "/busy":
					// Busy for a while after load, then free again, and says so.
					return html(
						`<!doctype html><p>Widget content</p><script>setTimeout(() => { const until = Date.now() + 8000; while (Date.now() < until) {} parent.postMessage("widget free", "*"); });</script>`,
					);
				default:
					return new Response("not found", { status: 404 });
			}
		},
	});
});

afterAll(async () => {
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

describe("observing a page with an out-of-process frame that does not answer", () => {
	it.skipIf(!CHROMIUM_AVAILABLE)(
		"prints the page with that frame marked, and reads the frame again once it answers",
		async () => {
			const origin = `http://127.0.0.1:${server!.port}`;
			const session = makeSession();
			const prelude = createBrowserPrelude(session);
			const name = `frame-${crypto.randomUUID().slice(0, 8)}`;
			const invoke = (parameters: Record<string, unknown>) =>
				prelude.invoke(parameters, { session, toolCallId: `frame-${crypto.randomUUID()}` });
			const observe = async () => {
				const result = await invoke({
					action: "call",
					name,
					chain: [{ method: "observe", args: [{ diff: false }] }],
				});
				return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
			};
			try {
				// A frame busy only for a while loses its content for that read alone.
				await invoke({ action: "open", name, url: `${origin}/busy-parent` });
				const busy = await observe();
				expect(busy).toContain('heading "Account"');
				// Its URL may not have reached the page yet; the mark is what matters.
				expect(busy).toMatch(/\[iframe .*did not answer in time/);
				expect(busy).not.toContain("Widget content");
				await invoke({
					action: "run",
					name,
					code: `await page.waitForFunction(() => document.title === "widget free", { timeout: 20_000 });`,
				});
				const free = await observe();
				expect(free).toContain("Widget content");
				expect(free).not.toContain("did not answer in time");
				// A frame stuck for good: the page's own tree and refs still come back. Last,
				// because the stuck renderer also serves any later frame of its site.
				await invoke({ action: "open", name, url: `${origin}/stuck-parent` });
				const stuck = await observe();
				expect(stuck).toContain('heading "Sign in"');
				expect(stuck).toMatch(/e\d+ button "Continue"/);
				expect(stuck).toMatch(/\[iframe localhost.*did not answer in time/);

			} finally {
				await invoke({ action: "close", name }).catch(() => undefined);
			}
		},
		60_000,
	);
});
