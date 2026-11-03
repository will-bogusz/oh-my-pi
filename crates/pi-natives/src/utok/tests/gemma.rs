//! Golden-fixture test: Gemma 4 vs reference HF tokenizers encode with
//! added-token matching off (`tools/gen-gemma-fixtures.py`), covering space
//! normalization, whitespace-run tiers, byte fallback, the segment cuts
//! and the long-segment heap merge.

use crate::utok::Encoding;

fn fixture_texts() -> Vec<(String, Vec<u32>)> {
	let raw = include_str!("../../../fixtures/gemma4.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	let cases = fixture["cases"].as_array().expect("cases array");
	assert!(!cases.is_empty());
	cases
		.iter()
		.map(|case| {
			let ids: Vec<u32> = case["ids"]
				.as_array()
				.expect("ids")
				.iter()
				.map(|v| v.as_u64().expect("id") as u32)
				.collect();
			assert_eq!(case["count"].as_u64(), Some(ids.len() as u64), "fixture self-consistency");
			(case["text"].as_str().expect("text").to_owned(), ids)
		})
		.collect()
}

#[test]
fn gemma4_matches_reference() {
	for (text, want) in fixture_texts() {
		assert_eq!(
			Encoding::Gemma4.encode(text.as_str()),
			Some(want.clone()),
			"encode mismatch on {text:?}"
		);
		assert_eq!(
			Encoding::Gemma4.count(text.as_str()),
			want.len() as u32,
			"count mismatch on {text:?}"
		);
	}
}

#[test]
fn gemma4_utf16_utf32_parity() {
	for (text, want) in fixture_texts() {
		let u16s: Vec<u16> = text.encode_utf16().collect();
		let u32s: Vec<u32> = text.chars().map(|c| c as u32).collect();
		assert_eq!(Encoding::Gemma4.encode(u16s.as_slice()), Some(want.clone()), "utf16 on {text:?}");
		assert_eq!(Encoding::Gemma4.encode(u32s.as_slice()), Some(want.clone()), "utf32 on {text:?}");
		assert_eq!(
			Encoding::Gemma4.count(u16s.as_slice()),
			want.len() as u32,
			"utf16 count on {text:?}"
		);
		assert_eq!(
			Encoding::Gemma4.count(u32s.as_slice()),
			want.len() as u32,
			"utf32 count on {text:?}"
		);
	}
}
