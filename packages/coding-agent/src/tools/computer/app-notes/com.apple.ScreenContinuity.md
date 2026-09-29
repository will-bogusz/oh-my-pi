### iPhone Mirroring

The window shows the iPhone's pixels only: there is no accessibility tree for iOS content. Work from screenshots.

- Scroll with `win.scroll("down", { target: [x, y], delivery: "foreground" })`, the target inside the list or view that should move. It takes focus for about a second and moves the real pointer, then puts both back. A background scroll does not reach this window.
- Distance: `{ by: "page" }` moves about 0.8 of the visible height; `{ amount: 300, by: "points" }` moves 300 points. The default is one 40-point line.
- The reply's first line is what the view measurably did: `✓ Scrolled down 231 pt at (163, 400)` moved; `✓ At end: …` reached the end, so stop repeating; `✗ No motion at …` nothing under that point scrolls with the wheel; `? Changed in place …` a pager, sheet or navigation changed the screen.
- After a scroll that moved the view, take a new screenshot before clicking anything: coordinates from the old frame now point at different content.
- Do not drag to scroll: vertical drags never scroll here. Horizontal drags on list rows open the row's swipe actions.
- Page Down, arrow keys and Space do not scroll. Shift+scroll does not scroll sideways; use `scroll("left" | "right", { target: [x, y], delivery: "foreground" })` on the row itself.
- Photo pagers and carousels that do not move with the wheel page by tapping their left or right edge.
- Home Screen: ⌘1 (`press("cmd+1", { delivery: "foreground" })`). App Switcher: ⌘2. Spotlight: ⌘3. The View menu has the same commands.
- Tap icons at their centre, not their label.
- If the window says the connection is paused, click its Connect button and wait about 5 seconds. Unlocking the phone ends the session.
