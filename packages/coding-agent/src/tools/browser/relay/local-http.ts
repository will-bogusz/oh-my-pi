import type { Socket } from "bun";

function decodeResponse(bytes: Buffer): Response {
	const split = bytes.indexOf("\r\n\r\n");
	if (split < 0) throw new Error("Invalid local browser response");
	const lines = bytes.subarray(0, split).toString("latin1").split("\r\n");
	const match = /^HTTP\/1\.[01] (\d{3})/.exec(lines.shift() ?? "");
	if (!match) throw new Error("Invalid local browser status");
	const headers = new Headers();
	for (const line of lines) {
		const colon = line.indexOf(":");
		if (colon <= 0) throw new Error("Invalid local browser header");
		headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
	}
	let body = bytes.subarray(split + 4);
	if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
		const chunks: Buffer[] = [];
		let offset = 0;
		while (true) {
			const end = body.indexOf("\r\n", offset);
			if (end < 0) throw new Error("Incomplete browser response chunk");
			const sizeText = body.subarray(offset, end).toString("ascii").split(";", 1)[0]!;
			if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error("Invalid browser response chunk");
			const size = Number.parseInt(sizeText, 16);
			offset = end + 2;
			if (size === 0) break;
			if (offset + size + 2 > body.length || body.subarray(offset + size, offset + size + 2).toString() !== "\r\n")
				throw new Error("Truncated browser response chunk");
			chunks.push(body.subarray(offset, offset + size));
			offset += size + 2;
		}
		body = Buffer.concat(chunks);
		headers.delete("transfer-encoding");
	} else if (headers.has("content-length") && Number(headers.get("content-length")) !== body.length) {
		throw new Error("Truncated browser response");
	}
	const status = Number(match[1]);
	return new Response([204, 205, 304].includes(status) ? null : body, { status, headers });
}

/** Bun fetch AND node:http honor proxy env. Direct TCP protects private local control traffic. */
export function localBrowserRequest(
	url: string,
	options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
	const endpoint = new URL(url);
	if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
		throw new Error("Browser control requires a loopback HTTP endpoint");
	const headers = new Headers(options.headers);
	headers.set("host", endpoint.host);
	headers.set("connection", "close");
	if (options.body !== undefined) headers.set("content-length", String(Buffer.byteLength(options.body)));
	const request = `${options.method ?? "GET"} ${endpoint.pathname}${endpoint.search} HTTP/1.1\r\n${[...headers].map(([key, value]) => `${key}: ${value}\r\n`).join("")}\r\n${options.body ?? ""}`;
	const result = Promise.withResolvers<Response>();
	const signal = options.signal ?? AbortSignal.timeout(25_000);
	let socket: Socket<undefined> | undefined;
	let settled = false;
	const chunks: Buffer[] = [];
	let length = 0;
	const finish = (error?: unknown): void => {
		if (settled) return;
		settled = true;
		signal.removeEventListener("abort", abort);
		if (error !== undefined) result.reject(error);
		else {
			try {
				result.resolve(decodeResponse(Buffer.concat(chunks)));
			} catch (failure) {
				result.reject(failure);
			}
		}
		socket?.terminate();
	};
	const abort = (): void => finish(signal.reason ?? new Error("Browser request aborted"));
	if (signal.aborted) {
		abort();
		return result.promise;
	}
	signal.addEventListener("abort", abort, { once: true });
	void Bun.connect({
		hostname: endpoint.hostname.replace(/^\[|\]$/g, ""),
		port: Number(endpoint.port || 80),
		socket: {
			open(client) {
				socket = client;
				if (settled) client.terminate();
				else client.write(request);
			},
			data(_client, chunk) {
				length += chunk.length;
				if (length > 32 * 1024 * 1024) finish(new Error("Browser response exceeds 32 MB"));
				else chunks.push(Buffer.from(chunk));
			},
			close() {
				finish();
			},
			error(_client, error) {
				finish(error);
			},
		},
	}).then(client => {
		socket = client;
		if (settled) client.terminate();
	}, finish);
	return result.promise;
}
