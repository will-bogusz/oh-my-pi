/** Install the repository's qualified Cua payload, or an explicit development build. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getNativesDir, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";
import { provisionBundledCuaArtifact } from "../src/tools/computer/cua-bundle";
import type { EmbeddedCuaArchive } from "../src/tools/computer/cua-embedded";
import { CUA_DRIVER_VERSION, type CuaArtifactFile, type CuaRuntimeArtifact } from "../src/tools/computer/cua-runtime";

const nativeNames = {
	library: "libcua_driver_sdk.dylib",
	nodeRuntime: "cua_driver_node_runtime.node",
	licenseNotice: "node-runtime-NOTICE.md",
} as const;
const nativeKeys = ["library", "nodeRuntime", "licenseNotice"] as const;
const flatName = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const sha256 = /^[0-9a-f]{64}$/;

export interface InstallCuaRuntimeOptions {
	/** Omit to install the verified repository vendor archive. */
	sourceDirectory?: string;
	/** Required only for an explicit development package. */
	revision?: string;
	cacheDirectory?: string;
	/** Alternate source package for installation qualification. */
	vendorDirectory?: string;
}

function digest(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Cua vendor metadata");
	return value as Record<string, unknown>;
}

function file(value: unknown): CuaArtifactFile {
	const row = object(value);
	if (
		typeof row.path !== "string" ||
		!flatName.test(row.path) ||
		typeof row.sha256 !== "string" ||
		!sha256.test(row.sha256)
	)
		throw new Error("Cua vendor files require flat paths and lowercase SHA256 digests");
	return { path: row.path, sha256: row.sha256 };
}

async function vendorArtifact(destination: string, vendorDirectory?: string): Promise<CuaRuntimeArtifact> {
	const vendor = path.resolve(vendorDirectory ?? path.join(import.meta.dir, "../../../vendor/cua-sdk"));
	const manifest = object(await Bun.file(path.join(vendor, "manifest.json")).json());
	if (
		manifest.schemaVersion !== 1 ||
		manifest.platform !== "darwin-arm64" ||
		manifest.sdkVersion !== CUA_DRIVER_VERSION ||
		typeof manifest.revision !== "string" ||
		!flatName.test(manifest.revision)
	)
		throw new Error(`Cua vendor manifest requires schema 1, SDK ${CUA_DRIVER_VERSION}, darwin-arm64 and a revision`);
	const source = object(manifest.source);
	const patch = file({ path: source.patch, sha256: source.patchSha256 });
	if (digest(await Bun.file(path.join(vendor, patch.path)).bytes()) !== patch.sha256)
		throw new Error("Cua vendor source patch SHA256 mismatch");
	const archiveRow = object(manifest.archive);
	const archiveFile = file(archiveRow);
	const members = object(archiveRow.files);
	const files: Record<string, string> = {};
	for (const [name, hash] of Object.entries(members)) files[name] = file({ path: name, sha256: hash }).sha256;
	const nativeFiles = object(manifest.nativeFiles);
	const library = file(nativeFiles.library);
	const nodeRuntime = file(nativeFiles.nodeRuntime);
	const licenseNotice = file(nativeFiles.licenseNotice);
	for (const entry of [library, nodeRuntime, licenseNotice]) {
		if (files[entry.path] !== entry.sha256)
			throw new Error(`Cua vendor native and archive pins disagree: ${entry.path}`);
	}
	const archive: EmbeddedCuaArchive = {
		filePath: path.join(vendor, archiveFile.path),
		sha256: archiveFile.sha256,
		platform: manifest.platform,
		revision: manifest.revision,
		files,
	};
	const descriptorPath = await provisionBundledCuaArtifact(destination, archive);
	if (!descriptorPath) throw new Error("Cua vendor archive was not provisioned");
	const portable = object(await Bun.file(descriptorPath).json());
	if (
		portable.schemaVersion !== 1 ||
		portable.revision !== manifest.revision ||
		portable.sdkVersion !== CUA_DRIVER_VERSION ||
		portable.platform !== manifest.platform
	)
		throw new Error("Cua vendor archive descriptor disagrees with the manifest");
	const native = { library, nodeRuntime, licenseNotice };
	for (const key of nativeKeys) {
		const entry = file(portable[key]);
		if (entry.path !== native[key].path || entry.sha256 !== native[key].sha256)
			throw new Error(`Cua vendor archive descriptor disagrees with native pins: ${key}`);
		native[key] = { ...entry, path: path.relative(destination, path.join(path.dirname(descriptorPath), entry.path)) };
	}
	return {
		schemaVersion: 1,
		revision: manifest.revision,
		sdkVersion: CUA_DRIVER_VERSION,
		platform: manifest.platform,
		...native,
	};
}

async function developmentArtifact(
	destination: string,
	sourceDirectory: string,
	revision: string,
): Promise<CuaRuntimeArtifact> {
	const source = path.resolve(sourceDirectory);
	const manifest = object(await Bun.file(path.join(source, "package.json")).json());
	if (manifest.version !== CUA_DRIVER_VERSION)
		throw new Error(`The source native package must declare Cua SDK ${CUA_DRIVER_VERSION}`);
	const entries = await Promise.all(
		nativeKeys.map(async key => {
			const name = nativeNames[key];
			const bytes = await Bun.file(path.join(source, name)).bytes();
			if (bytes.byteLength === 0) throw new Error(`Empty native artifact: ${name}`);
			return { key, name, bytes, sha256: digest(bytes) };
		}),
	);
	const native = {} as Record<(typeof nativeKeys)[number], CuaArtifactFile>;
	for (const entry of entries) {
		const relativePath = path.join("artifacts", revision, entry.name);
		const finalPath = path.join(destination, relativePath);
		try {
			if (digest(await Bun.file(finalPath).bytes()) !== entry.sha256)
				throw new Error(`Artifact revision ${revision} already contains different bytes; choose a new revision`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
			const temporary = `${finalPath}.${crypto.randomUUID()}.tmp`;
			try {
				await Bun.write(temporary, entry.bytes);
				await fs.rename(temporary, finalPath);
			} finally {
				await fs.rm(temporary, { force: true });
			}
		}
		native[entry.key] = { path: relativePath, sha256: entry.sha256 };
	}
	return { schemaVersion: 1, revision, sdkVersion: CUA_DRIVER_VERSION, platform: "darwin-arm64", ...native };
}

/** No native initialization or package download occurs during artifact installation. */
export async function installCuaRuntime(options: InstallCuaRuntimeOptions = {}) {
	if (process.platform !== "darwin" || process.arch !== "arm64")
		throw new Error("This native artifact installer is currently qualified for darwin-arm64 only");
	if (options.sourceDirectory ? !options.revision || !flatName.test(options.revision) : options.revision !== undefined)
		throw new Error(
			"An explicit native package requires a valid artifact revision; vendor installation uses its pinned revision",
		);
	if (options.sourceDirectory && options.vendorDirectory)
		throw new Error("Choose a repository vendor archive or an explicit native package");
	const destination = path.resolve(options.cacheDirectory ?? path.join(getNativesDir(), "cua-runtime"));
	await fs.mkdir(destination, { recursive: true });
	return withFileLock(path.join(destination, "install"), async () => {
		const descriptor = options.sourceDirectory
			? await developmentArtifact(destination, options.sourceDirectory, options.revision!)
			: await vendorArtifact(destination, options.vendorDirectory);
		const target = path.join(destination, "artifact.json");
		const temporary = `${target}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(temporary, `${JSON.stringify(descriptor, null, 2)}\n`);
			await fs.rename(temporary, target);
		} finally {
			await fs.rm(temporary, { force: true });
		}
		return { descriptor: target, revision: descriptor.revision, librarySha256: descriptor.library.sha256 };
	});
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	let options: InstallCuaRuntimeOptions;
	if (args.length === 0) options = {};
	else if (args.length === 2 && args[0] === "--cache-dir") options = { cacheDirectory: args[1] };
	else if ((args.length === 2 || args.length === 3) && !args[0]!.startsWith("--"))
		options = { sourceDirectory: args[0], revision: args[1], cacheDirectory: args[2] };
	else
		throw new Error(
			"Usage: bun packages/coding-agent/scripts/install-cua-runtime.ts [--cache-dir <directory>] | <native-package-directory> <artifact-revision> [cache-directory]",
		);
	console.log(JSON.stringify(await installCuaRuntime(options)));
}
