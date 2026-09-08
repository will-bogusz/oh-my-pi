import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { provisionBundledCuaArtifact } from "../../src/tools/computer/cua-bundle";
import type { EmbeddedCuaArchive } from "../../src/tools/computer/cua-embedded";

function hash(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function fixture(extra = false) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-bundle-"));
	const bytes: Record<string, Uint8Array> = {
		"artifact.json": new TextEncoder().encode('{"revision":"fixture"}'),
		"library.dylib": new TextEncoder().encode("qualified native fixture"),
		"NOTICE.md": new TextEncoder().encode("preserved contributor notice"),
	};
	const compressed = await new Bun.Archive(
		extra ? { ...bytes, "unexpected-file": "must not escape the manifest" } : bytes,
		{ compress: "gzip" },
	).bytes();
	const filePath = path.join(directory, "source.tar.gz");
	await Bun.write(filePath, compressed);
	const archive: EmbeddedCuaArchive = {
		filePath,
		platform: `${process.platform}-${process.arch}`,
		revision: "fixture",
		sha256: hash(compressed),
		files: Object.fromEntries(Object.entries(bytes).map(([name, value]) => [name, hash(value)])),
	};
	return { directory, base: path.join(directory, "cache"), archive, bytes };
}

it("provisions a complete verified bundle once under concurrent first use, without its source archive afterward", async () => {
	const f = await fixture();
	try {
		const descriptors = await Promise.all([
			provisionBundledCuaArtifact(f.base, f.archive),
			provisionBundledCuaArtifact(f.base, f.archive),
		]);
		expect(descriptors[0]).toBe(descriptors[1]);
		const destination = path.dirname(descriptors[0]!);
		for (const [name, expected] of Object.entries(f.bytes))
			expect([...(await Bun.file(path.join(destination, name)).bytes())]).toEqual([...expected]);
		await fs.rm(f.archive.filePath);
		expect(await provisionBundledCuaArtifact(f.base, f.archive)).toBe(descriptors[0]);
		await Bun.write(path.join(destination, "library.dylib"), "replaced native code");
		await expect(provisionBundledCuaArtifact(f.base, f.archive)).rejects.toThrow("cache SHA256 mismatch");
	} finally {
		await fs.rm(f.directory, { recursive: true, force: true });
	}
});

it("rejects a corrupted archive, incorrect member hash and extra archive member before publishing a descriptor", async () => {
	const f = await fixture();
	const extra = await fixture(true);
	try {
		await expect(provisionBundledCuaArtifact(f.base, { ...f.archive, sha256: "0".repeat(64) })).rejects.toThrow(
			"archive SHA256 mismatch",
		);
		await expect(
			provisionBundledCuaArtifact(f.base, {
				...f.archive,
				files: { ...f.archive.files, "library.dylib": "0".repeat(64) },
			}),
		).rejects.toThrow("member SHA256 mismatch");
		await expect(provisionBundledCuaArtifact(extra.base, extra.archive)).rejects.toThrow(
			"unexpected or missing members",
		);
		for (const item of [f, extra]) {
			expect(await Bun.file(path.join(item.base, "bundled", item.archive.sha256, "artifact.json")).exists()).toBe(
				false,
			);
		}
	} finally {
		await Promise.all([f, extra].map(item => fs.rm(item.directory, { recursive: true, force: true })));
	}
});

it("does not use another platform's binary and refuses an incomplete or symlinked cache", async () => {
	const f = await fixture();
	try {
		await expect(provisionBundledCuaArtifact(f.base, { ...f.archive, platform: "unsupported" })).rejects.toThrow(
			"does not support this platform",
		);
		expect(await provisionBundledCuaArtifact(f.base, null)).toBeUndefined();
		const destination = path.join(f.base, "bundled", f.archive.sha256);
		await fs.mkdir(destination, { recursive: true });
		await expect(provisionBundledCuaArtifact(f.base, f.archive)).rejects.toThrow("Incomplete bundled Cua cache");
		await fs.rm(destination, { recursive: true });
		await fs.symlink(f.directory, destination);
		await expect(provisionBundledCuaArtifact(f.base, f.archive)).rejects.toThrow(
			"Invalid bundled Cua cache directory",
		);
	} finally {
		await fs.rm(f.directory, { recursive: true, force: true });
	}
});
