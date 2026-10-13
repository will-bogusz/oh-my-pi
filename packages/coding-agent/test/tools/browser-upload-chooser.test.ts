import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { findFreeCdpPort, waitForCdp } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import puppeteer from "puppeteer-core";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
// Windows ignores POSIX read bits and root reads a mode-000 file, so neither can make delivery fail through one.
const MODE_BITS_ENFORCED = process.platform !== "win32" && process.getuid?.() !== 0;

// `#log` records what each control received; headless Chrome cancels a chooser nobody intercepts, so a `cancel`
// entry proves a click reached a real, uninterrupted chooser, while a chooser omp holds logs nothing until answered.
const html = `<!doctype html>
<style>button, label, div { display: block; margin: 8px; padding: 8px; }</style>
<input id="direct" type="file" multiple>
<button id="trigger" type="button">Upload</button><input id="trigger-input" type="file" hidden>
<button id="other" type="button">Upload another</button><input id="other-input" type="file" hidden>
<label id="images" for="images-input">Add images</label><input id="images-input" type="file" accept="image/*" multiple style="display:none">
<label id="nag" for="nag-input">Attach</label><input id="nag-input" type="file" style="display:none">
<button id="picker" type="button">Open</button>
<button id="ask-upload" type="button">Upload after asking</button>
<div id="drop">Drop files here</div>
<script>
window.log = [];
const record = (id, event, files) => log.push({ id, event, names: [...(files || [])].map(file => file.name) });
for (const id of ["direct", "trigger-input", "other-input", "images-input", "nag-input"]) {
  const input = document.getElementById(id);
  input.addEventListener("change", () => record(id, "change", input.files));
  input.addEventListener("cancel", () => record(id, "cancel"));
}
document.getElementById("nag-input").addEventListener("cancel", () => record("nag-input", "confirm:" + confirm("Attach nothing?")));
for (const id of ["trigger", "other"])
  document.getElementById(id).addEventListener("click", () => document.getElementById(id + "-input").click());
document.getElementById("picker").addEventListener("click", () =>
  showOpenFilePicker().then(() => record("picker", "picked"), error => record("picker", error.name)));
document.getElementById("ask-upload").addEventListener("click", () => {
  if (confirm("Upload?")) document.getElementById("trigger-input").click();
});
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => { event.preventDefault(); record("drop", "drop", event.dataTransfer.files); });
</script>`;

let tempDir = "";
let site: Bun.Server<undefined> | undefined;
let url = "";

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
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
}

interface LogEntry {
	id: string;
	event: string;
	names: string[];
}

/**
 * Open a tab on the fixture. `attempt` reloads it, runs `code`, and returns the thrown message and the page log;
 * `step` runs `code` on the page as it is and returns the call's printed notes and the page log.
 */
async function openFixture(app?: { cdp_url: string }) {
	const session = makeSession();
	const prelude = createBrowserPrelude(session);
	const context = { session, toolCallId: "browser-upload" };
	const name = `upload-${crypto.randomUUID()}`;
	await prelude.invoke({ action: "open", name, url, ...(app ? { app } : {}) }, context);
	const attempt = async (code: string): Promise<{ error?: string; log: LogEntry[] }> => {
		// Cells share top-level bindings, so `error` is reset explicitly. The 300 ms pause is real time: the
		// browser fires change/cancel after the CDP call returns and signals no end.
		const result = await prelude.invoke(
			{
				action: "run",
				name,
				timeout: 15,
				code: `await tab.goto(${JSON.stringify(url)});
let error = undefined;
try { ${code} } catch (e) { error = e instanceof Error ? e.message : String(e); }
await Bun.sleep(300);
return { error, log: await tab.evaluate(() => window.log) };`,
			},
			context,
		);
		const details = result.details;
		if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
		// `run` details carry the cell's return value untyped.
		return details.value as { error?: string; log: LogEntry[] };
	};
	const step = async (code: string): Promise<{ notes: string; value: unknown }> => {
		const result = await prelude.invoke({ action: "run", name, timeout: 15, code }, context);
		const notes = result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		const details = result.details;
		return { notes, value: details && typeof details === "object" && "value" in details ? details.value : undefined };
	};
	// The page log once the browser has fired the events a CDP call leaves behind.
	const log = async () =>
		(await step("await Bun.sleep(300); return await tab.evaluate(() => window.log);")).value as LogEntry[];
	const close = () => prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
	return { attempt, step, log, close };
}

/** A headless Chromium omp did not launch, standing in for the user's own browser. */
async function launchUserBrowser(): Promise<{ cdpUrl: string; stop: () => Promise<void> }> {
	const exe = await ensureChromiumExecutable();
	if (!exe) throw new Error("Expected a Chromium executable");
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-upload-connected-"));
	const port = await findFreeCdpPort();
	const child = Bun.spawn(
		[
			exe,
			"--headless=new",
			"--no-first-run",
			"--use-mock-keychain",
			`--user-data-dir=${root}`,
			`--remote-debugging-port=${port}`,
		],
		{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
	);
	const stop = async () => {
		child.kill();
		await child.exited;
		await fs.rm(root, { recursive: true, force: true });
	};
	try {
		await waitForCdp(`http://127.0.0.1:${port}`, 15_000);
	} catch (error) {
		await stop();
		throw error;
	}
	return { cdpUrl: `http://127.0.0.1:${port}`, stop };
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
	await Bun.write(path.join(tempDir, "beta.txt"), "beta");
	// Readable enough to open for an upload (a stat), not to copy or read: delivery fails after the chooser is caught.
	await Bun.write(path.join(tempDir, "locked.txt"), "locked");
	await fs.chmod(path.join(tempDir, "locked.txt"), 0o000);
	site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
	});
	url = `http://127.0.0.1:${site.port}/`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	site?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile", () => {
	test("fills the chooser a trigger opens", async () => {
		const { attempt, close } = await openFixture();
		try {
			expect(await attempt(`await tab.uploadFile("#trigger", "alpha.txt");`)).toEqual({
				log: [{ id: "trigger-input", event: "change", names: ["alpha.txt"] }],
			});

		} finally {
			await close();
		}
	}, 60_000);

	test.skipIf(!MODE_BITS_ENFORCED)(
		"cancels the chooser when delivering the files fails",
		async () => {
			const { attempt, close } = await openFixture();
			try {
				const failed = await attempt(`await tab.uploadFile("#trigger", "locked.txt");`);
				expect(failed.error).toBeDefined();
				expect(failed.log).toEqual([{ id: "trigger-input", event: "cancel", names: [] }]);
			} finally {
				await close();
			}
		},
		60_000,
	);

	test("rejects a File System Access picker without killing the tab", async () => {
		const { attempt, close } = await openFixture();
		try {
			// Puppeteer's chooser listener threw on the picker's node-less event, killing the tab worker;
			// the cell then hung until the supervisor killed the tab.
			const picker = await attempt(`await tab.uploadFile("#picker", "alpha.txt");`);
			expect(picker.error).toContain("File System Access picker");
			expect(picker.log).toEqual([{ id: "picker", event: "AbortError", names: [] }]);
			expect(await attempt(`await tab.uploadFile("#trigger", "alpha.txt");`)).toEqual({
				log: [{ id: "trigger-input", event: "change", names: ["alpha.txt"] }],
			});
		} finally {
			await close();
		}
	}, 60_000);

	test("holds a chooser a click opens, fails other page calls until it is answered, and answers it through handleDialog", async () => {
		const { attempt, step, log, close } = await openFixture();
		try {
			await attempt("");
			// It used to open the OS file dialog in a visible browser (headless: cancel), and the call said nothing.
			const clicked = await step(`await tab.click("#images");`);
			expect(clicked.notes).toContain(
				'The page opened a file chooser (one or more files, accepting "image/*") during this call',
			);
			expect(clicked.notes).toContain("tab.handleDialog({ accept: true, files: [path, ...] })");
			expect((await step("return await tab.dialog();")).value).toEqual({
				open: true,
				type: "file-chooser",
				multiple: true,
				accept: "image/*",
			});
			const blocked = await step(`try { await tab.text("#drop"); return "ran"; } catch (e) { return e.message; }`);
			expect(blocked.value).toContain(
				'tab.text("#drop") cannot run: the page is waiting on a file chooser (one or more files, accepting "image/*")',
			);
			await step(`await tab.handleDialog({ accept: true, files: ["alpha.txt", "beta.txt"] });`);
			expect(await log()).toEqual([{ id: "images-input", event: "change", names: ["alpha.txt", "beta.txt"] }]);
			expect((await step("return await tab.dialog();")).value).toEqual({ open: false });

			await step(`await tab.click("#trigger");`);
			await step(`await tab.handleDialog({ accept: false });`);
			expect((await log()).at(-1)).toEqual({ id: "trigger-input", event: "cancel", names: [] });
			const none = await attempt(`await tab.handleDialog({ accept: true, files: ["alpha.txt"] });`);
			expect(none.error).toContain("No file chooser is waiting");
		} finally {
			await close();
		}
	}, 60_000);

	test("names a File System Access picker a click opened and Chrome cancelled", async () => {
		const { attempt, step, log, close } = await openFixture();
		try {
			await attempt("");
			const clicked = await step(`await tab.click("#picker");`);
			expect(clicked.notes).toContain("The page opened a File System Access file picker during this call");
			expect(await log()).toEqual([{ id: "picker", event: "AbortError", names: [] }]);
			expect((await step("return await tab.dialog();")).value).toEqual({ open: false });
		} finally {
			await close();
		}
	}, 60_000);

	test("has the chooser a click opens waiting before the same cell's next call", async () => {
		const { attempt, close } = await openFixture();
		try {
			// The chooser reached omp a moment after the click returned, so the next call ran and handleDialog found
			// nothing to answer.
			const result = await attempt(`await tab.click("#trigger");
let read;
try { read = await tab.text("#drop"); } catch (e) { read = e.message; }
const state = await tab.dialog();
await tab.handleDialog({ accept: false });
error = JSON.stringify({ read, type: state.type });`);
			const { read, type } = JSON.parse(result.error ?? "{}") as { read: string; type: string };
			expect(read).toContain('tab.text("#drop") cannot run');
			expect(read).toContain("file chooser");
			expect(type).toBe("file-chooser");
			expect(result.log).toEqual([{ id: "trigger-input", event: "cancel", names: [] }]);
		} finally {
			await close();
		}
	}, 60_000);

	test("leaves the chooser a raw page.waitForFileChooser() waits for to it", async () => {
		const { attempt, close } = await openFixture();
		try {
			// The chooser was held as well, so after Puppeteer filled it the tab still reported it as waiting.
			const alpha = JSON.stringify(path.join(tempDir, "alpha.txt"));
			const result =
				await attempt(`const [chooser] = await Promise.all([page.waitForFileChooser(), tab.click("#trigger")]);
await chooser.accept([${alpha}]);
error = JSON.stringify(await tab.dialog());`);
			expect(JSON.parse(result.error ?? "{}")).toEqual({ open: false });
			expect(result.log).toEqual([{ id: "trigger-input", event: "change", names: ["alpha.txt"] }]);
		} finally {
			await close();
		}
	}, 60_000);

	test("lets go of a held chooser once something else fills its input", async () => {
		const { attempt, step, close } = await openFixture();
		try {
			await attempt("");
			await step(`await tab.click("#trigger");`);
			// Another attachment's catcher, or raw Puppeteer, fills it; this tab used to keep reporting it as waiting.
			const alpha = JSON.stringify(path.join(tempDir, "alpha.txt"));
			await step(`const input = await page.$("#trigger-input"); await input.uploadFile(${alpha});`);
			expect((await step("return await tab.dialog();")).value).toEqual({ open: false });
			expect((await step(`return await tab.text("#drop");`)).value).toBe("Drop files here");
		} finally {
			await close();
		}
	}, 60_000);

	test("ends a wait when the page opens a chooser during it", async () => {
		const { attempt, close } = await openFixture();
		try {
			const result =
				await attempt(`await tab.evaluate(() => { setTimeout(() => document.getElementById("trigger-input").click(), 100); });
const started = Date.now();
try { await tab.waitForText("never shown", { timeout: 5000 }); } catch (e) { error = e.message; }
error = JSON.stringify({ error, ms: Date.now() - started });
await tab.handleDialog({ accept: false });`);
			const { error, ms } = JSON.parse(result.error ?? "{}") as { error: string; ms: number };
			expect(error).toContain("the page opened a file chooser");
			expect(ms).toBeLessThan(3_000);
		} finally {
			await close();
		}
	}, 60_000);

	test("keeps the chooser waiting when the upload that opened it fails", async () => {
		const { attempt, step, log, close } = await openFixture();
		try {
			await attempt("");
			// The failed upload dropped its chooser: dialog() said nothing waited while the page still did.
			const failed = await step(`try { await tab.uploadFile("#trigger", "alpha.txt", "beta.txt"); } catch (e) {
	return { error: e.message, state: await tab.dialog() };
}`);
			const { error, state } = failed.value as { error: string; state: unknown };
			expect(error).toContain("Multiple file uploads only work with <input type=file multiple>");
			expect(error).toContain("still waiting");
			expect(state).toEqual({ open: true, type: "file-chooser", multiple: false });
			await step(`await tab.handleDialog({ accept: true, files: ["alpha.txt"] });`);
			expect(await log()).toEqual([{ id: "trigger-input", event: "change", names: ["alpha.txt"] }]);
		} finally {
			await close();
		}
	}, 60_000);

	test("returns from an answer that makes the page open a dialog", async () => {
		const { attempt, step, log, close } = await openFixture();
		try {
			await attempt("");
			await step(`await tab.click("#nag");`);
			// The cancel's own handler stops the page in a confirm, so the answer used to wait out its deadline.
			const started = Date.now();
			const answered = await step(`await tab.handleDialog({ accept: false }); return await tab.dialog();`);
			expect(Date.now() - started).toBeLessThan(1_500);
			expect(answered.value).toEqual({ open: true, type: "confirm", message: "Attach nothing?" });
			await step(`await tab.handleDialog({ accept: true });`);
			expect(await log()).toEqual([
				{ id: "nag-input", event: "cancel", names: [] },
				{ id: "nag-input", event: "confirm:true", names: [] },
			]);
		} finally {
			await close();
		}
	}, 60_000);

	test("in the user's own browser, holds choosers only around omp's calls", async () => {
		const user = await launchUserBrowser();
		try {
			const { attempt, step, log, close } = await openFixture({ cdp_url: user.cdpUrl });
			try {
				await attempt("");
				expect((await step(`await tab.click("#trigger");`)).notes).toContain(
					"The page opened a file chooser (one file) during this call",
				);
				// The hold ends 1.5 s after omp's call on the real clock; the chooser it already holds still waits.
				await Bun.sleep(2_000);
				await step(`await tab.handleDialog({ accept: true, files: ["alpha.txt"] });`);
				expect(await log()).toEqual([{ id: "trigger-input", event: "change", names: ["alpha.txt"] }]);

				// Past the tail, the user's own click reaches Chrome's chooser (headless: cancel), unreported.
				await Bun.sleep(2_000);
				const browser = await puppeteer.connect({ browserURL: user.cdpUrl, defaultViewport: null });
				try {
					const page = (await browser.pages()).find(candidate => candidate.url() === url);
					if (!page) throw new Error("Expected the fixture page in the user's browser");
					await page.click("#trigger");
				} finally {
					await browser.disconnect();
				}
				const after = await step("await Bun.sleep(300); return await tab.evaluate(() => window.log);");
				expect(after.value).toEqual([
					{ id: "trigger-input", event: "change", names: ["alpha.txt"] },
					{ id: "trigger-input", event: "cancel", names: [] },
				]);
				expect(after.notes).not.toContain("file chooser");
			} finally {
				await close();
			}
		} finally {
			await user.stop();
		}
	}, 60_000);

	test("in the user's own browser, lets the user's later click reach Chrome's chooser after a raw page.waitForFileChooser()", async () => {
		const user = await launchUserBrowser();
		try {
			const { attempt, step, close } = await openFixture({ cdp_url: user.cdpUrl });
			try {
				const alpha = JSON.stringify(path.join(tempDir, "alpha.txt"));
				await attempt(`const [chooser] = await Promise.all([page.waitForFileChooser(), tab.click("#trigger")]);
await chooser.accept([${alpha}]);`);
				// Real time past the 1.5 s release tail, which runs in the tab's worker where fake timers cannot reach.
				// Puppeteer left interception on for the page's session, which swallowed this click: the chooser was
				// intercepted with no one waiting, so the page saw neither a file nor a cancel.
				await Bun.sleep(2_000);
				const browser = await puppeteer.connect({ browserURL: user.cdpUrl, defaultViewport: null });
				try {
					const page = (await browser.pages()).find(candidate => candidate.url() === url);
					if (!page) throw new Error("Expected the fixture page in the user's browser");
					await page.click("#other");
				} finally {
					await browser.disconnect();
				}
				const after = await step("await Bun.sleep(300); return await tab.evaluate(() => window.log);");
				expect(after.value).toEqual([
					{ id: "trigger-input", event: "change", names: ["alpha.txt"] },
					{ id: "other-input", event: "cancel", names: [] },
				]);
			} finally {
				await close();
			}
		} finally {
			await user.stop();
		}
	}, 60_000);

	test("in the user's own browser, goes on while a confirm waits past the hold, and holds the chooser it leads to", async () => {
		const user = await launchUserBrowser();
		try {
			const { attempt, step, log, close } = await openFixture({ cdp_url: user.cdpUrl });
			try {
				await attempt("");
				await step(`await tab.click("#ask-upload");`);
				// Real time past the 1.5 s release tail, on the browser's clock, which fake timers cannot reach.
				await Bun.sleep(2_000);
				// The next call used to re-arm the chooser hold on a page the confirm stopped, and wait out its timeout.
				const started = Date.now();
				expect((await step("return await tab.dialog();")).value).toMatchObject({ open: true, type: "confirm" });
				expect(Date.now() - started).toBeLessThan(5_000);
				// The hold that was on when the confirm opened is still on when the page goes on to open its chooser.
				const answered = await step(`await tab.handleDialog({ accept: true });`);
				expect(answered.notes).toContain("file chooser");
				expect((await step("return await tab.dialog();")).value).toMatchObject({
					open: true,
					type: "file-chooser",
				});
				await step(`await tab.handleDialog({ accept: true, files: ["alpha.txt"] });`);
				expect(await log()).toEqual([{ id: "trigger-input", event: "change", names: ["alpha.txt"] }]);
			} finally {
				await close();
			}
		} finally {
			await user.stop();
		}
	}, 60_000);
});
