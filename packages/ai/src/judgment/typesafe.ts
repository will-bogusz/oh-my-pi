/**
 * TypeSafe System One client: the native {@link Judge} backend.
 *
 * Forwards a {@link JudgmentRequest} verbatim to the route's decisions
 * endpoint (`POST /v1/systemone` on TypeSafe's own API) and maps the typed
 * answers back. The same wire is re-exposed by OpenRouter's Decisions API
 * ({@link OPENROUTER_JEV_ROUTE}), so an OpenRouter key alone reaches Jev.
 * Credentials flow through {@link withAuth}, so a stored key rotates on
 * 401/403 exactly like chat providers; transient 429/5xx responses retry with
 * bounded, `retry-after`-aware backoff.
 *
 * Environment (mirrors the official SDK): `TYPESAFE_API_KEY` is resolved by
 * the auth registry (`rules/auth/typesafe.kdl`), `TYPESAFE_BASE_URL`
 * overrides the API root, `TYPESAFE_DEFAULT_MODEL` the model.
 */
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import { $env } from "@oh-my-pi/pi-utils";
import { type ApiKey, withAuth } from "../auth-retry";
import * as AIError from "../error";
import { getRetryAfterMsFromHeaders } from "../utils/retry-after";
import {
	type Answer,
	type Judge,
	type JudgeOptions,
	type JudgmentRequest,
	type JudgmentResult,
	type Questions,
	tokenUsage,
} from "./types";

export const TYPESAFE_PROVIDER = "typesafe";
export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/** `TYPESAFE_BASE_URL` when set, else the public API root; trailing slashes stripped. */
export function typesafeBaseUrl(): string {
	return ($env.TYPESAFE_BASE_URL?.trim() || TYPESAFE_DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** `TYPESAFE_DEFAULT_MODEL` when set, else {@link TYPESAFE_DEFAULT_MODEL}. */
export function typesafeModel(): string {
	return $env.TYPESAFE_DEFAULT_MODEL?.trim() || TYPESAFE_DEFAULT_MODEL;
}

/** Where the System One wire is served: TypeSafe's own API, or a gateway that re-exposes it. */
export interface TypeSafeRoute {
	/** API root; trailing slashes stripped. */
	baseUrl: string;
	/** Decisions endpoint under `baseUrl`, taking `{model, state, questions}`. */
	decisionsPath: string;
	/** Reported as {@link JudgmentResult.provider} and the label prefix. */
	provider: string;
	/** Model id the gateway knows Jev by. */
	model: string;
}

/** TypeSafe's own API, honouring `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL`. */
export function typesafeRoute(): TypeSafeRoute {
	return {
		baseUrl: typesafeBaseUrl(),
		decisionsPath: "/v1/systemone",
		provider: TYPESAFE_PROVIDER,
		model: typesafeModel(),
	};
}

/** Jev through OpenRouter's Decisions API, billed to the OpenRouter key. */
export const OPENROUTER_JEV_ROUTE: TypeSafeRoute = {
	baseUrl: "https://openrouter.ai/api",
	decisionsPath: "/alpha/decisions",
	provider: "openrouter",
	model: "typesafe/jev-1.13",
};

export interface TypeSafeJudgeOptions {
	apiKey: ApiKey;
	/** Defaults to {@link typesafeRoute}. */
	route?: TypeSafeRoute;
	/** Overrides the route's API root. */
	baseUrl?: string;
	/** Overrides the route's model. */
	model?: string;
	fetch?: FetchImpl;
	/** Per-attempt timeout; defaults to {@link DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** Non-2xx response from the TypeSafe API. */
export class TypeSafeApiError extends AIError.ProviderHttpError {
	override readonly name = "TypeSafeApiError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 5_000;

/** Wire shape of `GET /v1/models`. */
export interface TypeSafeModelCard {
	name: string;
	description: string;
	release_date: string;
}

interface SystemOneResponse {
	model: string;
	answers: Record<string, Answer>;
	usage: { input_tokens: number; output_tokens: number };
}

/** Server hint wins (capped); otherwise exponential backoff from {@link BACKOFF_BASE_MS}. */
function backoffMs(attempt: number, headers: Headers | undefined): number {
	const hinted = headers === undefined ? undefined : getRetryAfterMsFromHeaders(headers);
	if (hinted !== undefined) return Math.min(hinted, BACKOFF_MAX_MS);
	return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

export class TypeSafeJudge implements Judge {
	readonly label: string;
	readonly model: string;
	readonly baseUrl: string;
	readonly provider: string;
	readonly #decisionsPath: string;
	readonly #apiKey: ApiKey;
	readonly #fetch: FetchImpl;
	readonly #timeoutMs: number;

	constructor(options: TypeSafeJudgeOptions) {
		const route = options.route ?? typesafeRoute();
		this.#apiKey = options.apiKey;
		this.baseUrl = (options.baseUrl ?? route.baseUrl).replace(/\/+$/, "");
		this.#decisionsPath = route.decisionsPath;
		this.provider = route.provider;
		this.model = options.model ?? route.model;
		this.#fetch = options.fetch ?? fetch;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.label = `${this.provider}/${this.model}`;
	}

	async judge<Q extends Questions>(request: JudgmentRequest<Q>, options?: JudgeOptions): Promise<JudgmentResult<Q>> {
		const body = JSON.stringify({ state: request.state, model: this.model, questions: request.questions });
		const response = await this.#request<SystemOneResponse>("POST", this.#decisionsPath, body, options?.signal);
		for (const id in request.questions) {
			const answer = response.answers[id];
			if (answer === undefined || answer.type !== request.questions[id].type) {
				throw new AIError.ProviderResponseError(
					`TypeSafe response is missing a "${request.questions[id].type}" answer for question "${id}"`,
					{ provider: this.provider, kind: "envelope" },
				);
			}
		}
		return {
			api: TYPESAFE_PROVIDER,
			provider: this.provider,
			model: response.model,
			answers: response.answers as JudgmentResult<Q>["answers"],
			usage: tokenUsage(response.usage.input_tokens, response.usage.output_tokens),
		};
	}

	/** Models available to the account (`GET /v1/models`); also the login validation probe. TypeSafe-native only. */
	async listModels(signal?: AbortSignal): Promise<TypeSafeModelCard[]> {
		const response = await this.#request<{ models: TypeSafeModelCard[] }>("GET", "/v1/models", undefined, signal);
		if (!Array.isArray(response.models)) {
			throw new AIError.ProviderResponseError("TypeSafe /v1/models response is missing `models`", {
				provider: TYPESAFE_PROVIDER,
				kind: "envelope",
			});
		}
		return response.models;
	}

	async #request<T>(method: "GET" | "POST", path: string, body: string | undefined, signal?: AbortSignal): Promise<T> {
		return withAuth(this.#apiKey, key => this.#attempt<T>(method, path, body, key, signal), { signal });
	}

	async #attempt<T>(
		method: "GET" | "POST",
		path: string,
		body: string | undefined,
		key: string,
		signal: AbortSignal | undefined,
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		for (let attempt = 0; ; attempt++) {
			signal?.throwIfAborted();
			const timeout = AbortSignal.timeout(this.#timeoutMs);
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method,
					headers,
					body,
					signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
				});
			} catch (error) {
				if (signal?.aborted || attempt + 1 >= MAX_ATTEMPTS) throw error;
				await Bun.sleep(backoffMs(attempt, undefined));
				continue;
			}
			if (response.ok) return (await response.json()) as T;
			const text = await response.text();
			const error = new TypeSafeApiError(`TypeSafe API error (${response.status}): ${text}`, response.status, {
				headers: response.headers,
			});
			const transient = response.status === 408 || response.status === 429 || response.status >= 500;
			if (!transient || attempt + 1 >= MAX_ATTEMPTS) throw error;
			await Bun.sleep(backoffMs(attempt, response.headers));
		}
	}
}
