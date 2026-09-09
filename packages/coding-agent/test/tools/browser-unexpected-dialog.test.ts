import { expect, it } from "bun:test";
import type {
	ReadyInfo,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer, { type Dialog } from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it.skipIf(!CHROMIUM_AVAILABLE)(
	"preserves post-dialog saves after an observed-element click yields for a delayed decision",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		const saves: string[] = [];
		const fixture = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				if (new URL(request.url).pathname === "/save") {
					const value = await request.text();
					saves.push(value);
					// A stopLoading queued behind the modal must not abort this response.
					await Bun.sleep(100);
					return new Response(value);
				}
				return new Response(
					`<button>Rename</button><p>Original</p><script>document.querySelector('button').onclick=async()=>{try {const value=prompt('Name');const response=await fetch('/save',{method:'POST',body:value});document.querySelector('p').textContent=await response.text()}catch(error){document.querySelector('p').textContent=String(error)}}</script>`,
					{ headers: { "content-type": "text/html" } },
				);
			},
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
					// Enable the managed page policy against our disposable Chromium.
					// No popup is created, so no broker HTTP operation is needed.
					browserWSEndpoint: `${browser.wsEndpoint()}?lease=preparation-fixture`,
					safeDir: process.cwd(),
					timeoutMs: 5000,
				},
			});
			const target = await ready.promise;
			const pages = await browser.pages();
			const page = pages.find(
				candidate => (candidate.target() as { _targetId?: string })._targetId === target.targetId,
			);
			if (!page) throw new Error("Missing prepared page");
			await page.goto(fixture.url.toString());
			const run = async (id: string, code: string) => {
				result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
				receive({ type: "run", id, name: "dialog page", code, timeoutMs: 3000, session: { cwd: process.cwd() } });
				const response = await result.promise;
				return response;
			};
			let current: Dialog | undefined;
			page.on("dialog", dialog => {
				current = dialog;
			});
			const start = performance.now();
			const blocked = await run(
				"unexpected",
				'const snapshot = await tab.observe(); const button = snapshot.elements.find(element => element.role === "button"); await (await tab.ref(button.ref)).click(); await tab.fill("p", "Must not execute");',
			);
			expect(performance.now() - start).toBeLessThan(2000);
			expect(blocked.ok).toBe(false);
			if (blocked.ok) throw new Error("Unresolved modal unexpectedly completed");
			expect(blocked.error.message).toContain("tab.dialog()");
			expect(current?.type()).toBe("prompt");
			// A human/model decision can take longer than the input restore ceiling.
			await Bun.sleep(5500);
			const stillBlocked = await run("still-blocked", "await tab.observe();");
			expect(stillBlocked.ok).toBe(false);
			if (stillBlocked.ok) throw new Error("Page was inspected through an unresolved modal");
			expect(stillBlocked.error.message).toContain("tab.dialog()");
			await current!.accept("Resolved café Ω");
			await page.waitForFunction('document.querySelector("p").textContent === "Resolved café Ω"', {
				timeout: 2000,
			});
			const resumed = await run("resumed", "return await tab.ariaSnapshot();");
			if (!resumed.ok) throw new Error(resumed.error.message);
			expect(String(resumed.payload.returnValue)).toContain("Resolved café Ω");
			expect(await page.$eval("p", element => element.textContent)).toBe("Resolved café Ω");
			expect(saves).toEqual(["Resolved café Ω"]);
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
			fixture.stop(true);
		}
	},
	15_000,
);
