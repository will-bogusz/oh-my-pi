import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { type RelayServer, startRelayServer } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";
import type { ChromeTabLease, DiscoveredChromeTab } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/managed-tabs";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [
		{ tabId: 1, url: "https://example.com", title: "Human", active: true, windowId: 1, pinned: false, groupId: -1 },
	],
	attachedTabIds: [],
} as const;

async function rawGet(port: number, requestBytes: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	let response = "";
	await Bun.connect({
		hostname: "127.0.0.1",
		port,
		socket: {
			open(socket) {
				socket.write(requestBytes);
			},
			data(_socket, chunk) {
				response += chunk.toString("latin1");
			},
			error(_socket, error) {
				reject(error);
			},
			close() {
				resolve(response);
			},
		},
	});
	return promise;
}

function decodeChunkedBody(body: string): string {
	let decoded = "";
	let offset = 0;
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd === -1) throw new Error("Invalid chunked response: missing chunk size");
		const lengthText = body.slice(offset, lineEnd).split(";", 1)[0]!;
		const length = Number.parseInt(lengthText, 16);
		if (!Number.isFinite(length) || length < 0) throw new Error("Invalid chunked response: invalid chunk size");
		offset = lineEnd + 2;
		if (length === 0) return decoded;
		if (body.length < offset + length + 2) throw new Error("Invalid chunked response: truncated chunk");
		decoded += body.slice(offset, offset + length);
		offset += length;
		if (body.slice(offset, offset + 2) !== "\r\n")
			throw new Error("Invalid chunked response: missing chunk terminator");
		offset += 2;
	}
}

function parseVersion(response: string): Record<string, string> {
	const boundary = response.indexOf("\r\n\r\n");
	if (boundary === -1) throw new Error("Invalid HTTP response: missing header boundary");
	const headers = response.slice(0, boundary);
	const body = response.slice(boundary + 4);
	expect(headers).toContain("200");
	return JSON.parse(/\r\ntransfer-encoding:\s*chunked\b/i.test(headers) ? decodeChunkedBody(body) : body) as Record<
		string,
		string
	>;
}

async function connectExtension(relay: RelayServer): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ext`);
	ws.addEventListener(
		"open",
		() => {
			ws.send(
				JSON.stringify({
					t: "authenticate",
					auth: { id: crypto.randomUUID(), label: "Test Chrome", pairingCode: relay.access.issueCode().code },
				}),
			);
		},
		{ once: true },
	);
	ws.addEventListener("message", event => {
		const value = JSON.parse(String(event.data)) as { t?: string; op?: string; id?: number };
		if (value.t === "rpc" && value.op === "queryTabs")
			ws.send(
				JSON.stringify({ t: "rpcResult", id: value.id, ok: true, result: { tabs: relay.instances.discover() } }),
			);
		if (value.t === "authenticated") {
			ws.send(JSON.stringify(EXTENSION_HELLO));
			resolve(ws);
		}
	});
	ws.addEventListener("error", () => reject(new Error("Extension socket failed to connect")), { once: true });
	return promise;
}

async function waitForDiscovery(relay: RelayServer): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		if (relay.instances.ready) return;
		await Bun.sleep(5);
	}
	throw new Error("Relay discovery endpoint did not become ready");
}

describe("browser relay discovery endpoint", () => {
	let relay: RelayServer | undefined;
	let extension: WebSocket | undefined;
	let lease: ChromeTabLease;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		extension = undefined;
		relay = undefined;
	});

	async function startReadyRelay(): Promise<number> {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		extension = await connectExtension(relay);
		await waitForDiscovery(relay);
		lease = relay.instances.claim(relay.instances.discover()[0]!.id, "host-test");
		return port;
	}

	it("advertises the requested Host authority so a remote Puppeteer client dials the relay", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			`GET /managed/${lease.id}/json/version HTTP/1.1\r\nHost: 100.100.92.97:12803\r\nConnection: close\r\n\r\n`,
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://100.100.92.97:12803/cdp?lease=${lease.id}`);
	});

	it("reports and advertises the actual port when listening on an ephemeral port", async () => {
		const events: Array<Record<string, unknown> | undefined> = [];
		relay = startRelayServer({ port: 0, log: (_message, data) => events.push(data) });
		expect(relay.port).toBeGreaterThan(0);
		expect(events[0]).toEqual({ port: relay.port });
		extension = await connectExtension(relay);
		await waitForDiscovery(relay);
		lease = relay.instances.claim(relay.instances.discover()[0]!.id, "host-test");
		const response = await rawGet(relay.port, `GET /managed/${lease.id}/json/version HTTP/1.0\r\n\r\n`);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${relay.port}/cdp?lease=${lease.id}`);
	});

	it("uses the loopback discovery URL when an HTTP/1.0 request has no Host header", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(port, `GET /managed/${lease.id}/json/version HTTP/1.0\r\n\r\n`);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp?lease=${lease.id}`);
	});

	it("uses the loopback discovery URL when Host is empty", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			`GET /managed/${lease.id}/json/version HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n`,
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp?lease=${lease.id}`);
	});

	it("uses the loopback discovery URL when Host would produce an unusable WebSocket authority", async () => {
		const port = await startReadyRelay();
		const response = await rawGet(
			port,
			`GET /managed/${lease.id}/json/version HTTP/1.1\r\nHost: bad/host@evil\r\nConnection: close\r\n\r\n`,
		);
		expect(parseVersion(response).webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${port}/cdp?lease=${lease.id}`);
	});

	it("reports liveness without exposing a global CDP endpoint before pairing", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		expect(response.status).toBe(410);
		expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({
			service: "omp-browser",
			protocol: 2,
		});
	});

	it("discovers without debugger attachment and expires a scoped endpoint after release", async () => {
		const port = await startReadyRelay();
		const base = `http://127.0.0.1:${port}`;
		const commands: string[] = [];
		extension!.addEventListener("message", event => {
			const msg = JSON.parse(String(event.data)) as { op?: string };
			if (msg.op !== "queryTabs") commands.push(String(event.data));
		});
		extension!.send(
			JSON.stringify({
				t: "tabCreated",
				tab: {
					tabId: 71,
					url: "https://example.com",
					title: "Human tab",
					active: true,
					windowId: 1,
					pinned: false,
					groupId: -1,
				},
			}),
		);
		const request = (args: Record<string, unknown>, origin?: string) =>
			fetch(`${base}/managed`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${relay!.access.controlToken}`,
					...(origin ? { origin } : {}),
				},
				body: JSON.stringify(args),
			});
		await relay!.instances.select().bridge.managed.release(lease.id, "host-test");
		let discovered: DiscoveredChromeTab[] = [];
		for (let attempt = 0; attempt < 20 && discovered.length < 2; attempt++)
			discovered = (await (await request({ action: "discover" })).json()) as DiscoveredChromeTab[];
		expect(discovered).toHaveLength(2);
		expect(commands).toEqual([]);
		const claimed = await request({ action: "claim", id: discovered[0]!.id, owner: "actor A" });
		const claimedLease = (await claimed.json()) as ChromeTabLease;
		expect(claimed.status).toBe(200);
		expect((await request({ action: "claim", id: discovered[0]!.id, owner: "actor B" })).status).toBe(409);
		expect((await request({ action: "reveal", id: claimedLease.id, owner: "actor B" })).status).toBe(409);
		expect((await request({ action: "discover" }, "https://unrelated.example")).status).toBe(403);
		const version = await fetch(`${base}/managed/${claimedLease.id}/json/version`);
		expect(version.status).toBe(200);
		expect(await version.json()).toHaveProperty(
			"webSocketDebuggerUrl",
			`ws://127.0.0.1:${port}/cdp?lease=${claimedLease.id}`,
		);
		expect((await request({ action: "release", id: claimedLease.id, owner: "actor A" })).status).toBe(200);
		expect((await fetch(`${base}/managed/${claimedLease.id}/json/version`)).status).toBe(410);
		expect(commands).toEqual([]);
	});
});

it("requires a local control credential and rejects browser origins and unscoped CDP", async () => {
	const relay = startRelayServer({ port: 0 });
	const base = `http://127.0.0.1:${relay.port}`;
	try {
		for (const action of ["instances", "discover", "pair", "claim", "create", "release"]) {
			const response = await fetch(`${base}/managed`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action }),
			});
			expect(response.status).toBe(401);
		}
		const control = { "content-type": "application/json", authorization: `Bearer ${relay.access.controlToken}` };
		expect(
			(
				await fetch(`${base}/managed`, {
					method: "POST",
					headers: control,
					body: JSON.stringify({ action: "instances" }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await fetch(`${base}/managed`, {
					method: "POST",
					headers: { ...control, origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
					body: JSON.stringify({ action: "pair" }),
				})
			).status,
		).toBe(403);
		expect((await fetch(`${base}/ext`, { headers: { origin: "https://unrelated.example" } })).status).toBe(403);
		expect((await fetch(`${base}/cdp`)).status).toBe(403);
		expect((await fetch(`${base}/cdp?lease=unknown`)).status).toBe(410);
		expect((await fetch(`${base}/json/list`)).status).toBe(410);
	} finally {
		relay.stop();
	}
});
