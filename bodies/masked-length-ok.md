## What

I made `setValue` succeed when a password field reads back as a mask as long as the text written, instead of failing although the text landed.

The read-back verdict accepts one mask character per Unicode character or UTF-16 unit, whatever role the field reports. A mask of another length still fails without quoting the written text; unreadable values behave as before. Typed accessibility insertion uses the same verdict with no API or return-type change.

## Why

KeePassXC's Qt password field reports a plain text role and reads back bullets. Correct writes were reported as failures, inviting retries or abandonment of a write that worked.

| KeePassXC unlock field, five tries | before | earlier version |
|---|---|---|
| result | `AxFailed` 5/5 | returned with a note 5/5 |
| value landed, revealed with Control+H | 5/5 | 5/5 |

These counts were measured on the earlier version that also returned a note, with the verdict arm unchanged. This revision returns plain success; the note channel is removed.

## Testing

`cargo test -p pi-natives --lib -- a_same_length_mask a_different_length_mask an_unreadable_value`: the same-length regression fails on c0363292c8a and passes here. The other-length and unreadable-value guards pass on both. The tests assert failure codes and absence of the written text, not message wording. `rust-check --base c0363292c8a` passed for macOS and Linux; `rust-check --base c0363292c8a --windows` passed for Windows. No TypeScript remains in the diff.

## Limits

A matching mask length does not establish the hidden value's contents. The live counts above were not rerun on this revision.

Considered, not built: a done-but-unconfirmed note needs `set_value` to return one on every platform, which is the maintainer's call.

---

- [ ] `bun check` passes (no TypeScript changes)
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (PR link and contributor credit are added after creation)
