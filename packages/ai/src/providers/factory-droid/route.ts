import { buildModel } from "@oh-my-pi/pi-catalog/build";
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
	model: Model<"factory-droid-agent">,
	registry: FactoryDroidModelPolicy | undefined,
): string | undefined {
	return (model.factoryDroidApiProviders ?? registry?.rotation ?? ["fireworks"])[0];
}

/**
 * The model Factory's shared transport encodes `model` as on `wire` for
 * `upstream`, with the route's request policy: the same API, compat and
 * thinking the request (and its history replay) runs on.
 */
export function factoryDroidInnerRoute(
	model: Model<"factory-droid-agent">,
	wire: FactoryDroidSharedWire,
	upstream: string,
	baseUrl: string,
): { policy: RequestPolicy; inner: Model<FactoryDroidSharedWire> } {
	const resolved = resolveModelPolicy({ ...model, api: wire }, { upstream });
	return {
		policy: resolved.request,
		inner: buildModel({
			...model,
			api: wire,
			baseUrl,
			compat: resolved.compat,
			thinking: resolved.thinking,
		} as ModelSpec<FactoryDroidSharedWire>),
	};
}
