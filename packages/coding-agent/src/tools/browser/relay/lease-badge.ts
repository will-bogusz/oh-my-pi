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
 * In-page pointer for a leased tab. The favicon glyph says *which* tab OMP
 * drives; this says *where* it is acting, which is the only thing the user can
 * read at the moment a driven tab becomes visible (Chrome raising a
 * page-opened child, or the user switching to it themselves).
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
	// Glyph tip inside a 24px box scaled from the 32-unit viewBox: the arrow
	// point, not the box corner, has to land on the dispatched coordinates.
	const TIP_X = 24 * 7 / 32, TIP_Y = 24 * 2.5 / 32;
	let host = null, arrow = null, pressTimer = 0, x = 0, y = 0;
	const paint = (scale) => {
		arrow.style.transform = "translate3d(" + (x - TIP_X) + "px," + (y - TIP_Y) + "px,0) scale(" + scale + ")";
	};
	const mount = () => {
		if (host && host.isConnected) return true;
		const root = document.documentElement;
		if (!root) return false;
		host = document.createElement("div");
		host.setAttribute("data-omp-cursor", "");
		host.setAttribute("aria-hidden", "true");
		host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;border:0;margin:0;padding:0;background:none;contain:strict";
		const shadow = host.attachShadow({ mode: "closed" });
		arrow = document.createElement("div");
		arrow.style.cssText = "position:fixed;top:0;left:0;width:24px;height:24px;opacity:0;pointer-events:none;" +
			"transform-origin:" + TIP_X + "px " + TIP_Y + "px;will-change:transform;" +
			"filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));" +
			"transition:transform 120ms ease-out,opacity 120ms ease-out";
		arrow.innerHTML = ${JSON.stringify(GLYPH_SVG.replace("<svg ", '<svg width="24" height="24" style="display:block" '))};
		shadow.append(arrow);
		root.append(host);
		return true;
	};
	window[KEY] = {
		move: (nx, ny) => {
			if (!mount()) return;
			x = nx; y = ny;
			arrow.style.opacity = "1";
			paint(1);
		},
		press: () => {
			if (!host || !host.isConnected) return;
			clearTimeout(pressTimer);
			paint(0.7);
			pressTimer = setTimeout(() => paint(1), 120);
		},
		hide: () => {
			if (arrow) arrow.style.opacity = "0";
		},
		remove: () => {
			clearTimeout(pressTimer);
			delete window[KEY];
			for (const node of document.querySelectorAll("[data-omp-cursor]")) node.remove();
			host = null;
			arrow = null;
		},
	};
})()`;

export const CURSOR_OVERLAY_REMOVE = `window.__ompCursor?.remove()`;
