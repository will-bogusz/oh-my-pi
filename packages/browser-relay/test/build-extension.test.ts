import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const temporaryDirectories: string[] = [];
const repository = path.resolve(import.meta.dir, "../../..");

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test("extension payload, embedded assets and ZIP stay identical across checkout paths, cwd and time zone", async () => {
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-build-"));
	temporaryDirectories.push(temporary);
	const builds: Record<string, string>[] = [];
	for (const [directoryName, timezone, packageCwd] of [
		["first", "Pacific/Honolulu", false],
		["second café", "Asia/Tokyo", true],
	] as const) {
		const checkout = path.join(temporary, directoryName);
		for (const relative of [
			"packages/browser-relay/extension",
			"packages/browser-relay/scripts/build-extension.ts",
			"packages/coding-agent/src/tools/browser/relay/protocol.ts",
			"LICENSE",
			"THIRD-PARTY-NOTICES.txt",
		]) {
			const destination = path.join(checkout, relative);
			await fs.mkdir(path.dirname(destination), { recursive: true });
			await fs.cp(path.join(repository, relative), destination, { recursive: true });
		}
		const script = path.join(checkout, "packages/browser-relay/scripts/build-extension.ts");
		const result = await $`${process.execPath} ${script}`
			.cwd(packageCwd ? path.join(checkout, "packages/browser-relay") : checkout)
			.env({ ...process.env, TZ: timezone })
			.quiet()
			.nothrow();
		expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
		const hashes: Record<string, string> = {};
		for (const relative of [
			"packages/browser-relay/dist",
			"packages/coding-agent/src/tools/browser/relay/extension-assets",
		]) {
			const base = path.join(checkout, relative);
			for await (const file of new Bun.Glob("**/*").scan({ cwd: base, onlyFiles: true })) {
				hashes[`${relative}/${file}`] = new Bun.CryptoHasher("sha256")
					.update(await Bun.file(path.join(base, file)).arrayBuffer())
					.digest("hex");
			}
		}
		builds.push(hashes);
	}
	expect(builds[1]).toEqual(builds[0]);
}, 30_000);
