import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import { readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { ToolError } from "../tool-errors";
import { type EmbeddedCuaArchive, embeddedCuaArchive } from "./cua-embedded";

function digest(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Materialize the binary's qualified native payload without loading native code
 * or downloading dependencies. The runtime loader separately verifies the
 * artifact descriptor and installs Cua's maintained JavaScript graph.
 */
export async function provisionBundledCuaArtifact(
	base: string,
	archive: EmbeddedCuaArchive | null = embeddedCuaArchive,
): Promise<string | undefined> {
	if (!archive) return undefined;
	if (archive.platform !== `${process.platform}-${process.arch}`)
		throw new ToolError("Bundled Cua native artifact does not support this platform");
	if (!/^[0-9a-f]{64}$/.test(archive.sha256) || !archive.files["artifact.json"])
		throw new ToolError("Malformed bundled Cua artifact metadata");
	for (const [name, hash] of Object.entries(archive.files)) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || !/^[0-9a-f]{64}$/.test(hash))
			throw new ToolError("Bundled Cua artifact members require flat paths and SHA256 digests");
	}
	const directory = path.join(path.resolve(base), "bundled", archive.sha256);
	const descriptor = path.join(directory, "artifact.json");
	await fs.mkdir(path.dirname(directory), { recursive: true });
	await withFileLock(`${directory}.prepare`, async () => {
		try {
			const stat = await fs.lstat(directory);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ToolError("Invalid bundled Cua cache directory");
			for (const [name, expected] of Object.entries(archive.files)) {
				const file = path.join(directory, name);
				const fileStat = await fs.lstat(file);
				if (!fileStat.isFile() || fileStat.isSymbolicLink() || digest(await Bun.file(file).bytes()) !== expected)
					throw new ToolError(`Bundled Cua cache SHA256 mismatch: ${name}; remove this bundle and retry`);
			}
			return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			// A complete directory is renamed into place only after all files are
			// verified. A missing file inside an existing directory is corruption.
			try {
				await fs.lstat(directory);
				throw new ToolError("Incomplete bundled Cua cache; remove this bundle and retry");
			} catch (missing) {
				if (!isEnoent(missing)) throw missing;
			}
		}
		const compressed = await Bun.file(archive.filePath).bytes();
		if (digest(compressed) !== archive.sha256) throw new ToolError("Bundled Cua archive SHA256 mismatch");
		const entries = await readArchiveEntries(
			{ bytes: compressed, format: "tar.gz" },
			{ limits: { maxInMemorySize: 64 * 1024 * 1024, maxMemberSize: 64 * 1024 * 1024, maxEntries: 32 } },
		);
		if (entries.size !== Object.keys(archive.files).length)
			throw new ToolError("Bundled Cua archive contains unexpected or missing members");
		for (const [name, expected] of Object.entries(archive.files)) {
			const bytes = entries.get(name);
			if (!bytes || digest(bytes) !== expected) throw new ToolError(`Bundled Cua member SHA256 mismatch: ${name}`);
		}
		const temporary = `${directory}.${crypto.randomUUID()}.tmp`;
		try {
			for (const [name, bytes] of entries) await Bun.write(path.join(temporary, name), bytes);
			await fs.rename(temporary, directory);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});
	return descriptor;
}
