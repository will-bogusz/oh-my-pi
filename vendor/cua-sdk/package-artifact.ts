/** Package only native bytes whose reviewed digests are already in manifest.json. */
import * as path from "node:path";
import { encodeArchive } from "@oh-my-pi/pi-utils/ar";

interface FileIdentity {
	path: string;
	sha256: string;
}
interface VendorManifest {
	schemaVersion: 1;
	revision: string;
	platform: string;
	sdkVersion: string;
	source: { patch: string; patchSha256: string };
	nativeFiles: Record<"library" | "nodeRuntime" | "licenseNotice", FileIdentity>;
	archive: { path: string; sha256: string; files: Record<string, string> };
}

function digest(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

const sourceArgument = Bun.argv[2];
if (!sourceArgument) throw new Error("Usage: bun vendor/cua-sdk/package-artifact.ts <qualified-native-directory>");
const directory = import.meta.dir;
const manifestFile = Bun.file(path.join(directory, "manifest.json"));
const manifest = (await manifestFile.json()) as VendorManifest;
if (
	manifest.schemaVersion !== 1 ||
	manifest.sdkVersion !== "0.23.2" ||
	manifest.platform !== "darwin-arm64" ||
	!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar\.gz$/.test(manifest.archive.path)
)
	throw new Error("Unsupported Cua vendor manifest");
if (digest(await Bun.file(path.join(directory, manifest.source.patch)).bytes()) !== manifest.source.patchSha256)
	throw new Error("Source patch does not match its reviewed SHA256");
const entries: Record<string, Uint8Array> = {};
for (const identity of Object.values(manifest.nativeFiles)) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(identity.path)) throw new Error("Native members require flat paths");
	const bytes = await Bun.file(path.join(path.resolve(sourceArgument), identity.path)).bytes();
	if (digest(bytes) !== identity.sha256) throw new Error(`Unqualified native bytes: ${identity.path}`);
	entries[identity.path] = bytes;
}
entries["LICENSE-CUA.md"] = await Bun.file(path.join(directory, "LICENSE-CUA.md")).bytes();
const descriptor = {
	schemaVersion: manifest.schemaVersion,
	revision: manifest.revision,
	platform: manifest.platform,
	sdkVersion: manifest.sdkVersion,
	...manifest.nativeFiles,
};
entries["artifact.json"] = new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`);
const { archive: _archive, ...provenance } = manifest;
entries["source-provenance.json"] = new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}\n`);
// The central writer fixes tar timestamps to zero, keeping identical inputs
// content-addressable across packaging runs.
const compressed = await encodeArchive("tar.gz", Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
await Bun.write(path.join(directory, manifest.archive.path), compressed);
manifest.archive.sha256 = digest(compressed);
manifest.archive.files = Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, digest(bytes)]));
await Bun.write(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ revision: manifest.revision, archive: manifest.archive.path, sha256: manifest.archive.sha256 }));
