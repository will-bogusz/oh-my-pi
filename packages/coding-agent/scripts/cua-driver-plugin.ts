import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Standalone builds cannot read `vendor/cua-driver` from disk, so this plugin
 * replaces `src/tools/computer/vendored.ts` with a module that embeds the
 * target platform's executable (when one is vendored) as a Bun file asset.
 */
export async function createCuaDriverPlugin(
	repoRoot: string,
	target?: Bun.Build.CompileTarget,
): Promise<Bun.BunPlugin> {
	const platform = (target ?? `bun-${process.platform}-${process.arch}`)
		.replace(/^bun-/, "")
		.replace(/-(baseline|modern)$/, "");
	const sourceModule = await fs.realpath(path.join(repoRoot, "packages/coding-agent/src/tools/computer/vendored.ts"));
	const directory = path.join(repoRoot, "vendor/cua-driver", platform);
	const manifestFile = Bun.file(path.join(directory, "manifest.json"));
	let contents = "export async function vendoredDriver() { return undefined; }";
	if (await manifestFile.exists()) {
		const manifest: unknown = await manifestFile.json();
		if (!manifest || typeof manifest !== "object" || !("sha256" in manifest) || typeof manifest.sha256 !== "string")
			throw new Error(`Invalid cua-driver manifest for ${platform}`);
		const executable = path.join(directory, "cua-driver");
		const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(executable).bytes()).digest("hex");
		if (digest !== manifest.sha256)
			throw new Error(`Vendored cua-driver for ${platform} does not match its manifest`);
		contents = [
			`import filePath from ${JSON.stringify(executable)} with { type: "file" };`,
			`const manifest = ${JSON.stringify(manifest)};`,
			`export async function vendoredDriver(platform) { return platform === manifest.platform ? { ...manifest, filePath } : undefined; }`,
		].join("\n");
	}
	return {
		name: "omp-cua-driver",
		setup(build) {
			build.onLoad({ filter: /[\\/]vendored\.ts$/ }, args => {
				if (args.path !== sourceModule) return undefined;
				return { contents, loader: "js", resolveDir: path.dirname(sourceModule) };
			});
		},
	};
}
