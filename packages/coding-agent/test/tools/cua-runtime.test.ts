import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assertCuaHostRuntime,
	type CuaRuntimeArtifact,
	loadCuaRuntime,
} from "@oh-my-pi/pi-coding-agent/tools/computer/cua-runtime";

async function artifactFixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-artifact-"));
	const descriptorPath = path.join(directory, "bundle", "artifact.json");
	const cacheDir = path.join(directory, "cache");
	const file = async (name: string, value: string) => {
		const bytes = new TextEncoder().encode(value);
		await Bun.write(path.join(path.dirname(descriptorPath), "native", name), bytes);
		return { path: `native/${name}`, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
	};
	const descriptor: CuaRuntimeArtifact = {
		schemaVersion: 1,
		revision: "regression-native-build",
		sdkVersion: "0.23.2",
		platform: `${process.platform}-${process.arch}`,
		library: await file("libcua_driver_sdk.dylib", "verified native fixture"),
		nodeRuntime: await file("cua_driver_node_runtime.node", "verified Node runtime fixture"),
		licenseNotice: await file("node-runtime-NOTICE.md", "preserved license notice fixture"),
	};
	await Bun.write(descriptorPath, JSON.stringify(descriptor));
	return {
		directory,
		descriptorPath,
		cacheDir,
		descriptor,
		async close() {
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

it.skipIf(process.platform !== "darwin")(
	"refuses an absent patched artifact before installing the stock SDK",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-no-artifact-"));
		let installed = false;
		try {
			await expect(
				loadCuaRuntime({
					cacheDir: directory,
					installRuntime: async () => {
						installed = true;
						throw new Error("unexpected install");
					},
				}),
			).rejects.toThrow("Patched Cua runtime artifact is not installed");
			expect(installed).toBe(false);
			expect(await fs.readdir(directory)).toEqual([]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"checks every artifact hash and platform before dependency installation",
	async () => {
		const f = await artifactFixture();
		let installed = false;
		const options = {
			cacheDir: f.cacheDir,
			artifactPath: f.descriptorPath,
			installRuntime: async () => {
				installed = true;
				throw new Error("unexpected install");
			},
		};
		try {
			for (const name of ["library", "nodeRuntime", "licenseNotice"] as const) {
				await Bun.write(
					f.descriptorPath,
					JSON.stringify({ ...f.descriptor, [name]: { ...f.descriptor[name], sha256: "0".repeat(64) } }),
				);
				await expect(loadCuaRuntime(options)).rejects.toThrow("SHA256 mismatch");
			}
			await Bun.write(f.descriptorPath, JSON.stringify({ ...f.descriptor, platform: "unsupported-platform" }));
			await expect(loadCuaRuntime(options)).rejects.toThrow("platform");
			expect(installed).toBe(false);
		} finally {
			await f.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"confines artifact files and symlinks to the portable descriptor directory",
	async () => {
		const f = await artifactFixture();
		try {
			await Bun.write(
				f.descriptorPath,
				JSON.stringify({ ...f.descriptor, library: { ...f.descriptor.library, path: "../outside.dylib" } }),
			);
			await expect(loadCuaRuntime({ cacheDir: f.cacheDir, artifactPath: f.descriptorPath })).rejects.toThrow(
				"path escapes",
			);
			await Bun.write(path.join(f.directory, "outside.dylib"), "verified native fixture");
			await fs.symlink(
				path.join(f.directory, "outside.dylib"),
				path.join(path.dirname(f.descriptorPath), "link.dylib"),
			);
			await Bun.write(
				f.descriptorPath,
				JSON.stringify({ ...f.descriptor, library: { ...f.descriptor.library, path: "link.dylib" } }),
			);
			await expect(loadCuaRuntime({ cacheDir: f.cacheDir, artifactPath: f.descriptorPath })).rejects.toThrow(
				"symlink escapes",
			);
		} finally {
			await f.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"stages the verified package through the central install contract and checks installed bytes",
	async () => {
		const f = await artifactFixture();
		try {
			const runner = path.join(f.directory, "host.ts");
			const implementation = path.resolve(import.meta.dir, "../../src/tools/computer/cua-runtime.ts");
			await Bun.write(
				runner,
				`import * as path from "node:path";
import { loadCuaRuntime } from ${JSON.stringify(implementation)};
import { ensureRuntimeInstalled } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../utils/src/runtime-install.ts"))};
const options = JSON.parse(process.argv[2]);
let install;
options.installRuntime = async args => {
  install = args.install;
  const nativeName = Object.keys(args.install.overrides)[0];
  const nativeDestination = path.join(args.runtimeDir, "node_modules", nativeName);
  const sdk = path.join(args.runtimeDir, "sdk-fixture");
  await Bun.write(path.join(sdk, "package.json"), JSON.stringify({ name: "@trycua/cua-driver", version: "0.23.2", type: "module", main: "dist/entry.js", optionalDependencies: { [nativeName]: "0.23.2" } }));
  await Bun.write(path.join(sdk, "dist/entry.js"), 'import {createRequire} from "node:module"; import {readFileSync} from "node:fs"; import * as path from "node:path"; const require = createRequire(import.meta.url); export class CuaDriver { static create() { const native = require.resolve("'+nativeName+'/package.json"); return { async metadata() { return { marker: "verified-artifact-sdk-fixture", library: readFileSync(path.join(path.dirname(native), "libcua_driver_sdk.dylib"), "utf8") }; } }; } }');
  const installed = await ensureRuntimeInstalled({ ...args, install: { ...args.install, dependencies: { ...args.install.dependencies, "@trycua/cua-driver": "file:./sdk-fixture" } } });
  if (options.corrupt) await Bun.write(path.join(nativeDestination, "libcua_driver_sdk.dylib"), "unexpected native payload");
  return installed;
};
try {
  const sdk = await loadCuaRuntime(options);
  console.log(JSON.stringify({ metadata: await sdk.CuaDriver.create({claudeCodeCompatibility:false}).metadata(), install }));
} catch (error) { console.log(JSON.stringify({ error: error.message, install })); }
`,
			);
			// A real package in the bundle's ancestry must not shadow the verified runtime.
			const ancestor = path.join(
				f.directory,
				"node_modules",
				`@trycua/cua-driver-${process.platform}-${process.arch}`,
			);
			await Bun.write(
				path.join(ancestor, "package.json"),
				JSON.stringify({ name: `@trycua/cua-driver-${process.platform}-${process.arch}`, version: "0.23.2" }),
			);
			await Bun.write(path.join(ancestor, "libcua_driver_sdk.dylib"), "unverified ancestor payload");
			for (const corrupt of [false, true]) {
				const child = Bun.spawn(
					[
						process.execPath,
						runner,
						JSON.stringify({
							artifactPath: f.descriptorPath,
							cacheDir: path.join(f.cacheDir, String(corrupt)),
							corrupt,
						}),
					],
					{ cwd: f.directory, stdout: "pipe", stderr: "pipe" },
				);
				const [status, output, error] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				expect({ status, error }).toEqual({ status: 0, error: "" });
				const result = JSON.parse(output) as {
					metadata?: { marker: string; library: string };
					error?: string;
					install: { dependencies: Record<string, string>; overrides: Record<string, string> };
				};
				expect(result.install).toEqual({
					dependencies: {
						"@trycua/cua-driver": "0.23.2",
						[`@trycua/cua-driver-${process.platform}-${process.arch}`]: "file:./native-package",
					},
					overrides: { [`@trycua/cua-driver-${process.platform}-${process.arch}`]: "file:./native-package" },
				});
				if (corrupt) {
					expect(result.error).toContain("does not match verified revision");
					expect(result.metadata).toBeUndefined();
				} else {
					expect(result.error).toBeUndefined();
					expect(result.metadata).toEqual({
						marker: "verified-artifact-sdk-fixture",
						library: "verified native fixture",
					});
				}
			}
		} finally {
			await f.close();
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"rejects an experimental graph with an unpinned SDK version before loading it",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-runtime-"));
		try {
			const experimentalNodeModules = path.join(directory, "node_modules");
			const manifest = path.join(experimentalNodeModules, "@trycua/cua-driver/package.json");
			await Bun.write(manifest, JSON.stringify({ version: "0.24.0" }));
			await expect(
				loadCuaRuntime({ experimentalNodeModules, cacheDir: path.join(directory, "cache") }),
			).rejects.toThrow("exactly @trycua/cua-driver@0.23.2");
			expect(await Bun.file(manifest).json()).toEqual({ version: "0.24.0" });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);

it.skipIf(process.platform !== "darwin")(
	"loads the on-disk SDK bundle in an isolated host and refuses mixed native graphs",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-runtime-load-"));
		try {
			const experimentalNodeModules = path.join(directory, "node_modules");
			const packageDir = path.join(experimentalNodeModules, "@trycua/cua-driver");
			await Bun.write(
				path.join(packageDir, "package.json"),
				JSON.stringify({
					version: "0.23.2",
					type: "module",
					main: "dist/entry.js",
					exports: { ".": { import: "./dist/entry.js" } },
				}),
			);
			await Bun.write(
				path.join(packageDir, "dist/entry.js"),
				'export class CuaDriver { static create() { return { async metadata() { return { driverVersion: "0.23.2", marker: "on-disk SDK fixture" }; }, async shutdown() {}, uniffiDestroy() {} }; } }',
			);
			const runner = path.join(directory, "host.ts");
			const implementation = path.resolve(import.meta.dir, "../../src/tools/computer/cua-runtime.ts");
			await Bun.write(
				runner,
				`import { loadCuaRuntime } from ${JSON.stringify(implementation)};
const options = JSON.parse(process.argv[2]);
const first = await loadCuaRuntime(options);
const second = await loadCuaRuntime(options);
const driver = first.CuaDriver.create({ claudeCodeCompatibility: false });
const metadata = await driver.metadata();
let conflict = "";
try { await loadCuaRuntime({ ...options, experimentalNodeModules: options.experimentalNodeModules + "-other" }); }
catch (error) { conflict = error.message; }
await driver.shutdown(); driver.uniffiDestroy();
console.log(JSON.stringify({ metadata, sameModule: first === second, conflict }));
`,
			);
			const child = Bun.spawn(
				[
					process.execPath,
					runner,
					JSON.stringify({ experimentalNodeModules, cacheDir: path.join(directory, "cache") }),
				],
				{ cwd: directory, stdout: "pipe", stderr: "pipe" },
			);
			const [status, output, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ status, error }).toEqual({ status: 0, error: "" });
			const result = JSON.parse(output) as {
				metadata: { driverVersion: string; marker: string };
				sameModule: boolean;
				conflict: string;
			};
			expect(result.metadata).toEqual({ driverVersion: "0.23.2", marker: "on-disk SDK fixture" });
			expect(result.sameModule).toBe(true);
			expect(result.conflict).toContain("Restart the computer worker");
			expect(await Bun.file(path.join(packageDir, "package.json")).json()).toMatchObject({ version: "0.23.2" });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);

it("rejects unqualified host runtimes before native session startup", () => {
	expect(() => assertCuaHostRuntime("1.3.14")).toThrow("requires Bun 1.4.0 or newer");
	expect(() => assertCuaHostRuntime("1.4.0")).not.toThrow();
	expect(() => assertCuaHostRuntime("1.4.1")).not.toThrow();
});
