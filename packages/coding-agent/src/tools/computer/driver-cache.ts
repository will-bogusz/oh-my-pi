import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getCuaDriverCacheDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { DriverManifest } from "./vendored";

export function sha256Hex(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * The manifest's executable in the local download cache
 * (`<cacheDir>/<sha256>/cua-driver`), fetched from the manifest's release
 * asset when absent. Every returned path has been hashed against the
 * manifest: a cached file that no longer matches is replaced, a download that
 * does not match is never written. Both the runtime installer and the
 * standalone build (`scripts/cua-driver-plugin.ts`) resolve through here.
 */
export async function cachedCuaDriver(manifest: DriverManifest, options: { cacheDir?: string } = {}): Promise<string> {
	const directory = path.join(options.cacheDir ?? getCuaDriverCacheDir(), manifest.sha256);
	const executable = path.join(directory, "cua-driver");
	try {
		if (sha256Hex(await Bun.file(executable).bytes()) === manifest.sha256) return executable;
		await fs.rm(executable, { force: true });
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	logger.info("Downloading cua-driver", { version: manifest.version, sha256: manifest.sha256, url: manifest.url });
	let bytes: Uint8Array;
	try {
		const response = await fetch(manifest.url, { headers: { accept: "application/octet-stream" } });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		bytes = await response.bytes();
	} catch (error) {
		throw new ToolError(
			`Downloading cua-driver ${manifest.version} (sha256 ${manifest.sha256}) from ${manifest.url} failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const digest = sha256Hex(bytes);
	if (digest !== manifest.sha256)
		throw new ToolError(
			`cua-driver ${manifest.version} downloaded from ${manifest.url} does not match its manifest: expected sha256 ${manifest.sha256} (${manifest.size} bytes), got ${digest} (${bytes.byteLength} bytes); refusing to install it.`,
		);
	await fs.mkdir(directory, { recursive: true });
	const staging = `${executable}.${process.pid}.${crypto.randomUUID()}`;
	await Bun.write(staging, bytes);
	await fs.chmod(staging, 0o755);
	await fs.rename(staging, executable);
	return executable;
}
