## What

I made the Factory Droid Gemini schema copier send a union whose branches have different types as an `anyOf`, instead of merging them into one invalid schema.

The copier merged every `anyOf`/`oneOf` branch into one schema. For `string | string[]` (the `task` tool's `model` field) the first type won and the array branch added its `items`, giving `{ type: "string", items: { type: "string" } }`, which Gemini rejects. Now:

- Typed branches of different types go out as `anyOf`, with a `null` branch folded into `nullable: true` and any `required` name a branch does not define dropped.
- The proxy rejects `anyOf` next to other structural fields, so when the node has its own `type` or `properties`, the copier keeps only the branches of that type, or merges them as before if none match.
- Same-type unions and untyped branches merge exactly as before.

Factory's `droid` CLI also keeps such unions as `anyOf` (`convertJsonSchemaToGeminiSchema`), though it keeps `null` as a member and same-type unions as `anyOf` too; this change stays closer to the existing copier.

## Why

The default toolset includes `task`, so every Factory Droid Gemini turn failed before the model ran:

```
Factory Gemini generate failed (400): … `task` functionDeclaration `parameters.tasks.model`
schema specified incorrect schema type field. For schema with items, schema type should be ARRAY.
```

The union merge dates from v18.4.5; the `task` schema has carried `model: string | string[]` in v18.5.0–v18.8.1 and again since v18.11.3, so those releases hit it. The Gemini API and Vertex keep the `anyOf` (`parametersJsonSchema`) and Cloud Code Assist collapses it to `string`; neither is affected.

Two other built-in shapes change the same way, and Factory accepts both: `task`'s `outputSchema` (`object | boolean | string | null`, previously `{type: object}`) and the hidden `yield` tool's `type`.

| Input | Before | After |
|---|---|---|
| `anyOf: [string, array<string>, null]` | `{type: string, items, nullable: false}` (400) | `{anyOf: [string, array<string>], nullable: true}` |
| `{type: object, properties, anyOf: [string, integer]}` | `{type: object, properties}` | unchanged |
| `{type: string, anyOf: [string, array<string>]}` | `{type: string, items}` (400) | `{type: string}` |
| `anyOf` of object branches, or with an untyped branch | merged | unchanged |

## Testing

- New `normalizeSchemaForFactoryDroid` cases cover each row above and a branch `required` without `properties`; they fail on `main`.
- `bun test packages/ai` and `bun run check:ts` pass; full `bun check` was not run.
- Live on Factory Droid `gemini-3-flash-preview`: a default-toolset turn returned the 400 on `main` and finishes here. A probe tool with each table shape (and the `required`-without-`properties` branch) is accepted; the old `string`-with-`items` shape still gets the 400 as a control.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
