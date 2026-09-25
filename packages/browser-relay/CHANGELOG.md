# Changelog

## [Unreleased]

### Changed

- The extension now requests `scripting` and access to all sites, shown by Chrome as "Read and change all your data on all websites". It uses them only to empty other extensions' frames in a tab it is attaching to (see Fixed).
- Renamed the extension's display name to **Oh My Pi**. Existing installations keep their current name unless `omp browser-relay install --name "Oh My Pi"` is passed, so a refresh never silently changes the debugger warning a loaded copy shows.

### Fixed

- A password manager's inline autofill menu no longer takes a tab away from OMP. While the debugger is attached, a leased tab's documents carry the page opt-outs the vendors honour: `data-1p-ignore` on `<body>` (1Password), Dashlane's `dashlane/analysis` meta, and `data-bwignore` / `data-protonpass-ignore` on fields. The menu then stays closed for the agent, while the user's own tabs, and a leased tab once its debugger goes back, keep autofill. A vendor without an opt-out still makes Chrome drop the debugger once, but the reattach now succeeds: when Chrome refuses an attach over another extension's frame, the extension points every such frame at an empty document and retries.
- The extension now hands its `chrome.debugger` attachments back instead of holding them for a whole session, so Chrome's "started debugging this browser" bar no longer outlives the work that caused it. Attachments are released when the host ends a task or turn, when the relay socket stays closed for two seconds, and when Chrome unloads the extension's worker; the next command reattaches and restores the tab's root debugger state.
- When the relay is gone for good — its socket stays closed past the reconnect grace — the extension now hands the tabs it was driving back by itself: it restores their favicons over the still-live attachment and takes them out of the groups it created, so a killed or crashed relay no longer leaves tabs marked, grouped and owned by nothing.
- Selecting a tab no longer implies raising its window: the relay can put the user's own tab back after Chrome opens a `target="_blank"` child without touching window focus.
- Documents whose favicon Chrome will not re-read, such as PDFs in its built-in viewer, are no longer badged; a PDF tab kept after a task used to wear the cursor glyph permanently.

### Fixed

- Fixed browser relay support for multiple browser instances, such as Chrome and Edge, connected simultaneously. Each browser's stable instance id (the id it pairs with, sent in every hello) namespaces its tabs, target ids and relay requests, so equal tab numbers in two browsers never collide. Existing pairings keep working; a build that predates the field stays bound to the browser it authenticated as.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
