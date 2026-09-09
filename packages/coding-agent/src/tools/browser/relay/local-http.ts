import * as http from "node:http";

/**
 * `fetch` honors proxy env vars, which would route private local control
 * traffic (control token in the header) through a configured proxy. `node:http`
 * never consults them and never follows redirects, so the only thing left to
 * enforce here is that the endpoint really is loopback.
 */
export function localBrowserRequest(
	url: string,
	options: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<Response> {
	const endpoint = new URL(url);
	if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))
		throw new Error("Browser control requires a loopback HTTP endpoint");
	const { promise, resolve, reject } = Promise.withResolvers<Response>();
	const request = http.request(
		{
			hostname: endpoint.hostname.replace(/^\[|\]$/g, ""),
			port: Number(endpoint.port || 80),
			path: `${endpoint.pathname}${endpoint.search}`,
			method: options.method ?? "GET",
			headers: options.headers,
		},
		response => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("error", reject);
			response.on("end", () => {
				const status = response.statusCode ?? 502;
				const headers = new Headers();
				for (const [key, value] of Object.entries(response.headers))
					for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value])
						headers.append(key, entry);
				// Bodyless statuses reject a body, even an empty one.
				resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
			});
		},
	);
	const signal = options.signal ?? AbortSignal.timeout(25_000);
	const abort = (): void => {
		const reason: unknown = signal.reason;
		reject(reason instanceof Error ? reason : new Error("Browser request aborted"));
		request.destroy();
	};
	request.on("error", reject);
	if (signal.aborted) abort();
	else {
		signal.addEventListener("abort", abort, { once: true });
		request.end(options.body);
	}
	return promise;
}
