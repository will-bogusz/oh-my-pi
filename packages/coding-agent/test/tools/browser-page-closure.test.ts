import { expect, it } from "bun:test";
import type {
	ReadyInfo,
	Transport,
	WorkerInbound,
	WorkerOutbound,
} from "@oh-my-pi/pi-coding-agent/tools/browser/tab-protocol";
import { WorkerCore } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-worker";
import puppeteer from "puppeteer-core";
import { chromiumAvailable, chromiumExecutable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

it.skipIf(!CHROMIUM_AVAILABLE)(
	"returns a completed managed browser run after its target closes with request interception enabled",
	async () => {
		const browser = await puppeteer.launch({
			executablePath: await chromiumExecutable(),
			headless: true,
			protocolTimeout: 5000,
		});
		const ready = Promise.withResolvers<ReadyInfo>();
		const result = Promise.withResolvers<Extract<WorkerOutbound, { type: "result" }>>();
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
					browserWSEndpoint: `${browser.wsEndpoint()}?lease=closure-fixture`,
					safeDir: process.cwd(),
					timeoutMs: 5000,
				},
			});
			const target = await ready.promise;
			receive({
				type: "run",
				id: "close-page",
				name: "closure fixture",
				code: 'await page.setRequestInterception(true); await page.close(); display("closed target");',
				timeoutMs: 5000,
				session: { cwd: process.cwd() },
			});
			const outcome = await result.promise;
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) throw new Error(outcome.error.message);
			expect(outcome.payload.displays).toContainEqual({ type: "text", text: "closed target" });
			const cdp = await browser.target().createCDPSession();
			const remaining = await cdp.send("Target.getTargets");
			expect(remaining.targetInfos.some(info => info.targetId === target.targetId)).toBe(false);
			await cdp.detach();
		} finally {
			receive({ type: "close" });
			await closed.promise;
			await browser.close();
		}
	},
	15_000,
);
