import { expect, it } from "bun:test";
import type {
	ReadyInfo,
	RefStyle,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { pressChord } from "@oh-my-pi/pi-coding-agent/tools/browser/cdp";
import { BrowserEmulationController } from "@oh-my-pi/pi-coding-agent/tools/browser/emulation";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Browser, type CDPSession, type Page } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

interface Harness {
	browser: Browser;
	/** Run one cell of model code and return its value, throwing what the model would see. */
	run: <T>(code: string, refs?: RefStyle) => Promise<T>;
	/** Run one cell and return its error message instead of throwing. */
	runError: (code: string) => Promise<string>;
	goto: (url: string) => Promise<void>;
}

/**
 * A real tab worker over a real headless Chrome, driven the way the tool drives
 * it: one `run` message per cell. The point of these tests is the observe → ref
 * → act loop against a page that keeps moving, so nothing here reaches into the
 * worker's internals.
 */
async function withWorker(args: string[], body: (harness: Harness) => Promise<void>): Promise<void> {
	const browser = await puppeteer.launch({
		executablePath: await chromiumExecutable(),
		headless: true,
		protocolTimeout: 15_000,
		args,
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
	let cell = 0;
	const settle = async (code: string, refs: RefStyle) => {
		result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
		receive({
			type: "run",
			id: `cell-${++cell}`,
			name: "cdp actions fixture",
			code,
			timeoutMs: 15_000,
			session: { cwd: process.cwd(), refs },
		});
		return await result.promise;
	};
	try {
		receive({
			type: "init",
			payload: { mode: "headless", browserWSEndpoint: browser.wsEndpoint(), safeDir: process.cwd(), timeoutMs: 15_000 },
		});
		await ready.promise;
		await body({
			browser,
			run: async <T,>(code: string, refs: RefStyle = "compact") => {
				const settled = await settle(code, refs);
				if (!settled.ok) throw new Error(settled.error.message);
				return settled.payload.returnValue as T;
			},
			runError: async (code: string) => {
				const settled = await settle(code, "compact");
				if (settled.ok) throw new Error("cell unexpectedly succeeded");
				return settled.error.message;
			},
			goto: async (url: string) => {
				const settled = await settle(`await tab.goto(${JSON.stringify(url)});`, "compact");
				if (!settled.ok) throw new Error(settled.error.message);
			},
		});
	} finally {
		receive({ type: "close" });
		await closed.promise;
		await browser.close();
	}
}

const PAGE_A = `<!doctype html><title>A</title><h1>Page A</h1>
<button id="go" onclick="location.href='/b'">Go to B</button>`;

const PAGE_B = `<!doctype html><title>B</title><h1>Page B</h1>
<button id="hit" onclick="document.title='B-CLICKED'">Hit me on B</button>`;

const PAGE_REDIRECT = `<!doctype html><title>Hop</title><h1>Hop</h1><script>location.replace('/c')</script>`;

const PAGE_C = `<!doctype html><title>C</title><h1>Page C</h1>
<button id="cbtn" onclick="document.title='C-CLICKED'">Button on C</button>`;

// Class A: the click starts a navigation that only commits while observe() is
// already collecting. observe() promises the settled tree of the document the
// caller lands on, so it collects again instead of failing the cell.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"observes page B after a click navigates mid-collection",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const { pathname } = new URL(request.url);
				if (pathname === "/b") {
					// Commit well after the DOM-quiet window, so the navigation lands
					// while the first collection is already under way.
					await Bun.sleep(500);
					return new Response(PAGE_B, { headers: { "content-type": "text/html" } });
				}
				return new Response(PAGE_A, { headers: { "content-type": "text/html" } });
			},
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/a`);
				const first = await run<Record<string, string>>(
					`const observation = await tab.observe();
					 return Object.fromEntries(observation.elements.map(e => [e.name, e.ref]));`,
				);
				const tree = await run<string>(
					`await (await tab.ref(${JSON.stringify(first["Go to B"])})).click();
					 return (await tab.observe({ diff: false })).tree;`,
				);
				expect(tree).toContain("Page B");
				expect(tree).toContain("Hit me on B");
				expect(tree).not.toContain("Page A");
				expect(tree).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/b /m);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const PAGE_CHURN = `<!doctype html><title>Churn</title><h1>Churn</h1>
<script>setTimeout(() => location.href = "/churn?" + Date.now(), 150)</script>`;

// The restart is bounded by the one settle budget: a page that never stops
// navigating exhausts it once and is never presented as settled. Whether any
// read outlived one of its 150 ms documents is timing, so either answer is
// right: the last complete tree marked as still navigating, or, with none,
// the observe-again error.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"never presents a page that never stops navigating as settled",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(PAGE_CHURN, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/churn`);
				const started = Date.now();
				const outcome = await run<string>(
					`try { return (await tab.observe({ diff: false })).tree.split("\\n")[0]; } catch (error) { return error.message; }`,
				);
				expect(outcome).toMatch(
					/^(url: http:\/\/127\.0\.0\.1:\d+\/churn\?\d+ \|.*\| still navigating|The page changed while observing it)/,
				);
				// The budget is spent once, not once per navigation.
				expect(Date.now() - started).toBeLessThan(10_000);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const SPA_ROUTER = `<!doctype html><title>Router</title><h1>Router</h1><p id="route">Route 0</p>
<script>let n = 0; setInterval(() => { history.pushState(null, "", "/spa/" + ++n); document.getElementById("route").textContent = "Route " + n; }, 100)</script>`;

// A client-side router moves the URL without replacing the document, so a read
// a pushState lands in is still a read of the page the caller is on. Only a new
// document sends observe() back to collect again.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"observes a page whose client-side router keeps pushing history entries",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(SPA_ROUTER, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/spa`);
				const tree = await run<string>(`return (await tab.observe({ diff: false })).tree;`);
				const [header] = tree.split("\n");
				expect(header).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/spa\/\d+ \| title: Router /);
				expect(header).not.toContain("still navigating");
				expect(tree).toContain("Router");
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const INTERSTITIAL = `<!doctype html><title>Signing in</title><p>Loading your account</p>
<script>setTimeout(() => location.replace("/hop/" + Date.now()), 700)</script>`;

// A chain of loading pages never holds one document for the whole settle
// budget, yet every read of it completes. The last complete tree comes back
// marked as still navigating, instead of an error that observing again repeats.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"returns the last complete tree, marked as still navigating, when the page keeps replacing its document",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(INTERSTITIAL, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/hop/0`);
				const tree = await run<string>(`return (await tab.observe({ diff: false })).tree;`);
				expect(tree).toMatch(/^url: http:\/\/127\.0\.0\.1:\d+\/hop\/\d+ \|.*\| still navigating/m);
				expect(tree).toContain("Loading your account");
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const ARTICLE = `<h1>Quarterly report</h1><p>${"Revenue grew in every region this quarter, led by strong subscription renewals. ".repeat(6)}</p>`;

const LOADER_PAGES: Record<string, string> = {
	// A text loader that is not the first word of a status node, replaced well after the DOM-quiet window.
	"/text": `<!doctype html><title>Report</title><main id="root"><div role="status">Please wait…</div></main>
<script>setTimeout(() => { document.getElementById("root").innerHTML = ${JSON.stringify(ARTICLE)}; }, 1500)</script>`,
	// A skeleton screen: empty shimmering blocks, no text and no busy state, until the content arrives.
	"/skeleton": `<!doctype html><title>Report</title>
<style>.skeleton-line { height: 14px; margin: 8px; background: linear-gradient(90deg, #eee, #ddd, #eee); animation: shimmer 1s infinite; }
@keyframes shimmer { to { background-position: 200px 0; } }</style>
<main id="root"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></main>
<script>setTimeout(() => { document.getElementById("root").innerHTML = ${JSON.stringify(ARTICLE)}; }, 1500)</script>`,
	"/forever": `<!doctype html><title>Report</title><main><p>Loading…</p></main>`,
	// A permanent loader under content that is already there, outside any footer landmark.
	"/footer": `<!doctype html><title>Report</title>${ARTICLE}<div>Loading…</div>`,
};

// A loader or skeleton that the page replaces within the settle budget is
// waited out; one that outlasts it comes back marked instead of as settled;
// and a loader beside content the page already shows never holds the read.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"waits out text loaders and skeletons, and marks a loader that outlasts the settle budget",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request =>
				new Response(LOADER_PAGES[new URL(request.url).pathname], {
					headers: { "content-type": "text/html; charset=utf-8" },
				}),
		});
		const observe = async (run: Harness["run"], goto: Harness["goto"], path: string) => {
			await goto(`http://127.0.0.1:${server.port}${path}`);
			const started = Date.now();
			const tree = await run<string>(`return (await tab.observe({ diff: false })).tree;`);
			return { tree, elapsed: Date.now() - started };
		};
		try {
			await withWorker([], async ({ run, goto }) => {
				for (const path of ["/text", "/skeleton"]) {
					const { tree } = await observe(run, goto, path);
					expect(tree).toContain("Revenue grew in every region");
					expect(tree).not.toContain("Please wait");
					expect(tree).not.toContain("may still be loading");
				}

				const forever = await observe(run, goto, "/forever");
				expect(forever.tree).toMatch(/^url: .*\| may still be loading/m);
				expect(forever.tree).toContain('text "Loading…"');
				expect(forever.elapsed).toBeLessThan(6_000);

				const footer = await observe(run, goto, "/footer");
				expect(footer.tree).toContain("Revenue grew in every region");
				expect(footer.tree).not.toContain("may still be loading");
				expect(footer.elapsed).toBeLessThan(2_000);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const LOST_TAB = `<!doctype html><title>Lost</title><p>Loading forever</p>`;

// A session that closes with nothing taking its place is a lost tab, not a
// navigation: observe() fails with that, instead of spending the settle budget
// and sending the model to observe a tab that is gone.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"fails with the lost tab, not a page change, when the tab closes mid-observation",
	async () => {
		const closing = Promise.withResolvers<void>();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				if (new URL(request.url).pathname === "/close-me") closing.resolve();
				return new Response(LOST_TAB, { headers: { "content-type": "text/html" } });
			},
		});
		try {
			await withWorker([], async ({ browser, runError, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/lost`);
				// The page stays busy, so observe() is still collecting when the tab closes.
				const failed = runError(`await tab.evaluate(() => { fetch("/close-me"); }); await tab.observe();`);
				await closing.promise;
				const page = (await browser.pages()).find(candidate => candidate.url().endsWith("/lost"));
				await page!.close();
				expect(await failed).not.toContain("The page changed while observing it");
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

// Class B shape: two navigations back to back used to leave every later call
// bound to a dead execution context, so even a fresh observe() failed until the
// tab was released and re-claimed. Nothing in the loop holds a context now.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"observes and acts after two back-to-back navigations without reclaiming the tab",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const { pathname } = new URL(request.url);
				const body = pathname === "/c" ? PAGE_C : pathname === "/hop" ? PAGE_REDIRECT : PAGE_A;
				return new Response(body, { headers: { "content-type": "text/html" } });
			},
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/a`);
				// /hop replaces itself with /c: two document swaps, one after the other.
				await run(`await tab.goto("http://127.0.0.1:${server.port}/hop");`);
				const acted = await run<{ tree: string; title: string; url: string }>(
					`const observation = await tab.observe({ diff: false });
					 const button = observation.elements.find(e => e.name === "Button on C");
					 await (await tab.ref(button.ref)).click();
					 return { tree: observation.tree, title: await tab.title(), url: await tab.evaluate(() => location.pathname) };`,
				);
				expect(acted.tree).toContain("Page C");
				expect(acted.url).toBe("/c");
				expect(acted.title).toBe("C-CLICKED");
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const OOPIF_HOST = `<!doctype html><title>Host</title><h1>Host page</h1>
<iframe src="{{url}}" title="Widget" style="width:400px;height:200px;margin-left:40px"></iframe>`;

const OOPIF_WIDGET = `<!doctype html><title>Widget</title>
<button id="w" onclick="document.title='WIDGET-CLICKED'">Widget button</button>
<input id="field" aria-label="Widget field">`;

// A control inside an out-of-process iframe is invisible to the page session:
// its nodes come from the child session and its input has to go back there.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"clicks and types into a control inside an out-of-process iframe",
	async () => {
		const widget = Bun.serve({
			hostname: "localhost",
			port: 0,
			fetch: () => new Response(OOPIF_WIDGET, { headers: { "content-type": "text/html" } }),
		});
		const widgetUrl = `http://localhost:${widget.port}/widget`;
		const host = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(OOPIF_HOST.replace("{{url}}", widgetUrl), { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker(["--site-per-process"], async ({ browser, run, goto }) => {
				await goto(`http://127.0.0.1:${host.port}/`);
				expect(browser.targets().some(candidate => candidate.url() === widgetUrl)).toBe(true);
				const refs = await run<Record<string, string>>(
					`const observation = await tab.observe();
					 return Object.fromEntries(observation.elements.map(e => [e.name, e.ref]));`,
				);
				expect(refs["Widget button"]).toBeDefined();
				await run(
					`await (await tab.ref(${JSON.stringify(refs["Widget button"])})).click();
					 await (await tab.ref(${JSON.stringify(refs["Widget field"])})).fill("in the frame");`,
				);
				const frame = browser
					.targets()
					.map(candidate => candidate.url())
					.filter(url => url === widgetUrl);
				expect(frame.length).toBe(1);
				const page = (await browser.pages()).find(candidate => candidate.url().startsWith("http://127.0.0.1:"));
				const child = page?.frames().find(candidate => candidate.url() === widgetUrl);
				if (!child) throw new Error("Missing widget frame");
				expect(await child.evaluate("document.title")).toBe("WIDGET-CLICKED");
				expect(await child.evaluate("document.getElementById('field').value")).toBe("in the frame");
			});
		} finally {
			host.stop(true);
			widget.stop(true);
		}
	},
	60_000,
);

const KEYS_PAGE = `<!doctype html><title>Keys</title>
<input id="field" aria-label="Field">
<div id="log"></div>
<script>
  const field = document.getElementById("field");
  field.addEventListener("keydown", event => {
    document.getElementById("log").textContent +=
      event.key + ":" + Number(event.shiftKey) + Number(event.ctrlKey) + Number(event.altKey) + Number(event.metaKey) + " ";
  });
</script>`;

// type() must produce real per-character key events, press() must carry the
// modifier bitmask (and a chord must not insert text), fill() must replace.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"types characters, presses chords with modifiers, and replaces the value on fill",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(KEYS_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				const typed = await run<{ value: string; log: string }>(
					`const observation = await tab.observe();
					 const field = await tab.ref(observation.elements.find(e => e.role === "textbox").ref);
					 await field.type("hey");
					 await field.press("Backspace");
					 await field.press("Shift+A");
					 await field.press("Control+a");
					 return {
						 value: await tab.evaluate(() => document.getElementById("field").value),
						 log: await tab.evaluate(() => document.getElementById("log").textContent.trim()),
					 };`,
				);
				expect(typed.value).toBe("heA");
				// Shift reaches the page as a modifier and still produces text; a
				// non-shift modifier makes the stroke a shortcut with no text.
				expect(typed.log).toBe("h:0000 e:0000 y:0000 Backspace:0000 Shift:1000 A:1000 Control:0100 a:0100");
				const filled = await run<string>(
					`const observation = await tab.observe({ diff: false });
					 const field = await tab.ref(observation.elements.find(e => e.role === "textbox").ref);
					 await field.fill("replaced");
					 return await tab.evaluate(() => document.getElementById("field").value);`,
				);
				expect(filled).toBe("replaced");
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const SHORTCUT = process.platform === "darwin" ? "Meta" : "Control";

// On macOS select-all, undo and redo are app-menu commands a CDP key event
// never reaches, so the chord used to report success and leave the text alone.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"selects all, undoes and redoes with the platform's editing chords",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response(`<!doctype html><title>Edit</title><input aria-label="Field">`, {
					headers: { "content-type": "text/html" },
				}),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				const values = await run<string[]>(
					`const { elements } = await tab.observe();
					 const field = await tab.ref(elements.find(e => e.role === "textbox").ref);
					 const value = () => tab.evaluate(() => document.querySelector("input").value);
					 await field.type("abc");
					 await field.press("${SHORTCUT}+a");
					 await field.type("x");
					 const replaced = await value();
					 await field.press("${SHORTCUT}+z");
					 const undone = await value();
					 await field.press("Shift+${SHORTCUT}+z");
					 return [replaced, undone, await value()];`,
				);
				expect(values).toEqual(["x", "abc", "x"]);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

// The clipboard chords cannot be run against the real pasteboard here, so the
// macOS contract is checked where it is made: the key-down names the command.
it("names the editor command on macOS editing chords, including the clipboard helpers", async () => {
	const commands: unknown[] = [];
	const session = {
		send: async (method: string, params: { type: string; commands?: string[] }) => {
			if (method === "Input.dispatchKeyEvent" && params.commands) commands.push(...params.commands);
			return {};
		},
	} as unknown as CDPSession;
	const page = { on() {}, url: () => "about:blank", mainFrame: () => ({ client: session }) } as unknown as Page;
	const emulation = new BrowserEmulationController(page, {}, {}, "");
	await emulation.clipboardCopy();
	await emulation.clipboardPaste();
	for (const chord of ["Meta+x", "Meta+a", "Meta+z", "Shift+Meta+z", "Meta+b", "Control+c", "Alt+Meta+z"]) {
		await pressChord(session, chord);
	}
	expect(commands).toEqual(process.platform === "darwin" ? ["copy", "paste", "cut", "selectAll", "undo", "redo"] : []);
});

const TALL_PAGE = `<!doctype html><title>Tall</title>
<button id="top">Visible button</button>
<div style="height:4000px"></div>
<button id="bottom">Below the fold</button>`;

// `viewportOnly` measures each candidate's box against the viewport, so it must
// keep what is on screen and drop what is only reachable by scrolling.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"gives refs only to controls inside the viewport when asked",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(TALL_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				const names = await run<{ visible: string[]; all: string[] }>(
					`const visible = await tab.observe({ viewportOnly: true, display: false });
					 const all = await tab.observe({ diff: false, display: false });
					 return { visible: visible.elements.map(e => e.name), all: all.elements.map(e => e.name) };`,
				);
				expect(names.visible).toEqual(["Visible button"]);
				expect(names.all).toEqual(["Visible button", "Below the fold"]);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const PARITY_PAGE = `<!doctype html><title>Parity</title>
<button id="target" style="position:absolute;left:60px;top:40px;width:120px;height:30px"
  onclick="window.hits = (window.hits || []).concat(event.clientX + ',' + event.clientY)">Press me</button>`;

// Every selector form and every ref must reach the same element through the
// same geometry: identical click coordinates prove one path, not four.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"clicks the same element at the same point through css, text, xpath, aria and a ref",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(PARITY_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				const hits = await run<string[]>(
					`const observation = await tab.observe();
					 const ref = observation.elements.find(e => e.name === "Press me").ref;
					 await tab.click("#target");
					 await tab.click("text/Press me");
					 await tab.click("xpath//html/body/button");
					 await tab.click("aria/Press me");
					 await (await tab.ref(ref)).click();
					 return await tab.evaluate(() => window.hits);`,
				);
				expect(hits).toHaveLength(5);
				expect(new Set(hits).size).toBe(1);
				expect(hits[0]).toBe("120,55");
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const PRESS_PAGE = `<!doctype html><title>Press</title>
<style>body{margin:20px;font:20px/24px monospace}</style>
<body data-hits="">
<p><a href="#" style="font-size:0;padding:12px;background:red">Settings</a></p>
<p><span style="display:inline-block;transform:rotate(45deg)"><a href="#" style="font-size:0;padding:10px;background:red">Rotated</a></span></p>
<p style="width:12ch">xxxxxxxx <a href="#">ab cd</a> yyyyyyyyy</p>
<button id="gone">Gone</button>
<div id="menu"><button>Inside</button></div>
<button id="invisible">Invisible</button>
<button id="flat">Flat</button>
<script>document.addEventListener("click", event => {
  event.preventDefault();
  document.body.dataset.hits += (event.target.textContent || event.target.tagName) + ",";
})</script>`;

// A press targets the element's first fragment with area. An icon link has
// only padding (its content box is 0x0), a rotated one only a transformed
// quad, and a link wrapped across lines has a bounding-box centre that lands
// on the paragraph. When nothing can be pressed, the refusal says why.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"clicks padded, transformed and wrapped links on the link, and names why a hidden one cannot be clicked",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(PRESS_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, runError, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				const hits = await run<string>(
					`const { elements } = await tab.observe();
					 for (const name of ["Settings", "Rotated", "ab cd"]) await (await tab.ref(elements.find(e => e.name === name).ref)).click();
					 return await tab.evaluate(() => document.body.dataset.hits);`,
				);
				expect(hits).toBe("Settings,Rotated,ab cd,");
				const refs = await run<Record<string, string>>(
					`const { elements } = await tab.observe({ diff: false });
					 await tab.evaluate(() => {
						 document.getElementById("gone").style.display = "none";
						 document.getElementById("menu").style.display = "none";
						 document.getElementById("invisible").style.visibility = "hidden";
						 Object.assign(document.getElementById("flat").style, { width: "0", height: "0", padding: "0", border: "0", overflow: "hidden" });
					 });
					 return Object.fromEntries(elements.map(e => [e.name, e.ref]));`,
				);
				const click = (name: string) => runError(`await (await tab.ref(${JSON.stringify(refs[name])})).click();`);
				expect(await click("Gone")).toContain("has no box to act on: it has display:none");
				expect(await click("Inside")).toContain(
					"has no box to act on: it is inside <div#menu>, which has display:none",
				);
				expect(await click("Invisible")).toContain("blocked: it has visibility:hidden");
				expect(await click("Flat")).toContain("has no box to act on: it is zero-sized");
				expect(await run<string>("return await tab.evaluate(() => document.body.dataset.hits);")).toBe(
					"Settings,Rotated,ab cd,",
				);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const HOP_START = `<!doctype html><title>Start</title><h1>Start</h1>
<button id="go" onclick="location.href='/hop'">Go</button>`;

// A wait started before a navigation must survive it: a page-side wait task
// does not (its world is never re-acquired after the document swaps), so this
// one watches the frame url, which is event-driven.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"resolves waitForUrl for a navigation that starts after the wait",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: request => {
				const { pathname } = new URL(request.url);
				const body = pathname === "/c" ? PAGE_C : pathname === "/hop" ? PAGE_REDIRECT : HOP_START;
				return new Response(body, { headers: { "content-type": "text/html" } });
			},
		});
		try {
			await withWorker([], async ({ run, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/start`);
				const landed = await run<string>(
					`const arrived = tab.waitForUrl("/c", { timeout: 8000 });
					 await tab.click("#go");
					 return await arrived;`,
				);
				expect(landed).toMatch(/\/c$/);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

const FIELDS_PAGE = `<!doctype html><title>Fields</title>
<input id="email" type="email" aria-label="Email" value="old@example.test">
<input id="amount" type="number" aria-label="Amount" value="42">
<input id="colour" type="color" aria-label="Colour" value="#112233">
<select id="fuel" aria-label="Fuel">
  <option value="pet">Petrol</option>
  <option value="ele">Electric</option>
</select>`;

// `email`/`number` are plain text boxes whose selection offsets read null, so a
// read-back of the selection cannot be the proof that fill may replace them.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"fills inputs that report no selection range and refuses the ones with no text to replace",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(FIELDS_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, runError, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				const values = await run<{ email: string; amount: string }>(
					`await tab.fill("#email", "new@example.test");
					 await tab.fill("#amount", "77");
					 return await tab.evaluate(() => ({
						 email: document.getElementById("email").value,
						 amount: document.getElementById("amount").value,
					 }));`,
				);
				expect(values).toEqual({ email: "new@example.test", amount: "77" });
				const cleared = await run<string>(
					`await tab.fill("#email", "");
					 return await tab.evaluate(() => document.getElementById("email").value);`,
				);
				expect(cleared).toBe("");
				// A picker is not a text box: it still has no replaceable text.
				expect(await runError('await tab.fill("#colour", "#445566");')).toContain(
					"does not support text selection",
				);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

// The tree shows option labels; the values are page-internal keys.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"selects an option by its label or its value and reports what an unmatched one could have been",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(FIELDS_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, runError, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				expect(await run<string[]>('return await tab.select("#fuel", "Electric");')).toEqual(["ele"]);
				expect(await run<string[]>('return await tab.select("#fuel", "pet");')).toEqual(["pet"]);
				const refused = await runError('await tab.select("#fuel", "Diesel");');
				expect(refused).toContain('matched no option for "Diesel"');
				expect(refused).toContain('"Petrol"="pet"');
				// The refusal leaves the page alone rather than clearing the field.
				expect(await run<string>('return await tab.evaluate(() => document.getElementById("fuel").value);')).toBe(
					"pet",
				);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);

// Models write Playwright's `selectOption({ label })` from muscle memory; the
// object form used to miss a label printed verbatim in the offered list.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"selects by Playwright's { label } / { value } option form and keeps each key matching only what it names",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(FIELDS_PAGE, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ run, runError, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/`);
				expect(await run<string[]>('return await tab.select("#fuel", { label: "Electric" });')).toEqual(["ele"]);
				expect(await run<string[]>('return await tab.select("#fuel", { value: "pet" });')).toEqual(["pet"]);
				expect(
					await run<string[]>('return await (await tab.waitFor("#fuel")).select({ label: "Electric" });'),
				).toEqual(["ele"]);
				// `value` names the page-internal key only, so the label it shows is not one.
				expect(await runError('await tab.select("#fuel", { value: "Petrol" });')).toContain(
					'matched no option for {"value":"Petrol"}',
				);
				// Both keys given must land on the same option.
				expect(await runError('await tab.select("#fuel", { label: "Electric", value: "pet" });')).toContain(
					'matched no option for {"label":"Electric","value":"pet"}',
				);
				const refused = await runError('await tab.select("#fuel", { label: "Nope" });');
				expect(refused).toContain('matched no option for {"label":"Nope"}');
				expect(refused).toContain('"Petrol"="pet"');
				expect(await runError('await tab.select("#fuel", {});')).toContain(
					'select() cannot match the option {}: pass the option\'s text or value as a string, or one of { label: "…" }, { value: "…" }, { label: "…", value: "…" }.',
				);
			});
		} finally {
			server.stop(true);
		}
	},
	60_000,
);
