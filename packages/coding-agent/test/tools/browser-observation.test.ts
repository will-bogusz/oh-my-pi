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
	compactNodes,
	flattenSnapshot,
	hasBusyIndicator,
	renderHeader,
} from "@oh-my-pi/pi-coding-agent/tools/browser/observation";
import {
	buildTreeLines,
	formatRefRanges,
	renderTree,
	renderTreeDiff,
} from "@oh-my-pi/pi-coding-agent/tools/observed-tree";
import { printableTree, WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
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
/** What the tab worker passes the shared renderer: browser refs read `eN`. */
const BROWSER_TREE = { prefix: "e", fullHint: "observe({ diff: false }) for the full tree" };

// The tree carries text, structure and embedded documents; refs only where an
// action can land, on both sides of the iframe boundary.
it("renders text, structure and cross-origin iframe content inline with refs on controls only", () => {
	const nodes = flattenSnapshot(GUSTO_LIKE, { includeAll: false });
	let counter = 0;
	const refs = nodes.map(node => (node.actionable ? ++counter : undefined));
	const lines = buildTreeLines(nodes, refs, "e");
	expect(renderTree(renderHeader({ ...HEADER, focused: "e3" }), lines)).toBe(
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
	const before = buildTreeLines(nodes, refs, "e");
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
		"e",
	);
	expect(renderTreeDiff(renderHeader(HEADER), before, after, BROWSER_TREE)).toBe(
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
	expect(renderTreeDiff(renderHeader(HEADER), before, before, BROWSER_TREE)).toBe(
		`${renderHeader(HEADER)}\nno change since the previous observation (11 nodes)`,
	);
	expect(formatRefRanges([47, 12, 40, 41, 42, 43, 44, 45, 46, 50, 51], "e")).toBe("e12, e40-e47, e50, e51");
});

it("treats spinners as unsettled but valued progressbars and headings as content", () => {
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("StaticText", "Loading…")]))).toBe(true);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("img", "Loading contributions")]))).toBe(true);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("progressbar", "Uploading")]))).toBe(true);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("progressbar", "You", { value: "78" })]))).toBe(false);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("heading", "Loading times improved")]))).toBe(false);
	expect(hasBusyIndicator(ax("RootWebArea", "", {}, [ax("StaticText", "Reloading is unnecessary")]))).toBe(false);
});

it("counts loader text only where it stands in for the content", () => {
	const page = (...children: AxNode[]) => hasBusyIndicator(ax("RootWebArea", "Page", {}, children));
	const prose = ax("paragraph", undefined, {}, [
		ax("StaticText", "Revenue grew in every region this quarter. ".repeat(8)),
	]);
	const links = ax("navigation", undefined, {}, [ax("link", "Inbox ".repeat(80))]);
	// Loading wording anywhere in a short spinner-role name.
	expect(page(ax("alert", "Content loading"))).toBe(true);
	expect(page(ax("status", undefined, {}, [ax("StaticText", "Please wait…")]))).toBe(true);
	expect(
		page(ax("StaticText", "Loading is slow when the page has to fetch every attachment from the archive first")),
	).toBe(false);
	// A loader beside the page's content is a footer or a sentinel, not the page.
	expect(page(prose, ax("StaticText", "Loading…"))).toBe(false);
	expect(page(ax("contentinfo", undefined, {}, [ax("StaticText", "Loading…")]))).toBe(false);
	// Only the loader's own `main` counts, and the landmarks around it never do.
	expect(page(links, ax("main", undefined, {}, [ax("heading", "Inbox"), ax("StaticText", "Loading…")]))).toBe(true);
	expect(page(links, ax("main", undefined, {}, [prose, ax("StaticText", "Loading…")]))).toBe(false);
	// The page's own busy state holds wherever it is.
	expect(page(prose, ax("navigation", undefined, { busy: true }))).toBe(true);
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

			const first = await run<{ tree: string; text: string; refs: Record<string, string>; focused?: string }>(
				"first",
				`const observation = await tab.observe();
				 return { tree: observation.tree, text: String(observation), refs: Object.fromEntries(observation.elements.map(e => [e.name, e.ref])), focused: observation.focused };`,
			);
			const tree = first.returnValue.tree;
			// Run-scope code reads the value as its tree too.
			expect(first.returnValue.text).toBe(tree);
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

it("names the cell's own copy of a tree the printed output cannot hold whole", () => {
	// Under the eval sink's inline budget nothing is added; over it the print
	// is middle-cut, which on a long page takes exactly the rows the read was
	// for, and the only cheap way back to them is the value in the cell.
	const small = "- heading \"Overview\"\n- link \"Home\"";
	expect(printableTree(small)).toBe(small);
	const long = Array.from({ length: 4000 }, (_, index) => `- row "${index}" ${"x".repeat(20)}`).join("\n");
	const printed = printableTree(long);
	expect(printed.startsWith(long)).toBe(true);
	expect(printed.slice(long.length)).toContain("tab.initialObservation.tree");
	expect(printed.slice(long.length)).toContain("search it in code");
});

const RECORDS_PAGE = `<!doctype html><title>Records</title><style>.open { cursor: pointer }</style>
<table><tr><th>Name</th><th>Size</th></tr><tr><td>alpha.txt</td><td>1 KB</td></tr></table>
<table>
	<tr onclick="document.title = 'opened invoice 7'"><td>Invoice 7</td><td>$5</td></tr>
	<tr class="open"><td>Invoice 8</td><td>$6</td></tr>
</table>
<div role="grid">
	<div role="row" tabindex="-1"><div role="gridcell">Mail from Bob</div></div>
	<div role="row"><div role="gridcell" class="open">Mail from Al</div><div role="gridcell">Sep 3</div></div>
</div>`;

// Webmail and admin lists open an item only through its row or cell; the page
// says so with a listener, a pointer cursor or a tabindex. A plain data table
// says none of that and stays ref-free.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"gives refs to clickable table rows and cells but not to a plain data table",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 10_000,
		});
		const ready = Promise.withResolvers<ReadyInfo>();
		let result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
		const closed = Promise.withResolvers<void>();
		let receive: (message: WorkerInbound | WorkerOutbound) => void = () => {};
		new WorkerCore(
			{
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
			},
			false,
		);
		const run = async (id: string, code: string) => {
			result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			receive({
				type: "run",
				id,
				name: "records fixture",
				code,
				timeoutMs: 15_000,
				session: { cwd: process.cwd(), refs: "compact" },
			});
			return await result.promise;
		};
		try {
			receive({
				type: "init",
				payload: {
					mode: "headless",
					browserWSEndpoint: browser.wsEndpoint(),
					safeDir: process.cwd(),
					timeoutMs: 10_000,
				},
			});
			const target = await ready.promise;
			const page = (await browser.pages()).find(candidate => {
				const raw = candidate.target();
				return "_targetId" in raw && raw._targetId === target.targetId;
			});
			if (!page) throw new Error("Missing worker page");
			await page.setContent(RECORDS_PAGE);

			const observed = await run(
				"observe",
				`const observation = await tab.observe({ display: false });
				 return { tree: observation.tree, elements: observation.elements.map(e => [e.ref, e.role, e.name ?? ""]) };`,
			);
			if (!observed.ok) throw new Error(observed.error.message);
			const { tree, elements } = observed.payload.returnValue as {
				tree: string;
				elements: [string, string, string][];
			};
			// The listener row, the pointer row (its cells only inherit the cursor),
			// the focusable grid row and the pointer gridcell; nothing in the plain
			// table, and not the grid's static cell.
			expect(elements).toEqual([
				["e1", "row", ""],
				["e2", "row", ""],
				["e3", "row", "Mail from Bob"],
				["e4", "gridcell", "Mail from Al"],
			]);
			expect(tree).toContain('text "alpha.txt"');
			expect(tree).toMatch(/^e1 row\n {2}text "Invoice 7"$/m);

			// The row's ref lands the click on the row.
			const opened = await run(
				"click-row",
				`await (await tab.ref("e1")).click();
				 return await tab.evaluate(() => document.title);`,
			);
			if (!opened.ok) throw new Error(opened.error.message);
			expect(opened.payload.returnValue).toBe("opened invoice 7");

			// A lookup that matched nothing names the call instead of failing inside the parser.
			const missing = await run("ref-undefined", `await tab.ref(undefined);`);
			expect(missing.ok).toBe(false);
			if (missing.ok) throw new Error("tab.ref(undefined) resolved");
			expect(missing.error.message).toContain(
				'tab.ref() needs a ref string such as "e12" from an observation, got undefined',
			);
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
		}
	},
	60_000,
);

it("keeps a frame that did not answer in a compact read, so its missing content is not mistaken for none", () => {
	const page = ax("RootWebArea", "Sign in", { url: "https://shop.example/login" }, [
		ax("heading", "Sign in", { level: 1 }),
		ax("button", "Continue", { backendNodeId: 1 }),
		ax("Iframe", "challenge", { backendNodeId: 2 }, [
			ax("RootWebArea", undefined, { url: "https://widget.example/frame", unanswered: true }),
		]),
	]);
	const compact = compactNodes(flattenSnapshot(page, { includeAll: false }));
	const lines = buildTreeLines(compact, compact.map((node, i) => (node.actionable ? i + 1 : undefined)), "e");
	const tree = renderTree("header", lines);
	expect(tree).toContain('button "Continue"');
	expect(tree).toMatch(/\[iframe widget\.example .*did not answer in time/);
	expect(tree).not.toContain('heading "Sign in"');
});
