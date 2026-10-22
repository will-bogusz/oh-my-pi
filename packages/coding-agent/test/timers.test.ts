import { describe, expect, it } from "bun:test";
import { gateVerdict } from "@oh-my-pi/pi-coding-agent/timers/gate";
import { decideDue } from "@oh-my-pi/pi-coding-agent/timers/schedule";
import type { TimerSpec, TimerState } from "@oh-my-pi/pi-coding-agent/timers/types";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-21T12:00:00Z");

function spec(overrides: Partial<TimerSpec>): TimerSpec {
	return {
		id: "t",
		reason: "test",
		tz: "UTC",
		target: { kind: "fresh" },
		whenClosed: "resume",
		action: { kind: "shell", command: "true" },
		cwd: "/",
		overlap: "skip",
		paused: false,
		created: { at: new Date(T0).toISOString(), by: "cli", host: "h", cwd: "/", whenText: "" },
		...overrides,
	};
}

const fresh: TimerState = { seq: 0, runCount: 0, failStreak: 0 };

describe("timer slot math", () => {
	it("coalesces slots missed while no ticker ran into one run of the newest slot", () => {
		// every 5m from 12:00; ticker was down until 12:17 → slots 12:05, 12:10 missed, 12:15 runs.
		const decision = decideDue(spec({ every: "5m" }), fresh, T0 + 17 * MINUTE);
		expect(decision).toEqual({ kind: "due", slot: T0 + 15 * MINUTE, missedSlots: 2 });
	});

	it("never fires the same recurring slot twice once the ledger records it", () => {
		const state = { ...fresh, lastSlot: T0 + 15 * MINUTE };
		expect(decideDue(spec({ every: "5m" }), state, T0 + 19 * MINUTE).kind).toBe("idle");
		expect(decideDue(spec({ every: "5m" }), state, T0 + 20 * MINUTE)).toEqual({
			kind: "due",
			slot: T0 + 20 * MINUTE,
			missedSlots: 0,
		});
	});

	it("records a recurring slot as missed when it is later than half the period", () => {
		// every 1h: the 13:00 slot seen at 13:40 is past the 30m grace.
		const decision = decideDue(spec({ every: "1h" }), { ...fresh, lastSlot: T0 }, T0 + 100 * MINUTE);
		expect(decision).toEqual({ kind: "missed", slot: T0 + 60 * MINUTE, missedSlots: 0 });
	});

	it("fires a one-shot late within the late limit, misses it beyond, and retires it once consumed", () => {
		const at = new Date(T0 + MINUTE).toISOString();
		expect(decideDue(spec({ at }), fresh, T0)).toEqual({ kind: "idle" });
		expect(decideDue(spec({ at }), fresh, T0 + 3 * 3_600_000).kind).toBe("due");
		expect(decideDue(spec({ at }), fresh, T0 + 13 * 3_600_000).kind).toBe("missed");
		expect(decideDue(spec({ at }), { ...fresh, lastSlot: T0 + MINUTE }, T0 + 2 * MINUTE)).toEqual({
			kind: "retire",
			why: "once",
		});
	});

	it("checks a gate at most once per tick-minute", () => {
		const gated = spec({ until: "test -f x" });
		const first = decideDue(gated, fresh, T0 + 10_000);
		expect(first).toEqual({ kind: "due", slot: T0, missedSlots: 0 });
		expect(decideDue(gated, { ...fresh, lastSlot: T0 }, T0 + 50_000).kind).toBe("idle");
		expect(decideDue(gated, { ...fresh, lastSlot: T0 }, T0 + MINUTE + 1).kind).toBe("due");
	});

	it("retires an expired timer before evaluating its schedule", () => {
		const expired = spec({ every: "5m", expiresAt: new Date(T0 + MINUTE).toISOString() });
		expect(decideDue(expired, fresh, T0 + 10 * MINUTE)).toEqual({ kind: "retire", why: "expired" });
	});
});

describe("timer gate exit mapping", () => {
	it("maps exit 0 to fire, 1 to not yet, and anything else (or a timeout) to a broken gate", () => {
		expect(gateVerdict(0, "ok", false)).toEqual({ kind: "met", output: "ok" });
		expect(gateVerdict(1, "", false)).toEqual({ kind: "not-yet" });
		expect(gateVerdict(127, "sh: gh: not found", false)).toEqual({
			kind: "broken",
			exitCode: 127,
			output: "sh: gh: not found",
			timedOut: false,
		});
		// A gate killed by its deadline is broken even if a 0 had been reported.
		expect(gateVerdict(0, "", true).kind).toBe("broken");
	});
});
