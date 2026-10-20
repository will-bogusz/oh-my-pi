import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { mockFetch } from "../helpers/fetch-mock";

const PROSE = "This guide explains how the renderer handles every input it receives in one pass. ".repeat(3);

const DOCS_PAGE = `<!doctype html><html><head>
<title>Renderer guide</title>
<meta charset="utf-8">
<meta name="description" content="How the renderer works">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Renderer guide > Example Docs">
<meta property="og:image" content="https://example.com/images/social-card-renderer-guide.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="google-site-verification" content="abcdefghijklmnopqrstuvwxyz0123456789">
</head><body><main>
<h1>Renderer guide<a class="headerlink" href="#renderer-guide" title="Link to this heading">¶</a></h1>
<p>---
warning: BODY_FRONT_MATTER_LOOKALIKE
---</p>
<p>Contents: <a href="#setup">Setup</a>, <a href=#method(int)>method</a>, <a href="https://example.com/other#part">other page</a>.</p>
<p>${PROSE}</p>
<h2 id="setup">Setup<a class="headerlink" href="#setup" title="Link to this heading">¶</a></h2>
<p>Install it, then see <a href="#options">the options</a> below. <a href="#figure"><img src="figure.png" alt="Diagram"></a> <a href="#print" title="Print article"><span>Print</span></a> ${PROSE}</p>
<pre><code>[keep this](#literal-anchor)</code></pre>
<blockquote><pre><code>[quoted code](#quoted-anchor)</code></pre></blockquote>
<p>Inline <code>before \` [also kept](#inline-anchor)</code> stays as written.</p>
<h2 id="options">Options</h2><p>LAST_NEEDLE ${PROSE}</p>
</main></body></html>`;

const HEAD_ONLY_PAGE = `<!doctype html><html><head><title>Account</title>
<meta property="og:title" content="Account settings for your workspace">
<meta property="og:description" content="Manage members, billing and security for the workspace">
</head><body><div id="root"></div></body></html>`;

describe("read URL: native rendering without markup the reader cannot use", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	async function readPage(html: string): Promise<string> {
		const server = Bun.serve({
			port: 0,
			fetch: request =>
				new URL(request.url).pathname === "/page"
					? new Response(html, { headers: { "content-type": "text/html" } })
					: new Response("not found", { status: 404 }),
		});
		servers.push(server);
		const cwd = process.cwd();
		const artifactsDir = path.join(cwd, ".fetch-markup-tokens-artifacts");
		const session: ToolSession = {
			cwd,
			hasUI: false,
			getSessionFile: () => path.join(cwd, "session.jsonl"),
			getArtifactsDir: () => artifactsDir,
			getSessionSpawns: () => null,
			allocateOutputArtifact: async toolType => ({
				id: "test",
				path: path.join(artifactsDir, `test.${toolType}.log`),
			}),
			settings: Settings.isolated({ "fetch.enabled": true }),
		};
		const result = await new ReadTool(session).execute("call", { path: `http://127.0.0.1:${server.port}/page` });
		expect(result.details?.method).toBe("native");
		return result.content.find(block => block.type === "text")?.text ?? "";
	}

	it("keeps the title and description of the page's head and drops social-card and viewport tags", async () => {
		const text = await readPage(DOCS_PAGE);

		expect(text).toContain("title: Renderer guide");
		expect(text).toContain("meta-description: How the renderer works");
		expect(text).not.toContain("meta-og");
		expect(text).not.toContain("meta-twitter");
		expect(text).not.toContain("meta-viewport");
		expect(text).not.toContain("google-site-verification");
		expect(text).toContain("BODY_FRONT_MATTER_LOOKALIKE");
		expect(text).toContain("LAST_NEEDLE");
	});

	it("drops the targets of same-page anchor links and leaves code and other links alone", async () => {
		const text = await readPage(DOCS_PAGE);

		expect(text).not.toContain("](#setup");
		expect(text).not.toContain("](#options");
		expect(text).toContain('[Print](# "Print article")');
		expect(text).toContain("Contents: [Setup](#), [method](#), [other page](https://example.com/other#part)");
		expect(text).toContain("see [the options](#) below");
		expect(text).toContain("![Diagram](figure.png)");
		expect(text).toContain("[keep this](#literal-anchor)");
		expect(text).toContain("[quoted code](#quoted-anchor)");
		expect(text).toContain("[also kept](#inline-anchor)");
	});

	it("still reads a page whose only content is its head", async () => {
		const text = await readPage(HEAD_ONLY_PAGE);

		expect(text).toContain("Manage members, billing and security");
	});

	it("leaves another reader's output as it came", async () => {
		const markdown = `---\nlicense: Do not redistribute\nog:title: Example\n---\n\n# Example\n\nSee [the setup](#setup). ${PROSE}`;
		const result = await renderHtmlToText(
			"https://example.com/article",
			"<html><body><p>shell</p></body></html>",
			5,
			Settings.isolated({ "providers.fetch": "jina" }),
			undefined,
			null,
			mockFetch(() => new Response(`Markdown Content:\n${markdown}`)),
		);

		expect(result.method).toBe("jina");
		expect(result.content).toContain("license: Do not redistribute");
		expect(result.content).toContain("[the setup](#setup)");
	});
});
