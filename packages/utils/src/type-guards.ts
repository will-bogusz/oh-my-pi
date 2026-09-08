export function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Reads an own string-valued property without invoking accessors. */
export function stringProperty(value: object, key: string): string | undefined {
	const field = Object.getOwnPropertyDescriptor(value, key)?.value;
	return typeof field === "string" ? field : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

export function toError(value: unknown): Error {
	if (value instanceof Error) return value;
	// WebSocket connection promises can reject with a native ErrorEvent. Its
	// useful fields are inherited accessors, not own data properties.
	if (typeof ErrorEvent !== "undefined" && value instanceof ErrorEvent) {
		try {
			const nested: unknown = value.error;
			if (nested instanceof Error) return nested;
		} catch {
			// An unavailable host accessor must not mask the event's message.
		}
		try {
			if (value.message) return new Error(value.message);
		} catch {
			// Keep conversion usable even when a host getter throws.
		}
		return new Error("An error event did not provide accessible details");
	}
	return new Error(String(value));
}
