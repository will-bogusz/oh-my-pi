# Generate fixtures/gemma4.json from the reference HF tokenizer.
# Run: uv run --with tokenizers tools/gen-gemma-fixtures.py
#
# Reference: tools/cache/gemma-4.tokenizer.json (see tools/pack-gemma.ts for
# the pinned revision) with its added tokens dropped, so `<bos>`, `<|turn>`
# and the other specials are not matched in text: utok counts ordinary
# content, never chat-template markup.
import json
import os

from tokenizers import Tokenizer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, "tools/cache/gemma-4.tokenizer.json")) as f:
    spec = json.load(f)
spec["added_tokens"] = []
tok = Tokenizer.from_str(json.dumps(spec))

with open(os.path.join(ROOT, "fixtures/corpus.json")) as f:
    texts = json.load(f)

texts += [
    # Space normalization: ' ' and a literal '▁' are the same symbol.
    " ",
    "▁",
    "a▁b a b",
    "  leading and trailing  ",
    # Whitespace runs: the top merge tier (pure '\n' / '▁' / '\t' runs,
    # up to 31 long), with runs past the longest piece.
    "\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n",
    " " * 70 + "x",
    "\t" * 45 + "y",
    "a\n\n b\n \n\tc\r\n\r\nd",
    "    def f(x):\n        return x  # two spaces\n",
    # '>▁</' is the one piece holding a space after another character.
    "<b>bold</b> <i> </i> > </ x> </y",
    # Specials and unused pieces are plain text here.
    "<bos><eos><|turn>user\nhi<turn|><unused0><mask>[multimodal]",
    "<table><tr><td>cell</td></tr></table>",
    # Digits split singly; punctuation runs.
    "1234567890 3.14159 1,000,000 0x7fff_ffff",
    "!!!??? ... --- === *** ```js\n```",
    # Byte fallback: codepoints outside the vocabulary.
    "\x00\x01\x7f \U0010ffff \U000e0001 \ufffe",
    "𓀀𓀁 𐌰𐌱 🫨🪿 👨‍👩‍👧‍👦 🇺🇸",
    # Multilingual.
    "深度学习模型的训练需要大量的计算资源和高质量的数据集。",
    "日本語のテキストとカタカナ、ひらがな。",
    "한국어 텍스트입니다.",
    "Привет, мир! Ελληνικά. עברית. العربية. हिन्दी. ไทย.",
    "naïve café résumé Ångström ế ộ",
    "cafe\u0301 A\u030angstro\u0308m",
    # Long unspaced runs: the heap merge path (> 64 symbols).
    "a" * 300,
    "abcdefghij" * 20,
    "中文" * 60,
    "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6" * 3,
]

seen = set()
ordered = []
for t in texts:
    if t not in seen:
        seen.add(t)
        ordered.append(t)

cases = []
for text in ordered:
    ids = tok.encode(text, add_special_tokens=False).ids
    cases.append({"text": text, "ids": ids, "count": len(ids)})

out = {
    "generator": "tools/gen-gemma-fixtures.py: HF tokenizers Tokenizer.from_str(tools/cache/gemma-4.tokenizer.json with added_tokens=[]).encode(text, add_special_tokens=False)",
    "cases": cases,
}
with open(os.path.join(ROOT, "fixtures/gemma4.json"), "w") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(cases)} cases, total {sum(c['count'] for c in cases)} tokens")
