/**
 * What a leased tab shows the user: its favicon swapped for a cursor glyph
 * while OMP owns it, and an in-page arrow at the point OMP is clicking. Codex
 * marks driven tabs the same way, and for a background tab whose debugger
 * infobar they cannot see these are the only signals the user gets.
 *
 * Injected over the tab's existing `chrome.debugger` attachment rather than
 * through a content script: `chrome.scripting`/`content_scripts` would need
 * `<all_urls>` host permission (a "read and change all your data on all
 * websites" install prompt) for cosmetics, while the debugger attachment is
 * already there for the whole lease. Pages that refuse injection (chrome://,
 * Web Store, CSP'd data: icons) simply keep their icon.
 */

const GLYPH_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
	'<path d="M7 2.5 26 16.5l-8.6 1 4.7 8.6-4.2 2.4-4.7-8.6L7 25.5z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>' +
	"</svg>";

/**
 * Idempotent, and re-applied on every document: the badge has to survive the
 * page's own late `<link rel=icon>` insertions (and its own navigations, via
 * `Page.addScriptToEvaluateOnNewDocument`) without the relay polling.
 */
export const LEASE_BADGE_INSTALL = `(() => {
	if (window.top !== window) return;
	// Only a real HTML document takes its icon from <link rel=icon> and
	// re-reads it when one is removed. Chrome's PDF viewer accepts the badge
	// and then keeps it after the restore — a tab that looks driven forever —
	// so a document we cannot un-badge is never badged.
	if (document.contentType !== "text/html" && document.contentType !== "application/xhtml+xml") return;
	const KEY = "__ompLeaseBadge";
	if (window[KEY]) { window[KEY].apply(); return; }
	const href = "data:image/svg+xml," + encodeURIComponent(${JSON.stringify(GLYPH_SVG)});
	let originals = null;
	const apply = () => {
		const head = document.head;
		if (!head) return;
		const site = [...head.querySelectorAll("link[rel~='icon' i]")].filter(link => !link.hasAttribute("data-omp-badge"));
		if (site.length) {
			originals ??= [];
			for (const link of site) {
				originals.push(link.outerHTML);
				link.remove();
			}
		}
		if (head.querySelector("link[data-omp-badge]")) return;
		const badge = document.createElement("link");
		badge.setAttribute("rel", "icon");
		badge.setAttribute("data-omp-badge", "");
		badge.setAttribute("href", href);
		head.append(badge);
	};
	const observer = new MutationObserver(() => apply());
	window[KEY] = {
		apply,
		restore: () => {
			observer.disconnect();
			delete window[KEY];
			for (const badge of document.querySelectorAll("link[data-omp-badge]")) badge.remove();
			if (!originals || !document.head) return;
			const template = document.createElement("template");
			template.innerHTML = originals.join("");
			document.head.append(template.content);
		},
	};
	const watch = () => {
		if (!document.head) return false;
		apply();
		observer.observe(document.head, { childList: true });
		return true;
	};
	if (!watch()) new MutationObserver((_, self) => { if (watch()) self.disconnect(); }).observe(document.documentElement, { childList: true, subtree: true });
})()`;

export const LEASE_BADGE_RESTORE = `window.__ompLeaseBadge?.restore()`;

/**
 * Codex's cursor glyph (`images/cursor-chat.png`, 46x48 at 2x), inlined: the
 * overlay is injected over a debugger attachment, so it has no extension URL
 * to fetch an asset from, and a network fetch would make the first move blink.
 */
const CURSOR_ASSET =
	"data:image/png;base64,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";

/**
 * In-page pointer for a leased tab. The favicon glyph says *which* tab OMP
 * drives; this says *where* it is acting, which is the only thing the user can
 * read at the moment a driven tab becomes visible (Chrome raising a
 * page-opened child, or the user switching to it themselves).
 *
 * The motion model is a port of Codex's browser-extension cursor: every
 * property is a spring, a move longer than {@link SCOOT_DISTANCE} follows a
 * bezier path chosen from 20 candidates, the glyph rotates to the travel
 * tangent and stretches with speed, short moves "scoot" (squash along the
 * travel axis and tilt), the whole thing fades/blurs/shrinks through a
 * visibility spring, and after arriving it wobbles once while OMP thinks.
 * `move()` resolves when the glyph has actually arrived, which is what lets
 * the bridge hold a click back until the user can see where it lands.
 *
 * Constants below are Codex's, named as in their bundle so a newer build can
 * be diffed against this table:
 *
 * | Codex | here | value | meaning |
 * | ----- | ---- | ----- | ------- |
 * | `se` | `BOX` | 24 | cursor box side, px |
 * | `X` | `PIVOT` | 12 | pivot inside the box; the dispatched point lands here |
 * | `Pt`/`Lt` | `IMG_W`/`IMG_H` | 23/24 | glyph size in CSS px |
 * | `Bt`/`Ut` | `IMG_DX`/`IMG_DY` | 12/-2.5 | glyph offset inside the box; with `IMG_ROT` this puts the arrow tip 14.5px ahead of the pivot along the rest axis |
 * | `Ft` | `IMG_ROT` | 44 | glyph's own rotation, cancelling `REST_ANGLE` so the asset renders untilted at rest |
 * | `ae`/`Gt` | `GLOW_VAR`/`GLOW_FILTER` | — | glow colour custom property and the two drop-shadows that read it |
 * | `Nn` | `GLOW` | #339cff | glow colour |
 * | `Ht` | `HIDDEN_BLUR` | 5 | blur px at visibility 0 |
 * | `Vt` | `HIDDEN_SCALE` | 0.4 | scale at visibility 0 |
 * | `jn` | `REST_ANGLE` | -44 | rotation with no travel direction, deg |
 * | `kt` | `THINK_DELAY` | 0 | delay before the post-arrival wobble, s |
 * | `$t` | `THINK_DURATION` | 1.41 | wobble envelope length, s |
 * | `Yt` | `THINK_PERIOD` | 0.66 | wobble period, s |
 * | `Wt` | `THINK_AMPLITUDE` | 12.5 | wobble amplitude, deg |
 * | `qt`/`Xt` | `HOME_X`/`HOME_Y` | 0.58/0.55 | viewport fractions the cursor starts at |
 * | `K` | `FRAME` | 1/60 | nominal frame, s: first-frame dt, dt floor, catch-up rewind |
 * | `j` | `STEP` | 1/240 | fixed spring integration step, s |
 * | `Jt` | `MAX_LAG` | 1 | script/simulation drift before resync, s |
 * | `Ue` | `SETTLE` | 0.06 | velocity/force below which a spring may snap to target |
 * | `Kt` | `ARRIVE_DISTANCE` | 0.85 | arrival radius, px |
 * | `Le` | `ARRIVE_VELOCITY` | 12 | arrival speed, px/s |
 * | `jt` | `SCOOT_DISTANCE` | 196 | at or below this the move scoots instead of taking a path, px |
 * | `zt` | `SCOOT_ROTATION` | 70 | scoot tilt amplitude, deg |
 * | `Zt` | `SCOOT_STRETCH_MIX` | 0.15 | how much of the scoot squash is applied |
 * | `Be` | `SCOOT_STRETCH_MIN` | 0 | squash floor |
 * | `Qt` | `SPRING_STRETCH` | .85/.2 | speed stretch |
 * | `en` | `SPRING_VISIBILITY` | .86/.42 | fade in/out |
 * | `tn` | `SPRING_SCOOT_PROGRESS` | .94/.19 | scoot progress 0→1 |
 * | `z` | `SPRING_POSITION` | .9/.19 | position (response overridden per path) |
 * | `Fe` | `SPRING_ROTATION` | .9/.12 | rotation and scoot axis |
 * | `nn` | `SPRING_SCOOT_ROTATION` | .82/.055 | scoot tilt |
 * | `on` | `SPRING_SCOOT_STRETCH` | .86/.12 | scoot squash |
 * | `et` | `PATH_DAMPING` | 0.9 | damping of the path progress spring |
 * | `nt`/`tt` | `PATH_RESPONSE_MIN`/`MAX` | 0.12/2.2 | clamp on the path progress response, s |
 * | `ot` | `PATH_RESPONSE_SCALE` | 0.7 | global speed knob on that response |
 * | `ge` | `PATH` | — | path search config: arc size/flow fractions, 20px bounds margin, 20 candidates, -44deg click angle, 0.42/0.15 handle fractions |
 *
 * Installed and removed with the badge, over the same debugger attachment. The
 * DOM is built lazily on the first move: a document-start script runs before
 * `document.documentElement` exists, and a tab that is never pointed at should
 * not carry an overlay at all.
 */
export const CURSOR_OVERLAY_INSTALL = `(() => {
	if (window.top !== window) return;
	const KEY = "__ompCursor";
	if (window[KEY]) return;

	const BOX = 24; // se
	const PIVOT = BOX / 2; // X
	const IMG_W = 23; // Pt
	const IMG_H = 24; // Lt
	const IMG_DX = 12; // Bt
	const IMG_DY = -2.5; // Ut
	const IMG_ROT = 44; // Ft
	const GLOW_VAR = "--browser-agent-cursor-glow-color"; // ae
	const GLOW = "#339cff"; // Nn
	const GLOW_FILTER = "drop-shadow(0 0 6px color-mix(in srgb, var(" + GLOW_VAR + ") 90%, transparent))" +
		" drop-shadow(0 0 15px color-mix(in srgb, var(" + GLOW_VAR + ") 48%, transparent))"; // Gt
	const HIDDEN_BLUR = 5; // Ht
	const HIDDEN_SCALE = 0.4; // Vt
	const REST_ANGLE = -44; // jn
	const THINK_DELAY = 0; // kt
	const THINK_DURATION = 1.41; // $t
	const THINK_PERIOD = 0.66; // Yt
	const THINK_AMPLITUDE = 12.5; // Wt
	const HOME_X = 0.58; // qt
	const HOME_Y = 0.55; // Xt
	const FRAME = 1 / 60; // K
	const STEP = 1 / 240; // j
	const MAX_LAG = 1; // Jt
	const SETTLE = 0.001 * 60; // Ue
	const ARRIVE_DISTANCE = 0.85; // Kt
	const ARRIVE_VELOCITY = 12; // Le
	const SCOOT_DISTANCE = 196; // jt
	const SCOOT_ROTATION = 70; // zt
	const SCOOT_STRETCH_MIX = 0.15; // Zt
	const SCOOT_STRETCH_MIN = 0; // Be
	const SPRING_STRETCH = { dampingFraction: 0.85, response: 0.2 }; // Qt
	const SPRING_VISIBILITY = { dampingFraction: 0.86, response: 0.42 }; // en
	const SPRING_SCOOT_PROGRESS = { dampingFraction: 0.94, response: 0.19 }; // tn
	const SPRING_POSITION = { dampingFraction: 0.9, response: 0.19 }; // z
	const SPRING_ROTATION = { dampingFraction: 0.9, response: 0.12 }; // Fe
	const SPRING_SCOOT_ROTATION = { dampingFraction: 0.82, response: 0.055 }; // nn
	const SPRING_SCOOT_STRETCH = { dampingFraction: 0.86, response: 0.12 }; // on
	const PATH_DAMPING = 0.9; // et
	const PATH_RESPONSE_MAX = 2.2; // tt
	const PATH_RESPONSE_MIN = 0.12; // nt
	const PATH_RESPONSE_SCALE = 0.7; // ot
	const PATH = { // ge
		arcFlow: 0.5783555327868779,
		arcSize: 0.2765523188064277,
		boundsMargin: 20,
		candidateCount: 20,
		clickAngleDegrees: -44,
		endpointHandle: 0.15,
		startHandle: 0.41960295031576633,
	};

	const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value)); // m
	const lerp = (from, to, t) => from + (to - from) * t; // J
	const round3 = value => Math.round(value * 1000) / 1000; // O
	const now = () => (typeof performance === "undefined" ? Date.now() : performance.now()); // U
	const dist = (a, b) => { const dx = b.x - a.x, dy = b.y - a.y; return Math.sqrt(dx * dx + dy * dy); }; // E
	const magnitude = v => Math.sqrt(v.x * v.x + v.y * v.y);
	const norm = v => { const len = magnitude(v); return len < 0.001 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len }; }; // k
	const deg360 = deg => { const wrapped = deg % 360; return wrapped < 0 ? wrapped + 360 : wrapped; }; // w
	const degDelta = (from, to) => { let d = to - from; while (d > 180) d -= 360; while (d < -180) d += 360; return d; }; // Ye
	const radDelta = (from, to) => { let d = to - from; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }; // ft
	const unit = deg => { const rad = deg * (Math.PI / 180); return { x: Math.sin(rad), y: -Math.cos(rad) }; }; // ye
	// Cubic bezier point and derivative. // Ce / mt
	const bezier = (p0, c1, c2, p1, t) => {
		const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
		return { x: p0.x * a + c1.x * b + c2.x * c + p1.x * d, y: p0.y * a + c1.y * b + c2.y * c + p1.y * d };
	};
	const bezierTangent = (from, seg, t) => {
		const u = 1 - t;
		return {
			x: 3 * u * u * (seg.control1.x - from.x) + 6 * u * t * (seg.control2.x - seg.control1.x) + 3 * t * t * (seg.end.x - seg.control2.x),
			y: 3 * u * u * (seg.control1.y - from.y) + 6 * u * t * (seg.control2.y - seg.control1.y) + 3 * t * t * (seg.end.y - seg.control2.y),
		};
	};
	const inBounds = (p, bounds, margin) => p.x >= margin && p.x <= bounds.width - margin && p.y >= margin && p.y <= bounds.height - margin; // xe
	// Walk \`len\` px from \`from\` along \`dir\`, stopping at the viewport edge. // V
	const clampHandle = (bounds, from, dir, len) => {
		let reach = len;
		if (dir.x < 0) reach = Math.min(reach, from.x / -dir.x);
		if (dir.x > 0) reach = Math.min(reach, (bounds.width - from.x) / dir.x);
		if (dir.y < 0) reach = Math.min(reach, from.y / -dir.y);
		if (dir.y > 0) reach = Math.min(reach, (bounds.height - from.y) / dir.y);
		const used = Math.max(0, reach);
		return { x: from.x + dir.x * used, y: from.y + dir.y * used };
	};

	// ---- springs: SwiftUI-style dampingFraction/response, fixed-step integrated ----
	const spring = (value, target, config) => ({ // R
		dampingFraction: config.dampingFraction, force: 0, response: config.response,
		simulationTime: 0, scriptTime: 0, target, value, velocity: 0,
	});
	const snapSpring = (s, target) => { // v
		s.force = 0; s.simulationTime = 0; s.scriptTime = 0; s.target = target; s.value = target; s.velocity = 0;
	};
	// Angles travel the short way round, so a spring target may sit outside 0..360. // N
	const aimSpring = (s, deg) => { s.target = s.value + degDelta(s.value, deg); };
	const settled = s => { // We
		if (Math.max(s.velocity * s.velocity, s.force * s.force) > SETTLE * SETTLE) return false;
		const tolerance = s.target * 0.01, gap = s.target - s.value;
		return tolerance === 0 || gap * gap <= tolerance * tolerance;
	};
	const integrate = (s, stiffness, damping) => { // An
		const half = STEP / 2, velocity = s.velocity + s.force * half;
		s.value += velocity * STEP;
		s.force = velocity * -damping + (s.target - s.value) * stiffness;
		s.velocity = velocity + s.force * half;
	};
	const advance = (s, dt) => { // I
		const response = Math.max(0.001, s.response);
		const stiffness = Math.min((Math.PI * 2) ** 2 / response ** 2, 1 / (2 * STEP ** 2));
		const damping = Math.sqrt(stiffness) * 2 * s.dampingFraction;
		s.scriptTime += Math.max(0, dt);
		if (s.scriptTime - s.simulationTime > MAX_LAG) s.simulationTime = s.scriptTime - FRAME;
		while (s.simulationTime < s.scriptTime) { integrate(s, stiffness, damping); s.simulationTime += STEP; }
		if (settled(s)) s.value = s.target;
	};
	const atRest = s => s.value === s.target && settled(s); // M

	// ---- path search: 20 candidate beziers, cheapest one that stays on screen wins ----
	const directPath = (start, end, startControl, endControl) => ({ // he
		arc: null, arcIn: null, arcOut: null, end, endControl,
		segments: [{ control1: startControl, control2: endControl, end }], start, startControl,
	});
	const pushArc = o => { // fe + ct
		const arcDistance = o.arcDistanceBase * o.arcDistanceScale;
		const handle = o.arcHandleDistanceBase * o.arcHandleScale;
		const arc = {
			x: o.midpoint.x + o.arcNormal.x * arcDistance + o.clickTangent.x * o.startControlDistance * 0.16,
			y: o.midpoint.y + o.arcNormal.y * arcDistance + o.clickTangent.y * o.startControlDistance * 0.16,
		};
		const arcIn = { x: arc.x - o.arcTangent.x * handle, y: arc.y - o.arcTangent.y * handle };
		const arcOut = { x: arc.x + o.arcTangent.x * handle, y: arc.y + o.arcTangent.y * handle };
		o.candidates.push({
			arc, arcIn, arcOut, end: o.end, endControl: o.endControl,
			segments: [
				{ control1: o.startControl, control2: arcIn, end: arc },
				{ control1: arcOut, control2: o.endControl, end: o.end },
			],
			start: o.start, startControl: o.startControl,
		});
	};
	const pushArcPair = o => { // at
		pushArc(o);
		pushArc({ ...o, arcNormal: { x: -o.arcNormal.x, y: -o.arcNormal.y } });
	};
	const pathCandidates = (start, end, bounds) => { // st
		const clickTangent = unit(PATH.clickAngleDegrees);
		const span = dist(start, end);
		const delta = { x: end.x - start.x, y: end.y - start.y };
		const travel = norm(delta);
		const startLen = Math.max(48, Math.min(640, span * PATH.startHandle, span * 0.9));
		const endLen = Math.max(48, Math.min(640, span * PATH.endpointHandle, span * 0.9));
		const endTangent = { x: -clickTangent.x, y: -clickTangent.y };
		const startControl = clampHandle(bounds, start, clickTangent, startLen);
		const endControl = clampHandle(bounds, end, endTangent, endLen);
		const perp = { x: -travel.y, y: travel.x };
		const side = perp.x * clickTangent.x + perp.y * clickTangent.y >= 0 ? 1 : -1;
		const arcNormal = { x: perp.x * side, y: perp.y * side };
		const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }; // pt
		const tightStart = clampHandle(bounds, start, clickTangent, startLen * 0.65);
		const tightEnd = clampHandle(bounds, end, endTangent, endLen * 0.65);
		const arcTangent = norm(delta);
		const arcDistanceBase = Math.max(50, Math.min(520, span * PATH.arcSize));
		const arcHandleDistanceBase = Math.max(38, Math.min(440, span * PATH.arcFlow));
		const candidates = [
			directPath(start, end, startControl, endControl),
			directPath(start, end, tightStart, tightEnd),
		];
		for (const arcDistanceScale of [0.55, 0.8, 1.05]) {
			for (const arcHandleScale of [0.65, 1, 1.35]) {
				pushArcPair({
					arcDistanceBase, arcDistanceScale, arcHandleDistanceBase, arcHandleScale, arcNormal, arcTangent,
					candidates, clickTangent, end, endControl, midpoint: mid, start, startControl,
					startControlDistance: startLen,
				});
			}
		}
		return candidates.slice(0, PATH.candidateCount);
	};
	// Length, turning energy and whether the whole curve stays on screen. // ve
	const measure = (path, bounds) => {
		let length = 0, angleChangeEnergy = 0, maxAngleChange = 0, totalTurn = 0, prevAngle = null;
		let staysInBounds = bounds == null ? true : inBounds(path.start, bounds, PATH.boundsMargin);
		let segStart = path.start, prev = path.start;
		for (const seg of path.segments) {
			for (let sample = 1; sample <= 24; sample += 1) {
				const point = bezier(segStart, seg.control1, seg.control2, seg.end, sample / 24);
				length += dist(prev, point);
				if (bounds != null) staysInBounds = staysInBounds && inBounds(point, bounds, PATH.boundsMargin);
				const step = { x: point.x - prev.x, y: point.y - prev.y };
				if (magnitude(step) > 0.01) {
					const angle = Math.atan2(step.y, step.x);
					if (prevAngle != null) {
						const turn = radDelta(prevAngle, angle);
						angleChangeEnergy += turn * turn;
						maxAngleChange = Math.max(maxAngleChange, Math.abs(turn));
						totalTurn += Math.abs(turn);
					}
					prevAngle = angle;
				}
				prev = point;
			}
			segStart = seg.end;
		}
		return { angleChangeEnergy, length, maxAngleChange, staysInBounds, totalTurn };
	};
	// How much the travel direction fights the glyph's rest heading. // Se
	const clickAlignment = path => {
		const tangent = unit(REST_ANGLE);
		const travel = norm({ x: path.end.x - path.start.x, y: path.end.y - path.start.y });
		return clamp((-(travel.x * tangent.x + travel.y * tangent.y) - 0.08) / 0.92, 0, 1);
	};
	const pathCost = (path, m) => { // ut
		const span = Math.max(1, dist(path.start, path.end));
		const detour = Math.max(0, m.length / span - 1);
		return m.length + detour * 320 + m.angleChangeEnergy * 140 + m.maxAngleChange * 180 +
			m.totalTurn * 18 + clickAlignment(path) * 90 + (path.arc == null ? 0 : 45);
	};
	const pickPath = (candidates, bounds) => { // lt
		const first = candidates[0];
		if (first == null) throw new Error("Cursor motion requires at least one candidate");
		let best = first, bestCost = Number.POSITIVE_INFINITY, fallback = first, fallbackCost = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) {
			const m = measure(candidate, bounds);
			const cost = pathCost(candidate, m);
			if (cost < fallbackCost) { fallback = candidate; fallbackCost = cost; }
			if (m.staysInBounds && cost < bestCost) { best = candidate; bestCost = cost; }
		}
		return bestCost === Number.POSITIVE_INFINITY ? fallback : best;
	};
	// Longer, twistier, more backtracking paths get a slower progress spring. // dt
	const pathResponse = path => {
		const m = measure(path);
		const span = Math.max(1, dist(path.start, path.end));
		const detour = Math.max(0, m.length / span - 1);
		const lengthTerm = clamp((m.length - 180) / 760, 0, 1);
		const wiggle = clamp(
			clamp(detour / 0.55, 0, 1) * 0.42 +
			clamp(m.totalTurn / (Math.PI * 1.4), 0, 1) * 0.38 +
			clamp(m.angleChangeEnergy / 1.25, 0, 1) * 0.2,
			0, 1,
		);
		const backtrack = clickAlignment(path) * 0.28;
		const arcBonus = path.arc == null ? 0 : 0.04;
		const arcScale = path.arc == null ? 1 : 0.9;
		return clamp((0.42 + lengthTerm * 0.22 + wiggle * 0.12 + backtrack + arcBonus) * PATH_RESPONSE_SCALE * arcScale, PATH_RESPONSE_MIN, PATH_RESPONSE_MAX);
	};
	// The position springs chase the path point much faster than the path is walked. // In
	const progressResponse = response => clamp(response * 0.18, 0.035, 0.12);
	const samplePath = (path, progress) => { // me
		const t = clamp(progress, 0, 1);
		const scaled = t === 1 ? path.segments.length - 1 : t * path.segments.length;
		const index = Math.floor(scaled);
		const seg = path.segments[index];
		if (seg == null) throw new Error("Cursor motion path has no segment for progress");
		const from = index === 0 ? path.start : path.segments[index - 1]?.end;
		if (from == null) throw new Error("Cursor motion path segment is missing its start point");
		const local = t === 1 ? 1 : scaled - index;
		return { point: bezier(from, seg.control1, seg.control2, seg.end, local), tangent: bezierTangent(from, seg, local) };
	};
	const tangentRotation = tangent => { // pe
		if (magnitude(tangent) < 0.001) return deg360(REST_ANGLE);
		const dir = norm(tangent);
		return deg360(Math.atan2(dir.y, dir.x) * (180 / Math.PI) + 90);
	};
	const speedStretch = speed => clamp(1 - speed / 5500, 0.65, 1); // En
	const scootStretch = progress => lerp(1, lerp(1, SCOOT_STRETCH_MIN, Math.sin(clamp(progress, 0, 1) * Math.PI)), SCOOT_STRETCH_MIX); // Rn

	// ---- cursor state ----
	const createState = (point, visible) => { // an
		const visibility = visible ? 1 : 0, rotation = deg360(REST_ANGLE);
		return {
			motion: null, point,
			positionXSpring: spring(point.x, point.x, SPRING_POSITION),
			positionYSpring: spring(point.y, point.y, SPRING_POSITION),
			rotation, rotationSpring: spring(rotation, rotation, SPRING_ROTATION),
			scootAxisRotation: 0, scootAxisSpring: spring(0, 0, SPRING_ROTATION),
			scootRotationSpring: spring(0, 0, SPRING_SCOOT_ROTATION),
			scootStretchSpring: spring(1, 1, SPRING_SCOOT_STRETCH),
			stretchSpring: spring(1, 1, SPRING_STRETCH),
			thinkStartedAt: null,
			visibilitySpring: spring(visibility, visibility, SPRING_VISIBILITY),
		};
	};
	const setPositionResponse = (s, response, dampingFraction) => { // Ge
		s.positionXSpring.response = response; s.positionYSpring.response = response;
		s.positionXSpring.dampingFraction = dampingFraction; s.positionYSpring.dampingFraction = dampingFraction;
	};
	const snapPoint = (s, point) => { s.point = point; snapSpring(s.positionXSpring, point.x); snapSpring(s.positionYSpring, point.y); }; // ce
	const resetScoot = s => { // $e
		snapSpring(s.scootAxisSpring, 0); snapSpring(s.scootRotationSpring, 0);
		snapSpring(s.scootStretchSpring, 1); s.scootAxisRotation = 0;
	};
	const teleport = (s, point) => { // ke
		s.motion = null; snapPoint(s, point);
		snapSpring(s.rotationSpring, deg360(REST_ANGLE)); s.rotation = s.rotationSpring.value;
		resetScoot(s); snapSpring(s.stretchSpring, 1);
	};
	const axisDegrees = dir => (magnitude(dir) < 0.001 ? 0 : Math.atan2(dir.y, dir.x) * (180 / Math.PI)); // dn
	const scootRotationTarget = dir => clamp(dir.x * 0.75 + -dir.y * 0.62, -1, 1) * SCOOT_ROTATION; // gn
	const beginScoot = (s, from, target) => { // ln
		const dir = norm({ x: target.x - from.x, y: target.y - from.y }); // un
		const axisRotation = axisDegrees(dir);
		setPositionResponse(s, SPRING_POSITION.response, SPRING_POSITION.dampingFraction);
		s.positionXSpring.target = target.x;
		s.positionYSpring.target = target.y;
		aimSpring(s.rotationSpring, deg360(REST_ANGLE));
		aimSpring(s.scootAxisSpring, axisRotation);
		s.motion = {
			axisRotation, end: target, mode: "scoot",
			progressSpring: spring(0, 1, SPRING_SCOOT_PROGRESS),
			rotationTarget: scootRotationTarget(dir), start: from,
		};
	};
	const beginMove = (s, target, bounds) => { // cn
		s.thinkStartedAt = null;
		const from = { x: s.point.x, y: s.point.y };
		if (dist(from, target) <= SCOOT_DISTANCE) { beginScoot(s, from, target); return; }
		const path = pickPath(pathCandidates(from, target, bounds), bounds); // rt
		const response = pathResponse(path);
		setPositionResponse(s, progressResponse(response), PATH_DAMPING);
		s.motion = { mode: "bezier", path, progressSpring: spring(0, 1, { dampingFraction: PATH_DAMPING, response }) };
	};
	// Advance position/rotation springs and report the px/s the glyph just covered. // He
	const advancePosition = (s, dt) => {
		const from = s.point;
		advance(s.positionXSpring, dt); advance(s.positionYSpring, dt);
		advance(s.rotationSpring, dt); advance(s.scootAxisSpring, dt);
		const point = { x: s.positionXSpring.value, y: s.positionYSpring.value };
		const speed = dist(from, point) / Math.max(dt, 1 / 240);
		s.point = point; s.rotation = s.rotationSpring.value; s.scootAxisRotation = s.scootAxisSpring.value;
		return { point, speed };
	};
	const arrived = (s, target) => // Ve
		dist(s.point, target) <= ARRIVE_DISTANCE &&
		Math.abs(s.positionXSpring.velocity) <= ARRIVE_VELOCITY &&
		Math.abs(s.positionYSpring.velocity) <= ARRIVE_VELOCITY;
	// Fraction of the scoot's straight line already covered. // On
	const segmentProgress = (point, start, end) => {
		const axis = { x: end.x - start.x, y: end.y - start.y };
		const lenSq = axis.x * axis.x + axis.y * axis.y;
		if (lenSq < 0.001) return 1;
		return clamp(((point.x - start.x) * axis.x + (point.y - start.y) * axis.y) / lenSq, 0, 1);
	};
	const tickBezier = (s, dt, ts) => { // fn
		const motion = s.motion;
		if (motion?.mode !== "bezier") return false;
		s.scootStretchSpring.target = 1;
		s.scootRotationSpring.target = 0;
		advance(motion.progressSpring, dt);
		const progress = clamp(motion.progressSpring.value, 0, 1);
		const sample = samplePath(motion.path, progress);
		s.positionXSpring.target = sample.point.x;
		s.positionYSpring.target = sample.point.y;
		aimSpring(s.rotationSpring, tangentRotation(sample.tangent));
		aimSpring(s.scootAxisSpring, 0);
		s.stretchSpring.target = speedStretch(advancePosition(s, dt).speed);
		if (progress < 0.999 || Math.abs(motion.progressSpring.velocity) >= 0.01 || !arrived(s, sample.point)) return false;
		const end = samplePath(motion.path, 1);
		const rotation = tangentRotation(end.tangent);
		snapPoint(s, end.point);
		snapSpring(s.rotationSpring, rotation); s.rotation = rotation;
		snapSpring(s.scootAxisSpring, 0); s.scootAxisRotation = 0;
		snapSpring(s.stretchSpring, 1);
		s.motion = null; s.thinkStartedAt = ts;
		return true;
	};
	const tickScoot = (s, dt, ts) => { // hn
		const motion = s.motion;
		if (motion?.mode !== "scoot") return false;
		advance(motion.progressSpring, dt);
		s.positionXSpring.target = motion.end.x;
		s.positionYSpring.target = motion.end.y;
		aimSpring(s.scootAxisSpring, motion.axisRotation);
		aimSpring(s.rotationSpring, deg360(REST_ANGLE));
		const travelled = segmentProgress(advancePosition(s, dt).point, motion.start, motion.end);
		s.stretchSpring.target = 1;
		s.scootStretchSpring.target = scootStretch(travelled);
		s.scootRotationSpring.target = motion.rotationTarget * Math.sin(Math.min(1, travelled) * Math.PI);
		if (travelled < 0.999 || Math.abs(motion.progressSpring.velocity) >= 0.01 || !arrived(s, motion.end)) return false;
		snapPoint(s, motion.end);
		snapSpring(s.rotationSpring, deg360(REST_ANGLE)); s.rotation = s.rotationSpring.value;
		resetScoot(s); snapSpring(s.stretchSpring, 1);
		s.motion = null; s.thinkStartedAt = ts;
		return true;
	};
	const updateMotion = (s, dt, ts) => { // pn
		if (s.motion == null) {
			s.stretchSpring.target = 1; s.scootStretchSpring.target = 1; s.scootRotationSpring.target = 0;
			return false;
		}
		s.thinkStartedAt = null;
		const elapsed = Math.max(0, dt);
		return s.motion.mode === "scoot" ? tickScoot(s, elapsed, ts) : tickBezier(s, elapsed, ts);
	};
	const tick = (s, dt, ts) => { // mn
		const done = updateMotion(s, dt, ts);
		advance(s.visibilitySpring, dt); advance(s.stretchSpring, dt);
		advance(s.scootStretchSpring, dt); advance(s.scootRotationSpring, dt);
		return done;
	};
	const animating = s => // vn
		s.motion != null || s.thinkStartedAt != null ||
		!atRest(s.positionXSpring) || !atRest(s.positionYSpring) || !atRest(s.rotationSpring) ||
		!atRest(s.scootAxisSpring) || !atRest(s.scootRotationSpring) || !atRest(s.scootStretchSpring) ||
		!atRest(s.stretchSpring) || !atRest(s.visibilitySpring);
	// One decaying wobble after arriving, while OMP decides what to do next. // xn
	const thinkRotation = (s, ts) => {
		if (s.thinkStartedAt == null) return s.rotation;
		const elapsed = (ts - s.thinkStartedAt) / 1000 - THINK_DELAY;
		if (elapsed < 0) return s.rotation;
		const phase = Math.min(1, elapsed / THINK_DURATION);
		if (phase >= 1) { s.thinkStartedAt = null; return s.rotation; }
		const wobble = Math.sin((elapsed / THINK_PERIOD) * Math.PI * 2) * Math.sin(phase * Math.PI);
		return s.rotation + wobble * THINK_AMPLITUDE;
	};

	let host = null, cursorEl = null, state = null, rafId = null, lastFrame = now();
	let firstFrame = false, destroyed = false, pending = null;

	const viewport = () => ({
		height: window.visualViewport?.height ?? window.innerHeight,
		width: window.visualViewport?.width ?? window.innerWidth,
	});
	const pageVisible = () => document.visibilityState === "visible";
	const settle = () => { const waiter = pending; pending = null; waiter?.(); };
	const render = () => { // Z / Sn / yn
		if (cursorEl == null || state == null) return;
		const rotation = thinkRotation(state, now());
		const visibility = clamp(state.visibilitySpring.value, 0, 1);
		const scale = lerp(HIDDEN_SCALE, 1, visibility);
		const squash = clamp(state.scootStretchSpring.value, SCOOT_STRETCH_MIN, 1);
		const axis = state.scootAxisRotation;
		const parts = ["translate3d(" + round3(state.point.x - PIVOT) + "px, " + round3(state.point.y - PIVOT) + "px, 0)"];
		if (Math.abs(degDelta(0, axis)) > 0.001 || Math.abs(squash - 1) > 0.001) {
			parts.push("rotate(" + round3(axis) + "deg)", "scale(1, " + round3(squash) + ")", "rotate(" + round3(-axis) + "deg)");
		}
		parts.push(
			"rotate(" + round3(deg360(rotation + state.scootRotationSpring.value)) + "deg)",
			"scale(" + round3(state.stretchSpring.value * scale) + ", " + round3(scale) + ")",
		);
		cursorEl.style.transform = parts.join(" ");
		cursorEl.style.opacity = String(round3(visibility));
		cursorEl.style.filter = "blur(" + round3(lerp(HIDDEN_BLUR, 0, visibility)) + "px)";
	};
	const unframe = id => { if (window.cancelAnimationFrame) window.cancelAnimationFrame(id); else window.clearTimeout(id); }; // bn
	const loop = () => { // C
		if (rafId != null || state == null || destroyed) return;
		const onFrame = ts => {
			rafId = null;
			if (state == null || destroyed) return;
			const dt = firstFrame ? FRAME : Math.max(FRAME, (ts - lastFrame) / 1000);
			firstFrame = false;
			lastFrame = ts;
			const done = tick(state, dt, ts);
			render();
			if (done) settle();
			if (animating(state)) loop();
		};
		// Mn: a document without rAF still has to advance, just coarsely.
		rafId = window.requestAnimationFrame
			? window.requestAnimationFrame(onFrame)
			: window.setTimeout(() => onFrame(now()), FRAME * 1000);
	};
	const mount = () => {
		if (destroyed) return false;
		if (host && host.isConnected) return true;
		const root = document.documentElement;
		if (!root) return false;
		host = document.createElement("div");
		host.setAttribute("data-omp-cursor", "");
		host.setAttribute("aria-hidden", "true");
		host.style.cssText = "all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647";
		const shadow = host.attachShadow({ mode: "closed" });
		const layer = document.createElement("div");
		layer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:20";
		cursorEl = document.createElement("div");
		cursorEl.style.cssText = "position:absolute;left:0;top:0;width:" + BOX + "px;height:" + BOX + "px;" +
			"transform-origin:" + PIVOT + "px " + PIVOT + "px;will-change:transform";
		const wrap = document.createElement("div");
		wrap.style.transform = "translate3d(" + IMG_DX + "px, " + IMG_DY + "px, 0)";
		const img = document.createElement("img");
		img.alt = "";
		img.draggable = false;
		img.width = IMG_W;
		img.height = IMG_H;
		img.src = ${JSON.stringify(CURSOR_ASSET)};
		img.style.display = "block";
		img.style.setProperty(GLOW_VAR, GLOW);
		img.style.filter = GLOW_FILTER;
		img.style.transform = "rotate(" + IMG_ROT + "deg) scale(1)";
		img.style.transformOrigin = "0 0";
		wrap.append(img);
		cursorEl.append(wrap);
		layer.append(cursorEl);
		shadow.append(layer);
		root.append(host);
		if (state == null) { // Cn with no coordinates: the cursor starts near the middle of the page
			const view = viewport();
			state = createState(
				{ x: clamp(Math.round(view.width * HOME_X), 0, view.width), y: clamp(Math.round(view.height * HOME_Y), 0, view.height) },
				pageVisible(),
			);
		}
		host.style.display = pageVisible() ? "" : "none";
		render();
		return true;
	};
	const onVisibility = () => {
		if (state == null) return;
		const visible = pageVisible();
		if (host) host.style.display = visible ? "" : "none";
		state.visibilitySpring.target = visible ? 1 : 0;
		if (visible) { loop(); return; }
		// A hidden tab gets no animation frames, so nothing can travel and no
		// arrival can ever fire: land on the destination and release the wait.
		const motion = state.motion;
		teleport(state, motion == null ? state.point : motion.mode === "scoot" ? motion.end : samplePath(motion.path, 1).point);
		snapSpring(state.visibilitySpring, 0);
		if (rafId != null) { unframe(rafId); rafId = null; }
		render();
		settle();
	};
	const onPageShow = () => { if (state != null && mount()) onVisibility(); };
	const onResize = () => {
		if (state == null || state.motion != null) return;
		const view = viewport();
		const inside = { x: clamp(state.point.x, 0, view.width), y: clamp(state.point.y, 0, view.height) };
		if (dist(state.point, inside) >= 0.5) teleport(state, inside);
		render();
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("pageshow", onPageShow);
	window.addEventListener("resize", onResize);
	window.visualViewport?.addEventListener("resize", onResize);

	window[KEY] = {
		move: (nx, ny) => {
			const { promise, resolve } = Promise.withResolvers();
			if (!Number.isFinite(nx) || !Number.isFinite(ny) || !mount()) {
				resolve();
				return promise;
			}
			const view = viewport();
			const target = { x: clamp(nx, 0, view.width), y: clamp(ny, 0, view.height) };
			// A newer move supersedes whoever was waiting on the old one.
			settle();
			if (!pageVisible()) {
				state.visibilitySpring.target = 0;
				teleport(state, target);
				render();
				resolve();
				return promise;
			}
			state.visibilitySpring.target = 1;
			const reveal = state.visibilitySpring.value <= 0.001;
			state.thinkStartedAt = null;
			// A cursor that faded out, or a move too small to be worth travelling:
			// jump rather than fly in from wherever the glyph was left.
			if (reveal || dist(state.point, target) < 0.5) {
				if (reveal) snapSpring(state.visibilitySpring, 1);
				teleport(state, target);
				render();
				loop();
				resolve();
				return promise;
			}
			pending = resolve;
			beginMove(state, target, view);
			firstFrame = true;
			render();
			loop();
			return promise;
		},
		// Codex has no click flourish; its arrival starts the think wobble, so a
		// press restarts exactly that — and supplies it for a teleported move.
		press: () => {
			if (state == null || destroyed) return;
			state.thinkStartedAt = now();
			render();
			loop();
		},
		hide: () => {
			if (state == null || destroyed) return;
			state.visibilitySpring.target = 0;
			settle();
			loop();
		},
		remove: () => {
			destroyed = true;
			settle();
			if (rafId != null) { unframe(rafId); rafId = null; }
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pageshow", onPageShow);
			window.removeEventListener("resize", onResize);
			window.visualViewport?.removeEventListener("resize", onResize);
			delete window[KEY];
			for (const node of document.querySelectorAll("[data-omp-cursor]")) node.remove();
			host = null;
			cursorEl = null;
			state = null;
		},
	};
})()`;

export const CURSOR_OVERLAY_REMOVE = `window.__ompCursor?.remove()`;
