import { expect, it } from "bun:test";
import type { AxNode } from "@oh-my-pi/pi-coding-agent/tools/browser/observation";
import type {
	ReadyInfo,
	RefStyle,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import {
	buildTreeLines,
	flattenSnapshot,
	formatRefRanges,
	hasBusyIndicator,
	renderTree,
	renderTreeDiff,
} from "@oh-my-pi/pi-coding-agent/tools/browser/observation";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function ax(role: string, name?: string, extra: Partial<AxNode> = {}, children?: AxNode[]): AxNode {
	return {
		role,
		name,
		loaderId: "L",
		...extra,
		...(children ? { children } : {}),
	};
}

const GUSTO_LIKE = ax("RootWebArea", "401(k) contributions", { url: "https://app.gusto.com/401k" }, [
	ax("navigation", undefined, {}, [ax("link", "Home", { backendNodeId: 1 }), ax("link", "Pay", { backendNodeId: 2 })]),
	ax("main", undefined, {}, [
		ax("heading", "401(k)", { level: 1 }),
		ax("StaticText", "Account ID: 23I1202C-F8V93"),
		ax("tab", "Contributions", { backendNodeId: 3, selected: true }),
		ax("tab", "Overview", { backendNodeId: 4, selected: false }),
		ax("Iframe", "Guideline", { backendNodeId: 5 }, [
			ax("RootWebArea", "Guideline", { url: "https://my.guideline.com/savers/contributions", loaderId: "G" }, [
				ax("StaticText", "$1,387 / pay period", { loaderId: "G" }),
				ax("textbox", "Amount in percent", { backendNodeId: 5, loaderId: "G", value: "14.5" }),
			]),
		]),
	]),
]);

const HEADER = { url: "https://app.gusto.com/401k", title: "401(k) contributions", scroll: { y: 0, scrollHeight: 2140 } };

// The tree carries text, structure and embedded documents; refs only where an
// action can land, on both sides of the iframe boundary.
it("renders text, structure and cross-origin iframe content inline with refs on controls only", () => {
	const nodes = flattenSnapshot(GUSTO_LIKE, { includeAll: false });
	let counter = 0;
	const refs = nodes.map(node => (node.actionable ? ++counter : undefined));
	const lines = buildTreeLines(nodes, refs);
	expect(renderTree({ ...HEADER, focused: "e3" }, lines)).toBe(
		[
			"url: https://app.gusto.com/401k | title: 401(k) contributions | scroll: 0/2140 | focused: e3",
			"navigation",
			'  e1 link "Home"',
			'  e2 link "Pay"',
			"main",
			'  heading "401(k)"',
			'  text "Account ID: 23I1202C-F8V93"',
			'  e3 tab "Contributions" [selected]',
			'  e4 tab "Overview" [selected=false]',
			"  [iframe my.guideline.com]",
			'    text "$1,387 / pay period"',
			'    e5 textbox "Amount in percent" = "14.5"',
		].join("\n"),
	);
});

it("diffs only the changed subtree and summarizes removals as ref ranges", () => {
	const nodes = flattenSnapshot(GUSTO_LIKE, { includeAll: false });
	let counter = 0;
	const refs = nodes.map(node => (node.actionable ? ++counter : undefined));
	const before = buildTreeLines(nodes, refs);
	// The iframe re-rendered: one textbox changed value, the pay-period text was
	// replaced, and a new button appeared; the navigation lost both links.
	const afterNodes = flattenSnapshot(
		ax("RootWebArea", "401(k) contributions", { url: "https://app.gusto.com/401k" }, [
			ax("navigation"),
			ax("main", undefined, {}, [
				ax("heading", "401(k)", { level: 1 }),
				ax("StaticText", "Account ID: 23I1202C-F8V93"),
				ax("tab", "Contributions", { backendNodeId: 3, selected: true }),
				ax("tab", "Overview", { backendNodeId: 4, selected: false }),
				ax("Iframe", "Guideline", { backendNodeId: 5 }, [
					ax("RootWebArea", "Guideline", { url: "https://my.guideline.com/savers/contributions" }, [
						ax("StaticText", "$1,500 / pay period"),
						ax("textbox", "Amount in percent", { backendNodeId: 5, value: "15" }),
						ax("button", "Save", { backendNodeId: 6 }),
					]),
				]),
			]),
		]),
		{ includeAll: false },
	);
	const afterRefs: Record<string, number> = { Contributions: 3, Overview: 4, "Amount in percent": 5, Save: 6 };
	const after = buildTreeLines(
		afterNodes,
		afterNodes.map(node => (node.actionable ? afterRefs[node.name] : undefined)),
	);
	expect(renderTreeDiff(HEADER, before, after)).toBe(
		[
			"url: https://app.gusto.com/401k | title: 401(k) contributions | scroll: 0/2140",
			"diff vs previous observation (+ added, ~ changed; observe({ diff: false }) for the full tree)",
			"  main",
			"    [iframe my.guideline.com]",
			'+     text "$1,500 / pay period"',
			'~     e5 textbox "Amount in percent" = "15"',
			'+     e6 button "Save"',
			"removed: e1, e2, 1 unreferenced node",
			"unchanged: 7 nodes",
		].join("\n"),
	);
	expect(renderTreeDiff(HEADER, before, before)).toBe(
		`${renderTree(HEADER, []).split("\n")[0]}\nno change since the previous observation (11 nodes)`,
	);
	expect(formatRefRanges([47, 12, 40, 41, 42, 43, 44, 45, 46, 50, 51])).toBe("e12, e40-e47, e50, e51");
});

it("treats spinners as unsettled but valued progressbars and headings as content", () => {
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("StaticText", "Loading…")]))).toBe(true);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("img", "Loading contributions")]))).toBe(true);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("progressbar", "Uploading")]))).toBe(true);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("progressbar", "You", { value: "78" })]))).toBe(false);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("heading", "Loading times improved")]))).toBe(false);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("StaticText", "Reloading is unnecessary")]))).toBe(false);
});

const MAIN_PAGE = (widgetUrl: string) => `<!doctype html><title>401(k) contributions</title>
<nav><a href="/">Home</a><a href="/pay">Pay</a></nav>
<main>
  <h1>401(k)</h1>
  <p>Account ID: 23I1202C-F8V93</p>
  <div role="tablist"><button role="tab" aria-selected="true">Contributions</button><button role="tab" aria-selected="false">Overview</button></div>
  <button id="more">View all recent transactions</button>
  <div id="out"></div>
  <iframe src="${widgetUrl}" title="Guideline" style="width:400px;height:200px"></iframe>
</main>
<script>
  // A real delay is the behaviour under test: the observation must wait out the spinner.
  document.getElementById("more").addEventListener("click", () => {
    const out = document.getElementById("out");
    out.innerHTML = "<p>Loading…</p>";
    setTimeout(() => { out.innerHTML = "<p>Transaction $871.79 on Sep 1</p>"; }, 600);
  });
</script>`;

const WIDGET_PAGE = `<!doctype html><title>Guideline</title>
<p>$1,387 / pay period</p>
<label>Amount in percent <input value="14.5"></label>`;

it.skipIf(!CHROMIUM_AVAILABLE)(
	"observes settled pages with stable refs, inline text, OOPIF content and diffs",
	async () => {
		const widget = Bun.serve({
			hostname: "localhost",
			port: 0,
			fetch: () => new Response(WIDGET_PAGE, { headers: { "content-type": "text/html" } }),
		});
		const widgetUrl = `http://localhost:${widget.port}/widget`;
		const main = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(MAIN_PAGE(widgetUrl), { headers: { "content-type": "text/html" } }),
		});
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 10_000,
			// Force the widget into its own renderer so the iframe is a real OOPIF.
			args: ["--site-per-process"],
		});
		const ready = Promise.withResolvers<ReadyInfo>();
		let result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
		const closed = Promise.withResolvers<void>();
		let receive: (message: WorkerInbound | WorkerOutbound) => void = () => {};
		const transport: Transport = {
			send(message) {
				if (message.type === "ready") ready.resolve(message.info);
				if (message.type === "init-failed") ready.reject(new Error(message.error.message));
				if (message.type === "result") result.resolve(message);
				if (message.type === "closed") closed.resolve();
			},
			onMessage(handler) {
				receive = handler;
				return () => {};
			},
			close() {},
		};
		new WorkerCore(transport, false);
		try {
			receive({
				type: "init",
				payload: { mode: "headless", browserWSEndpoint: browser.wsEndpoint(), safeDir: process.cwd(), timeoutMs: 10_000 },
			});
			const target = await ready.promise;
			const page = (await browser.pages()).find(candidate => {
				const raw = candidate.target();
				return "_targetId" in raw && raw._targetId === target.targetId;
			});
			if (!page) throw new Error("Missing worker page");
			const run = async <T,>(id: string, code: string, refs: RefStyle = "compact") => {
				result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
				receive({ type: "run", id, name: "observation fixture", code, timeoutMs: 15_000, session: { cwd: process.cwd(), refs } });
				const settled = await result.promise;
				if (!settled.ok) throw new Error(settled.error.message);
				// The fixture code above returns exactly the shape the call site declares.
				const returnValue = settled.payload.returnValue as T;
				return { returnValue, displays: settled.payload.displays };
			};

			await page.goto(`http://127.0.0.1:${main.port}/`, { waitUntil: "load" });
			await page.waitForFrame(frame => frame.url() === widgetUrl);
			// Only an out-of-process iframe shows up as its own target; a same-process frame has none.
			expect(browser.targets().some(candidate => candidate.url() === widgetUrl)).toBe(true);

			const first = await run<{ tree: string; refs: Record<string, string>; focused?: string }>(
				"first",
				`const observation = await tab.observe();
				 return { tree: observation.tree, refs: Object.fromEntries(observation.elements.map(e => [e.name, e.ref])), focused: observation.focused };`,
			);
			const tree = first.returnValue.tree;
			expect(tree).toContain('heading "401(k)"');
			expect(tree).toContain('text "Account ID: 23I1202C-F8V93"');
			expect(tree).toContain(`[iframe localhost:${widget.port}]`);
			expect(tree).toContain('text "$1,387 / pay period"');
			expect(tree).toMatch(/e\d+ textbox "Amount in percent" = "14\.5"/);
			expect(tree).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/ \| title: 401\(k\) contributions \| scroll: 0\/\d+$/m);
			expect(tree).not.toContain("Loading");
			// observe() prints the tree itself, so a display() wrapper is unnecessary.
			expect(first.displays.map(part => (part.type === "text" ? part.text : "")).join("\n")).toContain(tree);
			const refs = first.returnValue.refs;

			// A DOM change: a new control appears before the existing ones. Existing
			// refs stay, the newcomer gets the next number, and the default view is
			// the diff — only the addition and its ancestors are listed.
			const second = await run<{ tree: string; refs: Record<string, string> }>(
				"second",
				`await tab.evaluate(() => {
					 const extra = document.createElement("button");
					 extra.textContent = "Extra";
					 document.querySelector("nav").prepend(extra);
				 });
				 const observation = await tab.observe();
				 return { tree: observation.tree, refs: Object.fromEntries(observation.elements.map(e => [e.name, e.ref])) };`,
			);
			const secondValue = second.returnValue;
			for (const name of ["Home", "Pay", "Contributions", "View all recent transactions", "Amount in percent"]) {
				expect(secondValue.refs[name]).toBe(refs[name]);
			}
			const maxRef = Math.max(...Object.values(refs).map(ref => Number(ref.slice(1))));
			expect(secondValue.refs.Extra).toBe(`e${maxRef + 1}`);
			expect(secondValue.tree).toContain(`+   e${maxRef + 1} button "Extra"`);
			expect(secondValue.tree).toContain("diff vs previous observation");
			expect(secondValue.tree).not.toContain("Account ID");
			expect(secondValue.tree).toContain("unchanged:");

			// Act then observe in one cell: the click swaps in a spinner that resolves
			// 600 ms later; the observation waits it out and shows the result.
			const third = await run<string>(
				"third",
				`await (await tab.ref(${JSON.stringify(refs["View all recent transactions"])})).click();
				 return (await tab.observe()).tree;`,
			);
			expect(third.returnValue).toContain('+   text "Transaction $871.79 on Sep 1"');
			expect(third.returnValue).not.toContain("Loading");

			// Refs from the first observation still act after re-renders and changes.
			const typed = await run<string>(
				"typed",
				`await (await tab.ref(${JSON.stringify(refs["Amount in percent"])})).fill("15");
				 const observation = await tab.observe({ diff: false });
				 return observation.tree;`,
			);
			expect(typed.returnValue).toContain('textbox "Amount in percent" = "15"');
			expect(typed.returnValue).toContain('text "Account ID: 23I1202C-F8V93"');

			// A tree nobody saw is not a baseline: the next printed diff is still
			// measured against the last tree the reader actually got.
			const hidden = await run<{ invisible: string; shown: string }>(
				"hidden-baseline",
				`const add = name => tab.evaluate(\`(() => {
					 const extra = document.createElement("button");
					 extra.textContent = "\${name}";
					 document.querySelector("nav").prepend(extra);
				 })()\`);
				 await add("Hidden step");
				 const invisible = await tab.observe({ display: false });
				 await add("Visible step");
				 const shown = await tab.observe();
				 return { invisible: invisible.tree, shown: shown.tree };`,
			);
			expect(hidden.returnValue.invisible).toContain('button "Hidden step"');
			expect(hidden.returnValue.shown).toContain("diff vs previous observation");
			expect(hidden.returnValue.shown).toContain('button "Hidden step"');
			expect(hidden.returnValue.shown).toContain('button "Visible step"');
			expect(hidden.displays.map(part => (part.type === "text" ? part.text : "")).join("\n")).not.toContain(
				"Hidden step\n",
			);

			// extract validates its positional format argument.
			result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			receive({
				type: "run",
				id: "extract",
				name: "observation fixture",
				code: "await tab.extract({});",
				timeoutMs: 15_000,
				session: { cwd: process.cwd(), refs: "compact" },
			});
			const extract = await result.promise;
			expect(extract.ok).toBe(false);
			if (extract.ok) throw new Error("extract({}) unexpectedly succeeded");
			expect(extract.error.message).toContain('"text"');
			expect(extract.error.message).toContain('"markdown"');
			expect((await run<string>("extract-text", `return await tab.extract("text");`)).returnValue).toContain("$871.79");
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
			main.stop(true);
			widget.stop(true);
		}
	},
	60_000,
);
