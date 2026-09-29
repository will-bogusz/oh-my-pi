/**
 * A window scroll's reply, said from what the driver measured. The driver
 * samples the window's pixels around the gesture and classifies what the view
 * did; the sentence here leads with that verdict, at the point in the caller's
 * own coordinates, so a scroll that landed nothing can never read as sent.
 */
import type { ComputerScrollOutcome, ComputerScrollOutcomeKind } from "./types";

type Wire = Record<string, unknown>;

const OUTCOMES: Record<string, ComputerScrollOutcomeKind> = {
	moved: "moved",
	at_end: "at_end",
	no_motion: "no_motion",
	changed_in_place: "changed_in_place",
	unmeasured: "unmeasured",
};
const DIRECTIONS: Record<string, ComputerScrollOutcome["direction"]> = {
	up: "up",
	down: "down",
	left: "left",
	right: "right",
};

function record(value: unknown): Wire | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Wire) : undefined;
}
function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The driver's `scroll` object, window-local screenshot pixels and all; absent from a driver that measures none. */
export interface DriverScroll {
	readonly outcome: ComputerScrollOutcome;
	/** Where the wheel went, in the driver's window-local screenshot pixels. */
	readonly point: { x: number; y: number } | undefined;
}

export function readDriverScroll(data: Wire): DriverScroll | undefined {
	const scroll = record(data.scroll);
	const outcome = typeof scroll?.outcome === "string" ? OUTCOMES[scroll.outcome] : undefined;
	const direction = typeof scroll?.direction === "string" ? DIRECTIONS[scroll.direction] : undefined;
	if (scroll === undefined || outcome === undefined || direction === undefined) return undefined;
	const point = record(scroll.point);
	const x = finite(point?.x);
	const y = finite(point?.y);
	const wheel = record(scroll.wheel);
	const unit = wheel?.unit === "pixel" || wheel?.unit === "line" ? wheel.unit : undefined;
	const events = finite(wheel?.events);
	const total = finite(wheel?.total);
	const chunks = finite(scroll.chunks);
	return {
		point: x === null || y === null ? undefined : { x, y },
		outcome: {
			outcome,
			delivery: scroll.delivery === "foreground" ? "foreground" : "background",
			direction,
			requestedPt: finite(scroll.requested_pt),
			movedPt: finite(scroll.moved_pt),
			acrossPt: finite(scroll.across_pt),
			confidence: finite(scroll.confidence),
			...(unit !== undefined && events !== null && total !== null ? { wheel: { unit, events, total } } : {}),
			...(chunks === null ? {} : { chunks }),
			...(typeof scroll.reason === "string" && scroll.reason ? { reason: scroll.reason } : {}),
		},
	};
}

/** How the wheel was sent, for the parenthesis after the verdict. */
function detail(scroll: ComputerScrollOutcome): string {
	const parts: string[] = [];
	if (scroll.requestedPt !== null) parts.push(`requested ${Math.round(scroll.requestedPt)} pt`);
	const wheel = scroll.wheel;
	const route = `${scroll.delivery} ${wheel === undefined ? "" : wheel.unit === "pixel" ? "pointer " : "line "}wheel`;
	const sent = [
		...(scroll.chunks !== undefined && scroll.chunks > 1 ? [`${scroll.chunks} chunks`] : []),
		...(wheel === undefined
			? []
			: [
					wheel.unit === "pixel"
						? `${Math.round(wheel.total)} px`
						: `${wheel.total} line${wheel.total === 1 ? "" : "s"}`,
				]),
	];
	parts.push(sent.length ? `${route}, ${sent.join(", ")}` : route);
	return ` (${parts.join("; ")})`;
}

const OPPOSITE: Record<ComputerScrollOutcome["direction"], ComputerScrollOutcome["direction"]> = {
	up: "down",
	down: "up",
	left: "right",
	right: "left",
};

/** The driver's reason ends with `stopped early: <why>` when the gesture was cut short. */
const STOPPED_EARLY = /(?:^|;\s*)stopped early:\s*(.+?)\.?$/i;
/** Why-clauses the driver writes when the user, not the target, interrupted the gesture. */
const USER_TOOK_OVER = /the user has it|another application came to the front/i;

/**
 * The next step after a scroll the driver stopped or never sent, by why: a
 * user who took the pointer or the front app is not to be fought.
 */
export function stoppedScrollAdvice(why: string): string {
	return USER_TOOK_OVER.test(why)
		? "The user has the pointer or the front app now: do not retry this scroll; wait until they are done, or ask."
		: "Observe before scrolling again.";
}

/**
 * The verdict line. `where` is the point in the caller's coordinates, a ref,
 * or the window centre, already worded (`(163, 400)`, `n5`). `confirmed` is
 * the driver's own postcondition (`effect: "confirmed"`): only then does a
 * move read ✓. Travel against the request is its own verdict, and a move
 * with no net travel reads as the end it is. A gesture the driver cut short
 * says why on the same line; one the user interrupted says the user has the
 * pointer, and no outcome's own next step is offered in its place.
 */
export function scrollVerdict(scroll: ComputerScrollOutcome, where: string, confirmed: boolean): string {
	const stopped = scroll.reason === undefined ? undefined : STOPPED_EARLY.exec(scroll.reason);
	const stop = stopped?.[1];
	const verdict = measuredVerdict(scroll, where, confirmed, stop === undefined, scroll.reason?.slice(0, stopped?.index));
	if (stop === undefined) return verdict;
	return `${verdict}. Stopped early: ${stop}. ${stoppedScrollAdvice(stop)}`;
}

function measuredVerdict(
	scroll: ComputerScrollOutcome,
	where: string,
	confirmed: boolean,
	advise: boolean,
	reason: string | undefined,
): string {
	const moved = scroll.movedPt === null ? 0 : Math.round(scroll.movedPt);
	const mark = confirmed ? "✓" : "?";
	const next = (advice: string) => (advise ? ` — ${advice}` : "");
	switch (scroll.outcome) {
		case "moved":
		case "at_end":
			if (moved < 0)
				return `? Moved the other way: the view scrolled ${OPPOSITE[scroll.direction]} ${-moved} pt at ${where}${detail(
					scroll,
				)}${next("observe before the next coordinate action")}`;
			if (scroll.outcome === "moved" && moved > 0)
				return `${mark} Scrolled ${scroll.direction} ${moved} pt at ${where}${detail(scroll)}`;
			// Either signature — a bounce, or travel that stopped short with the
			// frames settled — is the view's end; which one fired is not reported.
			return `${mark} At end: moved ${moved}${
				scroll.requestedPt === null ? "" : ` of ${Math.round(scroll.requestedPt)}`
			} pt at ${where}, then the view stopped at its end${next(
				`scrolling further ${scroll.direction} there moves nothing`,
			)}${detail(scroll)}`;
		case "no_motion":
			return `✗ No motion at ${where} — no displacement observed${detail(scroll)}${
				advise
					? scroll.delivery === "background"
						? '; the view may be at its end — unless it is, retry with { delivery: "foreground" }: background wheels do not reach views that scroll only under the real pointer'
						: "; the view may be at its end, or nothing under that point scrolls with the wheel (a pager or carousel pages by tapping its edge)"
					: ""
			}`;
		case "changed_in_place":
			return `? Changed in place at ${where}: pixels changed but nothing shifted (a pager, sheet or navigation)${detail(
				scroll,
			)}${next("observe before the next coordinate action")}`;
		case "unmeasured": {
			// The driver words its reason `capture unavailable: <why>`.
			const why = reason?.replace(/^capture unavailable:\s*/i, "");
			return `? Unmeasured: scrolled ${scroll.direction} at ${where}${detail(scroll)}, but the capture was unavailable${
				why ? `: ${why}` : ""
			}${next("observe({ screenshot: true }) to see where it landed")}`;
		}
	}
}
