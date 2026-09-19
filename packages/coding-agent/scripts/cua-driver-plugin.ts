import * as fs from "node:fs/promises";
import * as path from "node:path";
import { cachedCuaDriver } from "../src/tools/computer/driver-cache";
import { vendoredDriver } from "../src/tools/computer/vendored";

/**
 * Standalone builds cannot download at run time from inside `$bunfs`, so this
 * plugin replaces `src/tools/computer/vendored.ts` with a module that embeds
 * the target platform's executable (when one is vendored) as a Bun file asset.
 * The executable comes from the same download cache the runtime installer
 * uses, fetched and sha256-verified against the manifest when absent.
 */
export async function createCuaDriverPlugin(
	repoRoot: string,
	target?: Bun.Build.CompileTarget,
): Promise<Bun.BunPlugin> {
	const platform = (target ?? `bun-${process.platform}-${process.arch}`)
		.replace(/^bun-/, "")
		.replace(/-(baseline|modern)$/, "");
	const sourceModule = await fs.realpath(path.join(repoRoot, "packages/coding-agent/src/tools/computer/vendored.ts"));
	const manifest = await vendoredDriver(platform);
	let contents = "export async function vendoredDriver() { return undefined; }";
	if (manifest) {
		const executable = await cachedCuaDriver(manifest);
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
