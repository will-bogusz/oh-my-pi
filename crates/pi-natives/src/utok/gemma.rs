//! Gemma 4 vocabulary (`google/gemma-4-E4B-it` `tokenizer.json`), the
//! vocabulary Google's Gemini SDK `LocalTokenizer` counts Gemini 2.x+ in.
//!
//! The model is SentencePiece-style BPE over codepoints with byte fallback:
//!
//! 1. Normalize ' ' to '▁' (stored here as ' '; input '▁' maps to it too). The
//!    tokenizer's `Split(' ')` pre-tokenizer never matches after that, so the
//!    whole text is one BPE word.
//! 2. Seed one symbol per codepoint; a codepoint outside the vocabulary becomes
//!    one `<0xXX>` byte token per UTF-8 byte and never merges.
//! 3. Repeatedly merge the adjacent pair with the lowest merge rank, leftmost
//!    first (HF `tokenizers` `Word::merge_all`).
//!
//! No merges list is embedded: the 514,906 merges are every split of every
//! merge-reachable piece into two vocabulary pieces, ranked by a 91-piece
//! top tier (whitespace runs and '▁t') and then by piece id, ties by longer
//! left half (`tools/pack-gemma.ts` proves the rebuild exact). The table is
//! rebuilt from the vocabulary on first use.
//!
//! Merging the whole text at once is quadratic, so it is cut into segments
//! no vocabulary piece spans: before a space that follows a non-space other
//! than '>' (only `>▁</` holds a space after another character), and at
//! each edge of a '\n' run (newlines occur only in pure runs). The pack
//! asserts both properties; merges never cross a cut, so the segments
//! tokenize independently.
//!
//! Added tokens (`<bos>`, `<|turn>`, `<unused0>`, …) are not matched in
//! text: like every utok family this counts ordinary content.

use std::{
	cmp::Reverse,
	collections::{BinaryHeap, HashMap},
	hash::{BuildHasherDefault, Hasher},
	sync::LazyLock,
};

use crate::utok::{
	bpe::{Fx, PieceMemo, next_table_id, read_token},
	utf::Unit,
};

/// Segments longer than this many symbols merge through
/// [`Gemma::merge_long`]; the linear rescan is quadratic in length.
const LONG_SEGMENT: usize = 64;

/// No symbol / no merge.
const NONE: u32 = u32::MAX;

/// Multiplicative hash for the `(left << 32 | right)` pair keys.
#[derive(Default)]
struct PairHasher(u64);

impl Hasher for PairHasher {
	fn write(&mut self, bytes: &[u8]) {
		for &b in bytes {
			self.0 = (self.0.rotate_left(8) ^ u64::from(b)).wrapping_mul(0x9e37_79b9_7f4a_7c15);
		}
	}

	#[inline]
	fn write_u64(&mut self, key: u64) {
		self.0 = key;
	}

	#[inline]
	fn write_u32(&mut self, key: u32) {
		self.0 = u64::from(key);
	}

	#[inline]
	fn finish(&self) -> u64 {
		let h = self.0.wrapping_mul(0x9e37_79b9_7f4a_7c15);
		h ^ (h >> 32)
	}
}

type PairMap<K, V> = HashMap<K, V, BuildHasherDefault<PairHasher>>;

/// The merge a pair of adjacent symbols takes part in.
#[derive(Clone, Copy)]
struct Merge {
	/// Position in the merges list; lower merges first.
	rank: u32,
	/// The merged piece's id.
	id:   u32,
}

const NO_MERGE: Merge = Merge { rank: NONE, id: NONE };

pub struct Gemma {
	/// Symbol id of each BMP codepoint (`NONE`: byte fallback).
	bmp:       Box<[u32]>,
	/// Symbol ids of astral codepoints in the vocabulary.
	astral:    PairMap<u32, u32>,
	/// `(left << 32 | right)` → the merge of that adjacent pair.
	merges:    PairMap<u64, Merge>,
	/// Id of `<0x00>`; byte-fallback ids follow contiguously.
	byte_base: u32,
	/// This table's name in [`PieceMemo`] slots.
	memo_id:   u32,
}

static GEMMA4: LazyLock<Gemma> =
	LazyLock::new(|| Gemma::parse(include_bytes!("../../data/gemma4.bin.zst")));

/// One output step of [`Gemma::tokenize`], in text order.
enum Out<'a> {
	/// An unmerged segment: its seed symbols and, up to 16 bytes, its
	/// normalized UTF-8 text (longer text is cut short and never memoized).
	Segment { syms: &'a mut Vec<u32>, text: &'a [u8] },
	/// A codepoint outside the vocabulary: one byte token per UTF-8 byte.
	Fallback(char),
}

/// Content token count of `units` in the Gemma 4 vocabulary.
///
/// Segment counts go through the per-thread [`PieceMemo`]: words recur,
/// and a hit skips the merge loop.
pub fn content_token_count<U: Unit>(units: &[U]) -> u32 {
	let gemma = &*GEMMA4;
	let mut scratch = Vec::with_capacity(LONG_SEGMENT);
	let mut n = 0usize;
	PieceMemo::with(|memo| {
		gemma.tokenize(units, |out| match out {
			Out::Segment { syms, text } => {
				n += memo.count(text, gemma.memo_id, || {
					gemma.merge(syms, &mut scratch);
					syms.len() as u32
				}) as usize;
			},
			Out::Fallback(c) => n += c.len_utf8(),
		});
	});
	u32::try_from(n).unwrap_or(u32::MAX)
}

/// Gemma 4 token ids of `units` (no `<bos>`, no added-token matching).
pub fn encode<U: Unit>(units: &[U]) -> Vec<u32> {
	let gemma = &*GEMMA4;
	let mut scratch = Vec::with_capacity(LONG_SEGMENT);
	let mut ids = Vec::with_capacity(units.len() / 3);
	gemma.tokenize(units, |out| match out {
		Out::Segment { syms, .. } => {
			gemma.merge(syms, &mut scratch);
			ids.extend_from_slice(syms);
		},
		Out::Fallback(c) => {
			let mut buf = [0u8; 4];
			ids.extend(
				c.encode_utf8(&mut buf)
					.bytes()
					.map(|b| gemma.byte_base + u32::from(b)),
			);
		},
	});
	ids
}

impl Gemma {
	/// Parse the GEMMA1 blob (see `tools/pack-gemma.ts`) and rebuild the
	/// merges. Panics on malformed data: the blob is compile-time embedded.
	fn parse(zst: &[u8]) -> Self {
		let raw = zstd::decode_all(zst).expect("utoken: zstd decode failed");
		let mut p = raw
			.strip_prefix(b"GEMMA1\n")
			.expect("utoken: bad gemma magic");
		let mut word = || {
			let (&w, rest) = p
				.split_first_chunk::<4>()
				.expect("utoken: truncated gemma header");
			p = rest;
			u32::from_le_bytes(w)
		};
		let n = word();
		let byte_base = word();
		let top_n = word();
		let mut top = vec![false; n as usize];
		for _ in 0..top_n {
			top[word() as usize] = true;
		}
		let pieces: Vec<&str> = (0..n)
			.map(|_| {
				std::str::from_utf8(read_token(&mut p)).expect("utoken: gemma piece is not UTF-8")
			})
			.collect();
		assert!(p.is_empty(), "utoken: trailing bytes in gemma blob");

		let mut ids: HashMap<&str, u32, Fx> =
			HashMap::with_capacity_and_hasher(pieces.len(), Fx::default());
		let mut bmp = vec![NONE; 0x1_0000].into_boxed_slice();
		let mut astral = PairMap::default();
		for (id, &piece) in (0u32..).zip(&pieces) {
			if piece.is_empty() {
				continue;
			}
			ids.insert(piece, id);
			let mut chars = piece.chars();
			if let (Some(c), None) = (chars.next(), chars.next()) {
				let cp = c as u32;
				if cp < 0x1_0000 {
					bmp[cp as usize] = id;
				} else {
					astral.insert(cp, id);
				}
			}
		}
		// Input '▁' is the normalizer's output for ' ': the same symbol.
		bmp[0x2581] = bmp[usize::from(b' ')];

		// Every split of every merged piece into two live pieces, in HF
		// merge order: the top tier first, sorted by (left len desc, right
		// len desc, piece, left, right); then every other piece in id order,
		// its splits by left len desc. Lengths are codepoints.
		let mut top_pairs: Vec<(u32, u32, u32, u32, u32)> = Vec::new();
		let mut rest: Vec<(u32, u32, u32)> = Vec::with_capacity(520_000);
		for (x, &piece) in (0u32..).zip(&pieces) {
			let total = piece.chars().count() as u32;
			if total < 2 {
				continue;
			}
			let first = rest.len();
			for (left_len, (at, _)) in (0u32..).zip(piece.char_indices()).skip(1) {
				let (Some(&a), Some(&b)) = (ids.get(&piece[..at]), ids.get(&piece[at..])) else {
					continue;
				};
				if top[x as usize] {
					top_pairs.push((u32::MAX - left_len, u32::MAX - (total - left_len), x, a, b));
				} else {
					rest.push((a, b, x));
				}
			}
			rest[first..].reverse();
		}
		top_pairs.sort_unstable();
		let mut merges =
			PairMap::with_capacity_and_hasher(top_pairs.len() + rest.len(), Default::default());
		let ordered = top_pairs.iter().map(|&(.., x, a, b)| (a, b, x)).chain(rest);
		for (rank, (a, b, id)) in (0u32..).zip(ordered) {
			merges.insert(u64::from(a) << 32 | u64::from(b), Merge { rank, id });
		}
		Self { bmp, astral, merges, byte_base, memo_id: next_table_id() }
	}

	#[inline]
	fn symbol(&self, c: char) -> u32 {
		let cp = c as u32;
		if cp < 0x1_0000 {
			self.bmp[cp as usize]
		} else {
			self.astral.get(&cp).copied().unwrap_or(NONE)
		}
	}

	#[inline]
	fn merge_of(&self, left: u32, right: u32) -> Merge {
		self
			.merges
			.get(&(u64::from(left) << 32 | u64::from(right)))
			.copied()
			.unwrap_or(NO_MERGE)
	}

	/// Segment and seed `units`, emitting each segment and each
	/// out-of-vocabulary codepoint in text order.
	fn tokenize<U: Unit>(&self, units: &[U], mut emit: impl FnMut(Out<'_>)) {
		let mut seg: Vec<u32> = Vec::with_capacity(LONG_SEGMENT);
		let mut text: Vec<u8> = Vec::with_capacity(20);
		let mut prev = '\0';
		let mut i = 0;
		while i < units.len() {
			let (c, len) = U::decode(units, i);
			i += len;
			let c = if c == '\u{2581}' { ' ' } else { c };
			let cut = match c {
				' ' => prev != ' ' && prev != '>',
				'\n' => prev != '\n',
				_ => prev == '\n',
			};
			prev = c;
			let id = self.symbol(c);
			if (cut || id == NONE) && !seg.is_empty() {
				emit(Out::Segment { syms: &mut seg, text: &text });
				seg.clear();
				text.clear();
			}
			if id == NONE {
				emit(Out::Fallback(c));
			} else {
				seg.push(id);
				if text.len() <= 15 {
					let mut buf = [0u8; 4];
					text.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
				}
			}
		}
		if !seg.is_empty() {
			emit(Out::Segment { syms: &mut seg, text: &text });
		}
	}

	/// Merge `syms` in place to its final ids: the lowest-rank adjacent
	/// pair first, leftmost among equals.
	fn merge(&self, syms: &mut Vec<u32>, merges: &mut Vec<Merge>) {
		if syms.len() > LONG_SEGMENT {
			return self.merge_long(syms);
		}
		merges.clear();
		merges.extend(syms.array_windows::<2>().map(|&[a, b]| self.merge_of(a, b)));
		loop {
			let mut best = NONE;
			let mut at = 0;
			for (k, m) in merges.iter().enumerate() {
				if m.rank < best {
					best = m.rank;
					at = k;
				}
			}
			if best == NONE {
				return;
			}
			syms[at] = merges[at].id;
			syms.remove(at + 1);
			merges.remove(at);
			if at > 0 {
				merges[at - 1] = self.merge_of(syms[at - 1], syms[at]);
			}
			if at < merges.len() {
				merges[at] = self.merge_of(syms[at], syms[at + 1]);
			}
		}
	}

	/// [`merge`](Self::merge) in O(n log n): pending pairs sit in a min-heap
	/// keyed by (rank, position), so the lowest rank merges first and the
	/// leftmost among equals, as the rescan picks. Entries a merge changed
	/// go stale and are skipped when popped.
	fn merge_long(&self, syms: &mut Vec<u32>) {
		let len = syms.len();
		let end = len as u32;
		// Symbols are named by their seed position; `next[s]` is the symbol
		// after `s` (`end` past the last), `prev[s]` the one before it, and
		// `rank[s]` the rank of merging `s` with its successor.
		let mut next: Vec<u32> = (1..=end).collect();
		let mut prev: Vec<u32> = (0..end).map(|s| s.checked_sub(1).unwrap_or(NONE)).collect();
		let mut rank = vec![NONE; len];
		let mut heap = BinaryHeap::with_capacity(len);
		for (s, &[a, b]) in (0u32..).zip(syms.array_windows::<2>()) {
			let r = self.merge_of(a, b).rank;
			rank[s as usize] = r;
			if r != NONE {
				heap.push(Reverse((r, s)));
			}
		}
		while let Some(Reverse((r, s))) = heap.pop() {
			let si = s as usize;
			if rank[si] != r {
				continue;
			}
			let absorbed = next[si] as usize;
			syms[si] = self.merge_of(syms[si], syms[absorbed]).id;
			syms[absorbed] = NONE;
			rank[absorbed] = NONE;
			next[si] = next[absorbed];
			let after = next[si];
			if after < end {
				prev[after as usize] = s;
				rank[si] = self.merge_of(syms[si], syms[after as usize]).rank;
				if rank[si] != NONE {
					heap.push(Reverse((rank[si], s)));
				}
			} else {
				rank[si] = NONE;
			}
			let before = prev[si];
			if before != NONE {
				let bi = before as usize;
				rank[bi] = self.merge_of(syms[bi], syms[si]).rank;
				if rank[bi] != NONE {
					heap.push(Reverse((rank[bi], before)));
				}
			}
		}
		syms.retain(|&id| id != NONE);
	}
}
