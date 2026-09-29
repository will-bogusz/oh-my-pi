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

/**
 * The verdict line. `where` is the point in the caller's coordinates, a ref,
 * or the window centre, already worded (`(163, 400)`, `n5`). `confirmed` is
 * the driver's own postcondition (`effect: "confirmed"`): only then does a
 * move read ✓. Travel against the request is its own verdict, and a move
 * with no net travel reads as the end it is.
 */
export function scrollVerdict(scroll: ComputerScrollOutcome, where: string, confirmed: boolean): string {
	const moved = scroll.movedPt === null ? 0 : Math.round(scroll.movedPt);
	const mark = confirmed ? "✓" : "?";
	switch (scroll.outcome) {
		case "moved":
		case "at_end":
			if (moved < 0)
				return `? Moved the other way: the view scrolled ${OPPOSITE[scroll.direction]} ${-moved} pt at ${where}${detail(
					scroll,
				)} — observe before the next coordinate action`;
			if (scroll.outcome === "moved" && moved > 0)
				return `${mark} Scrolled ${scroll.direction} ${moved} pt at ${where}${detail(scroll)}`;
			// Either signature — a bounce, or travel that stopped short with the
			// frames settled — is the view's end; which one fired is not reported.
			return `${mark} At end: moved ${moved}${
				scroll.requestedPt === null ? "" : ` of ${Math.round(scroll.requestedPt)}`
			} pt at ${where}, then the view stopped at its end — scrolling further ${scroll.direction} there moves nothing${detail(scroll)}`;
		case "no_motion":
			return `✗ No motion at ${where} — the view under that point did not scroll${detail(scroll)}; ${
				scroll.delivery === "background"
					? 'unless it is already at its end, retry with { delivery: "foreground" }: background wheels do not reach views that scroll only under the real pointer'
					: "nothing there scrolls with the wheel (a pager or carousel pages by tapping its edge) or it is already at its end: pick a point inside the list"
			}`;
		case "changed_in_place":
			return `? Changed in place at ${where}: pixels changed but nothing shifted (a pager, sheet or navigation)${detail(
				scroll,
			)} — observe before the next coordinate action`;
		case "unmeasured": {
			// The driver words its reason `capture unavailable: <why>`.
			const why = scroll.reason?.replace(/^capture unavailable:\s*/i, "");
			return `? Unmeasured: scrolled ${scroll.direction} at ${where}${detail(scroll)}, but the capture was unavailable${
				why ? `: ${why}` : ""
			} — observe({ screenshot: true }) to see where it landed`;
		}
	}
}
