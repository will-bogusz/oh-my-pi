import { expect, it } from "bun:test";
import path from "node:path";
import { localBrowserRequest } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/local-http";

it("keeps private local browser requests off configured proxies and refuses redirect following", async () => {
	let direct = 0;
	let proxied = 0;
	const proxy = Bun.serve({
		port: 0,
		fetch: () => {
			proxied++;
			return new Response("proxy");
		},
	});
	const local = Bun.serve({
		port: 0,
		fetch: () => {
			direct++;
			return new Response(null, { status: 302, headers: { location: proxy.url.toString() } });
		},
	});
	try {
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				`import {localBrowserRequest} from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/tools/browser/relay/local-http.ts"))}; console.log((await localBrowserRequest(process.env.OMP_HTTP_TEST_URL)).status);`,
			],
			{
				env: {
					...process.env,
					HTTP_PROXY: proxy.url.toString(),
					http_proxy: proxy.url.toString(),
					NO_PROXY: "",
					no_proxy: "",
					OMP_HTTP_TEST_URL: local.url.toString(),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await new Response(child.stdout).text()).toBe("302\n");
		expect(await child.exited).toBe(0);
		expect(await new Response(child.stderr).text()).toBe("");
		expect(direct).toBe(1);
		expect(proxied).toBe(0);
		expect(() => localBrowserRequest("http://example.com")).toThrow("loopback");
	} finally {
		local.stop();
		proxy.stop();
	}
});
