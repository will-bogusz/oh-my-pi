import type { ControlImageMetadata, ControlImageReference } from "@oh-my-pi/pi-tui/tools/eval";

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

/** Browser tab / computer window a control still was taken of; the unit the preview policy keeps one still per. */
export function controlImageTarget(control: ControlImageMetadata): string {
	return `${control.kind}\u0000${control.label ?? ""}`;
}

/** Well-formed `details.controlImages` from a persisted tool result, or undefined when absent. */
export function readControlImageReferences(details: unknown): ControlImageReference[] | undefined {
	if (!details || typeof details !== "object" || !("controlImages" in details)) return undefined;
	const raw = details.controlImages;
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const references: ControlImageReference[] = [];
	for (const entry of raw) {
		const metadata = readControlImageMetadata(entry);
		if (!metadata || !("index" in entry)) return undefined;
		const index: unknown = entry.index;
		if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return undefined;
		references.push({ ...metadata, index });
	}
	return references;
}

/**
 * Preview policy for one tool result: the model-facing content carries one
 * still per control target — the last one displayed — while `details.images`
 * keeps every displayed image for the renderer. Returns the ordinals into the
 * full image list that stay in the model-facing content, in display order;
 * images without control metadata are always kept.
 */
export function modelFacingImageOrdinals(
	imageCount: number,
	controlImages: readonly ControlImageReference[],
): number[] {
	const superseded = new Set<number>();
	const lastByTarget = new Map<string, number>();
	for (const control of controlImages) {
		const target = controlImageTarget(control);
		const previous = lastByTarget.get(target);
		if (previous !== undefined) superseded.add(previous);
		lastByTarget.set(target, control.index);
	}
	const ordinals: number[] = [];
	for (let index = 0; index < imageCount; index++) {
		if (!superseded.has(index)) ordinals.push(index);
	}
	return ordinals;
}
