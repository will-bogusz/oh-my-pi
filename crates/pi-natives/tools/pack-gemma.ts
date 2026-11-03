// Pack the Gemma 4 vocabulary into data/gemma4.bin.zst (GEMMA1 + zstd -19).
//
//   bun tools/pack-gemma.ts
//
// Source: google/gemma-4-E4B-it tokenizer.json at the pinned revision below
// (Apache-2.0, see data/LICENSE.gemma4), cached in tools/cache/ and checked
// against its sha256. The model is SentencePiece-style BPE with byte
// fallback: normalizer ' ' -> '▁', no effective pre-tokenizer (its Split on
// ' ' never matches after the normalizer), merges over codepoints.
//
// No merges list is stored. tokenizer.json's 514,906 merges are exactly
// every split (a, b) of every merge-reachable piece with both halves in the
// vocabulary, ordered by
//   - a 91-piece top tier (pure '\n' / '▁' / '\t' runs and '▁t'), first,
//     by (len a desc, len b desc, id(a+b), id a, id b) — SentencePiece's
//     tied score 0 under the HF converter's stable sort;
//   - then every other piece by (id(a+b), len a desc),
// with lengths in codepoints. The engine rebuilds the list from the
// vocabulary and the top-tier ids at load; this script asserts that the
// rebuild reproduces tokenizer.json's merges in order before writing.
//
// GEMMA1 (before zstd): magic "GEMMA1\n", u32le vocab size, u32le id of
// <0x00> (byte-fallback ids are contiguous from it), u32le top-tier count,
// that many u32le ids, then one varint(len) + UTF-8 bytes entry per id. '▁'
// is stored as ' ' (the engine maps both to it). Multi-codepoint pieces no
// merge produces (specials, <unusedN>, HTML tags, byte tokens) are stored
// empty: with added-token matching off, nothing in text can emit them.
//
// The engine splits text before a space that follows a non-space other
// than '>' and at every '\n'-run edge; the asserts at the end prove no
// stored piece spans either boundary.

import { createHash } from "node:crypto";

const REPO = "google/gemma-4-E4B-it";
const REVISION = "ee0ef6023621cff504d758262d4e04895a5af4a2";
const SHA256 = "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f";
const SRC = new URL("cache/gemma-4.tokenizer.json", import.meta.url).pathname;
const OUT = new URL("../data/gemma4.bin.zst", import.meta.url).pathname;

const VOCAB_SIZE = 262_144;
const MERGES = 514_906;
const TOP_TIER = 91;

let file = Bun.file(SRC);
if (!(await file.exists())) {
	const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/tokenizer.json`;
	const response = await fetch(url);
	if (!response.ok) throw new Error(`fetch ${url}: ${response.status} ${response.statusText}`);
	await Bun.write(SRC, await response.arrayBuffer());
	file = Bun.file(SRC);
}
const source = new Uint8Array(await file.arrayBuffer());
const digest = createHash("sha256").update(source).digest("hex");
if (digest !== SHA256) throw new Error(`${SRC}: sha256 ${digest}, expected ${SHA256}`);

const tj = JSON.parse(new TextDecoder().decode(source));
const model = tj.model;
const expect = (ok: boolean, what: string) => {
	if (!ok) throw new Error(`unexpected tokenizer.json: ${what}`);
};
expect(model.type === "BPE" && model.byte_fallback === true && model.ignore_merges === false, "model flags");
expect(model.dropout == null && model.continuing_subword_prefix == null && model.end_of_word_suffix == null, "model affixes");
expect(
	JSON.stringify(tj.normalizer) === JSON.stringify({ type: "Replace", pattern: { String: " " }, content: "▁" }),
	"normalizer",
);
expect(
	JSON.stringify(tj.pre_tokenizer) ===
		JSON.stringify({ type: "Split", pattern: { String: " " }, behavior: "MergedWithPrevious", invert: false }),
	"pre_tokenizer",
);

const vocab: Record<string, number> = model.vocab;
const merges: [string, string][] = model.merges;
expect(merges.length === MERGES && merges.every(m => Array.isArray(m) && m.length === 2), "merges list shape");

const pieces: string[] = new Array(VOCAB_SIZE);
for (const piece in vocab) {
	const id = vocab[piece];
	expect(pieces[id] === undefined && id < VOCAB_SIZE, `id ${id}`);
	pieces[id] = piece;
}
for (let id = 0; id < VOCAB_SIZE; id++) expect(pieces[id] !== undefined, `id gap at ${id}`);
for (const piece of pieces) expect(!piece.includes(" "), `raw space in ${JSON.stringify(piece)}`);

const byteBase = vocab["<0x00>"];
for (let b = 0; b < 256; b++) {
	expect(vocab[`<0x${b.toString(16).toUpperCase().padStart(2, "0")}>`] === byteBase + b, "byte-fallback ids");
}

const cps = (s: string) => [...s].length;
const reachable = new Set(merges.map(([a, b]) => a + b));
const live = (piece: string) => cps(piece) === 1 || reachable.has(piece);
for (const [a, b] of merges) expect(live(a) && live(b), `dead merge component in ${a} ${b}`);

// Top tier: every merge before the longest suffix sorted by (id(a+b), len a desc).
const key = ([a, b]: [string, string]) => [vocab[a + b], -cps(a)];
let tierEnd = merges.length - 1;
while (tierEnd > 0) {
	const [x0, l0] = key(merges[tierEnd - 1]);
	const [x1, l1] = key(merges[tierEnd]);
	if (x0 < x1 || (x0 === x1 && l0 < l1)) tierEnd--;
	else break;
}
const top = new Set(merges.slice(0, tierEnd).map(([a, b]) => a + b));
expect(top.size === TOP_TIER, `top tier ${top.size}`);

// Rebuild the merge list from the vocabulary and the tier, as the engine does.
const rebuilt: { a: string; b: string; k: number[] }[] = [];
for (const x of reachable) {
	const chars = [...x];
	for (let i = 1; i < chars.length; i++) {
		const a = chars.slice(0, i).join("");
		const b = chars.slice(i).join("");
		if (!live(a) || !live(b) || vocab[a] === undefined || vocab[b] === undefined) continue;
		const k = top.has(x) ? [0, -i, -(chars.length - i), vocab[x], vocab[a], vocab[b]] : [1, vocab[x], -i, 0, 0, 0];
		rebuilt.push({ a, b, k });
	}
}
rebuilt.sort((p, q) => {
	for (let i = 0; i < 6; i++) if (p.k[i] !== q.k[i]) return p.k[i] - q.k[i];
	return 0;
});
expect(rebuilt.length === merges.length, `rebuilt ${rebuilt.length} merges`);
for (let r = 0; r < merges.length; r++) {
	expect(rebuilt[r].a === merges[r][0] && rebuilt[r].b === merges[r][1], `rebuilt merge ${r} differs`);
}

// Stored pieces, '▁' as ' '; dead multi-codepoint pieces empty.
const stored = pieces.map(p => (live(p) ? p.replaceAll("▁", " ") : ""));

// Segment boundaries the engine cuts at must lie inside no stored piece.
for (const p of stored) {
	const chars = [...p];
	for (let i = 1; i < chars.length; i++) {
		const [prev, c] = [chars[i - 1], chars[i]];
		expect(!(c === " " && prev !== " " && prev !== ">"), `piece ${JSON.stringify(p)} spans a space boundary`);
		expect((c === "\n") === (prev === "\n"), `piece ${JSON.stringify(p)} spans a newline boundary`);
	}
}

const enc = new TextEncoder();
const parts: Uint8Array[] = [enc.encode("GEMMA1\n")];
const u32 = (v: number) => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, v, true);
	return out;
};
parts.push(u32(VOCAB_SIZE), u32(byteBase), u32(top.size));
for (const id of [...top].map(x => vocab[x]).sort((a, b) => a - b)) parts.push(u32(id));
for (const p of stored) {
	const bytes = enc.encode(p);
	let len = bytes.length;
	const varint: number[] = [];
	do {
		varint.push(len >= 0x80 ? (len & 0x7f) | 0x80 : len);
		len >>>= 7;
	} while (len > 0);
	parts.push(new Uint8Array(varint), bytes);
}
const raw = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
{
	let off = 0;
	for (const p of parts) {
		raw.set(p, off);
		off += p.length;
	}
}

const packed = Bun.zstdCompressSync(raw, { level: 19 });
await Bun.write(OUT, packed);
const dead = stored.filter(p => p === "").length;
console.log(
	`gemma4: ${VOCAB_SIZE} entries (${dead} dead slots emptied, ${top.size} top-tier), ${merges.length} merges rebuilt exactly, raw ${raw.length} B -> ${packed.length} B zstd`,
);
