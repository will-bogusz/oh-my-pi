/**
 * Password managers draw their inline autofill menus as `chrome-extension://`
 * frames, and Chrome ends an extension's debugger session the moment a frame
 * of another extension starts navigating anywhere in the tab it debugs (and
 * refuses the next attach while that frame exists). The agent focusing and
 * typing into a form is exactly what opens those menus.
 *
 * So while OMP's debugger is attached, the tab's documents carry the page-side
 * opt-outs the vendors themselves honour, and their menus stay closed for the
 * agent. The user's own tabs never see these marks, and a driven tab loses
 * them when the debugger goes back (idle, turn end, release), so the user
 * taking over a tab gets autofill again.
 *
 * | vendor | mark | scope |
 * | --- | --- | --- |
 * | 1Password | `data-1p-ignore` on `<body>` | the document, read at every focus |
 * | Dashlane | `<meta name="dashlane/analysis" content="no">` | the document and its frames, read when it analyses the page |
 * | Bitwarden (≤ 2026.8; later only with its "honor ignore attribute" setting) | `data-bwignore` | the field |
 * | Proton Pass | `data-protonpass-ignore` | the field |
 *
 * Vendors without a page opt-out (LastPass by default, Enpass, iCloud
 * Passwords) are handled by the extension instead: it removes a foreign
 * extension frame when Chrome refuses an attach over it.
 *
 * Installed per document over the attachment (`Page.addScriptToEvaluateOnNewDocument`
 * runs before any page or content script, so an autofocused field is already
 * covered), plus once into the current document. Frames in another process
 * (cross-site iframes) are not reached.
 */
export const AUTOFILL_OPT_OUT_INSTALL = `(() => {
	const KEY = "__ompAutofillOptOut";
	const FIELD_MARKS = ["data-bwignore", "data-protonpass-ignore"];
	const FIELDS = "input, textarea, select";
	const install = win => {
		let doc;
		try { doc = win.document; } catch { return; }
		if (win[KEY]) return win[KEY].apply();
		// Only what this script set is taken back: a page's own opt-out stays.
		const added = [];
		const mark = (element, name) => {
			if (element.hasAttribute(name)) return;
			element.setAttribute(name, "");
			added.push(() => element.removeAttribute(name));
		};
		const markTree = root => {
			if (root.matches(FIELDS)) for (const name of FIELD_MARKS) mark(root, name);
			for (const field of root.querySelectorAll(FIELDS)) for (const name of FIELD_MARKS) mark(field, name);
			for (const frame of root.querySelectorAll("iframe, frame")) {
				try { if (frame.contentWindow) install(frame.contentWindow); } catch {}
			}
		};
		const apply = () => {
			if (doc.body) mark(doc.body, "data-1p-ignore");
			if (doc.head && !doc.head.querySelector('meta[name="dashlane/analysis"]')) {
				const meta = doc.createElement("meta");
				meta.name = "dashlane/analysis";
				meta.content = "no";
				doc.head.append(meta);
				added.push(() => meta.remove());
			}
			if (doc.documentElement) markTree(doc.documentElement);
		};
		const observer = new MutationObserver(records => {
			if ((doc.body && !doc.body.hasAttribute("data-1p-ignore")) || (doc.head && !doc.head.querySelector('meta[name="dashlane/analysis"]'))) apply();
			for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) markTree(node);
		});
		observer.observe(doc, { childList: true, subtree: true });
		win[KEY] = {
			apply,
			remove: () => {
				observer.disconnect();
				delete win[KEY];
				for (const undo of added.splice(0)) undo();
				for (let i = 0; i < win.frames.length; i++) {
					try { win.frames[i][KEY]?.remove(); } catch {}
				}
			},
		};
		apply();
	};
	install(window);
})()`;

export const AUTOFILL_OPT_OUT_REMOVE = `window.__ompAutofillOptOut?.remove()`;
