import type { FactoryDroidModelPolicy } from "@oh-my-pi/pi-catalog/compat/factory-droid";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import type { RequestPolicy } from "@oh-my-pi/pi-catalog/compat/types";
import type { FactoryDroidWire } from "@oh-my-pi/pi-catalog/wire/factory-droid";
import type { Model, ModelSpec } from "../../types";

/** Factory wires served through pi-ai's shared transports rather than the native Gemini client. */
export type FactoryDroidSharedWire = Exclude<FactoryDroidWire, "google-generate">;

/**
 * Default upstream from the discovered rotation. Routing comes from the KDL
 * registry or the spec itself, never from `model.headers`: the shared model
 * cache strips headers from persisted specs, so header-carried routing would
 * vanish on cached loads, while `factoryDroidApiProviders` survives.
 */
export function factoryDroidDefaultUpstream(
	model: Pick<Model<"factory-droid-agent">, "factoryDroidApiProviders">,
	registry: FactoryDroidModelPolicy | undefined,
): string | undefined {
	return (model.factoryDroidApiProviders ?? registry?.rotation ?? ["fireworks"])[0];
}

/**
 * The API, compat and thinking Factory's shared transport encodes `model` with
 * on `wire` for `upstream`, plus the route's request policy. The request
 * builds its inner model from this; history replay reads it as is.
 */
export function factoryDroidWireTarget<TModel extends Pick<Model, "id" | "provider" | "reasoning">>(
	model: TModel,
	wire: FactoryDroidSharedWire,
	upstream: string,
): {
	policy: RequestPolicy;
	target: Omit<TModel, "api" | "compat" | "thinking"> &
		Pick<Model<FactoryDroidSharedWire>, "api" | "compat" | "thinking">;
} {
	// Policy resolution reads identity fields and `baseUrl`, never name, limits or
	// cost, so a replay reader's partial row resolves (as a host-less spec).
	const spec = { ...model, api: wire } as unknown as ModelSpec<FactoryDroidSharedWire>;
	const resolved = resolveModelPolicy(spec, { upstream });
	return {
		policy: resolved.request,
		target: {
			...model,
			api: wire,
			compat: resolved.compat,
			thinking: resolved.thinking,
			reasoning: model.reasoning || resolved.thinking !== undefined,
		},
	};
}
