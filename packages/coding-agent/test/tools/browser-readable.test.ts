import { describe, expect, it } from "bun:test";
import { extractReadableFromHtml } from "@oh-my-pi/pi-coding-agent/tools/browser";

describe("browser readable extraction", () => {
	it("extracts markdown content from article-style pages", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Docs</title></head>
				<body>
					<article>
						<h1>Responses API</h1>
						<p>The Responses API stores output only when you opt in.</p>
					</article>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://example.com/docs", "markdown");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Docs");
		expect(result?.markdown).toContain("Responses API");
		expect(result?.markdown).toContain("stores output only when you opt in");
	});

	it("extracts docs-style main content", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Reference</title></head>
				<body>
					<div class="app-shell">
						<nav>Navigation</nav>
						<main data-pagefind-body>
							<section>
								<h1>Apps SDK</h1>
								<p>Build once, run in many places.</p>
							</section>
						</main>
					</div>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://developers.openai.com/apps-sdk/reference", "text");

		expect(result).not.toBeNull();
		expect(result?.title).toBe("Reference");
		expect(result?.text).toContain("Apps SDK");
		expect(result?.text).toContain("Build once, run in many places");
	});

	it("breaks extracted text at block boundaries instead of returning one line", async () => {
		const html = `<!doctype html>
			<html>
				<head><title>Rates</title><style>p { color: red }</style></head>
				<body>
					<main>
						<h1>Fares</h1>
						<p>One <em>way</em> costs $2.40.</p>
						<ul><li>Adult</li><li>Senior</li></ul>
						<table><tr><td>Zone 1</td><td>$2.40</td></tr></table>
						<p>Transfers are free.<br>Passes are not.</p>
					</main>
				</body>
			</html>`;

		const result = await extractReadableFromHtml(html, "https://example.com/fares", "text");
		const lines = result?.text?.split("\n").filter(line => line.length > 0);

		expect(lines).toBeDefined();
		// Every block stands on its own line, inline markup does not break one,
		// and the stylesheet is not content.
		expect(lines).toContain("Fares");
		expect(lines).toContain("One way costs $2.40.");
		expect(lines).toContain("Adult");
		expect(lines).toContain("Senior");
		expect(lines).toContain("Transfers are free.");
		expect(lines).toContain("Passes are not.");
		expect(result?.text).not.toContain("color: red");
		expect(result?.text).toMatch(/Zone 1\s*\$2\.40/);
	});
});
