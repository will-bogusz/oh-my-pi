# Changelog

## [Unreleased]

### Changed

- Renamed the extension's display name to **Oh My Pi**. Existing installations keep their current name unless `omp browser-relay install --name "Oh My Pi"` is passed, so a refresh never silently changes the debugger warning a loaded copy shows.

### Fixed

- The extension now hands its `chrome.debugger` attachments back instead of holding them for a whole session, so Chrome's "started debugging this browser" bar no longer outlives the work that caused it. Attachments are released when the host ends a task or turn, when the relay socket stays closed for two seconds, and when Chrome unloads the extension's worker; the next command reattaches and restores the tab's root debugger state.
- When the relay is gone for good — its socket stays closed past the reconnect grace — the extension now hands the tabs it was driving back by itself: it restores their favicons over the still-live attachment and takes them out of the groups it created, so a killed or crashed relay no longer leaves tabs marked, grouped and owned by nothing.
- Selecting a tab no longer implies raising its window: the relay can put the user's own tab back after Chrome opens a `target="_blank"` child without touching window focus.
- Documents whose favicon Chrome will not re-read, such as PDFs in its built-in viewer, are no longer badged; a PDF tab kept after a task used to wear the cursor glyph permanently.

## [18.0.7] - 2026-08-26

### Changed

- Clarified the scope of the two browser relay opt-in paths: per-call `app.relay: true` enables relay access for an individual call, while the `browser.relay` setting enables it by default across projects in a profile.

## [17.2.5] - 2026-08-03

### Added

- Initial release of the Chrome MV3 extension, enabling the omp browser tool to attach to and drive existing browser tabs via chrome.debugger.
- Added automatic, robust tab management that groups active agent-driven tabs into a dedicated per-window "omp" tab group and ensures clean dissolution upon disconnect.
