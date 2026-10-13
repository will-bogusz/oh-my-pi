import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { navigateMainFrame } from "@oh-my-pi/pi-coding-agent/tools/browser/navigation";
import { PrintHold } from "@oh-my-pi/pi-coding-agent/tools/browser/print-hold";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer, { type Dialog, type Page, type WaitForOptions } from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const server = Bun.serve({
	port: 0,
	// `/never-ends` must outlive the run budget instead of Bun's 10s idle cut.
	idleTimeout: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/never-ends") {
			// A frame document whose body never closes, like an ad or chat widget that keeps streaming.
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("<p>partial</p>"));
					},
				}),
				{ headers: { "content-type": "text/html" } },
			);
		}
		if (pathname === "/stuck-frame") {
			return new Response(`<!doctype html><title>stuck</title><iframe src="/never-ends"></iframe>`, {
				headers: { "content-type": "text/html" },
			});
		}
		if (pathname === "/late-frame") {
			return new Response(
				`<!doctype html><title>late</title><script>addEventListener("load", () => { const frame = document.createElement("iframe"); frame.src = "/never-ends"; document.body.append(frame); });</script>`,
				{ headers: { "content-type": "text/html" } },
			);
		}
		const iframe = `<iframe id="f" name="payment" srcdoc="<!doctype html><input id='in'><div id='out'>ready</div><script>document.querySelector('#in').addEventListener('input',e=>document.querySelector('#out').textContent=e.target.value)</script>"></iframe>`;
		const headers = { "content-type": "text/html" };
		if (pathname === "/card") return new Response(`<input aria-label="Card"><button>Pay</button>`, { headers });
		// Answers its load, then never returns from script again.
		if (pathname === "/stuck") {
			return new Response(
				`<button>Stuck</button><script>onload = () => setTimeout(() => { for (;;) {} })</script>`,
				{
					headers,
				},
			);
		}
		if (pathname === "/observe-frames") {
			// localhost and 127.0.0.1 are different sites, so the frame runs out of process.
			const card = `http://localhost:${new URL(request.url).port}/card`;
			return new Response(
				`<section id="checkout" aria-label="Checkout"><button>Main</button><iframe id="pay" src="${card}"></iframe></section><iframe srcdoc="<button>Outside</button>"></iframe>`,
				{ headers },
			);
		}
		if (pathname === "/observe-shadow-frame") {
			const card = `http://localhost:${new URL(request.url).port}/card`;
			return new Response(
				`<section id="checkout"><button>Main</button><pay-widget></pay-widget></section><script>
					customElements.define("pay-widget", class extends HTMLElement {
						constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<iframe src="${card}"></iframe>'; }
					});
				</script>`,
				{ headers },
			);
		}
		if (pathname === "/observe-stuck-frame") {
			const stuck = `http://localhost:${new URL(request.url).port}/stuck`;
			return new Response(`<button>Main</button><iframe id="stuck" src="${stuck}"></iframe>`, { headers });
		}
		if (pathname === "/ask" || pathname === "/ask-on-load") {
			// `log` records what each dialog returned; a dialog nobody answers leaves the page's script stopped in it.
			const onLoad = pathname === "/ask-on-load" ? "log.push('load:' + confirm('Leave unsaved?'));" : "";
			return new Response(
				`<button id="delete" onclick="log.push('confirm:' + confirm('Delete?'))">Delete</button><button id="save" onclick="alert('Saved'); log.push('alert closed')">Save</button><button id="later" style="display:none" onclick="log.push('later')">Later</button><input id="name" onfocus="confirm('Rename?')"><p id="status">ready</p><script>globalThis.log = [];${onLoad}</script>`,
				{ headers },
			);
		}
		if (pathname === "/ask-frame") {
			return new Response(`<iframe id="inner" src="/ask"></iframe>`, { headers });
		}
		if (pathname === "/print" || pathname === "/print-on-load") {
			// `log` records what the page saw: Chrome fires afterprint only once a print finished, and headless Chrome
			// returns from an unheld print() without printing anything.
			return new Response(
				`<button id="print">Print</button><button id="confirm-print">Print after asking</button><button id="popup-print">Print a receipt</button><button id="popup-url-print">Open a receipt</button><script>
					globalThis.log = [];
					addEventListener("afterprint", () => log.push("afterprint"));
					addEventListener("pageshow", event => { if (event.persisted) log.push("restored"); });
					document.querySelector("#print").addEventListener("click", () => { print(); log.push("print returned"); });
					document.querySelector("#confirm-print").addEventListener("click", () => { if (confirm("Print?")) print(); log.push("asked print returned"); });
					document.querySelector("#popup-print").addEventListener("click", () => {
						const receipt = open("");
						receipt.document.write("<p>receipt</p>");
						receipt.addEventListener("afterprint", () => log.push("receipt afterprint"));
						receipt.print();
						log.push("receipt print returned");
						receipt.close();
					});
					document.querySelector("#popup-url-print").addEventListener("click", () => void open("/receipt"));
					if (location.pathname === "/print-on-load") addEventListener("load", () => { print(); log.push("load print returned"); });
				</script>`,
				{ headers },
			);
		}
		if (pathname === "/receipt") {
			// A receipt window that prints as it loads, reporting to the page that opened it.
			return new Response(
				`<p>receipt</p><script>
					addEventListener("afterprint", () => opener.log.push("receipt afterprint"));
					print();
					opener.log.push("receipt print returned");
				</script>`,
				{ headers },
			);
		}
		return new Response(
			`<!doctype html><title>${pathname}</title><body data-path="${pathname}">${iframe}<script>
				sessionStorage.setItem('loads', String(Number(sessionStorage.getItem('loads') || 0) + 1));
				globalThis.confirmResult = null;
				globalThis.promptResult = null;
			</script></body>`,
			{ headers: { "content-type": "text/html" } },
		);
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
	const prelude = createBrowserPrelude(session);
	return (parameters: unknown, signal?: AbortSignal) =>
		prelude.invoke(parameters, { session, toolCallId: "browser-nav-frames-dialogs-test", signal });
}

function valueOf(result: { details?: unknown }): unknown {
	const { details } = result;
	if (!details || typeof details !== "object" || !("value" in details)) return undefined;
	return details.value;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap(part => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
}

/** Runs `use` against a headless Chromium omp did not launch, standing in for the user's own browser. */
async function withUserBrowser(use: (cdpUrl: string) => Promise<void>): Promise<void> {
	const exe = await ensureChromiumExecutable();
	if (!exe) throw new Error("Expected a Chromium executable");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-print-connected-"));
	const port = await findFreeCdpPort();
	const child = Bun.spawn(
		[
			exe,
			"--headless=new",
			"--no-sandbox",
			"--no-first-run",
			"--use-mock-keychain",
			`--user-data-dir=${root}`,
			`--remote-debugging-port=${port}`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	try {
		const cdpUrl = `http://127.0.0.1:${port}`;
		await waitForCdp(cdpUrl, 15_000);
		await use(cdpUrl);
	} finally {
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	}
}

/**
 * Stands in for the user at the page whose URL ends with `suffix`: a DevTools client of its own, attached before
 * the dialog opens as the browser's own dialog UI is, that can close the dialog the way the user's click would.
 */
async function userAtPage(cdpUrl: string, suffix: string): Promise<{ closeDialog(): Promise<void>; leave(): void }> {
	const targets = (await (await fetch(`${cdpUrl}/json/list`)).json()) as Array<{
		url: string;
		webSocketDebuggerUrl: string;
	}>;
	const target = targets.find(candidate => candidate.url.endsWith(suffix));
	if (!target) throw new Error(`Expected a page ending in ${suffix} in the user's browser`);
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	const replies = new Map<number, (message: { error?: { message: string } }) => void>();
	socket.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as { id?: number; error?: { message: string } };
		if (message.id !== undefined) replies.get(message.id)?.(message);
	});
	const { promise: opened, resolve: open } = Promise.withResolvers<void>();
	socket.addEventListener("open", () => open(), { once: true });
	await opened;
	let id = 0;
	const send = async (method: string, params: object = {}) => {
		const { promise, resolve } = Promise.withResolvers<{ error?: { message: string } }>();
		replies.set(++id, resolve);
		socket.send(JSON.stringify({ id, method, params }));
		const reply = await promise;
		if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
	};
	await send("Page.enable");
	return {
		closeDialog: () => send("Page.handleJavaScriptDialog", { accept: true }),
		leave: () => socket.close(),
	};
}

async function observe(invoke: (parameters: unknown) => Promise<{ details?: unknown }>, name: string, options: object) {
	const { elements } = valueOf(
		await invoke({ action: "call", name, chain: [{ method: "observe", args: [options] }] }),
	) as { elements: Array<{ id: number; role: string; name: string }> };
	return { elements, names: elements.map(entry => `${entry.role}:${entry.name}`) };
}

// Chromium takes about 10 s to shut down while the stuck-frame test's renderer is still spinning.
afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
}, 30_000);

function fakePage(frame: { _lifecycleEvents: Set<string>; detached?: boolean }, closed = () => false): Page {
	return {
		mainFrame: () => frame,
		isClosed: closed,
		browser: () => ({ connected: true }),
	} as unknown as Page;
}

test("fails a navigation whose main document reaches its event only after the timeout", async () => {
	const events = new Set<string>();
	const page = fakePage({ _lifecycleEvents: events });
	// Real time on purpose: the wait polls the frame on a timer and must stop reading at its deadline.
	const late = setTimeout(() => events.add("load"), 90);
	try {
		const error = await navigateMainFrame(page, "load", 60, undefined, async () => null).catch(err => err);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("TimeoutError");
		expect(error.message).toBe("Navigation timeout of 60 ms exceeded");
	} finally {
		clearTimeout(late);
	}
});

// Both detach tests flip state on the wait's second read: one poll still sees a live frame,
// then the frame goes away mid-wait. A wait that ignores it would run out the 10s budget.
test("stops waiting as soon as the navigating main frame detaches", async () => {
	let reads = 0;
	const frame = {
		_lifecycleEvents: new Set<string>(),
		get detached() {
			reads += 1;
			return reads > 1;
		},
	};
	await expect(navigateMainFrame(fakePage(frame), "load", 10_000, undefined, async () => null)).rejects.toThrow(
		"Navigating frame was detached",
	);
	expect(reads).toBe(2);
});

test("stops waiting as soon as the page closes", async () => {
	let checks = 0;
	const closed = () => ++checks > 1;
	await expect(
		navigateMainFrame(
			fakePage({ _lifecycleEvents: new Set() }, closed),
			"domcontentloaded",
			10_000,
			undefined,
			async () => null,
		),
	).rejects.toThrow("Navigating frame was detached");
	expect(checks).toBe(2);
});

test("hands any waitUntil other than load/domcontentloaded to Puppeteer unchanged", async () => {
	const seen: unknown[] = [];
	const page = fakePage({ _lifecycleEvents: new Set() });
	const values: NonNullable<WaitForOptions["waitUntil"]>[] = ["networkidle0", ["load", "networkidle2"]];
	for (const waitUntil of values) {
		await navigateMainFrame(page, waitUntil, 1_000, undefined, async options => seen.push(options.waitUntil));
	}
	expect(seen).toEqual(["networkidle0", ["load", "networkidle2"]]);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser navigation, frames, dialogs, and tab listing", () => {
	test("drives history and SPA navigation without reloading", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "nav", url: `${baseUrl}/one` });
		await invoke({ action: "call", name: "nav", chain: [{ method: "goto", args: [`${baseUrl}/two`] }] });

		await invoke({ action: "call", name: "nav", chain: [{ method: "back", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/one`,
		);
		await invoke({ action: "call", name: "nav", chain: [{ method: "forward", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/two`,
		);

		const beforeReload = valueOf(
			await invoke({
				action: "run",
				name: "nav",
				code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
			}),
		);
		await invoke({ action: "call", name: "nav", chain: [{ method: "reload", args: [] }] });
		expect(valueOf(await invoke({ action: "call", name: "nav", chain: [{ method: "url", args: [] }] }))).toBe(
			`${baseUrl}/two`,
		);
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "nav",
					code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
				}),
			),
		).toBe(Number(beforeReload) + 1);

		const beforePush = valueOf(
			await invoke({
				action: "run",
				name: "nav",
				code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
			}),
		);
		expect(
			valueOf(
				await invoke({ action: "call", name: "nav", chain: [{ method: "pushState", args: [`${baseUrl}/spa`] }] }),
			),
		).toBe(`${baseUrl}/spa`);
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "nav",
					code: "return await tab.evaluate(() => Number(sessionStorage.getItem('loads')));",
				}),
			),
		).toBe(beforePush);
	}, 30_000);

	test("navigates pages whose child frame never finishes loading", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "stuck", url: `${baseUrl}/one` });
		const result = await invoke({
			action: "run",
			name: "stuck",
			timeout: 10,
			code: `
				// The main document's load fires before its never-ending frame is added.
				await tab.goto(${JSON.stringify(`${baseUrl}/late-frame`)});
				// The main document is parsed; its frame never finishes.
				await tab.goto(${JSON.stringify(`${baseUrl}/stuck-frame`)}, { waitUntil: "domcontentloaded" });
				await tab.back();
				await tab.forward({ waitUntil: "domcontentloaded" });
				await tab.reload({ waitUntil: "domcontentloaded" });
				return [tab.url(), await tab.evaluate(() => document.readyState)];
			`,
		});
		expect(valueOf(result)).toEqual([`${baseUrl}/stuck-frame`, "interactive"]);
	}, 60_000);

	test("validates Playwright-style and array waitUntil values through Puppeteer", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "wait-values", url: `${baseUrl}/one` });
		const result = await invoke({
			action: "run",
			name: "wait-values",
			timeout: 20,
			code: `
				const started = Date.now();
				let message = "";
				try {
					await tab.goto(${JSON.stringify(`${baseUrl}/two`)}, { waitUntil: "networkidle" });
				} catch (error) {
					message = String(error?.message ?? error);
				}
				const elapsed = Date.now() - started;
				await tab.goto(${JSON.stringify(`${baseUrl}/three`)}, { waitUntil: ["load", "domcontentloaded"] });
				return [message, elapsed < 5000, tab.url()];
			`,
		});
		const [message, fast, url] = valueOf(result) as [string, boolean, string];
		expect(message).toContain("Unknown value for options.waitUntil: networkidle");
		expect(fast).toBe(true);
		expect(url).toBe(`${baseUrl}/three`);
	}, 60_000);

	test("auto-accepts alerts and explicitly settles confirm and prompt dialogs", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "dialogs", url: `${baseUrl}/dialogs` });
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: 'return await tab.evaluate(() => { alert("notice"); return "continued"; });',
				}),
			),
		).toBe("continued");

		const confirmDialog = valueOf(
			await invoke({
				action: "run",
				name: "dialogs",
				code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.confirmResult = confirm("continue?"); }); }); return await wait(async () => { const state = await tab.dialog(); return state.open ? state : false; }, { timeout: 2000, interval: 10 });',
			}),
		);
		expect(confirmDialog).toEqual({
			open: true,
			type: "confirm",
			message: "continue?",
		});
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "handleDialog", args: [{ accept: true }] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: "return await tab.evaluate(() => globalThis.confirmResult);",
				}),
			),
		).toBe(true);

		const promptDialog = valueOf(
			await invoke({
				action: "run",
				name: "dialogs",
				code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.promptResult = prompt("name?", "initial"); }); }); return await wait(async () => { const state = await tab.dialog(); return state.open ? state : false; }, { timeout: 2000, interval: 10 });',
			}),
		);
		expect(promptDialog).toEqual({
			open: true,
			type: "prompt",
			message: "name?",
			defaultValue: "initial",
		});
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "handleDialog", args: [{ accept: true, text: "Ada" }] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: "return await tab.evaluate(() => globalThis.promptResult);",
				}),
			),
		).toBe("Ada");

		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "setDialogs", args: ["dismiss"] }],
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "dialogs",
					code: 'return await tab.evaluate(() => confirm("auto-dismissed"));',
				}),
			),
		).toBe(false);
		await invoke({
			action: "call",
			name: "dialogs",
			chain: [{ method: "setDialogs", args: [null] }],
		});
	}, 30_000);

	test("reports a confirm the page waits on though the tab's emulation is set", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "emulated-dialog", url: `${baseUrl}/dialogs` });
		await invoke({
			action: "run",
			name: "emulated-dialog",
			code: "await tab.emulate({ viewport: { width: 500, height: 400 } });",
		});
		await invoke({
			action: "run",
			name: "emulated-dialog",
			code: 'await tab.evaluate(() => { requestAnimationFrame(() => { globalThis.confirmResult = confirm("continue?"); }); }); await wait(async () => (await tab.dialog()).open, { timeout: 2000, interval: 10 });',
		});
		// Each run re-applies the emulation first, which a page stopped in a dialog never answers.
		const started = performance.now();
		const dialog = await invoke({
			action: "run",
			name: "emulated-dialog",
			code: "return await tab.dialog();",
			timeout: 5,
		});
		expect(valueOf(dialog)).toEqual({ open: true, type: "confirm", message: "continue?" });
		expect(performance.now() - started).toBeLessThan(3_000);
		await invoke({
			action: "call",
			name: "emulated-dialog",
			chain: [{ method: "handleDialog", args: [{ accept: true }] }],
		});
	}, 30_000);

	test("lets the click that opens a confirm return and fails later page calls at once until it is answered", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask", url: `${baseUrl}/ask` });
		// The click used to wait on the stopped page until the cell timed out, and the tab was then killed.
		const clicked = await invoke({
			action: "run",
			name: "ask",
			timeout: 10,
			code: 'await tab.click("#delete"); return await tab.dialog();',
		});
		expect(valueOf(clicked)).toEqual({ open: true, type: "confirm", message: "Delete?" });
		expect(textOf(clicked)).toContain('The page is waiting on a confirm("Delete?")');
		const started = Date.now();
		const blocked = await invoke({
			action: "run",
			name: "ask",
			timeout: 10,
			code: 'try { await tab.text("#status"); return "ran"; } catch (e) { return e.message; }',
		});
		const message = String(valueOf(blocked));
		expect(message).toStartWith('tab.text("#status") cannot run');
		expect(message).toContain('confirm("Delete?")');
		expect(message).toContain("tab.handleDialog({ accept: true })");
		expect(Date.now() - started).toBeLessThan(5_000);
		// The first result named it; later ones do not repeat it.
		expect(textOf(blocked)).not.toContain("The page is waiting on");
		const answered = await invoke({
			action: "run",
			name: "ask",
			timeout: 10,
			code: "await tab.handleDialog({ accept: true }); return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(answered)).toEqual(["confirm:true"]);

		// A call whose own work the dialog stops ends at once, naming it.
		const evaluated = await invoke({
			action: "run",
			name: "ask",
			timeout: 10,
			code: 'try { await tab.evaluate(() => confirm("Again?")); return "returned"; } catch (e) { return e.message; }',
		});
		expect(valueOf(evaluated)).toContain('tab.evaluate(): the page opened a confirm("Again?")');
		await invoke({ action: "call", name: "ask", chain: [{ method: "handleDialog", args: [{ accept: false }] }] });
		await invoke({ action: "close", name: "ask" });
	}, 60_000);

	test("fails the calls running beside the click that opens a confirm, not just later ones", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-beside", url: `${baseUrl}/ask` });
		// The click's input used to count for every call in flight, so these returned as if they had finished.
		const result = valueOf(
			await invoke({
				action: "run",
				name: "ask-beside",
				timeout: 10,
				code: `const settle = promise => promise.then(value => ({ returned: value ?? null }), e => e.message);
// The page keeps the promise reachable: Chrome fails an evaluation whose promise it collected.
const evaluated = settle(tab.evaluate(() => { const pending = Promise.withResolvers(); window.keepPending = pending.resolve; return pending.promise; }));
const waiting = settle(tab.click("#later"));
await tab.click("#delete");
const result = { evaluated: await evaluated, waiting: await waiting };
await tab.handleDialog({ accept: false });
return result;`,
			}),
		) as { evaluated: unknown; waiting: unknown };
		expect(result.evaluated).toStartWith('tab.evaluate(): the page opened a confirm("Delete?")');
		expect(result.waiting).toStartWith('tab.click("#later"): the page opened a confirm("Delete?")');
		await invoke({ action: "close", name: "ask-beside" });
	}, 60_000);

	test("fails an input a timer's dialog beat to the page, without sending it", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-timer", url: `${baseUrl}/ask` });
		// It used to return as if clicked: the dialog opened while the click still waited for the hidden button.
		const result = valueOf(
			await invoke({
				action: "run",
				name: "ask-timer",
				timeout: 10,
				code: `await tab.evaluate(() => { setTimeout(() => confirm("Timer?"), 100); });
let clicked = "clicked";
try { await tab.click("#later"); } catch (e) { clicked = e.message; }
await tab.handleDialog({ accept: false });
return { clicked, log: await tab.evaluate(() => globalThis.log) };`,
			}),
		) as { clicked: string; log: string[] };
		expect(result.clicked).toContain('tab.click("#later"): the page opened a confirm("Timer?")');
		expect(result.log).toEqual([]);
		await invoke({ action: "close", name: "ask-timer" });
	}, 60_000);

	test("fails id and ref lookups at once while a dialog waits", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-ids", url: `${baseUrl}/ask` });
		const result = valueOf(
			await invoke({
				action: "run",
				name: "ask-ids",
				timeout: 10,
				code: `const { elements } = await tab.observe();
const id = elements.find(element => element.name === "Delete").id;
await tab.click("#delete");
const errors = [];
for (const lookup of [() => tab.id(id), () => tab.ref("e1")]) {
	try { await lookup(); errors.push("resolved"); } catch (e) { errors.push(e.message); }
}
await tab.handleDialog({ accept: true });
return errors;`,
			}),
		) as string[];
		// They used to wait on the stopped page until the cell timed out.
		expect(result[0]).toContain("tab.id(");
		expect(result[1]).toContain("tab.ref(");
		for (const error of result) expect(error).toContain('cannot run: the page is waiting on a confirm("Delete?")');
		await invoke({ action: "close", name: "ask-ids" });
	}, 60_000);

	test("fails a kept handle's reads at once while a dialog waits", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-kept", url: `${baseUrl}/ask` });
		const result = valueOf(
			await invoke({
				action: "run",
				name: "ask-kept",
				timeout: 10,
				code: `const status = await tab.waitFor("#status");
const [child] = await (await tab.waitFor("body")).$$("#status");
await tab.click("#delete");
const errors = [];
for (const read of [() => status.evaluate(el => el.textContent), () => status.boundingBox(), () => status.isVisible(), () => status.isHidden(), () => child.evaluate(el => el.textContent)]) {
	try { await read(); errors.push("returned"); } catch (e) { errors.push(e.message); }
}
await tab.handleDialog({ accept: true });
return { errors, text: await status.evaluate(el => el.textContent) };`,
			}),
		) as { errors: string[]; text: string };
		// They used to wait on the stopped page until the cell timed out; a child the handle returned as well.
		expect(result.errors.map(error => error.slice(0, error.indexOf(" cannot run")))).toEqual([
			"handle.evaluate()",
			"handle.boundingBox()",
			"handle.isVisible()",
			"handle.isHidden()",
			"handle.evaluate()",
		]);
		for (const error of result.errors) expect(error).toContain('the page is waiting on a confirm("Delete?")');
		expect(result.text).toBe("ready");
		await invoke({ action: "close", name: "ask-kept" });
	}, 60_000);

	test("keeps a tab whose page asks for a confirm while it opens, and answers it", async () => {
		const invoke = createHost();
		// The open used to treat the dialog as a failed navigation and close the tab it was waiting in.
		const opened = await invoke({ action: "open", name: "ask-load", url: `${baseUrl}/ask-on-load` });
		expect(textOf(opened)).toContain('The page is waiting on a confirm("Leave unsaved?")');
		const answered = await invoke({
			action: "run",
			name: "ask-load",
			timeout: 10,
			code: "await tab.handleDialog({ accept: true }); return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(answered)).toEqual(["load:true"]);
		await invoke({ action: "close", name: "ask-load" });
	}, 60_000);

	test("answers a reload whose page asks for a confirm with the URL it reached", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-reload", url: `${baseUrl}/ask-on-load` });
		// tab.reload() promises the URL; it used to return undefined once the reloaded page asked.
		const reloaded = await invoke({
			action: "run",
			name: "ask-reload",
			timeout: 10,
			code: "await tab.handleDialog({ accept: true }); const url = await tab.reload(); return { url, dialog: await tab.dialog() };",
		});
		expect(valueOf(reloaded)).toEqual({
			url: `${baseUrl}/ask-on-load`,
			dialog: { open: true, type: "confirm", message: "Leave unsaved?" },
		});
		await invoke({ action: "close", name: "ask-reload" });
	}, 60_000);

	test("lets a frame's click that opens a confirm return like the tab's", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-frame", url: `${baseUrl}/ask-frame` });
		const clicked = await invoke({
			action: "run",
			name: "ask-frame",
			timeout: 10,
			code: 'const frame = await tab.frame("#inner"); await frame.click("#delete"); return await tab.dialog();',
		});
		expect(valueOf(clicked)).toEqual({ open: true, type: "confirm", message: "Delete?" });
		await invoke({
			action: "call",
			name: "ask-frame",
			chain: [{ method: "handleDialog", args: [{ accept: true }] }],
		});
		await invoke({ action: "close", name: "ask-frame" });
	}, 60_000);

	test("names the dialog, not a timeout, when it cut a handle's action short", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-handle", url: `${baseUrl}/ask` });
		const result = valueOf(
			await invoke({
				action: "run",
				name: "ask-handle",
				timeout: 10,
				code: `const { elements } = await tab.observe();
const field = await tab.id(elements.find(element => element.role === "textbox").id);
const errors = [];
try { await field.fill("x"); } catch (e) { errors.push(e.message); }
await tab.handleDialog({ accept: false });
try { await field.fill("x"); } catch (e) { errors.push(e.message); }
return errors;`,
			}),
		) as string[];
		expect(result[0]).toContain('handle.fill(): the page opened a confirm("Rename?")');
		expect(result[1]).toContain("the page's dialog interrupted handle.fill()");
		expect(result[1]).not.toContain("timed out");
		await invoke({ action: "close", name: "ask-handle" });
	}, 60_000);

	test("dismisses a dialog a timed-out call left, so the tab recovers", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "ask-raw", url: `${baseUrl}/ask` });
		// Raw page calls do not check for dialogs; one stuck behind a confirm times the cell out. The tab used to be
		// reset from a fresh session, which cannot see the dialog, and was then killed with the page still stopped.
		const timedOut = await invoke({
			action: "run",
			name: "ask-raw",
			timeout: 2,
			code: 'await page.evaluate(() => confirm("Raw?"));',
		}).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
		expect(String(timedOut)).toContain('confirm("Raw?"), which omp dismissed');
		const after = await invoke({
			action: "run",
			name: "ask-raw",
			timeout: 10,
			code: "return [await tab.dialog(), await tab.text('#status')];",
		});
		expect(valueOf(after)).toEqual([{ open: false }, "ready"]);
		await invoke({ action: "close", name: "ask-raw" });
	}, 60_000);

	test("leaves an alert in the user's own browser for the user, and goes on once they close it", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-alert", url: `${baseUrl}/ask`, app: { cdp_url: cdpUrl } });
				const user = await userAtPage(cdpUrl, "/ask");
				try {
					// It used to be accepted at once, so the user never saw it.
					const clicked = await invoke({
						action: "run",
						name: "user-alert",
						timeout: 10,
						code: 'await tab.click("#save"); return await tab.dialog();',
					});
					expect(valueOf(clicked)).toEqual({ open: true, type: "alert", message: "Saved" });
					expect(textOf(clicked)).toContain('The page is waiting on an alert("Saved")');
					const blocked = await invoke({
						action: "run",
						name: "user-alert",
						timeout: 10,
						code: 'try { await tab.text("#status"); return "ran"; } catch (e) { return e.message; }',
					});
					expect(valueOf(blocked)).toContain('cannot run: the page is waiting on an alert("Saved")');
					await user.closeDialog();
				} finally {
					user.leave();
				}
				const after = await invoke({
					action: "run",
					name: "user-alert",
					timeout: 10,
					code: 'return [await tab.dialog(), await tab.text("#status"), await tab.evaluate(() => globalThis.log)];',
				});
				expect(valueOf(after)).toEqual([{ open: false }, "ready", ["alert closed"]]);
			} finally {
				await invoke({ action: "close", name: "user-alert" }).catch(() => {});
			}
		});
	}, 60_000);

	test("holds print() in a tab omp launched, during its calls and between them, and says so", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "print", url: `${baseUrl}/print` });
		const clicked = await invoke({
			action: "run",
			name: "print",
			code: 'await tab.click("#print"); return await tab.evaluate(() => globalThis.log);',
		});
		expect(valueOf(clicked)).toEqual(["afterprint", "print returned"]);
		expect(textOf(clicked)).toContain("The page called window.print()");
		expect(textOf(clicked)).toContain("tab.pdf()");

		// A page that prints a moment after the call returns: nobody but omp drives this browser, so it stays held.
		// The print has to land between two calls, which only the real clock in the page can arrange.
		await invoke({
			action: "run",
			name: "print",
			code: 'await tab.evaluate(() => { setTimeout(() => document.querySelector("#print").click(), 100); });',
		});
		await Bun.sleep(500);
		const later = await invoke({
			action: "run",
			name: "print",
			code: "return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(later)).toEqual(["afterprint", "print returned", "afterprint", "print returned"]);
		expect(textOf(later)).toContain("The page called window.print()");
	}, 30_000);

	test("reports a print the page makes while the open navigates to it", async () => {
		const invoke = createHost();
		const opened = await invoke({ action: "open", name: "print-open", url: `${baseUrl}/print-on-load` });
		expect(textOf(opened)).toContain("The page called window.print()");
		const log = await invoke({
			action: "run",
			name: "print-open",
			code: "return await tab.evaluate(() => globalThis.log);",
		});
		expect(valueOf(log)).toEqual(["afterprint", "load print returned"]);
	}, 30_000);

	test("holds print() in the user's own browser only around omp's calls", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-print", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
				// A document the call navigates to starts held, so a page printing as it loads is caught too.
				const loaded = await invoke({
					action: "run",
					name: "user-print",
					code: `await tab.goto(${JSON.stringify(`${baseUrl}/print-on-load`)}); return await tab.evaluate(() => globalThis.log);`,
				});
				expect(valueOf(loaded)).toEqual(["afterprint", "load print returned"]);
				expect(textOf(loaded)).toContain("The page called window.print()");

				// The hold ends 1.5 s after the call on the tab worker's real clock; then the user's own click prints.
				await Bun.sleep(2_000);
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print-on-load"));
					if (!page) throw new Error("Expected the print page in the user's browser");
					await page.evaluate('document.querySelector("#print").click()');
				} finally {
					await user.disconnect();
				}
				const after = await invoke({
					action: "run",
					name: "user-print",
					code: "return await tab.evaluate(() => globalThis.log);",
				});
				expect(valueOf(after)).toEqual(["afterprint", "load print returned", "print returned"]);
				expect(textOf(after)).not.toContain("window.print()");
			} finally {
				await invoke({ action: "close", name: "user-print" }).catch(() => {});
			}
		});
	}, 30_000);

	test("holds print() in a page the call brings back from the back/forward cache", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-bfcache", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
				// Past the release on the tab worker's real clock, the user leaves the page; it is cached released.
				await Bun.sleep(2_000);
				const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
				try {
					const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print"));
					if (!page) throw new Error("Expected the print page in the user's browser");
					await page.goto(`${baseUrl}/print-on-load`);
				} finally {
					await user.disconnect();
				}
				const restored = await invoke({
					action: "run",
					name: "user-bfcache",
					code: `await tab.back();
return await tab.evaluate(() => {
	document.querySelector("#print").click();
	return globalThis.log;
});`,
				});
				expect(valueOf(restored)).toEqual(["restored", "afterprint", "print returned"]);
			} finally {
				await invoke({ action: "close", name: "user-bfcache" }).catch(() => {});
			}
		});
	}, 30_000);

	test("lets go of a page cached during a call once it is restored after omp has gone", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			await invoke({ action: "open", name: "user-gone", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
			// The page leaves the cache held for the 30 s call budget; then omp lets go of the tab.
			await invoke({
				action: "run",
				name: "user-gone",
				code: `await tab.goto(${JSON.stringify(`${baseUrl}/print-on-load`)});`,
				timeout: 30,
			});
			await invoke({ action: "close", name: "user-gone" });
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = (await user.pages()).find(candidate => candidate.url().endsWith("/print-on-load"));
				if (!page) throw new Error("Expected the print page in the user's browser");
				await page.goBack();
				// The restored page holds for 1.5 s on its own real clock, which nothing outside the page can advance.
				await Bun.sleep(2_000);
				const clicked = await page
					.mainFrame()
					.mainRealm()
					.evaluate('document.querySelector("#print").click(); globalThis.log');
				expect(clicked).toEqual(["restored", "print returned"]);
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() in the user's browser while the page fakes its clock", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({ action: "open", name: "user-clock", url: `${baseUrl}/print`, app: { cdp_url: cdpUrl } });
				const clicked = await invoke({
					action: "run",
					name: "user-clock",
					code: `return await tab.evaluate(() => {
	Date.now = () => 8.64e15;
	document.querySelector("#print").click();
	return globalThis.log;
});`,
				});
				expect(valueOf(clicked)).toEqual(["afterprint", "print returned"]);
			} finally {
				await invoke({ action: "close", name: "user-clock" }).catch(() => {});
			}
		});
	}, 30_000);

	test("keeps one attachment's print hold when another attaches to the same page", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				const first = await PrintHold.install(page, "calls");
				try {
					await page.goto(`${baseUrl}/print`);
					await first.beginCall(30_000);
					// A second attachment that finishes its setup and lets go must not release the first one's call.
					const second = await PrintHold.install(page, "calls");
					try {
						second.endCall();
						// Real time, past the second one's 1.5 s release on the page's own clock.
						await Bun.sleep(1_700);
						const clicked = await page
							.mainFrame()
							.mainRealm()
							.evaluate('document.querySelector("#print").click(); globalThis.log');
						expect(clicked).toEqual(["afterprint", "print returned"]);
					} finally {
						await second.dispose();
					}
				} finally {
					await first.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("moves and releases the print hold without waiting on a page stopped in a dialog", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				const confirmOpened = async (message: string): Promise<Dialog> => {
					const { promise, resolve } = Promise.withResolvers<Dialog>();
					page.once("dialog", resolve);
					await page.evaluate(text => void setTimeout(() => confirm(text)), message);
					return await promise;
				};
				// A real deadline: what would hang is Chrome's stopped renderer, which fake timers cannot reach.
				const within3s = (work: Promise<void>): Promise<string> =>
					Promise.race([work.then(() => "done"), Bun.sleep(3_000).then(() => "still waiting")]);
				const stay = await confirmOpened("Stay?");
				// A call's start used to wait on the stopped page until someone answered the dialog.
				expect(await within3s(hold.beginCall(30_000))).toBe("done");
				await stay.dismiss();
				// Once the dialog closes, the page gets the call's hold: a Print click comes back held.
				await page
					.mainFrame()
					.mainRealm()
					.waitForFunction(
						'log.length = 0, document.querySelector("#print").click(), log.includes("afterprint")',
						{ timeout: 3_000, polling: 50 },
					);
				const close = await confirmOpened("Close?");
				// Closing the tab used to wait here until the tab worker was killed.
				expect(await within3s(hold.dispose())).toBe("done");
				await close.dismiss();
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds the print a confirm opened during a call leads to, though the hold ran out while it waited", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(0);
					const { promise, resolve } = Promise.withResolvers<Dialog>();
					page.once("dialog", resolve);
					await page
						.mainFrame()
						.mainRealm()
						.evaluate('void setTimeout(() => document.querySelector("#confirm-print").click())');
					const asked = await promise;
					hold.endCall();
					// Real time, past the 1.5 s release on the page's own clock, which fake timers cannot reach.
					await Bun.sleep(1_700);
					// The page went on to print() before omp could hold it again, and the print preview opened.
					await asked.accept();
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
						"afterprint",
						"asked print returned",
					]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() in a window the page opens to print from", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					// The receipt window's own print() was never held, so its preview blocked this page too.
					expect(
						await page
							.mainFrame()
							.mainRealm()
							.evaluate('document.querySelector("#popup-print").click(); globalThis.log'),
					).toEqual(["receipt afterprint", "receipt print returned"]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() in the page a window the page opens to a URL loads", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					await hold.beginCall(30_000);
					// Chrome loads the receipt into the same window object the open() wrapper reached; it prints as it loads.
					await page.mainFrame().mainRealm().evaluate('document.querySelector("#popup-url-print").click()');
					await page
						.mainFrame()
						.mainRealm()
						.waitForFunction('log.includes("receipt print returned")', { timeout: 5_000, polling: 50 });
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
						"receipt afterprint",
						"receipt print returned",
					]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() an init script the tab adds after the hold kept for later", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				const hold = await PrintHold.install(page, "calls");
				try {
					// Added the way the tab worker adds its init scripts, after the hold; each call moves the deadline.
					await page.evaluateOnNewDocument(
						'const keptPrint = print; addEventListener("load", () => { keptPrint(); log.push("load print returned"); });',
					);
					await hold.beginCall(30_000);
					await page.goto(`${baseUrl}/print`);
					expect(await page.mainFrame().mainRealm().evaluate("globalThis.log")).toEqual([
						"afterprint",
						"load print returned",
					]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("holds print() in the user's browser while omp sets up the tab, until setup ends", async () => {
		await withUserBrowser(async cdpUrl => {
			const user = await puppeteer.connect({ browserURL: cdpUrl, defaultViewport: null });
			try {
				const page = await user.newPage();
				await page.goto(`${baseUrl}/print`);
				const hold = await PrintHold.install(page, "calls");
				try {
					const click = 'log.length = 0; document.querySelector("#print").click(); globalThis.log';
					expect(await page.mainFrame().mainRealm().evaluate(click)).toEqual(["afterprint", "print returned"]);
					hold.endCall();
					// Real time, past the 1.5 s release on the page's own clock, which fake timers cannot reach.
					await Bun.sleep(1_700);
					expect(await page.mainFrame().mainRealm().evaluate(click)).toEqual(["print returned"]);
				} finally {
					await hold.dispose();
				}
			} finally {
				await user.disconnect();
			}
		});
	}, 30_000);

	test("re-arms the print hold in the user's browser without waiting on a stuck cross-site frame", async () => {
		await withUserBrowser(async cdpUrl => {
			const invoke = createHost();
			try {
				await invoke({
					action: "open",
					name: "user-stuck",
					url: `${baseUrl}/observe-stuck-frame`,
					app: { cdp_url: cdpUrl },
				});
				const read = 'return await tab.text("button");';
				expect(valueOf(await invoke({ action: "run", name: "user-stuck", code: read, timeout: 5 }))).toBe("Main");
				// Past the 1.5 s release on the tab worker's real clock, the next call arms the hold again.
				await Bun.sleep(2_000);
				expect(valueOf(await invoke({ action: "run", name: "user-stuck", code: read, timeout: 5 }))).toBe("Main");
			} finally {
				await invoke({ action: "close", name: "user-stuck" }).catch(() => {});
			}
		});
	}, 30_000);

	test("scopes helpers to iframe documents in run and direct call paths", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "frames", url: `${baseUrl}/frames` });
		const frameTree = valueOf(
			await invoke({ action: "call", name: "frames", chain: [{ method: "frames", args: [] }] }),
		) as Array<{ id: string; name: string; parentId: string | null; selector?: string }>;
		expect(frameTree.find(frame => frame.name === "payment")).toMatchObject({
			parentId: expect.any(String),
			selector: 'iframe[id="f"]',
		});
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "frames",
					code: 'const f = await tab.frame("#f"); await f.fill("#in", "run"); return await f.text("#out");',
				}),
			),
		).toBe("run");
		expect(
			valueOf(await invoke({ action: "run", name: "frames", code: 'return await (await tab.frame("#f")).text();' })),
		).toContain("run");
		// Only an omitted selector means the body; `null` is still rejected, as on the tab.
		expect(
			valueOf(
				await invoke({
					action: "run",
					name: "frames",
					code: 'const f = await tab.frame("#f"); try { await f.text(null); return "read"; } catch (e) { return String(e.message); }',
				}),
			),
		).toContain("selector must be a string");
		await invoke({
			action: "call",
			name: "frames",
			chain: [
				{ method: "frame", args: ["#f"] },
				{ method: "fill", args: ["#in", "direct"] },
			],
		});
		expect(
			valueOf(
				await invoke({
					action: "call",
					name: "frames",
					chain: [
						{ method: "frame", args: ["#f"] },
						{ method: "text", args: ["#out"] },
					],
				}),
			),
		).toBe("direct");
	}, 30_000);

	test("observes controls inside iframes and acts on them by id", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "observe-frames", url: `${baseUrl}/observe-frames` });
		// A selector reads only the iframes inside it.
		expect((await observe(invoke, "observe-frames", { selector: "#checkout" })).names).toEqual([
			"button:Main",
			"textbox:Card",
			"button:Pay",
		]);
		const observed = await observe(invoke, "observe-frames", {});
		expect(observed.names).toEqual(["button:Main", "textbox:Card", "button:Pay", "button:Outside"]);
		const card = observed.elements.find(entry => entry.name === "Card")!;
		await invoke({
			action: "call",
			name: "observe-frames",
			chain: [
				{ method: "id", args: [card.id] },
				{ method: "fill", args: ["4242"] },
			],
		});
		expect(
			valueOf(
				await invoke({
					action: "call",
					name: "observe-frames",
					chain: [
						{ method: "frame", args: ["#pay"] },
						{ method: "value", args: ["input"] },
					],
				}),
			),
		).toBe("4242");
	}, 30_000);

	test("scoped observe reads an iframe inside a web component's shadow root under the selector", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "observe-shadow-frame", url: `${baseUrl}/observe-shadow-frame` });
		expect((await observe(invoke, "observe-shadow-frame", { selector: "#checkout" })).names).toEqual([
			"button:Main",
			"textbox:Card",
			"button:Pay",
		]);
	}, 30_000);

	test("skips a cross-site frame stuck in script until it navigates", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "observe-stuck-frame", url: `${baseUrl}/observe-stuck-frame` });
		// The first observation waits out the frame, then still lists the page.
		expect((await observe(invoke, "observe-stuck-frame", {})).names).toEqual(["button:Main"]);
		const started = performance.now();
		expect((await observe(invoke, "observe-stuck-frame", {})).names).toEqual(["button:Main"]);
		expect(performance.now() - started).toBeLessThan(2_500);
		// Navigating the frame clears the memo; the evaluation settles once the new document has loaded.
		await invoke({
			action: "call",
			name: "observe-stuck-frame",
			chain: [
				{
					method: "evaluate",
					args: [
						`(async () => { const { promise, resolve } = Promise.withResolvers(); const frame = document.querySelector("#stuck"); frame.onload = () => resolve(true); frame.srcdoc = "<button>Fresh</button>"; await promise; })()`,
					],
				},
			],
		});
		expect((await observe(invoke, "observe-stuck-frame", {})).names).toEqual(["button:Main", "button:Fresh"]);
	}, 60_000);

	test("lists managed tabs with live metadata", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "listed-one", url: `${baseUrl}/one`, persist: true });
		await invoke({ action: "open", name: "listed-two", url: `${baseUrl}/two` });
		const listed = valueOf(await invoke({ action: "tabs" })) as Array<{
			name: string;
			url: string;
			persist: boolean;
		}>;
		expect(listed.find(tab => tab.name === "listed-one")).toMatchObject({
			url: `${baseUrl}/one`,
			title: "/one",
			targetId: expect.any(String),
			kind: "headless",
			persist: true,
		});
		expect(listed.find(tab => tab.name === "listed-two")).toMatchObject({
			url: `${baseUrl}/two`,
			persist: false,
		});
	}, 30_000);

	test("stops the page load when a run is cancelled mid-goto", async () => {
		const requested = Promise.withResolvers<AbortSignal>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				requested.resolve(request.signal);
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled", url: `${baseUrl}/one` });
			const cancel = new AbortController();
			const run = invoke(
				{ action: "run", name: "cancelled", code: `await tab.goto("http://127.0.0.1:${slow.port}/slow");` },
				cancel.signal,
			);
			const request = await requested.promise;
			cancel.abort();
			// The cancel itself, not a cleanup failure from a page still loading.
			expect(await run.catch((error: unknown) => error)).toMatchObject({ message: "Operation aborted" });
			// Chrome drops the request once the load is stopped; a load left running keeps waiting.
			const dropped = new Promise<string>(resolve => {
				if (request.aborted) resolve("stopped");
				request.addEventListener("abort", () => resolve("stopped"));
			});
			expect(await Promise.race([dropped, Bun.sleep(5_000).then(() => "still loading")])).toBe("stopped");
		} finally {
			slow.stop(true);
		}
	}, 30_000);

	test("leaves the page's in-flight fetches alone when a run that is not navigating is cancelled", async () => {
		const pending = Promise.withResolvers<AbortSignal>();
		const waiting = Promise.withResolvers<void>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/pending") pending.resolve(request.signal);
				else waiting.resolve();
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled-wait", url: `${baseUrl}/one` });
			await invoke({
				action: "run",
				name: "cancelled-wait",
				code: `await page.evaluate(url => { fetch(url, { mode: "no-cors" }).catch(() => {}); }, "http://127.0.0.1:${slow.port}/pending");`,
			});
			const request = await pending.promise;
			const cancel = new AbortController();
			const run = invoke(
				{
					action: "run",
					name: "cancelled-wait",
					code: `await page.evaluate(url => { fetch(url, { mode: "no-cors" }).catch(() => {}); }, "http://127.0.0.1:${slow.port}/waiting");
						await wait(60_000);`,
				},
				cancel.signal,
			);
			await waiting.promise;
			cancel.abort();
			expect(await run.catch((error: unknown) => error)).toMatchObject({ message: "Operation aborted" });
			const dropped = new Promise<string>(resolve => {
				if (request.aborted) resolve("dropped");
				request.addEventListener("abort", () => resolve("dropped"));
			});
			// Proving the fetch survives needs real time: nothing signals "Chrome did not cancel it".
			expect(await Promise.race([dropped, Bun.sleep(1_000).then(() => "pending")])).toBe("pending");
		} finally {
			slow.stop(true);
		}
	}, 30_000);

	test("does not call a cancelled run's page listeners for the requests the cancel stops", async () => {
		const requested = Promise.withResolvers<void>();
		const slow = Bun.serve({
			port: 0,
			idleTimeout: 0,
			fetch() {
				requested.resolve();
				return new Promise<Response>(() => {});
			},
		});
		try {
			const invoke = createHost();
			await invoke({ action: "open", name: "cancelled-listener", url: `${baseUrl}/one` });
			const cancel = new AbortController();
			const run = invoke(
				{
					action: "run",
					name: "cancelled-listener",
					code: `page.on("requestfailed", () => {
							globalThis.failedCalls = (globalThis.failedCalls ?? 0) + 1;
							page.url();
						});
						await tab.goto("http://127.0.0.1:${slow.port}/slow");`,
				},
				cancel.signal,
			);
			await requested.promise;
			cancel.abort();
			expect(await run.catch((error: unknown) => error)).toMatchObject({ message: "Operation aborted" });
			const after = await invoke({
				action: "run",
				name: "cancelled-listener",
				code: "return { url: page.url(), failedCalls: globalThis.failedCalls ?? 0 };",
			});
			expect(valueOf(after)).toEqual({ url: `${baseUrl}/one`, failedCalls: 0 });
		} finally {
			slow.stop(true);
		}
	}, 30_000);
});
