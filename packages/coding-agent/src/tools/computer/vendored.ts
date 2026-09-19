import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** One platform's vendored `cua-driver` executable, as recorded in `vendor/cua-driver/<platform>/manifest.json`. */
export interface VendoredDriver {
	platform: string;
	version: string;
	sha256: string;
	/** Fork commit the executable was built from, when known. */
	source?: string;
	/** Absolute executable path; a `$bunfs` path inside compiled binaries. */
	filePath: string;
}

const VENDOR_DIR = path.resolve(import.meta.dir, "../../../../../vendor/cua-driver");

/**
 * One platform directory's `manifest.json`, validated. The platform key must
 * match the directory it was read from: a driver built for another host is a
 * mismatch, not a fallback.
 */
export function parseDriverManifest(value: unknown, platform: string): Omit<VendoredDriver, "filePath"> {
	if (!value || typeof value !== "object") throw new ToolError(`Malformed cua-driver manifest for ${platform}`);
	const row = value as Record<string, unknown>;
	if (
		row.platform !== platform ||
		typeof row.version !== "string" ||
		typeof row.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(row.sha256)
	)
		throw new ToolError(`Malformed cua-driver manifest for ${platform}`);
	return {
		platform,
		version: row.version,
		sha256: row.sha256,
		source: typeof row.source === "string" ? row.source : undefined,
	};
}

/**
 * The vendored driver for one platform, or undefined when none is vendored.
 * Source checkouts read the vendor tree; compiled binaries replace this module
 * with the embedded executable (`scripts/cua-driver-plugin.ts`).
 */
export async function vendoredDriver(platform: string): Promise<VendoredDriver | undefined> {
	const directory = path.join(VENDOR_DIR, platform);
	let manifest: unknown;
	try {
		manifest = await Bun.file(path.join(directory, "manifest.json")).json();
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
	return { ...parseDriverManifest(manifest, platform), filePath: path.join(directory, "cua-driver") };
}
