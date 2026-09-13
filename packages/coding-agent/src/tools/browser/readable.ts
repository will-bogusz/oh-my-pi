import type * as DomNs from "@oh-my-pi/pi-utils/dom";
import type * as ReadabilityNs from "@oh-my-pi/pi-utils/readability";
import { htmlToBasicMarkdown } from "../../web/scrapers/types";

export type ReadableFormat = "text" | "markdown";

export interface ReadableResult {
	url: string;
	title?: string;
	byline?: string;
	excerpt?: string;
	contentLength: number;
	text?: string;
	markdown?: string;
}

/** Trim to non-empty string or undefined. */
function normalize(text: string | null | undefined): string | undefined {
	const trimmed = text?.trim();
	return trimmed || undefined;
}

let readabilityModule: typeof ReadabilityNs | undefined;
async function loadReadability(): Promise<typeof ReadabilityNs> {
	if (!readabilityModule) {
		readabilityModule = await import("@oh-my-pi/pi-utils/readability");
	}
	return readabilityModule;
}

let domModule: typeof DomNs | undefined;
async function loadDom(): Promise<typeof DomNs> {
	if (!domModule) {
		domModule = await import("@oh-my-pi/pi-utils/dom");
	}
	return domModule;
}

/**
 * Elements that end a line of prose. `textContent` concatenates across them,
 * which turns a whole article into one line — unreadable, and the first thing
 * any per-line budget cuts.
 */
const BLOCK_TAGS: Readonly<Record<string, true>> = {
	ADDRESS: true,
	ARTICLE: true,
	ASIDE: true,
	BLOCKQUOTE: true,
	BR: true,
	CAPTION: true,
	DD: true,
	DETAILS: true,
	DIALOG: true,
	DIV: true,
	DL: true,
	DT: true,
	FIELDSET: true,
	FIGCAPTION: true,
	FIGURE: true,
	FOOTER: true,
	FORM: true,
	H1: true,
	H2: true,
	H3: true,
	H4: true,
	H5: true,
	H6: true,
	HEADER: true,
	HR: true,
	LI: true,
	MAIN: true,
	NAV: true,
	OL: true,
	P: true,
	PRE: true,
	SECTION: true,
	SUMMARY: true,
	TABLE: true,
	TD: true,
	TH: true,
	TR: true,
	UL: true,
};
const SKIP_TAGS: Readonly<Record<string, true>> = { SCRIPT: true, STYLE: true, NOSCRIPT: true, TEMPLATE: true };

/**
 * Text of a subtree with a line break wherever the document has a block
 * boundary. Whitespace inside a line is collapsed the way a renderer collapses
 * it; `<pre>` keeps its own.
 */
function blockText(root: DomNs.Node): string {
	const parts: string[] = [];
	const walk = (node: DomNs.Node, preserve: boolean): void => {
		if (node.nodeType === 3) {
			parts.push(preserve ? (node.textContent ?? "") : (node.textContent ?? "").replace(/\s+/g, " "));
			return;
		}
		if (node.nodeType !== 1) return;
		const tag = (node as DomNs.Element).tagName?.toUpperCase() ?? "";
		if (SKIP_TAGS[tag]) return;
		const block = BLOCK_TAGS[tag] === true;
		if (block) parts.push("\n");
		for (const child of Array.from(node.childNodes)) walk(child, preserve || tag === "PRE");
		if (block) parts.push("\n");
	};
	walk(root, false);
	return parts
		.join("")
		.split("\n")
		.map(line => line.trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * Extract readable content from raw HTML.
 * Tries Readability (article-isolation scoring) first, then falls back to a
 * CSS selector chain over the same pre-parsed DOM. Returns null if neither
 * path yields usable content.
 */
export async function extractReadableFromHtml(
	html: string,
	url: string,
	format: ReadableFormat,
): Promise<ReadableResult | null> {
	const [{ parseHTML }, { Readability }] = await Promise.all([loadDom(), loadReadability()]);
	const { document } = parseHTML(html);

	// --- Primary: Readability article extraction ---
	const article = new Readability(document).parse();
	if (article) {
		// Readability returns the article as markup plus a `textContent` that has
		// no block boundaries in it at all; re-read its own markup for the breaks.
		// The markup is a fragment, so it needs a body to parse into.
		const body = article.content ? parseHTML(`<body>${article.content}</body>`).document.body : null;
		const text = body ? blockText(body) : article.textContent;
		const result = await toReadableResult(url, format, text, article.content, {
			title: article.title,
			byline: article.byline,
			excerpt: article.excerpt,
			length: article.length,
		});
		if (result) return result;
	}

	// --- Fallback: CSS selector chain ---
	const candidates = [
		document.querySelector("[data-pagefind-body]"),
		document.querySelector("main article"),
		document.querySelector("article"),
		document.querySelector("main"),
		document.querySelector("[role='main']"),
		document.body,
	];
	for (const el of candidates) {
		if (!el) continue;
		const innerHTML = el.innerHTML?.trim();
		const textContent = blockText(el);
		if (!innerHTML || !textContent) continue;
		const result = await toReadableResult(url, format, textContent, innerHTML, {
			title: document.title,
			excerpt: textContent.slice(0, 240),
			length: textContent.length,
		});
		if (result) return result;
	}

	return null;
}

/** Shared builder for both extraction paths. */
async function toReadableResult(
	url: string,
	format: ReadableFormat,
	textContent: string | null | undefined,
	htmlContent: string | null | undefined,
	meta: { title?: string | null; byline?: string | null; excerpt?: string | null; length?: number | null },
): Promise<ReadableResult | null> {
	const text = normalize(textContent);
	const markdown =
		format === "markdown" ? (normalize(await htmlToBasicMarkdown(htmlContent ?? "")) ?? text) : undefined;
	const normalizedText = format === "text" ? text : undefined;
	if (!normalizedText && !markdown) return null;
	return {
		url,
		title: normalize(meta.title),
		byline: normalize(meta.byline),
		excerpt: normalize(meta.excerpt),
		contentLength: meta.length ?? text?.length ?? markdown?.length ?? 0,
		text: normalizedText,
		markdown,
	};
}
