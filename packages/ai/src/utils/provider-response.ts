import type { Api, Model, ProviderResponseMetadata, StreamOptions, Usage } from "../types";

export function normalizeProviderResponse(
	response: Response,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): ProviderResponseMetadata {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	const providerResponse: ProviderResponseMetadata = {
		status: response.status,
		headers,
	};
	if (requestId !== undefined) providerResponse.requestId = requestId;
	if (metadata !== undefined) providerResponse.metadata = metadata;
	return providerResponse;
}

export async function notifyProviderResponse(
	options: Pick<StreamOptions, "onResponse"> | undefined,
	response: Response,
	model?: Model<Api>,
	requestId?: string | null,
	metadata?: Record<string, unknown>,
): Promise<void> {
	if (!options?.onResponse) return;
	await options.onResponse(normalizeProviderResponse(response, requestId, metadata), model);
}

/** Reconcile token-price estimates with a gateway's authoritative account charge. */
export function applyProviderReportedCost(model: Pick<Model, "provider">, usage: Usage, rawUsage: unknown): void {
	if (
		(model.provider !== "openrouter" && model.provider !== "cline-pass") ||
		typeof rawUsage !== "object" ||
		rawUsage === null
	)
		return;
	const reportedCost = Reflect.get(rawUsage, "cost");
	if (typeof reportedCost !== "number" || !Number.isFinite(reportedCost) || reportedCost < 0) return;

	const estimatedCost = usage.cost.total;
	if (Number.isFinite(estimatedCost) && estimatedCost > 0) {
		const scale = reportedCost / estimatedCost;
		usage.cost.input *= scale;
		usage.cost.output *= scale;
		usage.cost.cacheRead *= scale;
		usage.cost.cacheWrite *= scale;
	} else {
		// Keep legacy component-only aggregators additive when catalog pricing is unavailable.
		usage.cost.input = reportedCost;
		usage.cost.output = 0;
		usage.cost.cacheRead = 0;
		usage.cost.cacheWrite = 0;
	}
	usage.cost.total = reportedCost;
}
