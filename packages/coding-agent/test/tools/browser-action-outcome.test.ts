import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const available = await chromiumAvailable();

// `#change` renders on a page timer after its click returns, as a framework update does.
const page = `<h1>Static</h1>
<button id="change" onclick="setTimeout(() => document.querySelector('h1').textContent = 'Changed', 0)">Change</button>
<button id="self" onclick="this.classList.add('pressed')">Self</button>
<button id="show" onclick="document.getElementById('modal').style.display = 'block'">Show</button>
<div id="modal" style="display: none">Modal</div>
<button id="open" onclick="document.getElementById('panel').classList.add('open')">Open</button>
<div id="panel">Panel</div>
<x-counter></x-counter>
<button id="bump" onclick="document.querySelector('x-counter').shadowRoot.querySelector('span').textContent = '1'">Bump</button>
<button id="confirm" onclick="setTimeout(() => confirm('Continue?'), 0)">Confirm</button>
<input id="short" maxlength="3"><input id="secret" type="password" maxlength="3">
<input id="otp1" maxlength="1" oninput="document.getElementById('otp2').focus()"><input id="otp2" maxlength="1">
<textarea id="upper" oninput="this.value = this.value.toUpperCase()"></textarea>
<select id="pick" onchange="document.querySelector('h1').textContent = this.value"><option>a</option><option>b</option></select>
<a id="link" href="about:blank#next">Next</a>
<iframe id="child" srcdoc="<button id='inner' onclick='this.textContent=&quot;done&quot;'>Inner</button>"></iframe>
<script>customElements.define('x-counter', class extends HTMLElement {
	constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<span>0</span>'; }
});</script>`;

let tool: EvalTool;
const run = async (code: string): Promise<string> => {
	const result = await tool.execute(crypto.randomUUID(), { language: "js", code, timeout: 20 });
	if (result.details?.cells?.[0]?.status !== "complete") throw new Error(JSON.stringify({ code, result }));
	return result.content
		.filter(block => block.type === "text")
		.map(block => block.text)
		.join("\n");
};

beforeAll(async () => {
	if (!available) return;
	const id = crypto.randomUUID();
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"async.enabled": false,
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
		}),
		// One eval session, so the tab variable survives between cells.
		getEvalSessionId: () => id,
		getEvalPreludes: () => [prelude],
	};
	const prelude = createBrowserPrelude(session);
	tool = new EvalTool(session);
	await run(`var t = await browser.open({ app: { relay: false, tern: false } });`);
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!available)("browser action outcomes", () => {
	const load = () => run(`await t.goto(${JSON.stringify(`data:text/html,${encodeURIComponent(page)}`)});`);

	test("goto and a navigating click print where they went", async () => {
		expect(await load()).toContain("navigated to data:text/html,");
		expect(await run(`await t.click('#link'); return 1`)).toContain("navigated to about:blank#next");
	});

	test("a click prints whether the page changed, mid-cell and for element handles", async () => {
		await load();
		const noop = await run(`await t.click('h1'); return 'after'`);
		expect(noop).toContain("no change yet");
		expect(noop).toContain("after");
		expect(await run(`await t.click('#change'); return 1`)).toContain("page changed");
		const handle = await run(
			`await t.run(async ({ tab }) => { await (await tab.waitFor('h1')).click(); return 1; })`,
		);
		expect(handle).toContain("no change yet");
	});

	test("style, class and shadow-root changes count; the clicked element's own state does not", async () => {
		await load();
		expect(await run(`await t.click('#show'); return 1`)).toContain("page changed");
		expect(await run(`await t.click('#open'); return 1`)).toContain("page changed");
		expect(await run(`await t.click('#bump'); return 1`)).toContain("page changed");
		expect(await run(`await t.click('#self'); return 1`)).toContain("no change yet");
	});

	test("fill and type read back a value the page rewrote, but never a password", async () => {
		await load();
		expect(await run(`await t.fill('#short', 'abcdef'); return 1`)).toContain('page changed (field now shows "abc")');
		expect(await run(`await t.type('#short', 'x'); return 1`)).toContain('(field now shows "abc")');
		const handleFill = await run(
			`await t.run(async ({ tab }) => { await (await tab.waitFor('#short')).fill('abcdef'); return 1; })`,
		);
		expect(handleFill).toContain('(field now shows "abc")');
		const secret = await run(`await t.fill('#secret', 'hunter2'); return 1`);
		expect(secret).toContain("page changed");
		expect(secret).not.toContain("hun");
		// The page moves focus on input: the read-back is the field written, not the one focused afterwards.
		expect(await run(`await t.fill('#otp1', '7'); return 1`)).not.toContain("field now shows");
		const long = await run(`await t.fill('#upper', ${JSON.stringify("a".repeat(500))}); return 1`);
		expect(long).toContain(`(field now shows "${"A".repeat(79)}…")`);
	});

	test("select, press and frame actions print their outcome", async () => {
		await load();
		expect(await run(`await t.select('#pick', 'b'); return 1`)).toContain("page changed");
		const handleSelect = await run(
			`await t.run(async ({ tab }) => { await (await tab.waitFor('#pick')).select('a'); return 1; })`,
		);
		expect(handleSelect).toContain("page changed");
		expect(await run(`await t.press('Shift'); return 1`)).toContain("no change yet");
		expect(await run(`await (await t.frame('#child')).click('#inner'); return 1`)).toContain("page changed");
	});

	test("a dialog the action opened is reported, and the page cannot see the probe", async () => {
		await load();
		expect(await run(`await t.click('#change'); return 1`)).toContain("page changed");
		expect(await run(`return await t.evaluate(() => typeof globalThis.__ompActionOutcome)`)).toContain("undefined");
		expect(await run(`await t.click('#confirm'); return 1`)).toContain('dialog pending: confirm "Continue?"');
		await run(`await t.handleDialog({ accept: false });`);
	});
});
