import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EmbeddedCuaArchive } from "../src/tools/computer/cua-embedded";

interface CuaVendorManifest {
	platform: string;
	revision: string;
	archive: { path: string; sha256: string; files: Record<string, string> };
}

/** Bundle the exact maintained native payload in every standalone build path. */
export async function createCuaArtifactPlugin(
	repoRoot: string,
	target?: Bun.Build.CompileTarget,
): Promise<Bun.BunPlugin> {
	const targetId = target ?? `bun-${process.platform}-${process.arch}`;
	const supported = targetId === "bun-darwin-arm64";
	const sourceModule = await fs.realpath(
		path.join(repoRoot, "packages/coding-agent/src/tools/computer/cua-embedded.ts"),
	);
	let contents = "export const embeddedCuaArchive = null;";
	if (supported) {
		const vendor = path.join(repoRoot, "vendor/cua-sdk");
		const manifest = (await Bun.file(path.join(vendor, "manifest.json")).json()) as CuaVendorManifest;
		if (
			manifest.platform !== "darwin-arm64" ||
			!manifest.revision ||
			!/^[-a-zA-Z0-9._]+\.tar\.gz$/.test(manifest.archive.path) ||
			!/^[0-9a-f]{64}$/.test(manifest.archive.sha256)
		)
			throw new Error("Invalid maintained Cua vendor artifact manifest");
		const archivePath = path.join(vendor, manifest.archive.path);
		const bytes = await Bun.file(archivePath).bytes();
		if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== manifest.archive.sha256)
			throw new Error("Maintained Cua archive SHA256 mismatch; do not compile an unqualified payload");
		const metadata: Omit<EmbeddedCuaArchive, "filePath"> = {
			sha256: manifest.archive.sha256,
			platform: manifest.platform,
			revision: manifest.revision,
			files: manifest.archive.files,
		};
		contents = `import filePath from ${JSON.stringify(archivePath)} with { type: "file" };\nexport const embeddedCuaArchive = { ...${JSON.stringify(metadata)}, filePath };`;
	}
	return {
		name: "omp-cua-native-artifact",
		setup(build) {
			build.onLoad({ filter: /[\\/]cua-embedded\.ts$/ }, args => {
				if (args.path !== sourceModule) return undefined;
				return { contents, loader: "ts", resolveDir: path.dirname(sourceModule) };
			});
		},
	};
}
