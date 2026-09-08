import { expect, it } from "bun:test";
import { acquireBrowser } from "../../src/tools/browser/registry";

it("surfaces the connection failure when a discovered browser refuses its WebSocket upgrade", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, host) {
			if (new URL(request.url).pathname.endsWith("/json/version")) {
				return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:${host.port}/refused` });
			}
			return new Response("fixture connection refused", { status: 403 });
		},
	});
	try {
		const result = await acquireBrowser(
			{ kind: "connected", cdpUrl: `http://127.0.0.1:${server.port}/fixture` },
			{ cwd: import.meta.dir },
		).then(
			() => ({ error: undefined }),
			(error: unknown) => ({ error }),
		);
		expect(result.error).toBeInstanceOf(Error);
		expect((result.error as Error).message).toMatch(/WebSocket|101|403/i);
		expect(String(result.error)).not.toContain("[object ErrorEvent]");
	} finally {
		server.stop(true);
	}
}, 30_000);
