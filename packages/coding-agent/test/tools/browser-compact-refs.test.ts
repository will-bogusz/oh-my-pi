import { expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import type {
	ReadyInfo,
	RefStyle,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { matchRefs, type RefRecord } from "@oh-my-pi/pi-coding-agent/tools/browser/observation";
import { parseRefToken, WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// The model acts on refs from the prompt's contract: each style must state its
// own, and neither may leak the other's or the raw template.
it("documents the configured ref style to the model", () => {
	const documentationFor = (refs: RefStyle) => {
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true, "browser.refs": refs }),
		};
		return createBrowserPrelude(session).documentation ?? "";
	};
	const snapshotToken = "`<snapshot>:<n>`";
	const sharedRefs = "carries the same refs";
	expect(documentationFor("compact")).toContain(sharedRefs);
	expect(documentationFor("compact")).not.toContain(snapshotToken);
	expect(documentationFor("uuid")).toContain(snapshotToken);
	expect(documentationFor("uuid")).not.toContain(sharedRefs);
	expect(documentationFor("uuid")).not.toContain("{{");
	expect(documentationFor("compact").split(/\s+/).length).toBeLessThanOrEqual(650);
});

// Ref stability: the same DOM node keeps its number; a re-render that replaced
// the node still matches by role/name/position; only new nodes mint numbers,
// which are never reused.
it("keeps refs across observations and mints fresh numbers only for new nodes", () => {
	let counter = 0;
	const mint = () => ++counter;
	const previous = new Map<number, RefRecord>();
	const first = matchRefs(
		[
			{ role: "button", name: "Save", nodeKey: "L:1" },
			{ role: "button", name: "Delete", nodeKey: "L:2" },
			{ role: "button", name: "Delete", nodeKey: "L:3" },
		],
		previous,
		mint,
	);
	expect(first).toEqual([1, 2, 3]);
	previous.set(1, { role: "button", name: "Save", position: 0, nodeKey: "L:1" });
	previous.set(2, { role: "button", name: "Delete", position: 0, nodeKey: "L:2" });
	previous.set(3, { role: "button", name: "Delete", position: 1, nodeKey: "L:3" });
	// Same node renamed keeps its ref; a replaced node re-matches by
	// role/name/position; a new node mints the next number.
	expect(
		matchRefs(
			[
				{ role: "button", name: "Saving…", nodeKey: "L:1" },
				{ role: "button", name: "Delete", nodeKey: "L:9" },
				{ role: "button", name: "Delete", nodeKey: "L:3" },
				{ role: "link", name: "Home", nodeKey: "L:4" },
			],
			previous,
			mint,
		),
	).toEqual([1, 2, 3, 4]);
	expect(counter).toBe(4);
});

it("reads the element id out of both compact and snapshot-bound ref tokens", () => {
	const observation = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
	expect(parseRefToken("e12", observation)).toBe(12);
	expect(parseRefToken(" e12 ", observation)).toBe(12);
	expect(parseRefToken(`${observation}:12`, observation)).toBe(12);
	// A token from a previous observation must not silently resolve against the
	// current one, and non-refs (ARIA snapshot handles, selectors) are not ours.
	expect(parseRefToken("11111111-2222-3333-4444-555555555555:12", observation)).toBeNull();
	expect(parseRefToken("aria-ref=e12", observation)).toBeNull();
	expect(parseRefToken("e0", observation)).toBeNull();
	expect(parseRefToken("button", observation)).toBeNull();
});

it.skipIf(!CHROMIUM_AVAILABLE)(
	"re-attaches a ref to the equivalent node on the next observation, and fails until then",
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
				payload: {
					mode: "headless",
					browserWSEndpoint: browser.wsEndpoint(),
					safeDir: process.cwd(),
					timeoutMs: 10_000,
				},
			});
			const target = await ready.promise;
			const page = (await browser.pages()).find(candidate => {
				// puppeteer keeps the private target id off the public Target type.
				const raw = candidate.target();
				return "_targetId" in raw && raw._targetId === target.targetId;
			});
			if (!page) throw new Error("Missing worker page");
			const render = () =>
				page.setContent(
					`<button onclick="this.dataset.hit='1'">First</button>
					 <button onclick="this.dataset.hit='1'">Second</button>
					 <button onclick="this.dataset.hit='1'">Third</button>`,
				);
			const run = async (id: string, code: string, refs: RefStyle) => {
				result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
				receive({
					type: "run",
					id,
					name: "refs fixture",
					code,
					timeoutMs: 8_000,
					session: { cwd: process.cwd(), refs },
				});
				const settled = await result.promise;
				if (!settled.ok) throw new Error(settled.error.message);
				return settled.payload.returnValue;
			};

			await render();
			// Compact refs are small integers that stay put across observations of the same nodes.
			expect(
				await run(
					"compact-observe",
					`const first = await tab.observe();
					 const second = await tab.observe();
					 return [first.elements.map(e => e.ref), second.elements.map(e => e.ref)];`,
					"compact",
				),
			).toEqual([
				["e1", "e2", "e3"],
				["e1", "e2", "e3"],
			]);

			// A React-style re-render replaces every node. The ref survives because
			// the next observation re-matches it to the equivalent node by
			// role/name/position — that re-match is the whole healing story now, and
			// the number the model already holds keeps working.
			const healed = await run(
				"compact-heal",
				`await tab.observe();
				 await tab.evaluate(() => {
					 document.body.innerHTML = document.body.innerHTML;
				 });
				 await tab.observe();
				 const element = await tab.ref("e2");
				 await element.click();
				 return await tab.evaluate(() =>
					 [...document.querySelectorAll("button")].map(b => \`\${b.textContent}:\${b.dataset.hit ?? ""}\`),
				 );`,
				"compact",
			);
			expect(healed).toEqual(["First:", "Second:1", "Third:"]);

			// Without that observation the ref names a node the page dropped, and
			// the action says so instead of guessing at a replacement.
			await render();
			result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			receive({
				type: "run",
				id: "compact-unobserved",
				name: "refs fixture",
				code: `await tab.observe();
					 await tab.evaluate(() => {
						 document.body.innerHTML = document.body.innerHTML;
					 });
					 await (await tab.ref("e2")).click();`,
				timeoutMs: 8_000,
				session: { cwd: process.cwd(), refs: "compact" },
			});
			const unobserved = await result.promise;
			expect(unobserved.ok).toBe(false);
			if (unobserved.ok) throw new Error("a replaced node was clicked without a fresh observation");
			expect(unobserved.error.message).toContain("stale");

			// The uuid style keeps its snapshot-bound contract: same sequence, hard stale.
			await render();
			const uuidRefs = (await run("uuid-observe", `return (await tab.observe()).elements[1].ref;`, "uuid")) as string;
			expect(uuidRefs).toMatch(/^[0-9a-f-]{36}:\d+$/);
			result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			receive({
				type: "run",
				id: "uuid-heal",
				name: "refs fixture",
				code: `const observation = await tab.observe();
					 await tab.evaluate(() => {
						 document.body.innerHTML = document.body.innerHTML;
					 });
					 await (await tab.ref(observation.elements[1].ref)).click();`,
				timeoutMs: 8_000,
				session: { cwd: process.cwd(), refs: "uuid" },
			});
			const stale = await result.promise;
			expect(stale.ok).toBe(false);
			if (stale.ok) throw new Error("uuid ref unexpectedly survived the re-render");
			expect(stale.error.message).toContain("stale");

			// A compact ref for an element that is really gone still fails.
			await render();
			result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
			receive({
				type: "run",
				id: "compact-gone",
				name: "refs fixture",
				code: `await tab.observe();
					 await tab.evaluate(() => {
						 document.querySelectorAll("button")[1].remove();
					 });
					 await (await tab.ref("e2")).click();`,
				timeoutMs: 8_000,
				session: { cwd: process.cwd(), refs: "compact" },
			});
			const gone = await result.promise;
			expect(gone.ok).toBe(false);
			if (gone.ok) throw new Error("compact ref unexpectedly resolved a removed element");
			expect(gone.error.message).toContain("stale");
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
		}
	},
	60_000,
);
