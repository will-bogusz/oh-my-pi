import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/**
 * One platform's `vendor/cua-driver/<platform>/manifest.json`: the release
 * asset holding the `cua-driver` executable and the bytes it must hash to.
 */
export interface DriverManifest {
	platform: string;
	version: string;
	/** Fork commit the executable was built from. */
	commit: string;
	sha256: string;
	/** Byte count of the executable. */
	size: number;
	/** Release asset the executable downloads from. */
	url: string;
	/** Build and signing provenance, free-form. */
	source?: string;
}

export interface VendoredDriver extends DriverManifest {
	/**
	 * The executable embedded in a compiled binary (a `$bunfs` path). Source
	 * checkouts leave it unset and resolve `url` through the download cache.
	 */
	filePath?: string;
}

const VENDOR_DIR = path.resolve(import.meta.dir, "../../../../../vendor/cua-driver");

/**
 * One platform directory's `manifest.json`, validated. The platform key must
 * match the directory it was read from: a driver built for another host is a
 * mismatch, not a fallback.
 */
export function parseDriverManifest(value: unknown, platform: string): DriverManifest {
	if (!value || typeof value !== "object") throw new ToolError(`Malformed cua-driver manifest for ${platform}`);
	const row = value as Record<string, unknown>;
	if (
		row.platform !== platform ||
		typeof row.version !== "string" ||
		typeof row.commit !== "string" ||
		typeof row.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.sha256) ||
		typeof row.size !== "number" ||
		!Number.isInteger(row.size) ||
		row.size <= 0 ||
		typeof row.url !== "string" ||
		!row.url.startsWith("https://")
	)
		throw new ToolError(`Malformed cua-driver manifest for ${platform}`);
	return {
		platform,
		version: row.version,
		commit: row.commit,
		sha256: row.sha256,
		size: row.size,
		url: row.url,
		source: typeof row.source === "string" ? row.source : undefined,
	};
}

/**
 * The vendored driver for one platform, or undefined when none is vendored.
 * Source checkouts read the manifest from the vendor tree; compiled binaries
 * replace this module with one that also carries the embedded executable
 * (`scripts/cua-driver-plugin.ts`).
 */
export async function vendoredDriver(platform: string): Promise<VendoredDriver | undefined> {
	let manifest: unknown;
	try {
		manifest = await Bun.file(path.join(VENDOR_DIR, platform, "manifest.json")).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	return parseDriverManifest(manifest, platform);
}
