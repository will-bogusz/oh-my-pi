# Our oh-my-pi PR queue

Rendered by `pr-queue` from `queue.json` with every write; last write 2026-11-03 00:12Z. Read-only: change the queue through `pr-queue` alone.

**Opening:** not paused
**Ready budget:** 0 of 8 ready events used in the hour before the last plan, 8 left (plan of 2026-11-03 00:10Z on MacBook-Pro; groups below are from it, states from the manifest)
**Counts:** openable now 2, conflict-held 6, stacked 8, held 8, open PRs 18; merged 210, closed 27

## Openable now (2)

| id | title | area | priority | age | plan | branch |
|---|---|---|---|---|---|---|
| factory-droid-110-pin | feat(ai,catalog): identify Factory Droid requests as droid 1.1.0 | providers | P1 | 20h | open | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/factory-droid-110-pin) |
| cli-reference-models-row | docs(coding-agent): restore the --models row in the CLI reference | other | P1 | 0h | open | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/cli-reference-models-row) |

## Conflict-held (6)

| id | title | area | priority | age | blocked by | branch |
|---|---|---|---|---|---|---|
| factory-droid-web-search | feat(coding-agent): search the web through a Factory Droid login (web/factory) | web | P2 | 15d | [#17862](https://github.com/can1357/oh-my-pi/pull/17862), main | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/factory-droid-web-search) |
| computer-ui-quiet | fix(computer): wait for the app to finish reacting before the next read or input | computer | P2 | 14d | [#15282](https://github.com/can1357/oh-my-pi/pull/15282) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/computer-ui-quiet) |
| compaction-trigger | feat(coding-agent): record what triggered each compaction | other |  | 13d | [#17747](https://github.com/can1357/oh-my-pi/pull/17747), [#17610](https://github.com/can1357/oh-my-pi/pull/17610), [#15128](https://github.com/can1357/oh-my-pi/pull/15128), [#15130](https://github.com/can1357/oh-my-pi/pull/15130), [#17496](https://github.com/can1357/oh-my-pi/pull/17496), main | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/compaction-trigger) |
| computer-menu-subtree | feat(coding-agent): find nested menu commands in one read | computer | P2 | 9d | [#15282](https://github.com/can1357/oh-my-pi/pull/15282) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/computer-menu-subtree) |
| iphone-mirror-scroll-distance | fix(natives): scroll iPhone Mirroring the whole distance asked for in the background | computer | P1 | 3d | [#17756](https://github.com/can1357/oh-my-pi/pull/17756) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/iphone-mirror-scroll-distance) |
| text-reader-usage-shift | fix(coding-agent): price a text-only fallback's archive text, not the failed request's frames, in the fit check | coding-agent |  | 2d | [#17747](https://github.com/can1357/oh-my-pi/pull/17747) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/text-reader-usage-shift) |

## Stacked (8)

| id | title | area | priority | age | needs | branch |
|---|---|---|---|---|---|---|
| computer-input-diff-report | feat(computer): report what input changed as a diff once the app goes quiet | computer | P2 | 20d | computer-ui-quiet | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/computer-input-diff-report) |
| r2/relay-own-only | fix(browser): attach only the relay tabs omp opened or borrowed | browser | P2 | 20d | [#15508](https://github.com/can1357/oh-my-pi/pull/15508), r2/relay-bg-input-main ([#17831](https://github.com/can1357/oh-my-pi/pull/17831)), r2/native-window-report | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/r2/relay-own-only) |
| r2/page-waiting | feat(coding-agent): make a browser dialog or held file chooser one pending state that page calls fail fast on | browser | P2 | 20d | r2/relay-own-only | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/r2/page-waiting) |
| r2/relay-turn-end-detach | fix(browser): release relay tabs from Chrome's debugger between turns | browser | P2 | 20d | r2/relay-popup-owned, r2/page-waiting | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/r2/relay-turn-end-detach) |
| r2/native-window-report | feat(coding-agent): name the native windows a browser call raised on macOS | browser | P2 | 20d | [#15508](https://github.com/can1357/oh-my-pi/pull/15508) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/r2/native-window-report) |
| r2/relay-popup-owned | fix(browser): own popups omp's relay tabs open and keep them behind the user's selection | browser | P2 | 20d | r2/relay-own-only | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/r2/relay-popup-owned) |
| computer-rich-text | feat(computer): read macOS text as Markdown with value({ format: "markdown" }) | computer | P2 | 20d | computer-ui-quiet, computer-ax-lines ([#15282](https://github.com/can1357/oh-my-pi/pull/15282)) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/computer-rich-text) |
| macos-scroll-direction | fix(natives): scroll down for a positive dy on macOS, as on Windows and Linux | computer | P2 | 3d | iphone-mirror-scroll-distance | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/macos-scroll-direction) |

## Held (8)

| id | title | area | priority | age | hold | branch |
|---|---|---|---|---|---|---|
| devin-billed-cost | feat(ai,catalog,coding-agent): show what each Devin turn billed to quota and overage | catalog |  | 20d | Will, 2026-10-22: parked; reopens only when Will asks | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/devin-billed-cost) |
| account-window-reserves | feat(ai,coding-agent): set account reserves per usage window | broker |  | 20d | Will, 2026-11-02: account-broker cluster on hold for redesign (Codex flagged codex-auto-reset.ts over 9 rounds on #15128); do not open or advance | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/account-window-reserves) |
| reset-account-optout | feat(ai,coding-agent): let an account policy turn saved-reset auto-redeem on or off | broker | P2 | 20d | Will, 2026-11-02: account-broker cluster on hold for redesign (Codex flagged codex-auto-reset.ts over 9 rounds on #15128); do not open or advance | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/reset-account-optout) |
| fallback-revert-when-healthy | feat(coding-agent): add retry.fallbackRevertPolicy when-healthy to return from usage fallbacks | broker | P2 | 20d | Will, 2026-11-02: account-broker cluster on hold for redesign (Codex flagged codex-auto-reset.ts over 9 rounds on #15128); do not open or advance | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/fallback-revert-when-healthy) |
| broker-reset-sweep | feat(coding-agent): spend saved resets from the auth broker before they expire | broker |  | 20d | Will, 2026-11-02: account-broker cluster on hold for redesign (Codex flagged codex-auto-reset.ts over 9 rounds on #15128); do not open or advance | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/broker-reset-sweep) |
| broker-sweep-clients-defer | feat(ai,coding-agent): stop sessions sweeping saved resets the auth broker already spends | broker |  | 20d | Will, 2026-11-02: account-broker cluster on hold for redesign (Codex flagged codex-auto-reset.ts over 9 rounds on #15128); do not open or advance | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/broker-sweep-clients-defer) |
| relay-popup-lossless | fix(browser): send the user's keys back to their app while Chrome activates for a popup omp's relay tab opens on macOS | browser | P1 | 15d | Main, 2026-11-02: rework in progress (honor PI_BROWSER_RELAY_KEEP_FRONT=0 for the key reroute) | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/relay-popup-lossless) |
| iphone-mirror-key-gap | perf(natives): type on iPhone Mirroring twice as fast | computer | P2 | 3d | Will, 2026-11-02: robustness of the 60 ms gap on a weak wireless link unmeasured | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/iphone-mirror-key-gap) |

## Open PRs (18)

| PR | id | title | area | rank | open | plan | branch |
|---|---|---|---|---|---|---|---|
| [#15128](https://github.com/can1357/oh-my-pi/pull/15128) | reset-restore-longest-wait | feat(coding-agent): restore the blocked account whose reset buys the most time | broker | P2 | 23d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/reset-restore-longest-wait) |
| [#15130](https://github.com/can1357/oh-my-pi/pull/15130) | reset-before-reserve | feat(coding-agent): opt in to spending a blocked account's saved reset before a reserve-only backup | broker | P2 | 23d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/reset-before-reserve) |
| [#15282](https://github.com/can1357/oh-my-pi/pull/15282) | computer-ax-lines | feat(natives): show what macOS ax() elements can do | computer | P2 | 23d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/computer-ax-lines) |
| [#15508](https://github.com/can1357/oh-my-pi/pull/15508) | print-hold | fix(coding-agent): keep browser calls going when a page calls window.print() | browser | P2 | 21d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/print-hold) |
| [#17831](https://github.com/can1357/oh-my-pi/pull/17831) | r2/relay-bg-input-main | fix(coding-agent): let background relay and app.cdp_url tabs take omp's clicks and keys | browser | P1 | 9h | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/r2/relay-bg-input-main) |
| [#16223](https://github.com/can1357/oh-my-pi/pull/16223) | computer-text-drag-select | feat(natives): make a macOS background drag across native text an accessibility selection | computer | P2 | 15d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/computer-text-drag-select) |
| [#16274](https://github.com/can1357/oh-my-pi/pull/16274) | read-after-bash-revalidate | fix(agent,coding-agent): re-read a file an earlier bash call changed in the same message | other | P1 | 14d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/read-after-bash-revalidate) |
| [#16553](https://github.com/can1357/oh-my-pi/pull/16553) | click-place-release | fix(natives): keep a macOS drag from the user's app onto the target the user's pick | natives-macos | P1 | 13d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/click-place-release) |
| [#16611](https://github.com/can1357/oh-my-pi/pull/16611) | read-audio-transcripts | feat(coding-agent): transcribe audio files and video soundtracks in read with a model that hears audio | catalog | P2 | 12d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/read-audio-transcripts) |
| [#16908](https://github.com/can1357/oh-my-pi/pull/16908) | relay-extension-frame | fix(browser-relay): keep a tab omp drives usable when a password manager's menu opens in it | browser | P2 | 10d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/relay-extension-frame) |
| [#17496](https://github.com/can1357/oh-my-pi/pull/17496) | cache-marker | feat(coding-agent): show whether the next message reads the prompt cache | status-line | P2 | 3d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/cache-marker) |
| [#17757](https://github.com/can1357/oh-my-pi/pull/17757) | macos-capture-geometry | fix(natives): match macOS window screenshots to the window on screen | computer | P0 | 20h | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/macos-capture-geometry) |
| [#17756](https://github.com/can1357/oh-my-pi/pull/17756) | iphone-mirror-pointer | fix(natives): keep background iPhone Mirroring taps reaching the phone after a takeover tap | computer | P1 | 20h | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/iphone-mirror-pointer) |
| [#17747](https://github.com/can1357/oh-my-pi/pull/17747) | switch-remote-reexpand | fix(agent,coding-agent): read the history behind an OpenAI remote compaction after a model switch | other | P1 | 21h | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/switch-remote-reexpand) |
| [#17610](https://github.com/can1357/oh-my-pi/pull/17610) | claude-refusal-strip-retry | fix(ai,coding-agent): carry other models' reasoning to Claude and retry its refusal without it | other | P2 | 2d | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/claude-refusal-strip-retry) |
| [#17862](https://github.com/can1357/oh-my-pi/pull/17862) | factory-droid-muse-spark-1-3 | feat(catalog): add Muse Spark 1.3 to Factory Droid | providers | P2 | 3h | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/factory-droid-muse-spark-1-3) |
| [#17861](https://github.com/can1357/oh-my-pi/pull/17861) | factory-droid-gemini-4-argon-110 | feat(ai,catalog,coding-agent): add Factory Droid Gemini 4 Argon with its request dialect | providers | P2 | 3h | keep | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/factory-droid-gemini-4-argon-110) |
| [#17773](https://github.com/can1357/oh-my-pi/pull/17773) | visuals-guidance | feat(coding-agent): ask for one designed SVG figure where an answer has shape | other |  | 19h | draft | [compare](https://github.com/can1357/oh-my-pi/compare/main...will-bogusz:oh-my-pi:will/visuals-guidance) |
