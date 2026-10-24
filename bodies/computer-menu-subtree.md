## What

I made named-menu reads include the nested commands so the agent doesn't have to discover the same menu one level at a time.

Menu-walking tasks went from 1.00× → 0.81× model turns across nine task-legs, with every run passing in both arms.

`menu.items(path)` now returns exposed descendants depth-first with full paths. No-path reads still return only the menu bar. Disabled or unreadable submenus remain discoverable, and cancellation still propagates. Expansion fits whole submenu levels within 150 items; the requested menu's own items are never dropped.

## Why

Moving a reminder through Edit > List > Local > Errands needed a separate read for each level. Returning those paths together removes discovery turns without changing command selection.

**Maintainer decision:** expand by default, or require `menu.items(path, {depth})`. I recommend this PR's default: the model need not discover a new option, while the expansion bound limits large-menu output. Lazy or oversized submenus remain available through an explicit path read. Linux AT-SPI and Windows HMENU/UIA already resolve nested paths; expansion can only return what each app exposes. This does not open lazy menus to populate them.

## Testing

- `bun test packages/coding-agent/test/tools/computer.test.ts`: 131 passed, including Python, nested paths, exact/oversized limits and operational failures. Removing expansion fails the nested-path test; restoring catch-all error handling fails the user-intervention test.
- Root `bun run check:ts` passed on Linux, including lint, formatting and all package type checks (two unrelated existing warnings). Full `bun check` was not run.
- Isolated, no-tools main/branch samples with Haiku 5.5 and GPT-6.1 Sol: both read Edit first; after the corresponding result, both controls requested List while both variants selected the full Errands path. No desktop input ran.
- Live benchmark: GPT-6.1 Sol medium on macOS 26.5 VMs cloned from one frozen seed; control and variant in each leg, three runs per arm/task in ABBA order. Turns count tool-call model round trips. Effects use the geometric mean of per-task median ratios with bootstrap 95% intervals. All runs passed. The private harness has no public rerun command; executable regression coverage is the unit-test command above.

| Measurement | Variant/control |
| --- | --- |
| Menu-task turns, nine task-legs | 0.81× [0.75–0.96] |
| Menu-task tokens, nine task-legs | 0.85× [0.76–0.99] |
| Menu-task wall time, nine task-legs | 0.88× [0.76–1.00] |
| All-task turns, sixteen task-legs | 0.90× [0.84–0.99] |

Unchanged-build spread was 0.95× [0.85–1.10] across seven tasks; random four-task subsets ranged 0.84–1.05. Benchmark menus stayed below the bound; the port additionally refuses expansion of a whole level that would exceed it. Windows/Linux native UI was not run here; their nested-path implementations were inspected.

<details>
<summary>Model-facing wording</summary>

Before: “lists native menu items”.

After: “with a path that menu's items and exposed descendants depth-first, every item with its full `path`”, with the 150-item expansion boundary and explicit-path fallback documented.
</details>

---

- [ ] `bun check` passes
- [x] Tested locally
- [ ] CHANGELOG updated with the required attribution (PR link and contributor credit are added after creation)
