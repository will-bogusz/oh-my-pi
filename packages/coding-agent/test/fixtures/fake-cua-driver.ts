// A stand-in `cua-driver mcp --direct`: newline-delimited JSON-RPC over stdio.
// Tools: `echo` (returns its arguments), `sleep` ({ms}; honours cancellation
// when FAKE_CUA_CANCEL=1, replying with the driver's typed cancelled envelope),
// `crash` (exits abruptly), `pid` (returns process.pid). Set FAKE_CUA_CANCEL=1
// to advertise `cancel_operation` and honour `notifications/cancelled`.
const supportsCancel = process.env.FAKE_CUA_CANCEL === "1";
const decoder = new TextDecoder();
const inflight = new Map<number, () => void>();

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function toolResult(id: number, structured: Record<string, unknown>, isError = false): void {
	write({
		jsonrpc: "2.0",
		id,
		result: { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError },
	});
}

function cancel(requestId: unknown): boolean {
	const settle = typeof requestId === "number" ? inflight.get(requestId) : undefined;
	if (!settle) return false;
	settle();
	return true;
}

async function handle(message: {
	id?: number;
	method?: string;
	params?: { name?: string; arguments?: Record<string, unknown>; requestId?: unknown };
}): Promise<void> {
	const { id, method, params } = message;
	if (method === "notifications/cancelled") {
		if (supportsCancel) cancel(params?.requestId);
		return;
	}
	if (id === undefined) return;
	if (method === "initialize") {
		write({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
		return;
	}
	if (method === "tools/list") {
		const tools = [{ name: "echo" }, { name: "sleep" }, { name: "crash" }, { name: "pid" }, { name: "get_config" }];
		if (supportsCancel) tools.push({ name: "cancel_operation" });
		write({ jsonrpc: "2.0", id, result: { tools } });
		return;
	}
	if (method !== "tools/call") {
		write({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
		return;
	}
	const name = params?.name;
	const args = params?.arguments ?? {};
	switch (name) {
		case "get_config":
			toolResult(id, { version: "fake-1.0" });
			return;
		// Both backends' key sets: this stand-in runs on whichever host the
		// suite runs on, and each platform reads only its own keys.
		case "check_permissions":
			toolResult(id, { accessibility: true, screen_recording: true, x11: true, atspi: true, xsend_event: true });
			return;
		case "list_apps":
			toolResult(id, { apps: [], pid: process.pid });
			return;
		case "echo":
			toolResult(id, { echoed: args });
			return;
		case "pid":
			toolResult(id, { pid: process.pid });
			return;
		case "crash":
			process.exit(3);
		case "cancel_operation": {
			toolResult(id, { cancelled: cancel(args.request_id) });
			return;
		}
		case "sleep": {
			const ms = typeof args.ms === "number" ? args.ms : 0;
			const { promise, resolve } = Promise.withResolvers<"done" | "cancelled">();
			const timer = setTimeout(() => resolve("done"), ms);
			inflight.set(id, () => {
				clearTimeout(timer);
				resolve("cancelled");
			});
			const outcome = await promise;
			inflight.delete(id);
			if (outcome === "cancelled") {
				write({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: "cancelled" }],
						structuredContent: { code: "cancelled", call_id: `fake#${id}`, partial: { waited_ms: ms } },
						isError: true,
					},
				});
			} else toolResult(id, { slept_ms: ms });
			return;
		}
		default:
			toolResult(id, { code: "unknown_tool", error: `unknown tool ${String(name)}` }, true);
	}
}

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
	buffer += decoder.decode(chunk, { stream: true });
	let newline = buffer.indexOf("\n");
	while (newline >= 0) {
		const line = buffer.slice(0, newline);
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (line.trim()) void handle(JSON.parse(line));
	}
}
// stdin EOF: drain in-flight work, then exit like the real driver.
while (inflight.size > 0) await Bun.sleep(10);
process.exit(0);
