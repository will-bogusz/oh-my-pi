import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createCuaArtifactPlugin } from "../scripts/cua-artifact-plugin";

it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
	"a relocated compiled consumer retains the verified native archive after the source checkout disappears",
	async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cua-compiled-"));
		try {
			const checkout = path.join(directory, "checkout");
			const sourceModule = path.join(checkout, "packages/coding-agent/src/tools/computer/cua-embedded.ts");
			const archive = await new Bun.Archive(
				{ "artifact.json": "qualified fixture descriptor" },
				{ compress: "gzip" },
			).bytes();
			const sha256 = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
			const manifest = {
				platform: "darwin-arm64",
				revision: "relocation-fixture",
				archive: { path: "native.tar.gz", sha256, files: {} },
			};
			await Bun.write(sourceModule, "export const embeddedCuaArchive = null;");
			await Bun.write(path.join(checkout, "vendor/cua-sdk/native.tar.gz"), archive);
			await Bun.write(path.join(checkout, "vendor/cua-sdk/manifest.json"), JSON.stringify(manifest));
			const entrypoint = path.join(checkout, "consumer.ts");
			await Bun.write(
				entrypoint,
				`import {embeddedCuaArchive as archive} from ${JSON.stringify(sourceModule)};
const bytes = await Bun.file(archive.filePath).bytes();
console.log(JSON.stringify({ sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"), revision: archive.revision }));`,
			);
			const binary = path.join(directory, "relocated", "consumer");
			await fs.mkdir(path.dirname(binary));
			const result = await Bun.build({
				entrypoints: [entrypoint],
				plugins: [await createCuaArtifactPlugin(checkout)],
				compile: { outfile: binary },
			});
			expect(result.success).toBe(true);
			await Bun.write(path.join(checkout, "vendor/cua-sdk/native.tar.gz"), "unqualified replacement");
			await expect(createCuaArtifactPlugin(checkout)).rejects.toThrow("archive SHA256 mismatch");
			await fs.rm(checkout, { recursive: true });
			const child = Bun.spawn([binary], { cwd: path.dirname(binary), stdout: "pipe", stderr: "pipe" });
			const [status, output, error] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect({ status, error }).toEqual({ status: 0, error: "" });
			expect(JSON.parse(output)).toEqual({ sha256, revision: manifest.revision });
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	},
);
