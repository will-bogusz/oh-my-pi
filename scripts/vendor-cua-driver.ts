#!/usr/bin/env bun
/**
 * Publish one platform's `cua-driver` build as a sha256-pinned release asset
 * on the fork and write `vendor/cua-driver/<platform>/manifest.json`, which is
 * what OMP resolves the executable from (`src/tools/computer/driver-cache.ts`).
 *
 *   bun scripts/vendor-cua-driver.ts --commit <fork sha> --fork <checkout>
 *       [--platform darwin-arm64] [--binary <prebuilt executable> --source <how it was built>]
 *       [--features <cargo features>] [--repo will-bogusz/cua]
 *
 * Without `--binary` the fork checkout must have `--commit` checked out; the
 * script runs `cargo build --locked --release -p cua-driver` there. Darwin
 * executables are signed with the local "OMP Computer Use" identity before
 * they are hashed (see vendor/cua-driver/README.md) unless they already carry
 * it. The release is `cua-driver-<version>-<short sha>`, one asset per
 * platform; an asset that already exists with the same bytes is kept, one
 * with different bytes is refused. Ends by printing the vendor commit message.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

const SIGNING_IDENTITY = "OMP Computer Use";
const SIGNING_IDENTIFIER = "com.ohmypi.cua-driver";
const SIGNING_REQUIREMENT = `identifier "${SIGNING_IDENTIFIER}" and certificate leaf[subject.CN] = "${SIGNING_IDENTITY}"`;

const { values } = parseArgs({
	args: process.argv.slice(2),
	options: {
		commit: { type: "string" },
		fork: { type: "string", default: process.env.CUA_FORK },
		platform: { type: "string", default: `${process.platform}-${process.arch}` },
		binary: { type: "string" },
		source: { type: "string" },
		features: { type: "string" },
		repo: { type: "string", default: "will-bogusz/cua" },
	},
});
if (!values.commit) throw new Error("--commit <fork sha> is required");
if (!values.fork) throw new Error("--fork <fork checkout> (or CUA_FORK) is required");
const fork = path.resolve(values.fork);
const platform = values.platform;
const repo = values.repo;
const repoRoot = path.join(import.meta.dir, "..");

const sha = (await $`git -C ${fork} rev-parse --verify ${`${values.commit}^{commit}`}`.text()).trim();
const short = sha.slice(0, 9);
const version = (await $`git -C ${fork} show ${`${sha}:libs/cua-driver/rust/VERSION`}`.text()).trim();
if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Unexpected cua-driver VERSION at ${short}: ${version}`);

const rustDir = path.join(fork, "libs/cua-driver/rust");
let built: string;
let source: string;
if (values.binary) {
	built = path.resolve(values.binary);
	source = `github.com/${repo} commit ${short} (${values.source ?? `prebuilt ${path.basename(built)}`}`;
} else {
	const head = (await $`git -C ${fork} rev-parse HEAD`.text()).trim();
	if (head !== sha) throw new Error(`${fork} has ${head.slice(0, 9)} checked out; check out ${short} to build it`);
	const features = values.features ? ["--features", values.features] : [];
	await $`cargo build --locked --release -p cua-driver ${features}`.cwd(rustDir);
	built = path.join(process.env.CARGO_TARGET_DIR ?? path.join(rustDir, "target"), "release/cua-driver");
	source = `github.com/${repo} commit ${short} (cargo build --locked --release -p cua-driver${values.features ? ` --features ${values.features}` : ""}`;
}

const assetName = `cua-driver-${platform}`;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "vendor-cua-driver-"));
try {
	const asset = path.join(scratch, assetName);
	await fs.copyFile(built, asset);
	await fs.chmod(asset, 0o755);
	if (platform.startsWith("darwin-")) {
		const signed = await $`codesign --verify --strict -R=${SIGNING_REQUIREMENT} ${asset}`.quiet().nothrow();
		if (signed.exitCode !== 0) {
			await $`codesign -f -s ${SIGNING_IDENTITY} --identifier ${SIGNING_IDENTIFIER} ${asset}`;
			await $`codesign --verify --strict -R=${SIGNING_REQUIREMENT} ${asset}`;
		}
		source += `; codesign ${SIGNING_IDENTITY}`;
	}
	source += ")";
	const bytes = await Bun.file(asset).bytes();
	const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	const size = bytes.byteLength;
	console.log(`${assetName}: sha256 ${sha256} (${size} bytes) from ${short}`);

	const tag = `cua-driver-${version}-${short}`;
	const url = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
	const existing = await $`gh release view ${tag} -R ${repo} --json assets --jq ${".assets[].name"}`.quiet().nothrow();
	if (existing.exitCode !== 0) {
		if (!existing.stderr.toString().includes("release not found")) throw new Error(existing.stderr.toString());
		const notes = `Prebuilt \`cua-driver\` from ${repo}@${sha}, vendored by oh-my-pi through \`vendor/cua-driver/<platform>/manifest.json\`. One asset per platform; the manifest pins its sha256.`;
		await $`gh release create ${tag} -R ${repo} --target ${sha} --title ${`cua-driver ${version} (${short})`} --notes ${notes}`;
		console.log(`created release ${tag}`);
	}
	if (existing.exitCode === 0 && existing.text().split("\n").includes(assetName)) {
		const previous = path.join(scratch, "published");
		await $`gh release download ${tag} -R ${repo} -p ${assetName} -O ${previous}`.quiet();
		const publishedSha = new Bun.CryptoHasher("sha256").update(await Bun.file(previous).bytes()).digest("hex");
		if (publishedSha !== sha256)
			throw new Error(
				`${url} already holds sha256 ${publishedSha}, not ${sha256}; a different build of ${short} needs a new tag, not a replaced asset`,
			);
		console.log(`asset already published: ${url}`);
	} else {
		await $`gh release upload ${tag} ${asset} -R ${repo}`;
		console.log(`uploaded ${url}`);
	}

	const response = await fetch(url, { headers: { accept: "application/octet-stream" } });
	if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
	const fetchedSha = new Bun.CryptoHasher("sha256").update(await response.bytes()).digest("hex");
	if (fetchedSha !== sha256) throw new Error(`${url} serves sha256 ${fetchedSha}, expected ${sha256}`);

	const manifestPath = path.join(repoRoot, "vendor/cua-driver", platform, "manifest.json");
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await Bun.write(
		manifestPath,
		`${JSON.stringify({ platform, version, commit: short, sha256, size, url, source }, null, "\t")}\n`,
	);
	console.log(`wrote ${path.relative(repoRoot, manifestPath)}\n`);
	console.log(`git add ${path.relative(repoRoot, manifestPath)}`);
	console.log(
		`git commit -m 'chore(computer): vendor cua-driver ${version} fork build (${short})' -m '${platform}: ${url} sha256 ${sha256} (${size} bytes)'`,
	);
} finally {
	await fs.rm(scratch, { recursive: true, force: true });
}
