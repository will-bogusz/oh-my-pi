/**
 * Manual end-to-end smoke for the relay: replicates the omp browser tool's
 * connection pattern against a live relay + extension.
 *
 * The tool opens TWO puppeteer connections per driven tab — the supervisor
 * (`puppeteer.connect({browserURL})`, picks a target from the relay's `/json`
 * listing without attaching to it) and a tab worker
 * (`puppeteer.connect({browserWSEndpoint})`, claims that target with the
 * relay-private `OMP.claimTarget`, which attaches it) — so this script does
 * exactly that, then exercises evaluate/navigate/screenshot, an extra CDP
 * session, and the createTarget/closeTarget path.
 *
 * Usage: bun scripts/smoke.ts [relay-url] [target-substring]
 */
import type { Target } from "puppeteer-core";
import puppeteer from "puppeteer-core";

const relayUrl = Bun.argv[2] ?? "http://127.0.0.1:9224";
const matcher = Bun.argv[3] ?? "Relay Smoke Page";

/** Puppeteer keeps the CDP target id on an internal field; same access the omp tab supervisor uses (`targetIdForPage`). */
function targetIdOf(target: Target): string {
	// Internal puppeteer field, not on the public type.
	const raw = target as unknown as { _targetId: string };
	return raw._targetId;
}

function step(name: string): void {
	console.log(`\n== ${name}`);
}

step("supervisor: connect via browserURL");
const supervisor = await puppeteer.connect({ browserURL: relayUrl, defaultViewport: null, protocolTimeout: 20_000 });
console.log("version:", await supervisor.version());

step("supervisor: list pages from /json");
const listed = (await (await fetch(`${relayUrl}/json`)).json()) as Array<{ id: string; title: string; url: string }>;
console.log(
	"pages:",
	listed.map(entry => entry.url),
);
const picked = listed.find(entry => entry.url.includes(matcher) || entry.title.includes(matcher));
if (!picked) throw new Error(`no page matching ${JSON.stringify(matcher)}`);
const targetId = picked.id;
const wsEndpoint = supervisor.wsEndpoint();
console.log("picked target:", targetId, "ws:", wsEndpoint);

step("worker: second connection via browserWSEndpoint");
const worker = await puppeteer.connect({
	browserWSEndpoint: wsEndpoint,
	defaultViewport: null,
	protocolTimeout: 20_000,
});
// The relay attaches only tabs a connection owns: claim the picked tab on the worker's connection.
if (!("_connection" in worker)) throw new Error("puppeteer browser exposes no CDP connection");
// Puppeteer's CDP browser keeps its connection on an internal field, and its protocol map lacks the relay method.
const workerConnection = worker._connection as { send(method: string, params: object): Promise<unknown> };
await workerConnection.send("OMP.claimTarget", { targetId });
const workerTarget = await worker.waitForTarget(target => targetIdOf(target) === targetId, { timeout: 10_000 });
const page = await workerTarget.page();
if (!page) throw new Error("worker could not adopt page");

step("worker: evaluate on existing tab");
console.log("title:", await page.title());
// String form: the callback body runs in the page; a function literal would need the DOM lib.
console.log("hero:", await page.evaluate(`document.querySelector("#hero")?.textContent ?? "(no hero)"`));

step("worker: extra CDP session (screenshot path)");
const session = await page.createCDPSession();
const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { url: string } } };
console.log("frame url:", frameTree.frameTree.frame.url);
await session.detach();

step("worker: navigate existing tab");
await page.goto("https://example.com/?relay-smoke", { waitUntil: "load", timeout: 20_000 });
console.log("navigated:", page.url(), "/", await page.title());

step("worker: screenshot");
const shot = await page.screenshot({ type: "png" });
console.log("screenshot bytes:", shot.byteLength);

step("supervisor: newPage (Target.createTarget) + close (Target.closeTarget)");
const fresh = await supervisor.newPage();
await fresh.goto("about:blank");
console.log("new page url:", fresh.url());
await fresh.close();
console.log("closed");

step("disconnect both");
await worker.disconnect();
await supervisor.disconnect();

console.log("\nSMOKE OK");
process.exit(0);
