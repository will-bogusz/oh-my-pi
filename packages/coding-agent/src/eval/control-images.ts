import type { ControlImageMetadata } from "./types";

/** Validate metadata crossing a language/IPC boundary; never derive paths from captions. */
export function readControlImageMetadata(value: unknown): ControlImageMetadata | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.kind !== "browser" && record.kind !== "computer") return undefined;
	const metadata: ControlImageMetadata = { kind: record.kind };
	if (typeof record.label === "string" && record.label.length > 0) metadata.label = record.label;
	if (typeof record.path === "string" && record.path.length > 0) metadata.path = record.path;
	return metadata;
}
