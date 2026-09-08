import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";
import { installCuaRuntime } from "../scripts/install-cua-runtime";
import type { CuaRuntimeArtifact } from "../src/tools/computer/cua-runtime";

const vendor = path.resolve(import.meta.dir, "../../../vendor/cua-sdk");
const supported = process.platform === "darwin" && process.arch === "arm64";

function digest(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

it.skipIf(!supported)(
	"installs the repository's actual qualified archive from the CLI without a development package",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-install-"));
		try {
			const cache = path.join(directory, "cache");
			const script = path.resolve(import.meta.dir, "../scripts/install-cua-runtime.ts");
			const command = await $`${process.execPath} ${script} --cache-dir ${cache}`.cwd(directory).quiet();
			const result = JSON.parse(command.text());
			const manifest = await Bun.file(path.join(vendor, "manifest.json")).json();
			const artifact: CuaRuntimeArtifact = await Bun.file(result.descriptor).json();
			for (const file of [artifact.library, artifact.nodeRuntime, artifact.licenseNotice]) {
				expect(path.isAbsolute(file.path)).toBe(false);
				expect(file.path.startsWith("bundled/")).toBe(true);
				expect(digest(await Bun.file(path.join(cache, file.path)).bytes())).toBe(file.sha256);
			}
			const bundle = path.dirname(path.join(cache, artifact.library.path));
			expect(await Bun.file(path.join(bundle, "LICENSE-CUA.md")).text()).toContain("MIT License");
			expect(await Bun.file(path.join(bundle, "node-runtime-NOTICE.md")).text()).toContain(
				"Mozilla Public License 2.0",
			);
			expect((await Bun.file(path.join(bundle, "source-provenance.json")).json()).source).toEqual(manifest.source);
			const repeat = await installCuaRuntime({ cacheDirectory: cache });
			expect(repeat).toEqual(result);
			const relocated = path.join(directory, "relocated");
			await fs.rename(cache, relocated);
			expect(digest(await Bun.file(path.join(relocated, artifact.library.path)).bytes())).toBe(
				manifest.nativeFiles.library.sha256,
			);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);

it.skipIf(!supported)(
	"rejects incorrect source, archive and native pins without replacing the installed default",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-install-pins-"));
		try {
			const cache = path.join(directory, "cache");
			const fixture = path.join(directory, "vendor");
			const original = await Bun.file(path.join(vendor, "manifest.json")).json();
			await Bun.write(path.join(fixture, original.source.patch), Bun.file(path.join(vendor, original.source.patch)));
			await Bun.write(path.join(fixture, original.archive.path), Bun.file(path.join(vendor, original.archive.path)));
			const target = path.join(cache, "artifact.json");
			await Bun.write(target, "previous installation");
			const cases = [
				{ field: "patch", error: "source patch SHA256 mismatch" },
				{ field: "archive", error: "archive SHA256 mismatch" },
				{ field: "native", error: "native and archive pins disagree" },
				{ field: "path", error: "flat paths" },
			];
			for (const testCase of cases) {
				const manifest = structuredClone(original);
				if (testCase.field === "patch") manifest.source.patchSha256 = "0".repeat(64);
				if (testCase.field === "archive") manifest.archive.sha256 = "0".repeat(64);
				if (testCase.field === "native") manifest.nativeFiles.library.sha256 = "0".repeat(64);
				if (testCase.field === "path") manifest.source.patch = "../cua-sdk-omp.patch";
				await Bun.write(path.join(fixture, "manifest.json"), JSON.stringify(manifest));
				await expect(installCuaRuntime({ cacheDirectory: cache, vendorDirectory: fixture })).rejects.toThrow(
					testCase.error,
				);
				expect(await Bun.file(target).text()).toBe("previous installation");
			}
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);

it.skipIf(!supported)(
	"preserves explicit development installs and refuses revision reuse with different native bytes",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-install-development-"));
		try {
			const source = path.join(directory, "development");
			const cache = path.join(directory, "cache");
			await Bun.write(path.join(source, "package.json"), JSON.stringify({ version: "0.23.2" }));
			for (const name of ["libcua_driver_sdk.dylib", "cua_driver_node_runtime.node", "node-runtime-NOTICE.md"])
				await Bun.write(path.join(source, name), `development fixture: ${name}`);
			const options = { sourceDirectory: source, revision: "development-test", cacheDirectory: cache };
			const installed = await installCuaRuntime(options);
			const original = await Bun.file(installed.descriptor).text();
			expect((JSON.parse(original) as CuaRuntimeArtifact).library.path).toBe(
				"artifacts/development-test/libcua_driver_sdk.dylib",
			);
			expect(await installCuaRuntime(options)).toEqual(installed);
			await Bun.write(path.join(source, "libcua_driver_sdk.dylib"), "different development build");
			await expect(installCuaRuntime(options)).rejects.toThrow("already contains different bytes");
			expect(await Bun.file(installed.descriptor).text()).toBe(original);
			await expect(installCuaRuntime({ ...options, revision: "../escape" })).rejects.toThrow(
				"valid artifact revision",
			);
			await Bun.write(path.join(source, "package.json"), JSON.stringify({ version: "0.0.0-local" }));
			await expect(installCuaRuntime({ ...options, revision: "next" })).rejects.toThrow(
				"must declare Cua SDK 0.23.2",
			);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);
