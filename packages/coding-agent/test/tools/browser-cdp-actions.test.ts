import { expect, it } from "bun:test";
import type {
	ReadyInfo,
	RefStyle,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Browser } from "puppeteer-core";
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
// navigating exhausts it and observe() says exactly that, instead of looping.
it.skipIf(!CHROMIUM_AVAILABLE)(
	"gives up with the observe-again error when the page never stops navigating",
	async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(PAGE_CHURN, { headers: { "content-type": "text/html" } }),
		});
		try {
			await withWorker([], async ({ runError, goto }) => {
				await goto(`http://127.0.0.1:${server.port}/churn`);
				const started = Date.now();
				const message = await runError(`await tab.observe();`);
				expect(message).toContain("The page changed while observing it. Observe again.");
				// The budget is spent once, not once per navigation.
				expect(Date.now() - started).toBeLessThan(10_000);
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
