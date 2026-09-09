# @oh-my-pi/browser-relay

Chrome extension that lets omp's Eval `browser` API drive **your existing Chrome tabs** — logged-in sessions included — without relaunching Chrome with `--remote-debugging-port` (which Chrome 136+ refuses on the default profile anyway).

The companion relay server lives in the omp CLI (`omp browser-relay`, see `packages/coding-agent/src/tools/browser/relay/`). For each paired browser it publishes only acquired tabs through scoped CDP endpoints, synthesizes the browser target and `Target.*` hierarchy that `chrome.debugger` doesn't expose, and multiplexes any number of downstream puppeteer connections (omp opens one per tab worker) over the single debugger attachment Chrome allows per tab.

## Setup

Saved download paths are an optional capability. After updating the extension and OMP service, open extension settings and choose **Enable download file lookup** to grant Chrome's downloads permission. The same button can disable it. `tab.downloads({paths:true})` then returns bounded URL/time-matched file candidates for download IDs observed on the owned page. It does not read an unfiltered history into the agent, change where Chrome saves files, or automatically request permission. Multiple candidate files remain ambiguous; verify the actual file before claiming its destination.

1. `omp browser-relay install` — writes the bundled extension to `~/.omp/browser-relay/extension`, then load it via `chrome://extensions` → Developer mode → _Load unpacked_. (Or grab `omp-browser-relay-extension.zip` from GitHub releases.)
2. Run `omp browser-relay pair`. Click the extension's toolbar button to open its options, choose a browser name such as Work Chrome, and enter the one-use code (expires after ten minutes). Repeat in each Chrome profile you want to connect. Labels come from this setup; OMP does not inspect account email or guess profile names.
3. Opt in, one of two ways:
   - **Per call** — pass `app: { relay: true }` to `browser.open(...)` in Eval. Works without any setting and persists nothing: the configured default for every other call and session stays whatever it already was.
   - **As the default** — `omp config set browser.relay true` makes the relay the default for every session using this profile. An ordinary `browser.open(...)` creates a new inactive task tab; it does not adopt or navigate the current human tab.

That's it: the relay server auto-starts under omp's profile-independent global daemon broker the first time Eval's browser API needs it. Every relay consumer holds a broker lease, so one project exiting cannot interrupt another; the server stops after the last consumer across all projects exits. The extension badge turns **on** when connected. Run `omp browser-relay` manually for `--no-group` or a non-default port — a relay already serving the port is adopted, never fought over.

Use `await browser.discover()` for exact Chrome tab IDs, then `await browser.claim(id, {label})` to adopt one without navigation or grouping changes. `await browser.create({url, label})` creates an inactive task tab in the owner's group, titled `label` (default **Oh My Pi**) — one group per owner per window, reused by every later tab, never re-titled once it exists, so a group you renamed by hand stays renamed. A claimed tab of yours is never regrouped. Substring selection through `app.target` is rejected for this path. Ownership is exclusive to the calling actor.

While OMP holds a tab, its favicon is replaced by a cursor glyph so a background task tab is recognisable in the strip; the page's own icon comes back when the lease ends. Pages that refuse injection (`chrome://`, the Web Store, a strict `img-src` policy) simply keep their icon. `--no-group` turns off both the group and the glyph.

The returned handle supports `reveal()` (the explicit focus action) and release. Releasing is one wire action, `releaseTab`, with an explicit choice: `close: false` hands the page back to the user — out of the group, debugger detached, favicon restored, ownership dropped, page left exactly where it is — and `close: true` closes it. The tab always leaves the group *before* it closes, which is what stops Chrome from saving the emptied group as a chip in the bookmarks bar. After a full release the tab strip carries no OMP group and no chip.

A tab the browser opens from a leased tab (`target=_blank`, `window.open`, a native popup) is leased to the opener's owner in the opener's group; page script never claims anything. Ask for them with the `childTabs` action on the parent's lease and claim the exact child by its discovered id to drive it. Unclaimed children are handed back when the parent is released.

The broker recovers stale ownership five minutes after a lease stops being used, waiting for admitted commands to finish and preserving the physical page. Every operation on a lease (claim, get, dialog, childTabs, any command) rearms that window, and a live scoped connection suspends it entirely, so only a lease whose host died is reclaimed.

Chrome draws its "<extension> started debugging this browser" bar once per debugger attach and removes it about five seconds after the last detach, so the relay gives attachments back rather than holding them for a whole session. A tab loses its debugger when nothing drives it anymore, when the host ends a task or turn, when the relay socket closes for longer than two seconds, and when Chrome unloads the extension's worker. Ownership, page state and tab groups survive all of these; the next command reattaches, which shows the bar again. A tab with an open JavaScript dialog keeps its debugger, because nothing else can answer that dialog.

Custom ports use separate broker daemon identities, so testing another endpoint cannot replace the default service. After upgrading, use a separate endpoint while an older service still owns active work; update that service after its tasks finish.

For an independent installation alongside an older loaded extension, use `omp browser-relay install --dir /absolute/new/extension --port 9333 --name "Oh My Pi 9333"`, then load that directory in Chrome and run `omp browser-relay pair --port 9333`. A fresh installation uses that port for its first connection and in Options. Set `browser.relayUrl` to `http://127.0.0.1:9333` in the intended OMP settings scope. Updating an already configured extension preserves its profile-local saved port and pairing; changing that connection requires an explicit new pairing in Options. A different unpacked directory gives this keyless extension its own Chrome identity and storage, preserving an extension already installed elsewhere.

`--name` sets the extension's manifest name and toolbar settings title; surrounding whitespace is trimmed and empty names are rejected before files are written. Without it, the name remains **Oh My Pi**. This display name is separate from the browser label chosen during pairing and is not browser-instance identity. Use a distinct extension name for simultaneously loaded copies: Chromium compares debugger infobar message text, so identical manifest names can automatically cancel the newer debugger even with different extension IDs. Distinct names preserve the visible debugging warning; do not suppress the infobar or use silent-debugger flags. Another debugger already owning the same tab remains a conflict regardless of extension names.

## Development

- `bun run build` — bundles the extension into `dist/extension/`, zips it for GH releases, and regenerates the embedded CLI install assets under `packages/coding-agent/src/tools/browser/relay/extension-assets/` (**commit those**).
- `bun scripts/smoke.ts [relay-url] [browser-id]` — creates its own inactive scratch tab and checks the supervisor + tab-worker connection pattern, then releases that tab.

## Limitations

- `chrome://`, DevTools, Web Store, and other-extension pages are not attachable and are hidden from the agent.
- Chrome shows its "is debugging this browser" infobar while any tab is attached; dismissing it detaches that tab until it navigates again.
- A tab with DevTools open can't be attached (one debugger per tab — the constraint the relay multiplexes around for its own clients).
- The service binds loopback and rejects browser-origin control requests. Local discovery, acquisition, pairing and lifecycle operations require a private credential stored in a mode-0600 endpoint file. Extension credentials are separate, paired once, and stored hashed on the service. Worker CDP and popup creation use random exact-tab capabilities. This protects against unauthenticated local/network clients; arbitrary programs running as your OS user can read its credentials and are not sandboxed.

Multiple paired profiles can share an endpoint. `browser.instances()` lists exact IDs, setup names and connection state; `browser.discover({browserId})` filters tabs. Pass `browserId` to `create` when more than one profile is connected. Exact discovered tab IDs already route `claim` to the right instance. Reconnecting one profile invalidates only that profile’s handles; other instances keep their sessions and ownership.

`omp browser-relay list` lists paired profiles; `omp browser-relay unpair --id <exact-id>` revokes one profile without closing its tabs. To recover a lost extension credential, unpair its old record, generate a fresh code, and enter it in extension options. For another endpoint, use `pair --port <port>` and set the same port under extension options. A fresh code deliberately replaces the extension’s previous endpoint credential; the previous service keeps its offline record until explicitly unpaired.
