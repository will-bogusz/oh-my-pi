/** Create and release an inactive scratch tab through a paired instance; never adopt a human tab. */
import puppeteer, { type Browser } from "puppeteer-core";
import { readRelayControlToken } from "../../coding-agent/src/tools/browser/relay/access";
import type { InstanceLease } from "../../coding-agent/src/tools/browser/relay/instances";
import { localBrowserRequest } from "../../coding-agent/src/tools/browser/relay/local-http";

const relayUrl = (Bun.argv[2] ?? "http://127.0.0.1:9224").replace(/\/+$/, "");
const browserId = Bun.argv[3];
const owner = `smoke-${crypto.randomUUID()}`;
const request = async (args: Record<string, unknown>): Promise<unknown> => {
	const response = await localBrowserRequest(`${relayUrl}/managed`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${readRelayControlToken(relayUrl)}` },
		body: JSON.stringify(args),
	});
	if (!response.ok) throw new Error(await response.text());
	return await response.json();
};
const fixture = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: () =>
		new Response("<title>OMP scratch smoke</title><h1>Ready</h1>", { headers: { "content-type": "text/html" } }),
});
const clients: Browser[] = [];
let lease: InstanceLease | undefined;
try {
	lease = (await request({
		action: "create",
		url: fixture.url.toString(),
		browserId,
		owner,
		taskId: owner,
		label: "OMP smoke",
	})) as InstanceLease;
	const version = await localBrowserRequest(`${relayUrl}/managed/${lease.id}/json/version`);
	const endpoint = ((await version.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
	for (let index = 0; index < 2; index++)
		clients.push(
			await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null, protocolTimeout: 5000 }),
		);
	for (const client of clients) {
		const targets = client.targets().filter(target => target.type() === "page");
		if (targets.length !== 1) throw new Error("Expected only the acquired page");
		const page = await targets[0]!.page();
		if (!page) throw new Error("Missing acquired page");
		await page.waitForSelector("h1");
		if ((await page.title()) !== "OMP scratch smoke") throw new Error("Wrong page");
		console.log(
			`Verified owned tab in ${lease.browserLabel}; screenshot ${(await page.screenshot()).byteLength} bytes`,
		);
	}
	console.log("SMOKE OK");
} finally {
	for (const client of clients) await client.disconnect();
	if (lease) await request({ action: "release", id: lease.id, owner });
	fixture.stop();
}
