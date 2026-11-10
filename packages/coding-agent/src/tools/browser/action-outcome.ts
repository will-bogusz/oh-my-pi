/**
 * One line saying what a browser action did to the page, printed into the cell output. Models read what a cell
 * prints but rarely the value an action returns, since they act and then look in the same cell.
 */
import { truncate, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import type { Frame } from "puppeteer-core";
import type { DialogState } from "./dialogs";
import { isNavigatedContextError } from "./navigation";

/** Text an action wrote into a field: `fill` replaces its value, `type` inserts into it. */
export interface ActionInput {
	text: string;
	replaces: boolean;
}

/** Marks an op as an action whose outcome the cell output reports. */
export interface ActionOutcomeOptions {
	/** The frame the action works in; the tab's main frame when unset. */
	frame?: Frame;
	/** What the action wrote, so a value the page rewrote (`maxlength`, input masks) is read back. */
	input?: ActionInput;
}

/** Hooks the outcome needs from the tab that runs the action. */
export interface ActionOutcomeHooks {
	/** The tab's pending JavaScript dialog; page evaluations stall while one is open. */
	dialog(): DialogState | undefined;
	/** Wait for a main-frame navigation the action requested to commit; unset for actions inside a child frame. */
	navigation?(): Promise<unknown>;
}

/** Longest one page probe may take; past it the action goes unreported rather than slower. */
const PROBE_TIMEOUT_MS = 400;
/** DOM silence after the action that counts as its effects having landed. */
const QUIET_MS = 80;
/** Longest the outcome waits for that silence; a page that keeps changing is reported as changed. */
const QUIET_CAP_MS = 300;
/** Longest value or dialog message the line quotes. */
const QUOTE_MAX_CHARS = 80;

interface Probe {
	url: string;
	/** Identity of the document the probe was installed in. */
	document: string;
	mutations: number;
	/** Hash of every form control's value and checked state, shadow roots included. */
	fields: number;
	/**
	 * Value of the field the action's last input event went to, else of the focused field (a keystroke the field
	 * refused fires none); absent for password fields and non-fields.
	 */
	value?: string;
	/** Milliseconds since the action started or the DOM last changed, whichever is later. */
	quiet: number;
}

// Runs in the frame's isolated world, so page scripts can neither see nor overwrite the probe. It watches the
// document and every open shadow root. A style or class change on the focused element or the innermost hovered one
// (focus rings, hover and pressed states) does not count; every other node, text and attribute change does. Field
// values are hashed in the page, so only the read-back value of the field the action typed into leaves it.
const INSTALL = `const install = () => {
 let p = globalThis.__ompActionOutcome;
 if (p) return p;
 p = globalThis.__ompActionOutcome = {document: String(Math.random()), mutations: 0, changed: performance.now(), roots: [document]};
 const options = {subtree: true, childList: true, characterData: true, attributes: true};
 const observer = new MutationObserver(records => {
  const now = performance.now();
  for (const r of records) {
   if (r.type === 'childList') for (const node of r.addedNodes) adopt(node);
   const t = r.target;
   if (r.type === 'attributes' && (r.attributeName === 'style' || r.attributeName === 'class')
    && (t === document.activeElement || (t.matches(':hover') && !t.querySelector(':hover')))) continue;
   p.mutations++;
   p.changed = now;
  }
 });
 const adopt = node => {
  if (node.nodeType !== 1 && node.nodeType !== 11) return;
  for (const e of [node, ...node.querySelectorAll('*')]) {
   if (e.shadowRoot && !p.roots.includes(e.shadowRoot)) {
    p.roots.push(e.shadowRoot);
    observer.observe(e.shadowRoot, options);
    adopt(e.shadowRoot);
   }
  }
 };
 observer.observe(document, options);
 if (document.documentElement) adopt(document.documentElement);
 document.addEventListener('input', e => { p.input = e.composedPath()[0]; }, true);
 p.snapshot = () => {
  let fields = 0;
  for (const root of p.roots) for (const e of root.querySelectorAll('input,textarea,select')) {
   for (const c of String(e.value) + (e.checked ? '\\u0001' : '\\u0000')) fields = (Math.imul(fields, 31) + c.charCodeAt(0)) | 0;
  }
  const f = p.input ?? document.activeElement;
  const value = f && 'value' in f && f.type !== 'password' ? String(f.value) : undefined;
  return {url: location.href, document: p.document, mutations: p.mutations, fields, value, quiet: performance.now() - p.changed};
 };
 return p;
};`;
const BEFORE = `(() => {
 ${INSTALL}
 const p = install();
 p.changed = performance.now();
 p.input = undefined;
 return p.snapshot();
})()`;
// A new document gets the probe installed here too, so the next action on it is measured from this moment.
const AFTER = `(() => {
 ${INSTALL}
 return install().snapshot();
})()`;

/**
 * Run `action`, then describe what it did to `frame`'s document: `navigated to <url>`, `page changed`, `no change
 * yet` (nothing changed while the DOM stayed quiet; a slower render may still come), or `dialog pending: …`.
 * `line` is unset when the page could not be probed. The probe never fails, repeats or outlives the action's
 * signal: once the action has run, an abort only drops the line.
 */
export async function runWithActionOutcome<T>(
	frame: Frame,
	action: () => Promise<T>,
	hooks: ActionOutcomeHooks,
	signal: AbortSignal,
	input?: ActionInput,
): Promise<{ result: T; line?: string }> {
	const before = hooks.dialog()?.open ? undefined : await probe(frame, BEFORE, signal);
	const result = await action();
	if (!before) return { result };
	const finished = Date.now();
	await hooks.navigation?.().catch(() => undefined);
	let after: Probe | undefined;
	while (!hooks.dialog()?.open && !signal.aborted) {
		after = await probe(frame, AFTER, signal);
		if (!after || after.document !== before.document) break;
		const waited = Date.now() - finished;
		const quiet = Math.min(after.quiet, waited);
		if (quiet >= QUIET_MS || waited >= QUIET_CAP_MS) break;
		const pause = Math.min(QUIET_MS - quiet, QUIET_CAP_MS - waited);
		try {
			await untilAborted(signal, () => Bun.sleep(pause));
		} catch {
			return { result };
		}
	}
	const dialog = hooks.dialog();
	if (dialog?.open) {
		const message = JSON.stringify(truncate(dialog.message ?? "", QUOTE_MAX_CHARS));
		return { result, line: `dialog pending: ${dialog.type ?? "dialog"} ${message}` };
	}
	if (signal.aborted) return { result };
	if (!after) {
		// The document went away mid-probe and no new one answered in time; its URL alone still tells a navigation.
		if (frame.detached || frame.url() === before.url) return { result };
		return { result, line: `navigated to ${frame.url()}` };
	}
	if (after.url !== before.url || after.document !== before.document)
		return { result, line: `navigated to ${after.url}` };
	let line = after.mutations !== before.mutations || after.fields !== before.fields ? "page changed" : "no change yet";
	if (input && after.value !== undefined) {
		const shown = input.replaces ? after.value === input.text : after.value.includes(input.text);
		if (!shown) line += ` (field now shows ${JSON.stringify(truncate(after.value, QUOTE_MAX_CHARS))})`;
	}
	return { result, line };
}

/** Evaluate a probe in `frame`'s isolated world; a navigation mid-probe gets one retry on the new document. */
async function probe(frame: Frame, script: string, signal: AbortSignal): Promise<Probe | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			return (await withTimeout(
				frame.isolatedRealm().evaluate(script),
				PROBE_TIMEOUT_MS,
				"action outcome probe timed out",
				signal,
			)) as Probe;
		} catch (error) {
			if (signal.aborted || !isNavigatedContextError(error)) return undefined;
		}
	}
	return undefined;
}
