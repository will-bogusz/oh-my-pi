/** Authenticated local browser broker. Each paired browser has its own CDP bridge. */
import { RelayAccess } from "./access";
import type { RelayBridge } from "./bridge";
import { BrowserInstances } from "./instances";

export interface RelayServerOptions {
	port: number;
	/** Omit for an ephemeral in-memory broker; the production CLI supplies persistent endpoint access. */
	access?: RelayAccess;
	/** Put driven tabs in their owner's Chrome tab group; default on. */
	group?: boolean;
	log?: (message: string, data?: Record<string, unknown>) => void;
	/** Keep an automatically started service available while a finite CLI's code is usable. */
	onPairingCode?: (expiresAt: number) => Promise<void>;
}
export interface RelayServer {
	instances: BrowserInstances;
	access: RelayAccess;
	port: number;
	stop(): void;
}
type SocketData = { role: "ext" } | { role: "cdp"; bridge: RelayBridge; leaseId: string; connId?: number };
type RelayWebSocket = Bun.ServerWebSocket<SocketData>;
export const RELAY_PROTOCOL_VERSION = 2;

function isWsAuthority(raw: string): boolean {
	if (/[\s/\\@#?]|[\x00-\x1f]/.test(raw)) return false;
	try {
		return new URL(`ws://${raw}`).host.length > 0;
	} catch {
		return false;
	}
}

export function startRelayServer(opts: RelayServerOptions): RelayServer {
	const log = opts.log ?? (() => {});
	const access = opts.access ?? new RelayAccess();
	const instances = new BrowserInstances(access, { log, group: opts.group ?? true });
	const sockets = new Set<RelayWebSocket>();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port,
		async fetch(req, srv): Promise<Response | undefined> {
			const fallback = `127.0.0.1:${srv.port ?? opts.port}`;
			const rawHost = req.headers.get("host")?.trim();
			const host = rawHost && isWsAuthority(rawHost) ? rawHost : fallback;
			const requestUrl =
				rawHost && rawHost !== host && req.url.startsWith(`http://${rawHost}`)
					? req.url.slice(`http://${rawHost}`.length)
					: req.url;
			const url = new URL(requestUrl, `http://${fallback}`);
			const route = url.pathname.replace(/\/+$/, "") || "/";
			// This liveness route exposes no tab/profile metadata or control capability.
			if (route === "/health" && req.method === "GET")
				return Response.json({ service: "omp-browser", protocol: RELAY_PROTOCOL_VERSION });
			if (route === "/ext") {
				const origin = req.headers.get("origin");
				if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin))
					return new Response("Forbidden", { status: 403 });
				if (srv.upgrade(req, { data: { role: "ext" } })) return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			// Neither cross-origin pages nor extension pages may use the local control plane.
			if (req.headers.get("origin")) return new Response("Forbidden", { status: 403 });
			if (route === "/managed") {
				if (req.method !== "POST" || req.headers.get("content-type") !== "application/json")
					return new Response("Forbidden", { status: 403 });
				try {
					const body: unknown = await req.json();
					if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid browser request");
					const args = body as Record<string, unknown>;
					const string = (key: string): string => {
						const value = args[key];
						if (typeof value !== "string" || !value.length || value.length > 8192)
							throw new Error(`Invalid ${key}`);
						return value;
					};
					const optional = (key: string): string | undefined =>
						args[key] === undefined ? undefined : string(key);
					if (!access.authorized(req.headers.get("authorization")))
						return new Response("Local browser credential required", { status: 401 });
					if (args.action !== "pair" && args.action !== "unpair") await instances.settled();
					switch (args.action) {
						case "instances":
							return Response.json(instances.list());
						case "pair": {
							const pair = access.issueCode();
							await opts.onPairingCode?.(pair.expiresAt);
							return Response.json(pair);
						}
						case "unpair":
							instances.unpair(string("id"));
							break;
						case "discover":
							return Response.json(await instances.refresh(optional("owner"), optional("browserId")));
						// Turn/task end: drop the debugger attachments (and Chrome's
						// infobar) without giving up tab ownership or page state.
						case "detachDebuggers":
							return Response.json({
								detached: await instances.detachDebuggers(optional("owner"), optional("browserId")),
							});
						case "create":
							return Response.json(
								await instances.create(
									string("url"),
									string("owner"),
									string("taskId"),
									optional("label"),
									optional("browserId"),
								),
							);
						case "claim":
							return Response.json(
								instances.claim(
									string("id"),
									string("owner"),
									optional("taskId"),
									optional("label"),
									optional("browserId"),
								),
							);
						case "dialog":
							return Response.json(
								await instances
									.requireLease(string("id"))
									.bridge.dialog(string("id"), string("owner"), args.dialog, req.signal),
							);
						case "get":
							return Response.json(instances.get(string("id"), string("owner")));
						case "closeTab":
							await instances.closeTab(string("id"), string("owner"), optional("browserId"), req.signal);
							break;
						case "reveal":
							await instances.requireLease(string("id")).bridge.managed.reveal(string("id"), string("owner"));
							break;
						// Hand a tab back to the user. `close: false` keeps the page:
						// ungrouped, debugger detached, no longer owned.
						case "releaseTab":
							if (typeof args.close !== "boolean") throw new Error("Invalid close");
							await instances.releaseTab(string("id"), string("owner"), args.close, req.signal);
							break;
						// Tabs the browser opened from this one, auto-leased to its owner.
						case "childTabs":
							return Response.json({ tabs: instances.childTabs(string("id"), string("owner")) });
						default:
							throw new Error("Unknown browser operation");
					}
					return Response.json({});
				} catch (error) {
					return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
				}
			}
			const managedVersion = /^\/managed\/([^/]+)\/json\/version$/.exec(route);
			if (managedVersion) {
				const leaseId = managedVersion[1]!;
				const instance = instances.forLease(leaseId);
				if (!instance) return new Response("Stale tab ownership", { status: 410 });
				return Response.json(instance.bridge.versionInfo(`ws://${host}/cdp?lease=${encodeURIComponent(leaseId)}`));
			}
			if (route === "/cdp") {
				const leaseId = url.searchParams.get("lease");
				if (!leaseId) return new Response("Acquire an exact tab before connecting", { status: 403 });
				const instance = instances.forLease(leaseId);
				if (!instance) return new Response("Stale tab ownership", { status: 410 });
				if (srv.upgrade(req, { data: { role: "cdp", leaseId, bridge: instance.bridge } })) return undefined;
				return new Response("WebSocket upgrade required", { status: 426 });
			}
			if (route === "/json/version" || route === "/json" || route === "/json/list")
				return new Response("Use paired-browser discovery and exact tab acquisition", { status: 410 });
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			maxPayloadLength: 256 * 1024 * 1024,
			idleTimeout: 0,
			open(ws: RelayWebSocket): void {
				sockets.add(ws);
				if (ws.data.role === "ext") instances.extConnected(ws);
				else ws.data.connId = ws.data.bridge.cdpConnected(ws, ws.data.leaseId);
			},
			message(ws: RelayWebSocket, message: string | Buffer): void {
				const text = typeof message === "string" ? message : new TextDecoder().decode(message);
				if (ws.data.role === "ext") instances.extMessage(ws, text);
				else if (ws.data.connId !== undefined) ws.data.bridge.cdpMessage(ws.data.connId, text);
			},
			close(ws: RelayWebSocket): void {
				sockets.delete(ws);
				if (ws.data.role === "ext") instances.extClosed(ws);
				else if (ws.data.connId !== undefined) ws.data.bridge.cdpClosed(ws.data.connId);
			},
		},
	});
	const keepalive = setInterval(() => {
		for (const ws of sockets) ws.ping();
	}, 30_000);
	keepalive.unref();
	const port = server.port!;
	// The bound port, not the requested one: an ephemeral relay still has to be
	// able to spell out the reinstall command for a build-skewed extension.
	instances.port = port;
	log("relay listening", { port });
	return {
		instances,
		access,
		port,
		stop() {
			clearInterval(keepalive);
			instances.close();
			server.stop(true);
		},
	};
}
