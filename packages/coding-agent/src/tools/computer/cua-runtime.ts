import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
	ensureRuntimeInstalled,
	getNativesDir,
	installRuntimeModuleResolver,
	resolveRuntimeModule,
	withFileLock,
} from "@oh-my-pi/pi-utils";
import { ToolError } from "../tool-errors";
import { provisionBundledCuaArtifact } from "./cua-bundle";

export const CUA_DRIVER_VERSION = "0.23.2";
export const CUA_MIN_BUN_VERSION = "1.4.0";

/** Older host runtimes can deliver stream frames without completing native start. */
export function assertCuaHostRuntime(version: string = Bun.version): void {
	if (Bun.semver.order(version, CUA_MIN_BUN_VERSION) < 0)
		throw new ToolError(
			`Computer control on Apple Silicon macOS requires Bun ${CUA_MIN_BUN_VERSION} or newer; this worker uses ${version}. Run source OMP with an updated Bun, or use an OMP binary built with Bun ${CUA_MIN_BUN_VERSION} or newer.`,
		);
}
const PACKAGE = "@trycua/cua-driver";
let loadedRuntime: { nodeModules: string; module?: CuaSdkModule } | undefined;

function existingRuntime(nodeModules: string): CuaSdkModule | undefined {
	if (!loadedRuntime) return undefined;
	if (loadedRuntime.nodeModules !== nodeModules || !loadedRuntime.module) {
		throw new ToolError("Restart the computer worker before changing or retrying a loaded Cua native runtime");
	}
	return loadedRuntime.module;
}

/** The SDK's open-ended adapter contract; no SDK code is bundled into OMP. */
export interface CuaToolResult {
	text: string;
	images: { dataBase64: string; mimeType: string }[];
	structuredJson?: string;
	isError: boolean;
	errorCode?: string;
}
export interface CuaDriverMetadata {
	driverVersion: string;
	contractVersion: string;
	toolsListSchemaVersion: string;
	capabilityVersion: string;
	mcpProtocolVersion: string;
	pid: number;
	embedded: boolean;
}
export interface CuaDriverHandle {
	callTool(name: string, argumentsJson: string): Promise<CuaToolResult>;
	metadata(): Promise<CuaDriverMetadata>;
	shutdown(): Promise<void>;
	uniffiDestroy(): void;
}
export interface CuaSdkModule {
	CuaDriver: { create(options: { claudeCodeCompatibility: boolean }): CuaDriverHandle };
}
export interface CuaRuntimeOptions {
	/** Explicit research injection. Never installs into or rewrites this dependency graph. */
	experimentalNodeModules?: string;
	/** Trusted local artifact descriptor. Defaults to the stable OMP native cache. */
	artifactPath?: string;
	/** Optional isolated cache, primarily for packaging qualification. */
	cacheDir?: string;
	/** Per-instance dependency for installation regressions without downloading native code. */
	installRuntime?: typeof ensureRuntimeInstalled;
}
export interface CuaArtifactFile {
	path: string;
	sha256: string;
}
/**
 * Install this descriptor at getNativesDir()/cua-runtime/artifact.json, with
 * referenced files beneath the same directory. Build the library from the
 * patched Cua source using `cargo build --locked --release -p cua-driver-sdk`;
 * preserve the matching maintained Node runtime and node-runtime-NOTICE.md.
 * Paths are relative, portable and confined to the descriptor directory.
 * revision identifies the source/build record; every loaded native byte is
 * SHA256-checked. No published stock library is accepted as an implicit default.
 */
export interface CuaRuntimeArtifact {
	schemaVersion: 1;
	revision: string;
	sdkVersion: typeof CUA_DRIVER_VERSION;
	platform: string;
	library: CuaArtifactFile;
	nodeRuntime: CuaArtifactFile;
	licenseNotice: CuaArtifactFile;
}
interface ArtifactBytes {
	library: Uint8Array;
	nodeRuntime: Uint8Array;
	licenseNotice: Uint8Array;
}
function digest(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
function artifactObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ToolError("Malformed Cua runtime artifact descriptor");
	return value as Record<string, unknown>;
}
function artifactFile(value: unknown): CuaArtifactFile {
	const file = artifactObject(value);
	if (
		typeof file.path !== "string" ||
		!file.path ||
		path.isAbsolute(file.path) ||
		typeof file.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(file.sha256)
	)
		throw new ToolError("Cua artifact files require a relative path and lowercase SHA256");
	return { path: file.path, sha256: file.sha256 };
}
function artifactDescriptor(value: unknown): CuaRuntimeArtifact {
	const row = artifactObject(value);
	if (
		row.schemaVersion !== 1 ||
		row.sdkVersion !== CUA_DRIVER_VERSION ||
		row.platform !== `${process.platform}-${process.arch}` ||
		typeof row.revision !== "string" ||
		!row.revision.trim()
	)
		throw new ToolError(
			`Cua artifact requires schemaVersion 1, SDK ${CUA_DRIVER_VERSION}, a revision, and platform ${process.platform}-${process.arch}`,
		);
	return {
		schemaVersion: 1,
		sdkVersion: CUA_DRIVER_VERSION,
		platform: row.platform,
		revision: row.revision,
		library: artifactFile(row.library),
		nodeRuntime: artifactFile(row.nodeRuntime),
		licenseNotice: artifactFile(row.licenseNotice),
	};
}
async function artifactBytes(directory: string, file: CuaArtifactFile): Promise<Uint8Array> {
	const source = path.resolve(directory, file.path);
	const relative = path.relative(directory, source);
	if (relative === ".." || relative.startsWith(`..${path.sep}`))
		throw new ToolError("Cua artifact path escapes its descriptor directory");
	const realDirectory = await fs.realpath(directory);
	const realSource = await fs.realpath(source);
	const realRelative = path.relative(realDirectory, realSource);
	if (realRelative === ".." || realRelative.startsWith(`..${path.sep}`))
		throw new ToolError("Cua artifact symlink escapes its descriptor directory");
	const bytes = new Uint8Array(await Bun.file(realSource).arrayBuffer());
	if (digest(bytes) !== file.sha256)
		throw new ToolError(
			`Cua artifact SHA256 mismatch: ${file.path}; rebuild/install the verified artifact before retrying`,
		);
	return bytes;
}
async function verifiedFile(destination: string, bytes: Uint8Array, expected: string): Promise<void> {
	if (await Bun.file(destination).exists()) {
		if (digest(new Uint8Array(await Bun.file(destination).arrayBuffer())) !== expected)
			throw new ToolError(
				`Cua cached artifact SHA256 mismatch: ${destination}; remove this runtime cache and install it again`,
			);
		return;
	}
	const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
	try {
		await Bun.write(temporary, bytes);
		await fs.rename(temporary, destination);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}
async function installedArtifact(options: CuaRuntimeOptions): Promise<{ bundleDir: string; nodeModules: string }> {
	const base = path.resolve(options.cacheDir ?? path.join(getNativesDir(), "cua-runtime"));
	const bundled = options.artifactPath ? undefined : await provisionBundledCuaArtifact(base);
	const descriptorPath = path.resolve(options.artifactPath ?? bundled ?? path.join(base, "artifact.json"));
	if (!(await Bun.file(descriptorPath).exists()))
		throw new ToolError(
			`Patched Cua runtime artifact is not installed. Install artifact.json plus its hashed SDK library, Node runtime and license notice at ${path.dirname(descriptorPath)}, or pass an explicit artifactPath. The unfixed ${CUA_DRIVER_VERSION} native release will not be loaded.`,
		);
	const artifact = artifactDescriptor(await Bun.file(descriptorPath).json());
	const directory = path.dirname(descriptorPath);
	// Validate all source artifacts before installing any dependency or native code.
	const bytes: ArtifactBytes = {
		library: await artifactBytes(directory, artifact.library),
		nodeRuntime: await artifactBytes(directory, artifact.nodeRuntime),
		licenseNotice: await artifactBytes(directory, artifact.licenseNotice),
	};
	const key = digest(new TextEncoder().encode(JSON.stringify(artifact)));
	const runtimeDir = path.join(base, "installed", key);
	const nativeName = `${PACKAGE}-${artifact.platform}`;
	const staged = path.join(runtimeDir, "native-package");
	const names = {
		library: "libcua_driver_sdk.dylib",
		nodeRuntime: "cua_driver_node_runtime.node",
		licenseNotice: "node-runtime-NOTICE.md",
	} as const;
	await fs.mkdir(runtimeDir, { recursive: true });
	await withFileLock(
		path.join(runtimeDir, "prepare"),
		async () => {
			await fs.mkdir(staged, { recursive: true });
			for (const name of ["library", "nodeRuntime", "licenseNotice"] as const)
				await verifiedFile(path.join(staged, names[name]), bytes[name], artifact[name].sha256);
			await Bun.write(
				path.join(staged, "package.json"),
				JSON.stringify(
					{
						name: nativeName,
						version: CUA_DRIVER_VERSION,
						license: "MIT AND MPL-2.0",
						os: [process.platform],
						cpu: [process.arch],
						files: Object.values(names),
						ompArtifact: artifact,
					},
					null,
					"\t",
				),
			);
			// Keep Cua's maintained JS/dependency graph. Its optional native package is
			// replaced by the verified local package, never patched after native loading.
			await (options.installRuntime ?? ensureRuntimeInstalled)({
				runtimeDir,
				install: {
					dependencies: { [PACKAGE]: CUA_DRIVER_VERSION, [nativeName]: "file:./native-package" },
					overrides: { [nativeName]: "file:./native-package" },
				},
				probePackage: PACKAGE,
			});
			for (const name of ["library", "nodeRuntime", "licenseNotice"] as const) {
				const installed = path.join(runtimeDir, "node_modules", nativeName, names[name]);
				if (
					!(await Bun.file(installed).exists()) ||
					digest(new Uint8Array(await Bun.file(installed).arrayBuffer())) !== artifact[name].sha256
				)
					throw new ToolError(
						`Installed Cua ${name} does not match verified revision ${artifact.revision}; refusing to load the runtime`,
					);
			}
		},
		{ retries: 240, retryDelayMs: 250 },
	);
	return { bundleDir: path.join(base, "bundles", key), nodeModules: path.join(runtimeDir, "node_modules") };
}

/** Worker-only: the maintained resolver patches Node resolution for this process. */
export async function loadCuaRuntime(options: CuaRuntimeOptions = {}): Promise<CuaSdkModule> {
	if (process.platform !== "darwin")
		throw new ToolError("The Cua computer adapter is currently qualified for macOS only");
	if (options.experimentalNodeModules && options.artifactPath)
		throw new ToolError("Choose either a verified Cua artifact or an explicit experimental runtime");
	const { bundleDir, nodeModules } = options.experimentalNodeModules
		? {
				bundleDir: path.resolve(options.cacheDir ?? path.join(getNativesDir(), "cua-runtime", "experimental")),
				nodeModules: path.resolve(options.experimentalNodeModules),
			}
		: await installedArtifact(options);
	const existing = existingRuntime(nodeModules);
	if (existing) return existing;
	const manifest: unknown = await Bun.file(path.join(nodeModules, PACKAGE, "package.json")).json();
	if (
		!manifest ||
		typeof manifest !== "object" ||
		!("version" in manifest) ||
		manifest.version !== CUA_DRIVER_VERSION
	) {
		throw new ToolError(`Cua runtime must contain exactly ${PACKAGE}@${CUA_DRIVER_VERSION}`);
	}
	const entry = resolveRuntimeModule(nodeModules, PACKAGE);
	if (!entry) throw new ToolError("Cua runtime has no resolvable SDK entrypoint");
	await fs.mkdir(bundleDir, { recursive: true });
	// A fresh worker gets a fresh experimental JS bundle. Native changes require a
	// worker restart; two runtime graphs must never compete in Node's native cache.
	const key = options.experimentalNodeModules ? crypto.randomUUID() : `v1-${Bun.version}`;
	// Keep emitted code outside the SDK graph's ancestors: Bun's build resolver
	// caches their directory listings before the new on-disk bundle exists.
	const bundlePath = path.join(bundleDir, `sdk-${key}.mjs`);
	await withFileLock(path.join(bundleDir, "bundle"), async () => {
		if (await Bun.file(bundlePath).exists()) return;
		const build = await Bun.build({ entrypoints: [entry], target: "bun", format: "esm" });
		if (!build.success || build.outputs.length !== 1) {
			throw new ToolError(`Cua SDK runtime bundle failed: ${build.logs.map(log => log.message).join("\n")}`);
		}
		const temporary = `${bundlePath}.${crypto.randomUUID()}.tmp`;
		try {
			await Bun.write(temporary, build.outputs[0]!);
			await fs.rename(temporary, bundlePath);
		} finally {
			await fs.rm(temporary, { force: true });
		}
	});
	// Another concurrent initializer may have completed while the bundle awaited IO.
	const concurrent = existingRuntime(nodeModules);
	if (concurrent) return concurrent;
	loadedRuntime = { nodeModules };
	// Keep the registration for the computer worker's lifetime: native packages may
	// resolve deferred assets after construction, and several sessions can share it.
	const nativeSpecifier = `${PACKAGE}-${process.platform}-${process.arch}/package.json`;
	const nativeManifest = resolveRuntimeModule(nodeModules, nativeSpecifier);
	if (!options.experimentalNodeModules && !nativeManifest)
		throw new ToolError("Verified Cua native package manifest is unavailable; refusing ancestor resolution");
	installRuntimeModuleResolver({
		runtimeNodeModules: nodeModules,
		pinnedSpecifiers: nativeManifest ? { [nativeSpecifier]: nativeManifest } : {},
	});
	const loaded: unknown = createRequire(bundlePath)(bundlePath);
	if (
		!loaded ||
		typeof loaded !== "object" ||
		!("CuaDriver" in loaded) ||
		!loaded.CuaDriver ||
		(typeof loaded.CuaDriver !== "function" && typeof loaded.CuaDriver !== "object") ||
		!("create" in loaded.CuaDriver) ||
		typeof loaded.CuaDriver.create !== "function"
	) {
		throw new ToolError("Cua runtime does not expose the embedded CuaDriver.create SDK contract");
	}
	loadedRuntime.module = loaded as CuaSdkModule;
	return loadedRuntime.module;
}
