import { expect, it } from "bun:test";
import { toError } from "../src/type-guards";

it("unwraps a host event without losing the underlying failure's type or stack", () => {
	let failure: unknown;
	try {
		decodeURIComponent("%");
	} catch (error) {
		failure = error;
	}
	const normalized = toError(new ErrorEvent("error", { error: failure, message: "dispatch wrapper" }));
	expect(normalized).toBeInstanceOf(URIError);
	expect(normalized.stack).toBe((failure as Error).stack);
	expect(normalized.message).not.toContain("dispatch wrapper");
});

it("extracts a message-only native event instead of its object tag", () => {
	const normalized = toError(new ErrorEvent("error", { message: "Browser rejected the connection" }));
	expect(normalized.message).toContain("rejected the connection");
	expect(String(normalized)).not.toContain("[object ErrorEvent]");
});

it("keeps the event message when the host's nested-error accessor is unavailable", () => {
	const event = new ErrorEvent("error", { message: "Browser connection closed" });
	Object.defineProperty(event, "error", {
		get() {
			throw new Error("Host accessor unavailable");
		},
	});
	expect(toError(event).message).toContain("connection closed");
});
