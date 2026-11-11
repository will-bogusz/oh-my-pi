## What

I wanted `press()` on a disabled control to fail and say so, instead of reporting a press that did nothing.

A disabled AppKit button still lists `AXPress` among its actions and answers it with success while its action never runs, so on main `el.press()` on it returned normally and the agent went on as if the button had worked. `ax()` already marked the element `(disabled)`; the press path never read `AXEnabled`.

Now the action chooser (`choose_action`) refuses a press of an element whose `AXEnabled` is false with `AxFailed` ("the element reports itself disabled, so nothing was sent: wait for it to become enabled, or do what enables it first"), before anything is sent. Only the press is gated: a scroll into view, a menu, a raise and every other action still go to a disabled element, and an element that reports no `AXEnabled`, such as a window, is pressed as before.

## Why

An agent that presses a control before the step that enables it (a Save button before the form is valid, Next before a choice) is told the press worked and moves on from a state that never happened.

## Testing

An AppKit window with a disabled `NSButton`, TextEdit in front, macOS 26.5.2 VM, addon swapped into `@oh-my-pi/pi-coding-agent`. The button reads `enabled: false` with `actions: ["AXPress"]` on both builds. `el.press()` on it: on main it returned normally and the button's action never ran (5/5); on this branch it throws `AxFailed` naming the disabled state and nothing runs (30/30). The enabled button next to it still presses and fires on both. A Chrome button marked `aria-disabled` lists no `AXPress` at all, so it is refused as unsupported on main and here alike (3/3).

`a_press_of_a_disabled_element_is_refused_before_anything_is_sent` covers the chooser: a disabled press is refused, an enabled or silent one goes ahead, other actions on a disabled element go ahead, and an unlisted action is refused as unsupported rather than disabled.

---

- [ ] `bun check` passes
- [x] Tested locally
- [x] CHANGELOG updated with the required attribution (if user-facing; internal issue fixes use issue links, external contributions add the PR link and contributor credit after creation)
