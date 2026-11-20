use std::{
	ptr::with_exposed_provenance_mut,
	time::{Duration, Instant},
};

use uiautomation::{
	UIAutomation, UIElement,
	patterns::{
		UIExpandCollapsePattern, UIInvokePattern, UILegacyIAccessiblePattern, UIRangeValuePattern,
		UIScrollItemPattern, UISelectionItemPattern, UISelectionPattern, UITogglePattern,
		UIValuePattern,
	},
	types::{ControlType, ExpandCollapseState, Handle, Point, ToggleState, TreeScope, UIProperty},
	variants::{Value, Variant},
};
use windows::Win32::UI::Accessibility::UIA_E_TIMEOUT;
use windows_sys::Win32::{
	Foundation::{HWND, POINT},
	UI::WindowsAndMessaging::{GA_PARENT, GetAncestor, GetDesktopWindow, IsWindow, WindowFromPoint},
};

use super::{
	super::{
		ax::{
			AxBounds, AxHandle, AxProps, decimal_value, normalize_role_uia, plain_decimal,
			real_reached,
		},
		backend::AxBackend,
		control,
		error::{CoreResult, DesktopError, ErrorCode},
		types::DesktopWindow,
	},
	delivery::is_wpf_class,
	window,
};

/// Ancestors of a hit-tested element searched for the control that owns it.
const MAX_PRESS_ANCESTORS: usize = 8;

pub(super) struct Win32Ax {
	automation_initialized: bool,
}

impl Win32Ax {
	pub(super) const fn new() -> Self {
		Self { automation_initialized: false }
	}

	/// Uses the COM apartment already initialized and owned by the caller.
	pub(super) const fn new_initialized() -> Self {
		Self { automation_initialized: true }
	}

	fn automation(&mut self) -> CoreResult<UIAutomation> {
		if self.automation_initialized {
			UIAutomation::new_direct().map_err(ax_error)
		} else {
			let automation = UIAutomation::new().map_err(ax_error)?;
			self.automation_initialized = true;
			Ok(automation)
		}
	}

	#[allow(
		clippy::missing_const_for_fn,
		clippy::unnecessary_wraps,
		reason = "in test configuration handle matching can return an error"
	)]
	fn element(handle: &AxHandle) -> CoreResult<&UIElement> {
		match handle {
			AxHandle::Uia(element, _) => Ok(element),
			#[cfg(test)]
			_ => Err(DesktopError::ax_failed("accessibility handle does not belong to UI Automation")),
		}
	}

	/// The control window `handle` is itself, such as a classic edit box's;
	/// `None` for a windowless element drawn inside a parent's window.
	pub(super) fn own_window(handle: &AxHandle) -> CoreResult<Option<HWND>> {
		Ok(native_window(Self::element(handle)?))
	}

	fn walker(&mut self) -> CoreResult<uiautomation::UITreeWalker> {
		self.automation()?.get_raw_view_walker().map_err(ax_error)
	}

	/// Top-level window hosting `element`, found through the nearest ancestor
	/// that owns a native window; `None` for the desktop itself.
	pub(super) fn host_root(&mut self, element: &UIElement) -> Option<HWND> {
		let walker = self.walker().ok()?;
		Self::host_root_from(element, &walker, native_window(element))
	}

	fn host_root_from(
		element: &UIElement,
		walker: &uiautomation::UITreeWalker,
		mut direct: Option<HWND>,
	) -> Option<HWND> {
		let mut current = element.clone();
		for depth in 0..64 {
			if let Some(hwnd) = direct {
				let root = window::root(hwnd);
				// SAFETY: GetDesktopWindow has no preconditions.
				return (root != unsafe { GetDesktopWindow() }).then_some(root);
			}
			current = walker.get_parent(&current).ok()?;
			if depth < 63 {
				direct = native_window(&current);
			}
		}
		None
	}

	/// [`Self::host_root_from`] for a route that has already qualified: a
	/// provider error ends the walk with that error instead of reading as
	/// another window.
	fn qualified_host_root(
		element: &UIElement,
		walker: &uiautomation::UITreeWalker,
	) -> Result<Option<HWND>, uiautomation::Error> {
		let mut current = element.clone();
		for depth in 0..64 {
			let raw: isize = current.get_native_window_handle()?.into();
			if raw != 0 {
				let root = window::root(with_exposed_provenance_mut(raw as usize));
				// SAFETY: GetDesktopWindow has no preconditions.
				return Ok((root != unsafe { GetDesktopWindow() }).then_some(root));
			}
			if depth == 63 {
				break;
			}
			current = walker.get_parent(&current)?;
		}
		Ok(None)
	}

	/// Refuses known self-activating providers rather than disabling a foreign
	/// window or trying to undo a foreground steal after the action.
	fn contained(
		&mut self,
		element: &UIElement,
		call: impl FnOnce() -> CoreResult<()>,
	) -> CoreResult<()> {
		Self::contained_root(self.host_root(element), call)
	}

	fn contained_root(root: Option<HWND>, call: impl FnOnce() -> CoreResult<()>) -> CoreResult<()> {
		let root = root.ok_or_else(|| {
			DesktopError::ax_failed("cannot establish the native window hosting this UIA element")
		})?;
		window::ensure_pattern_safe(root)?;
		call()
	}

	/// Presses the control under a physical screen point through UI
	/// Automation, for toolkits that drop posted clicks (WPF, `WinUI` 3, Tk,
	/// GTK). Returns whether a pattern ran.
	///
	/// Only controls whose click does the same thing wherever it lands inside
	/// them qualify, so canvases and panes keep pixel semantics and stay
	/// refused. The point must hit `root`'s visible window tree, so an
	/// occluding window is never pressed.
	pub(super) fn invoke_at_point(&mut self, root: HWND, point: POINT) -> CoreResult<bool> {
		// SAFETY: WindowFromPoint takes a scalar point.
		let visible = unsafe { WindowFromPoint(point) };
		if visible.is_null() || window::root(visible) != root {
			return Ok(false);
		}
		let automation = self.automation()?;
		let walker = automation.get_raw_view_walker().map_err(ax_error)?;
		let mut element = automation
			.element_from_point(Point::new(point.x, point.y))
			.map_err(ax_error)?;
		// A process can own several independent top-level windows. Process ID
		// equality (or an overlapping rectangle) cannot prove this membership.
		if self.host_root(&element) != Some(root) {
			return Ok(false);
		}
		let legacy_candidate = !window::owns_foreground(root) && legacy_window(root);
		let mut ancestors = 0;
		while ancestors < MAX_PRESS_ANCESTORS {
			let control_type = element.get_control_type().map_err(ax_error)?;
			if legacy_candidate
				&& let Some(legacy) = LegacyPress::prepare(&element, control_type, true)
			{
				return Self::legacy_at_point(&automation, &walker, root, point, &element, legacy);
			}
			if let Some(press) = positionless_press(&element, control_type) {
				let rect = element.get_bounding_rectangle().map_err(ax_error)?;
				if point.x < rect.get_left()
					|| point.x >= rect.get_right()
					|| point.y < rect.get_top()
					|| point.y >= rect.get_bottom()
					|| !element.is_enabled().map_err(ax_error)?
					|| element.is_offscreen().map_err(ax_error)?
					|| self.host_root(&element) != Some(root)
				{
					return Ok(false);
				}
				// Recheck occlusion after provider queries, before any action.
				// SAFETY: WindowFromPoint takes a scalar point.
				if window::root(unsafe { WindowFromPoint(point) }) != root {
					return Ok(false);
				}
				if let Err(refusal) = window::ensure_pattern_safe(root) {
					// The window left the front during the provider queries: a
					// WPF button or check box can still take the default action
					// instead; anything else keeps the refusal.
					if !legacy_candidate
						&& legacy_window(root)
						&& let Some(legacy) = LegacyPress::prepare(&element, control_type, true)
					{
						return Self::legacy_at_point(
							&automation,
							&walker,
							root,
							point,
							&element,
							legacy,
						);
					}
					return Err(refusal);
				}
				press.run().map_err(|error| {
					DesktopError::ax_failed(format!(
						"UIA coordinate action failed and may already have taken effect; do not replay \
						 it automatically: {error}"
					))
				})?;
				return Ok(true);
			}
			// Only decorative content may inherit a parent's primary click.
			// Never climb from a canvas/list/tree/split button into an outer
			// invokable container and silently lose the requested coordinates.
			if native_window(&element) == Some(root)
				|| !matches!(control_type, ControlType::Text | ControlType::Image)
			{
				break;
			}
			element = walker.get_parent(&element).map_err(ax_error)?;
			ancestors += 1;
		}
		Ok(false)
	}

	/// Sends a prepared WPF press at `point` while the point still shows its
	/// control; `Ok(false)` leaves the click to the ordinary routes.
	fn legacy_at_point(
		automation: &UIAutomation,
		walker: &uiautomation::UITreeWalker,
		root: HWND,
		point: POINT,
		element: &UIElement,
		(cutoff, legacy): (Instant, CoreResult<LegacyPress>),
	) -> CoreResult<bool> {
		// Nothing is sent before `run`: a timed-out lookup is `Timeout`.
		let unsent = |error: uiautomation::Error| legacy_error(error, false);
		let hit = || -> CoreResult<bool> {
			let rect = element.get_bounding_rectangle().map_err(unsent)?;
			if point.x < rect.get_left()
				|| point.x >= rect.get_right()
				|| point.y < rect.get_top()
				|| point.y >= rect.get_bottom()
				|| element.is_offscreen().map_err(unsent)?
				|| Self::qualified_host_root(element, walker).map_err(unsent)? != Some(root)
			{
				return Ok(false);
			}
			// A layout change can replace the control without changing its
			// HWND.
			let mut current = automation
				.element_from_point(Point::new(point.x, point.y))
				.map_err(unsent)?;
			for _ in 0..MAX_PRESS_ANCESTORS {
				if automation
					.compare_elements(element, &current)
					.map_err(unsent)?
				{
					// Recheck occlusion after the last provider query.
					// SAFETY: WindowFromPoint takes a scalar point.
					return Ok(window::root(unsafe { WindowFromPoint(point) }) == root);
				}
				if !matches!(
					current.get_control_type().map_err(unsent)?,
					ControlType::Text | ControlType::Image
				) {
					break;
				}
				current = walker.get_parent(&current).map_err(unsent)?;
			}
			Ok(false)
		};
		let left = || {
			let left = cutoff.saturating_duration_since(Instant::now());
			control::time_left().map_or(left, |time| time.min(left))
		};
		match legacy_route_end(legacy, hit, left)? {
			Some(press) => press.run(root, Some(point)).map(|()| true),
			None => Ok(false),
		}
	}

	/// Writes `text` into a windowless control without a text value: as a
	/// number into a range control (a WPF slider), or by selecting the item it
	/// names in a selection container (a WPF combo box or list). Either is read
	/// back.
	fn set_number_or_item(&mut self, element: &UIElement, text: &str) -> CoreResult<()> {
		if let Some(range) = present(element.get_pattern::<UIRangeValuePattern>(), "RangeValue")? {
			let root = self.write_root(element)?;
			control::check()?;
			return Self::set_number(root, &range, text);
		}
		if let Some(selection) = present(element.get_pattern::<UISelectionPattern>(), "Selection")? {
			let root = self.write_root(element)?;
			control::check()?;
			return self.select_item(root, element, &selection, text);
		}
		Err(DesktopError::ax_failed(
			"this element offers none of UI Automation's Value, RangeValue and Selection patterns, \
			 so it takes no text, number or item; nothing was written; set it via press/click instead",
		))
	}

	fn write_root(&mut self, element: &UIElement) -> CoreResult<HWND> {
		let root = self.host_root(element).ok_or_else(|| {
			DesktopError::background_unavailable(
				"cannot establish the window hosting this UIA element; nothing was sent",
			)
		})?;
		fresh_write(root)?;
		Ok(root)
	}

	fn set_number(root: HWND, range: &UIRangeValuePattern, text: &str) -> CoreResult<()> {
		let current = range.get_value().map_err(ax_error)?;
		control::check()?;
		let refusal = |reason: &str| {
			DesktopError::ax_failed(format!("{reason}; it reads {current} now; nothing was written"))
		};
		// The number written must spell the text back, so no digit is lost to
		// the parse.
		let value = plain_decimal(text)
			.filter(|_| {
				let (_, integer, fraction) = decimal_value(text);
				let digits = if integer.is_empty() {
					fraction.trim_start_matches('0').len()
				} else {
					integer.len() + fraction.len()
				};
				digits <= 15
			})
			.and_then(|_| text.parse::<f64>().ok())
			.filter(|value| decimal_value(text) == decimal_value(&value.to_string()))
			.ok_or_else(|| {
				refusal(
					"this control takes a number and the text given is not one it can hold: write \
					 plain digits such as \"75\" or \"0.5\", at most 32 characters and 15 significant \
					 digits",
				)
			})?;
		let readonly = range.is_readonly().map_err(ax_error)?;
		control::check()?;
		if readonly {
			return Err(refusal("this control is read-only"));
		}
		let (minimum, maximum) =
			(range.get_minimum().map_err(ax_error)?, range.get_maximum().map_err(ax_error)?);
		control::check()?;
		if !(minimum..=maximum).contains(&value) {
			return Err(refusal(&format!(
				"{text} is outside the control's range {minimum} to {maximum}"
			)));
		}
		fresh_write(root)?;
		range.set_value(value).map_err(|error| {
			DesktopError::input_failed(format!(
				"RangeValue.SetValue({text}) was attempted and may have taken effect ({error})"
			))
		})?;
		let read = range.get_value().map_err(|error| {
			DesktopError::input_failed(format!(
				"wrote {text}, but the control's value could not be read back ({error}); inspect it \
				 before writing again"
			))
		})?;
		if real_reached(value, read) {
			Ok(())
		} else {
			Err(DesktopError::input_failed(format!(
				"wrote {text}; the control now reads {read}. The app may have rounded it to a step or \
				 not taken it: inspect it before writing again"
			)))
		}
	}

	/// Selects the item of the selection container `element` named exactly
	/// `text` among the items currently exposed. A cold combo is opened to
	/// expose its items and closed again while its window remains in front.
	/// Read-back follows a bounded pause for deferred close handlers.
	fn select_item(
		&mut self,
		root: HWND,
		element: &UIElement,
		selection: &UISelectionPattern,
		text: &str,
	) -> CoreResult<()> {
		let items = self.selection_items(element)?;
		if !items.is_empty() {
			let item = pick(items, text)?;
			self.preserve_selection(selection, Some(&item.element))?;
			fresh_write(root)?;
			item.pattern.select().map_err(|error| {
				DesktopError::input_failed(format!(
					"SelectionItem.Select({text:?}) was attempted and may have taken effect ({error})"
				))
			})?;
			return self.confirm_selected(selection, &item.element, text, false);
		}
		let combo = matches!(element.get_control_type().map_err(ax_error)?, ControlType::ComboBox);
		control::check()?;
		let expander = if combo {
			let pattern = present(element.get_pattern::<UIExpandCollapsePattern>(), "ExpandCollapse")?;
			control::check()?;
			match pattern {
				Some(pattern) => {
					let state = pattern.get_state().map_err(|error| {
						DesktopError::ax_failed(format!("ExpandCollapse.GetState failed ({error})"))
					})?;
					control::check()?;
					matches!(state, ExpandCollapseState::Collapsed).then_some(pattern)
				},
				None => None,
			}
		} else {
			None
		};
		let Some(expander) = expander else {
			return Err(DesktopError::ax_failed(
				"this list exposes no selectable items to UI Automation; nothing was selected",
			));
		};
		// Before Expand, cancellation or loss of foreground still sent nothing.
		self.preserve_selection(selection, None)?;
		fresh_write(root)?;
		let expanded = expander.expand();
		let selected = expanded
			.map_err(|error| format!("Expand was attempted and failed ({error})"))
			.and_then(|()| {
				let foreground = || {
					control::check().map_err(|error| error.message)?;
					if !window::owns_foreground(root) {
						return Err(
							"the window lost the foreground after Expand; Select was not sent".to_string(),
						);
					}
					Ok(())
				};
				let realize = std::time::Duration::from_millis(500);
				let realize = control::time_left().map_or(realize, |left| left.min(realize));
				let until = std::time::Instant::now() + realize;
				// A cold combo can return from Expand before its items enter
				// the UIA tree. Wait only while the hosting window stays in front.
				let items = loop {
					foreground()?;
					let items = self
						.selection_items(element)
						.map_err(|error| error.message)?;
					foreground()?;
					let left = until.saturating_duration_since(std::time::Instant::now());
					if !items.is_empty() || left.is_zero() {
						break items;
					}
					let pause = left.min(std::time::Duration::from_millis(10));
					let pause = control::time_left().map_or(pause, |left| left.min(pause));
					control::wait(pause).map_err(|error| error.message)?;
				};
				let item = pick(items, text).map_err(|error| error.message)?;
				fresh_write(root).map_err(|error| {
					if error.code == ErrorCode::BackgroundUnavailable {
						"the window lost the foreground after Expand; Select was not sent".to_string()
					} else {
						format!("Select was not sent: {}", error.message)
					}
				})?;
				item.pattern.select().map_err(|error| {
					format!("SelectionItem.Select({text:?}) was attempted and failed ({error})")
				})?;
				Ok(item)
			});
		// Expand was attempted, even if it returned an error. Cleanup must not
		// be skipped by cancellation or by an unreadable expansion state.
		let before_close = std::time::Instant::now();
		let deadline = control::time_left().map(|left| before_close + left);
		let closed = Self::close_opened(root, &expander);
		match (selected, closed) {
			(Ok(item), Ok(())) => {
				let settle = std::time::Duration::from_millis(150);
				if deadline.is_some_and(|deadline| std::time::Instant::now() + settle > deadline) {
					return Err(DesktopError::ax_unconfirmed(format!(
						"selected {text:?} and the list now reads closed, but the remaining time cannot \
						 cover the full post-close settling window; the selection could not be \
						 confirmed; inspect it before writing again"
					)));
				}
				control::wait(settle).map_err(|error| {
					DesktopError::ax_unconfirmed(format!(
						"selected {text:?} and the list now reads closed, but the selection could not \
						 be confirmed because the full post-close settling window did not finish ({}); \
						 inspect the selection before writing again",
						error.message
					))
				})?;
				self.confirm_selected(selection, &item.element, text, true)
			},
			(Ok(_), Err(close)) => Err(DesktopError::input_failed(format!(
				"selected {text:?}; Expand was attempted; {close}"
			))),
			(Err(failed), closed) => Err(DesktopError::input_failed(format!(
				"Expand was attempted; {failed}; {}",
				closed
					.err()
					.unwrap_or_else(|| "the list now reads closed".to_string())
			))),
		}
	}

	/// Cleanup is independent of cancellation, but never sends Collapse
	/// after the hosting window loses the foreground.
	fn close_opened(root: HWND, expander: &UIExpandCollapsePattern) -> Result<(), String> {
		let before = expander.get_state();
		if matches!(before, Ok(ExpandCollapseState::Collapsed)) {
			return Ok(());
		}
		if !window::owns_foreground(root) {
			return Err(match before {
				Ok(_) => "the list still reads open; the window lost the foreground, so Collapse was \
				          not sent"
					.to_string(),
				Err(error) => format!(
					"the list state is unknown ({error}); the window lost the foreground, so Collapse \
					 was not sent"
				),
			});
		}
		let collapsed = expander.collapse();
		// A provider error does not prove the mutation had no effect.
		match (collapsed, expander.get_state()) {
			(Ok(()), Ok(ExpandCollapseState::Collapsed)) => Ok(()),
			(Err(error), Ok(ExpandCollapseState::Collapsed)) => {
				Err(format!("Collapse failed ({error}), but the list now reads closed"))
			},
			(Ok(()), Ok(_)) => Err("Collapse returned, but the list still reads open".to_string()),
			(Err(error), Ok(_)) => {
				Err(format!("Collapse failed ({error}); the list still reads open"))
			},
			(Ok(()), Err(error)) => {
				Err(format!("Collapse returned, but the list state could not be read ({error})"))
			},
			(Err(error), Err(read)) => {
				Err(format!("Collapse failed ({error}); the list state could not be read ({read})"))
			},
		}
	}

	/// The selectable items of the selection container `element`: exposed
	/// descendants offering `SelectionItem` whose container it is, which a
	/// grouped list nests under its groups.
	fn selection_items(&mut self, element: &UIElement) -> CoreResult<Vec<SelectionItem>> {
		let read_failed = |error: uiautomation::Error| {
			DesktopError::ax_failed(format!(
				"reading the list's items failed ({error}); nothing was selected"
			))
		};
		let automation = self.automation()?;
		let condition = automation
			.create_property_condition(
				UIProperty::IsSelectionItemPatternAvailable,
				Variant::from(true),
				None,
			)
			.map_err(ax_error)?;
		let mut items = Vec::new();
		let found = element
			.find_all(TreeScope::Descendants, &condition)
			.map_err(read_failed)?;
		control::check()?;
		for found in found {
			let pattern = found
				.get_pattern::<UISelectionItemPattern>()
				.map_err(read_failed)?;
			let container = pattern.get_selection_container().map_err(read_failed)?;
			control::check()?;
			if automation
				.compare_elements(&container, element)
				.map_err(read_failed)?
			{
				items.push(SelectionItem {
					name: found.get_name().map_err(read_failed)?,
					element: found,
					pattern,
				});
			}
		}
		control::check()?;
		Ok(items)
	}

	/// Select replaces the whole selection, even in a multiple-selection list.
	fn preserve_selection(
		&mut self,
		selection: &UISelectionPattern,
		target: Option<&UIElement>,
	) -> CoreResult<()> {
		if !selection.can_select_multiple().map_err(ax_error)? {
			return Ok(());
		}
		let selected = selection.get_selection().map_err(ax_error)?;
		let automation = self.automation()?;
		for item in selected {
			if let Some(target) = target
				&& automation
					.compare_elements(&item, target)
					.map_err(ax_error)?
			{
				continue;
			}
			return Err(DesktopError::ax_failed(
				"setValue would replace other selected items in this multiple-selection list; nothing \
				 was changed; press the item or select via click instead",
			));
		}
		Ok(())
	}

	/// Checks that the container's selection is the item selected, alone.
	fn confirm_selected(
		&mut self,
		selection: &UISelectionPattern,
		item: &UIElement,
		text: &str,
		closed: bool,
	) -> CoreResult<()> {
		let automation = self.automation()?;
		let selected = selection.get_selection().map_err(|error| {
			DesktopError::input_failed(format!(
				"selected {text:?}, but the selection could not be read back ({error})"
			))
		})?;
		if let [only] = selected.as_slice() {
			let same = automation.compare_elements(only, item).map_err(|error| {
				DesktopError::input_failed(format!(
					"selected {text:?}, but CompareElements failed during read-back ({error})"
				))
			})?;
			if same {
				return Ok(());
			}
		}
		let names = selected
			.iter()
			.map(|item| item.get_name().unwrap_or_default())
			.collect::<Vec<_>>()
			.join(", ");
		if closed {
			Err(DesktopError::ax_failed(format!(
				"after the list closed, the selection reads [{}] instead of {text:?}; inspect it \
				 before writing again, do not retry blindly",
				truncate(names)
			)))
		} else {
			Err(DesktopError::input_failed(format!(
				"selected {text:?}, but the selection now reads [{}]; the app may have changed it",
				truncate(names)
			)))
		}
	}
}

/// Fresh writes honour cancellation after provider reads and require the
/// exact host window in front, regardless of its toolkit or class.
fn fresh_write(root: HWND) -> CoreResult<()> {
	control::check()?;
	if !window::owns_foreground(root) {
		return Err(DesktopError::background_unavailable(
			"the window must own the foreground for this UIA write; nothing was sent",
		));
	}
	Ok(())
}

/// A selectable item of a selection container.
struct SelectionItem {
	name:    String,
	element: UIElement,
	pattern: UISelectionItemPattern,
}

/// The one item of `items` named exactly `text`.
fn pick(items: Vec<SelectionItem>, text: &str) -> CoreResult<SelectionItem> {
	let count = items.iter().filter(|item| item.name == text).count();
	if count > 1 {
		return Err(DesktopError::ax_failed(format!(
			"{count} items are named {text:?}; nothing was selected"
		)));
	}
	if count == 0 {
		let names = items
			.iter()
			.map(|item| item.name.as_str())
			.collect::<Vec<_>>()
			.join(", ");
		return Err(DesktopError::ax_failed(format!(
			"no currently exposed item is named exactly {text:?}; the exposed items are {}; \
			 virtualized offscreen rows are not searched; nothing was selected",
			truncate(names)
		)));
	}
	Ok(items
		.into_iter()
		.find(|item| item.name == text)
		.expect("one item has the name"))
}

fn ax_error(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("UI Automation failed: {error}"))
}

/// The pattern a lookup found, or `None` when the element does not offer it:
/// UI Automation answers that with success and no interface, which reaches us
/// as an error with code 0 ("The operation completed successfully"). Any
/// other failure is an error naming the pattern.
fn present<P>(lookup: uiautomation::Result<P>, name: &str) -> CoreResult<Option<P>> {
	match lookup {
		Ok(pattern) => Ok(Some(pattern)),
		Err(error) if error.code() == 0 => Ok(None),
		Err(error) => Err(DesktopError::ax_failed(format!(
			"reading UI Automation's {name} pattern failed: {error}"
		))),
	}
}

/// Maps a failed lookup of a pattern an action needs, as [`present`] tells
/// a missing pattern from a failed lookup.
fn pattern_error(name: &'static str) -> impl Fn(uiautomation::Error) -> DesktopError {
	move |error| {
		if error.code() == 0 {
			DesktopError::ax_failed(format!(
				"this element does not offer UI Automation's {name} pattern; nothing was sent"
			))
		} else {
			ax_error(error)
		}
	}
}

/// Handle for `element` carrying the `RuntimeId` that identifies it across
/// reads, or none when the element reports none. Read as a property:
/// `UIElement::get_runtime_id` leaks the array UI Automation returns.
fn uia_handle(element: UIElement) -> AxHandle {
	let runtime_id = match element
		.get_property_value(UIProperty::RuntimeId)
		.and_then(|value| value.get_value())
	{
		Ok(Value::ArrayI4(id)) if !id.is_empty() => Some(id.into_boxed_slice()),
		_ => None,
	};
	AxHandle::Uia(element, runtime_id)
}

/// Native window handle `element` represents, if any.
fn native_window(element: &UIElement) -> Option<HWND> {
	let raw: isize = element.get_native_window_handle().ok()?.into();
	(raw != 0).then(|| with_exposed_provenance_mut(raw as usize))
}

/// Presses the enabled native button `element` represents through `BM_CLICK`
/// ([`window::click_button`]) while it stays inside `top`. A `WinForms` check
/// box draws itself and keeps its state out of `BM_GETCHECK`, so its Toggle
/// state shows whether the click changed it: unread or unchanged, the click is
/// reported as unconfirmed (an app may manage the box's state itself and leave
/// it as it was).
fn press_button(element: &UIElement, button: HWND, top: HWND) -> CoreResult<()> {
	if window::native_auto_button(button) {
		return window::click_button(button, top);
	}
	let toggle = match element.get_pattern::<UITogglePattern>() {
		Ok(toggle) => toggle,
		Err(error) => {
			let kind = element.get_control_type().map_err(|error| {
				DesktopError::input_failed(format!(
					"the button's control type could not be read ({error}); nothing was clicked"
				))
			})?;
			if kind == ControlType::CheckBox {
				return Err(DesktopError::input_failed(format!(
					"the check box's Toggle pattern could not be read ({error}); nothing was clicked"
				)));
			}
			return window::click_button(button, top);
		},
	};
	let before = toggle.get_toggle_state().map_err(|error| {
		DesktopError::input_failed(format!(
			"the check box's state could not be read ({error}); nothing was clicked"
		))
	})?;
	window::click_button(button, top)?;
	match toggle.get_toggle_state() {
		Ok(after) if after != before => Ok(()),
		Ok(_) => Err(DesktopError::ax_unconfirmed(
			"the check box processed its click but its state did not change; the app may manage it \
			 itself or have refused the click; inspect the target before pressing again",
		)),
		// Not `AxUnconfirmed`: naming the target would query the same,
		// possibly unresponsive, provider again.
		Err(error) => Err(DesktopError::input_failed(format!(
			"the check box processed its click and may have changed, but its state could not be read \
			 afterwards ({error}); inspect the target before pressing again"
		))),
	}
}

/// How long a control acted on through `LegacyIAccessible` is given to show its
/// new state: WPF runs the action from its dispatcher after the call returns.
const LEGACY_READBACK: Duration = Duration::from_millis(500);

/// Whether `root` is a WPF window, where UI Automation's control patterns
/// bring the window to the front while `LegacyIAccessible`'s actions leave it
/// behind. A Chromium/`WebView2` child HWND excludes the window; visually
/// hosted `WebView2` composition controls have no child HWND and are not
/// detected. Web elements are excluded by framework ID. XAML hosts stay
/// refused.
fn legacy_window(root: HWND) -> bool {
	is_wpf_class(&window::class_name(root)) && !window::has_chromium_descendant(root)
}

/// A press through `LegacyIAccessible`'s default action, prepared for a
/// [`legacy_window`] that [`window::ensure_pattern_safe`] refused.
struct LegacyPress {
	action: UILegacyIAccessiblePattern,
	/// The held check-box pattern and initial state, if applicable.
	toggle: Option<(UITogglePattern, ToggleState)>,
	cutoff: Instant,
}

impl LegacyPress {
	/// Prepares a WPF button's `Invoke` or a check box's `Toggle`. `None`
	/// where the window or element does not qualify for that default action
	/// (whose default actions are that same press; a list item's may be
	/// "Double Click", a combo box's "Open"), or there is no default action, so
	/// the caller keeps its refusal. Otherwise the route's cutoff, which bounds
	/// a refusal found while preparing as well as the press. Nothing is sent
	/// here.
	fn prepare(
		element: &UIElement,
		kind: ControlType,
		coordinate: bool,
	) -> Option<(Instant, CoreResult<Self>)> {
		if !matches!(kind, ControlType::Button | ControlType::CheckBox)
			|| element.get_framework_id().ok()?.as_str() != "WPF"
		{
			return None;
		}
		let toggle = if kind == ControlType::CheckBox {
			Some(element.get_pattern::<UITogglePattern>().ok()?)
		} else {
			element.get_pattern::<UIInvokePattern>().ok()?;
			None
		};
		let action = element.get_pattern::<UILegacyIAccessiblePattern>().ok()?;
		if action.get_default_action().ok()?.trim().is_empty() {
			return None;
		}
		let cutoff = Instant::now()
			+ control::time_left().map_or(LEGACY_READBACK, |left| {
				if toggle.is_some() {
					left.min(LEGACY_READBACK)
				} else {
					left
				}
			});
		let press = match element.is_enabled() {
			Ok(false) => {
				Err(DesktopError::input_failed("the WPF control is disabled; nothing was pressed"))
			},
			Err(error) => Err(legacy_error(error, false)),
			Ok(true) => Self::read(action, toggle, coordinate, cutoff),
		};
		Some((cutoff, press))
	}

	fn read(
		action: UILegacyIAccessiblePattern,
		toggle: Option<UITogglePattern>,
		coordinate: bool,
		cutoff: Instant,
	) -> CoreResult<Self> {
		legacy_before(false, || cutoff.saturating_duration_since(Instant::now()))?;
		let toggle = if let Some(toggle) = toggle {
			let result = toggle.get_toggle_state();
			legacy_before(false, || cutoff.saturating_duration_since(Instant::now()))?;
			let before =
				result.map_err(|error| legacy_initial_error(legacy_error(error, false), coordinate))?;
			Some((toggle, before))
		} else {
			None
		};
		legacy_before(false, || cutoff.saturating_duration_since(Instant::now()))?;
		Ok(Self { action, toggle, cutoff })
	}

	/// Checks the deadline between provider calls; synchronous calls can block
	/// past it, and a late reply cannot confirm an action already sent.
	fn run(self, root: HWND, point: Option<POINT>) -> CoreResult<()> {
		self.run_inner(root, point).map_err(|mut error| {
			if error.code == super::super::error::ErrorCode::AxUnconfirmed {
				error.target_window = Some(root.expose_provenance());
			}
			error
		})
	}

	fn run_inner(self, root: HWND, point: Option<POINT>) -> CoreResult<()> {
		control::check()?;
		legacy_before(false, || self.cutoff.saturating_duration_since(Instant::now()))?;
		legacy_before(false, || control::time_left().unwrap_or(LEGACY_READBACK))?;
		// A Chromium child that appeared during the provider reads takes the
		// window out of this route.
		let eligible = if legacy_window(root) {
			Ok(())
		} else {
			Err(DesktopError::new(
				super::super::error::ErrorCode::BackgroundUnavailable,
				"the WPF window now hosts web content; nothing was pressed",
			))
		};
		// The point is sampled last before dispatch.
		let eligible = eligible.and_then(|()| match point {
			// SAFETY: WindowFromPoint takes a scalar point.
			Some(point) if window::root(unsafe { WindowFromPoint(point) }) != root => {
				Err(DesktopError::new(
					super::super::error::ErrorCode::BackgroundUnavailable,
					"the WPF control is covered; nothing was pressed",
				))
			},
			_ => Ok(()),
		});
		control::check()?;
		legacy_route_end(
			eligible,
			|| Ok(true),
			|| self.cutoff.saturating_duration_since(Instant::now()),
		)?;
		control::dispatching()?;
		let result = self.action.do_default_action();
		// A late acknowledgement cannot confirm an action already sent.
		legacy_before(true, || self.cutoff.saturating_duration_since(Instant::now()))?;
		result.map_err(|error| legacy_error(error, true))?;
		let Some((toggle, before)) = self.toggle else {
			return Ok(());
		};
		loop {
			control::check()?;
			legacy_before(true, || self.cutoff.saturating_duration_since(Instant::now()))?;
			let after = toggle.get_toggle_state().map_err(|error| {
				DesktopError::ax_unconfirmed(format!(
					"the check box's default action was sent but its state could not be read \
					 ({error}); inspect the target before pressing again"
				))
			})?;
			control::check()?;
			legacy_before(true, || self.cutoff.saturating_duration_since(Instant::now()))?;
			if after != before {
				return Ok(());
			}
			control::wait(
				self
					.cutoff
					.saturating_duration_since(Instant::now())
					.min(Duration::from_millis(20)),
			)?;
		}
	}
}

fn legacy_before(sent: bool, remaining: impl FnOnce() -> Duration) -> CoreResult<()> {
	if !remaining().is_zero() {
		return Ok(());
	}
	Err(if sent {
		DesktopError::ax_unconfirmed(
			"the control's default action was sent but its outcome was not confirmed; inspect the \
			 target before pressing again",
		)
	} else {
		DesktopError::timeout("the WPF action deadline expired; nothing was pressed")
	})
}

/// Settles a prepared WPF press route after `hit` checked its point again:
/// `Some` sends it, `None` leaves the click to the ordinary routes. A timeout
/// met while preparing stands without further reads. Once `remaining` reads
/// zero the route is `Timeout` whatever was learned, so a miss or a refusal
/// read after the cutoff cannot hand the click to takeover.
fn legacy_route_end<T>(
	prepared: CoreResult<T>,
	hit: impl FnOnce() -> CoreResult<bool>,
	remaining: impl FnOnce() -> Duration,
) -> CoreResult<Option<T>> {
	if let Err(error) = &prepared
		&& error.code == super::super::error::ErrorCode::Timeout
	{
		return prepared.map(Some);
	}
	let hit = hit();
	legacy_before(false, remaining)?;
	if !hit? {
		return Ok(None);
	}
	prepared.map(Some)
}

fn legacy_error(error: uiautomation::Error, sent: bool) -> DesktopError {
	if error.code() == UIA_E_TIMEOUT as i32 {
		if sent {
			DesktopError::ax_unconfirmed(
				"the default action was sent but UI Automation timed out; inspect before pressing \
				 again",
			)
		} else {
			DesktopError::timeout("UI Automation timed out; nothing was pressed")
		}
	} else {
		DesktopError::ax_failed(format!(
			"the control's default action failed {}: {error}",
			if sent {
				"and may already have taken effect; do not replay it automatically"
			} else {
				"before dispatch; nothing was pressed"
			}
		))
	}
}

/// A missing initial state is a known-unsent background-route refusal.
fn legacy_initial_error(error: DesktopError, coordinate: bool) -> DesktopError {
	if coordinate && error.code == super::super::error::ErrorCode::AxFailed {
		DesktopError::background_unavailable(format!(
			"the WPF check box's initial state could not be read ({}); nothing was sent",
			error.message
		))
	} else {
		error
	}
}

/// UI Automation pattern performing a control's position-independent click.
enum PositionlessPress {
	Invoke(UIInvokePattern),
	Expand(UIExpandCollapsePattern),
	Collapse(UIExpandCollapsePattern),
	Toggle(UITogglePattern),
	Select(UISelectionItemPattern),
}

impl PositionlessPress {
	fn run(&self) -> Result<(), uiautomation::Error> {
		match self {
			Self::Invoke(pattern) => pattern.invoke(),
			Self::Expand(pattern) => pattern.expand(),
			Self::Collapse(pattern) => pattern.collapse(),
			Self::Toggle(pattern) => pattern.toggle(),
			Self::Select(pattern) => pattern.select(),
		}
	}
}

/// The press for a control whose click does the same thing wherever it lands
/// inside it. Menu items with a submenu toggle it through `ExpandCollapse`,
/// where `Invoke` does nothing.
fn positionless_press(element: &UIElement, control_type: ControlType) -> Option<PositionlessPress> {
	if !coordinate_click_supported(control_type) {
		return None;
	}
	if control_type == ControlType::MenuItem
		&& let Ok(pattern) = element.get_pattern::<UIExpandCollapsePattern>()
	{
		match pattern.get_state() {
			Ok(ExpandCollapseState::Collapsed | ExpandCollapseState::PartiallyExpanded) => {
				return Some(PositionlessPress::Expand(pattern));
			},
			Ok(ExpandCollapseState::Expanded) => return Some(PositionlessPress::Collapse(pattern)),
			Ok(ExpandCollapseState::LeafNode) | Err(_) => {},
		}
	}
	if control_type == ControlType::CheckBox {
		return element
			.get_pattern::<UITogglePattern>()
			.ok()
			.map(PositionlessPress::Toggle);
	}
	if matches!(control_type, ControlType::TabItem | ControlType::RadioButton) {
		return element
			.get_pattern::<UISelectionItemPattern>()
			.ok()
			.map(PositionlessPress::Select);
	}
	element
		.get_pattern::<UIInvokePattern>()
		.ok()
		.map(PositionlessPress::Invoke)
}

/// Split buttons, trees and list rows have independently clickable subregions;
/// their default action cannot substitute for a pixel-addressed click.
const fn coordinate_click_supported(control_type: ControlType) -> bool {
	matches!(
		control_type,
		ControlType::Button
			| ControlType::MenuItem
			| ControlType::Hyperlink
			| ControlType::CheckBox
			| ControlType::RadioButton
			| ControlType::TabItem
	)
}

fn optional(value: Result<String, uiautomation::Error>) -> Option<String> {
	value.ok().filter(|value| !value.is_empty())
}

fn actions(element: &UIElement) -> Vec<String> {
	let can_invoke = element.get_pattern::<UIInvokePattern>().is_ok();
	let can_toggle = element.get_pattern::<UITogglePattern>().is_ok();
	let can_select = element.get_pattern::<UISelectionItemPattern>().is_ok();
	let can_expand = element.get_pattern::<UIExpandCollapsePattern>().is_ok();
	let can_legacy_press = element
		.get_pattern::<UILegacyIAccessiblePattern>()
		.and_then(|pattern| pattern.get_default_action())
		.is_ok_and(|action| !action.is_empty());
	let mut actions = Vec::with_capacity(8);
	if can_invoke
		|| can_toggle
		|| can_select
		|| can_legacy_press
		|| (can_expand && element.get_control_type().ok() == Some(ControlType::MenuItem))
	{
		actions.push("press".to_string());
	}
	if can_invoke {
		actions.push("invoke".to_string());
	}
	if can_toggle {
		actions.push("toggle".to_string());
	}
	if can_expand {
		actions.push("expand".to_string());
		actions.push("collapse".to_string());
	}
	if can_select {
		actions.push("select".to_string());
	}
	if element.get_pattern::<UIScrollItemPattern>().is_ok() {
		actions.push("scrollintoview".to_string());
	}
	actions
}

fn pattern_value(element: &UIElement) -> Option<String> {
	element
		.get_pattern::<UIValuePattern>()
		.and_then(|pattern| pattern.get_value())
		.ok()
}

fn legacy_value(element: &UIElement) -> Option<String> {
	element
		.get_pattern::<UILegacyIAccessiblePattern>()
		.and_then(|pattern| pattern.get_value())
		.ok()
}

fn value(element: &UIElement) -> Option<String> {
	pattern_value(element)
		.filter(|value| !value.is_empty())
		.or_else(|| legacy_value(element).filter(|value| !value.is_empty()))
}

fn truncate(value: impl ToString) -> String {
	let value = value.to_string();
	if value.chars().count() <= 200 {
		value
	} else {
		value
			.chars()
			.take(199)
			.chain(std::iter::once('…'))
			.collect()
	}
}

impl AxBackend for Win32Ax {
	fn window_id(&mut self, handle: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let root = self.host_root(Self::element(handle)?).ok_or_else(|| {
			DesktopError::ax_failed("cannot establish the native window hosting this UIA element")
		})?;
		// SAFETY: IsWindow validates the provider-supplied native handle.
		if unsafe { IsWindow(root) } == 0 {
			return Err(DesktopError::window_not_found("the UIA element's window no longer exists"));
		}
		let address = root.expose_provenance();
		windows
			.iter()
			.find(|window| window.id.parse::<usize>().ok() == Some(address))
			.map(|window| window.id.clone())
			.ok_or_else(|| {
				DesktopError::window_not_found(
					"the UIA element's exact native window is not an available target",
				)
			})
	}

	fn window_root(&mut self, window: &DesktopWindow) -> CoreResult<AxHandle> {
		let address = window.id.parse::<usize>().map_err(|_| {
			DesktopError::ax_failed(format!("invalid Win32 window id '{}'", window.id))
		})?;
		let handle = Handle::from(address as isize);
		self
			.automation()?
			.element_from_handle(handle)
			.map(uia_handle)
			.map_err(ax_error)
	}

	fn props(&mut self, handle: &AxHandle) -> CoreResult<AxProps> {
		let element = Self::element(handle)?;
		let control_type = element.get_control_type().map_err(ax_error)?;
		let native_role = control_type.to_string();
		let walker = self.walker()?;
		let child_count = walker
			.get_children(element)
			.map_or(0, |children| children.len().min(u32::MAX as usize) as u32);
		// UIA rectangles already use physical desktop pixels, the same
		// native coordinate space as window metadata and capture geometry.
		let bounds = element.get_bounding_rectangle().ok().map(|rect| AxBounds {
			x:      f64::from(rect.get_left()),
			y:      f64::from(rect.get_top()),
			width:  f64::from(rect.get_right()) - f64::from(rect.get_left()),
			height: f64::from(rect.get_bottom()) - f64::from(rect.get_top()),
		});
		Ok(AxProps {
			#[cfg(test)]
			read_as_fingerprint: None,
			role: normalize_role_uia(&native_role),
			native_role,
			title: optional(element.get_name()),
			value: value(element),
			description: optional(element.get_help_text()),
			enabled: element.is_enabled().unwrap_or(false),
			focused: element.has_keyboard_focus().unwrap_or(false),
			bounds,
			actions: actions(element),
			child_count,
			identity: None,
			partial: false,
			label_complete: false,
			selected: false,
			role_name: None,
			unread_children: 0,
		})
	}

	fn children(&mut self, handle: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let element = Self::element(handle)?;
		Ok(self
			.walker()?
			.get_children(element)
			.unwrap_or_default()
			.into_iter()
			.map(uia_handle)
			.collect())
	}

	fn parent(&mut self, handle: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let element = Self::element(handle)?;
		Ok(self.walker()?.get_parent(element).ok().map(uia_handle))
	}

	fn perform(&mut self, handle: &AxHandle, action: &str) -> CoreResult<()> {
		let element = Self::element(handle)?;
		let action = action.trim().to_ascii_lowercase();
		// Preserve containment's walker-then-HWND query order, retaining even
		// an absent direct handle so the fallback never queries it twice.
		let walker = self.walker().ok();
		let direct = walker.as_ref().and_then(|_| native_window(element));
		// A native-button candidate's Invoke lookup, made before containment and
		// reused after it: asking a provider again could reach the Invoke this
		// route avoids, which takes the foreground.
		let mut invoke = None;
		if matches!(action.as_str(), "press" | "invoke")
			&& let Some((hwnd, button)) =
				direct.and_then(|hwnd| window::native_button(hwnd).map(|state| (hwnd, state)))
		{
			// The top-level window now, before any provider call runs app code.
			let top = window::root(hwnd);
			// Only native-button candidates query Invoke before containment.
			// Other controls keep the containment guard ahead of provider calls.
			if action == "press"
				|| invoke
					.insert(element.get_pattern::<UIInvokePattern>())
					.is_ok()
			{
				return match button {
					window::NativeButton::Disabled => Err(DesktopError::input_failed(format!(
						"button {} is disabled, or its window is (behind a dialog, for instance); \
						 nothing was clicked",
						hwnd.expose_provenance()
					))),
					window::NativeButton::Enabled => press_button(element, hwnd, top),
				};
			}
		}
		let root = walker.and_then(|walker| Self::host_root_from(element, &walker, direct));
		let root = root.ok_or_else(|| {
			DesktopError::ax_failed("cannot establish the native window hosting this UIA element")
		})?;
		if let Err(refusal) = window::ensure_pattern_safe(root) {
			if action == "press"
				&& legacy_window(root)
				&& let Ok(kind) = element.get_control_type()
				&& let Some((_, legacy)) = LegacyPress::prepare(element, kind, false)
			{
				return legacy?.run(root, None);
			}
			return Err(refusal);
		}
		(|| match action.as_str() {
			"press" => {
				if let Some(pattern) = element
					.get_control_type()
					.ok()
					.and_then(|kind| positionless_press(element, kind))
				{
					control::dispatching()?;
					return pattern.run().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UIInvokePattern>() {
					control::dispatching()?;
					return pattern.invoke().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UITogglePattern>() {
					control::dispatching()?;
					return pattern.toggle().map_err(ax_error);
				}
				if let Ok(pattern) = element.get_pattern::<UISelectionItemPattern>() {
					control::dispatching()?;
					return pattern.select().map_err(ax_error);
				}
				let pattern = element
					.get_pattern::<UILegacyIAccessiblePattern>()
					.map_err(ax_error)?;
				if pattern.get_default_action().map_err(ax_error)?.is_empty() {
					return Err(DesktopError::ax_failed("UIA element has no default press action"));
				}
				control::dispatching()?;
				pattern.do_default_action().map_err(ax_error)
			},
			"invoke" => {
				let pattern = invoke
					.unwrap_or_else(|| element.get_pattern::<UIInvokePattern>())
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.invoke().map_err(ax_error)
			},
			"toggle" => {
				let pattern = element.get_pattern::<UITogglePattern>().map_err(ax_error)?;
				control::dispatching()?;
				pattern.toggle().map_err(ax_error)
			},
			"expand" => {
				let pattern = element
					.get_pattern::<UIExpandCollapsePattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.expand().map_err(ax_error)
			},
			"collapse" => {
				let pattern = element
					.get_pattern::<UIExpandCollapsePattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.collapse().map_err(ax_error)
			},
			"select" => {
				let pattern = element
					.get_pattern::<UISelectionItemPattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.select().map_err(ax_error)
			},
			"scrollintoview" => {
				let pattern = element
					.get_pattern::<UIScrollItemPattern>()
					.map_err(ax_error)?;
				control::dispatching()?;
				pattern.scroll_into_view().map_err(ax_error)
			},
			other => {
				Err(DesktopError::ax_failed(format!("unsupported UI Automation action '{other}'")))
			},
		})()
	}

	fn set_value(&mut self, handle: &AxHandle, text: &str) -> CoreResult<()> {
		let element = Self::element(handle)?;
		// A windowless control without a text value, such as a WPF slider or
		// combo box, takes a number or the item it should select.
		let native = native_window(element);
		let mut value = None;
		if native.is_none() {
			self.contained(element, || {
				value = present(element.get_pattern::<UIValuePattern>(), "Value")?;
				Ok(())
			})?;
			if value.is_none() {
				return self.set_number_or_item(element, text);
			}
		}
		let password = element.is_password().ok();
		let secure = password.unwrap_or(true);
		let hwnd = native.map(super::value_write::combo_target);
		let class = hwnd.map_or_default(window::class_name);
		let parent_class = hwnd.map_or_default(|hwnd| {
			// SAFETY: GetAncestor only queries the native control's true parent.
			window::class_name(unsafe { GetAncestor(hwnd, GA_PARENT) })
		});
		match super::value_write::route(&class, &parent_class) {
			super::value_write::ValueRoute::Combo => {
				return super::value_write::set_combo(
					hwnd.ok_or_else(|| {
						DesktopError::ax_failed(
							"combo box has no native window; select the item via press/click instead",
						)
					})?,
					text,
					element.is_enabled().map_err(ax_error)?,
					secure,
				);
			},
			super::value_write::ValueRoute::RefuseCombo => {
				return Err(DesktopError::ax_failed(
					"this combo box cannot notify the app through setValue; select the item via \
					 press/click instead",
				));
			},
			super::value_write::ValueRoute::Edit => {
				return super::value_write::set_edit(
					hwnd.ok_or_else(|| DesktopError::ax_failed("text field has no native window"))?,
					text,
					element.is_enabled().map_err(ax_error)?,
					password,
				);
			},
			super::value_write::ValueRoute::Pattern => {
				self.contained(element, || {
					let pattern = match value {
						Some(pattern) => pattern,
						None => element
							.get_pattern::<UIValuePattern>()
							.map_err(pattern_error("Value"))?,
					};
					pattern.set_value(text).map_err(ax_error)
				})?;
			},
		}
		// Password providers cannot supply evidence, so do not query hidden
		// or protected representations just to discard them.
		let pattern = if password == Some(true) {
			None
		} else {
			pattern_value(element)
		};
		let legacy = if password != Some(true) && pattern.is_none() {
			legacy_value(element)
		} else {
			None
		};
		let read = pattern.as_deref().or(legacy.as_deref());
		if read.is_some_and(|read| super::value_write::rich_edit_holds(&class, text, read)) {
			return Ok(());
		}
		super::value_write::verdict(text, pattern.as_deref(), legacy.as_deref(), password)
	}

	fn focus(&mut self, handle: &AxHandle) -> CoreResult<()> {
		Self::element(handle)?.set_focus().map_err(ax_error)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		self
			.automation()?
			.element_from_point(Point::new(x.round() as i32, y.round() as i32))
			.map(uia_handle)
			.map(Some)
			.map_err(ax_error)
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self
			.automation()?
			.get_focused_element()
			.map(uia_handle)
			.map(Some)
			.map_err(ax_error)
	}

	fn attributes(&mut self, handle: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let element = Self::element(handle)?;
		let properties = [
			UIProperty::RuntimeId,
			UIProperty::BoundingRectangle,
			UIProperty::ProcessId,
			UIProperty::ControlType,
			UIProperty::LocalizedControlType,
			UIProperty::Name,
			UIProperty::AcceleratorKey,
			UIProperty::AccessKey,
			UIProperty::HasKeyboardFocus,
			UIProperty::IsKeyboardFocusable,
			UIProperty::IsEnabled,
			UIProperty::AutomationId,
			UIProperty::ClassName,
			UIProperty::HelpText,
			UIProperty::ClickablePoint,
			UIProperty::Culture,
			UIProperty::IsControlElement,
			UIProperty::IsContentElement,
			UIProperty::IsPassword,
			UIProperty::NativeWindowHandle,
			UIProperty::ItemType,
			UIProperty::IsOffscreen,
			UIProperty::Orientation,
			UIProperty::FrameworkId,
			UIProperty::IsRequiredForForm,
			UIProperty::ItemStatus,
			UIProperty::AriaRole,
			UIProperty::AriaProperties,
			UIProperty::ProviderDescription,
			UIProperty::FullDescription,
		];
		let mut attributes = Vec::with_capacity(properties.len());
		for property in properties {
			if let Ok(value) = element.get_property_value(property)
				&& !value.is_null()
			{
				attributes.push((property.to_string(), truncate(value)));
			}
		}
		Ok(attributes)
	}

	/// `RuntimeId`s are only unique among live elements. Any failure to read
	/// the stored element counts as gone: a needless new ref is harmless, a ref
	/// renewed onto another element is not.
	fn alive(&mut self, handle: &AxHandle) -> bool {
		Self::element(handle).is_ok_and(|element| element.get_process_id().is_ok())
	}
}

#[cfg(test)]
mod tests {
	use windows_sys::Win32::UI::{
		Input::KeyboardAndMouse::EnableWindow,
		WindowsAndMessaging::{BS_PUSHBUTTON, DestroyWindow},
	};

	use super::{
		super::{
			super::error::ErrorCode,
			window::tests::{button, button_parent, click_messages, clicks, record},
		},
		*,
	};

	#[test]
	fn native_buttons_are_pressed_by_their_click_message_and_never_behind_a_dialog() {
		let parent = button_parent();
		let pushed = button(parent, "BUTTON", BS_PUSHBUTTON as u32);
		record(pushed);
		let mut ax = Win32Ax::new();
		let element = ax
			.automation()
			.unwrap()
			.element_from_handle(Handle::from(pushed.expose_provenance() as isize))
			.unwrap();
		let handle = uia_handle(element);

		// No message pump runs: the click must have reached the app, as the
		// button's own click message, when the action returns.
		ax.perform(&handle, "press").unwrap();
		assert_eq!((clicks(), click_messages()), (1, 1));
		ax.perform(&handle, "invoke").unwrap();
		assert_eq!((clicks(), click_messages()), (2, 2));

		// A form behind its modal dialog: refused with nothing sent, never
		// handed on to UI Automation.
		// SAFETY: this thread owns the window.
		unsafe { EnableWindow(parent, 0) };
		let error = ax.perform(&handle, "press").unwrap_err();
		assert!(matches!(error.code, ErrorCode::InputFailed), "{error:?}");
		assert_eq!((clicks(), click_messages()), (2, 2));
		// SAFETY: this thread owns the window.
		unsafe { DestroyWindow(parent) };
	}

	#[test]
	fn legacy_deadline_distinguishes_unsent_from_unconfirmed() {
		use crate::desktop::error::ErrorCode;
		let clock = std::cell::Cell::new(Duration::from_millis(1));
		assert!(legacy_before(false, || clock.get()).is_ok());
		assert!(legacy_before(true, || clock.get()).is_ok(), "on-time button acknowledgement");
		clock.set(Duration::ZERO);
		assert_eq!(legacy_before(false, || clock.get()).unwrap_err().code, ErrorCode::Timeout);
		assert_eq!(
			legacy_before(true, || clock.get()).unwrap_err().code,
			ErrorCode::AxUnconfirmed,
			"late button acknowledgement"
		);
	}

	#[test]
	fn a_wpf_press_route_past_its_cutoff_ends_in_timeout_not_a_refusal_or_a_miss() {
		use crate::desktop::error::ErrorCode;
		let refused = || -> CoreResult<()> { Err(DesktopError::background_unavailable("covered")) };
		let left = || Duration::from_millis(1);
		// In time: a hit sends, a miss leaves the click to the ordinary routes
		// and a refusal stands.
		assert!(matches!(legacy_route_end(Ok(()), || Ok(true), left), Ok(Some(()))));
		assert!(matches!(legacy_route_end(Ok(()), || Ok(false), left), Ok(None)));
		let error = legacy_route_end(refused(), || Ok(true), left).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		// Past the cutoff, with the caller's time left, whatever the last checks
		// found.
		for hit in [true, false] {
			for prepared in [Ok(()), refused()] {
				let error = legacy_route_end(prepared, || Ok(hit), || Duration::ZERO).unwrap_err();
				assert_eq!(error.code, ErrorCode::Timeout, "hit {hit}");
			}
		}
		// A timeout met while preparing stands; the point is not checked again.
		let error = legacy_route_end(
			Err::<(), _>(DesktopError::timeout("UI Automation timed out")),
			|| -> CoreResult<bool> { panic!("the point was checked again") },
			left,
		)
		.unwrap_err();
		assert_eq!(error.code, ErrorCode::Timeout);
	}

	#[test]
	fn initial_read_failure_only_keeps_coordinate_takeover_before_dispatch() {
		use crate::desktop::error::ErrorCode;
		for (coordinate, code, expected) in [
			(true, ErrorCode::AxFailed, ErrorCode::BackgroundUnavailable),
			(false, ErrorCode::AxFailed, ErrorCode::AxFailed),
			(true, ErrorCode::Timeout, ErrorCode::Timeout),
		] {
			assert_eq!(
				legacy_initial_error(DesktopError::new(code, "initial read failed"), coordinate).code,
				expected
			);
		}
	}

	/// A WPF window with a button, a check box, a disabled button and a list
	/// row, and an unrelated window of the same app placed beside it, in its
	/// own `PowerShell` process as an app's would be. It prints `ready`, the
	/// two windows' handles and the screen centres of `Bump` and `Off` once
	/// both show, then what its controls do (`checked` when the check box's
	/// state changes, `clicked` for its `Click`, which a UI Automation toggle
	/// does not raise), `activated` whenever the window becomes active, and
	/// `mark` for each mark posted to it.
	const WPF_PRESS: &str = r#"
Add-Type -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml,UIAutomationProvider,UIAutomationTypes -TypeDefinition @'
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls.Primitives;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Threading;
public class StickyBox : CheckBox {
	protected override void OnToggle() { Console.Out.WriteLine("sticky"); Console.Out.Flush(); }
}
public static class Fixture {
	static Window window, other;
	static int bumps, checks;
	static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }
	static IntPtr Hook(IntPtr hwnd, int message, IntPtr w, IntPtr l, ref bool handled) {
		if (message == 0x8007) window.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle, new Action(() => {
			Say("counts " + bumps + " " + checks);
			Say("mark");
		}));
		else if (message == 0x800C) {
			other.Left = window.Left; other.Top = window.Top; other.Width = window.Width; other.Height = window.Height;
			other.UpdateLayout();
			Say("covered");
		}
		return IntPtr.Zero;
	}
	static IntPtr Handle(Window window) { return new WindowInteropHelper(window).Handle; }
	static string Centre(FrameworkElement element) {
		var point = element.PointToScreen(new Point(element.ActualWidth / 2, element.ActualHeight / 2));
		return (int)point.X + " " + (int)point.Y;
	}
	static T Named<T>(T element, string name) where T : FrameworkElement {
		AutomationProperties.SetName(element, name);
		return element;
	}
	public static void Run() {
		var bump = Named(new Button { Content = "Bump" }, "Bump");
		bump.Click += (sender, e) => { bumps++; Say("bumped"); };
		var check = Named(new CheckBox { Content = "Check" }, "Check");
		check.Checked += (sender, e) => { checks++; Say("checked True"); };
		check.Unchecked += (sender, e) => { checks++; Say("checked False"); };
		check.Click += (sender, e) => Say("clicked");
		var off = Named(new Button { Content = "Off", IsEnabled = false }, "Off");
		off.Click += (sender, e) => Say("clicked off");
		var nonqualifying = Named(new ToggleButton { Content = "Disabled toggle", IsEnabled = false }, "Disabled toggle");
		nonqualifying.Click += (sender, e) => Say("clicked disabled toggle");
		var sticky = Named(new StickyBox { Content = "Sticky" }, "Sticky");
		var row = Named(new ListBoxItem { Content = "Row" }, "Row");
		row.Selected += (sender, e) => Say("selected row");
		row.MouseDoubleClick += (sender, e) => Say("opened row");
		var list = new ListBox();
		list.Items.Add(row);
		var panel = new StackPanel();
		foreach (UIElement child in new UIElement[] { bump, check, off, nonqualifying, sticky, list }) panel.Children.Add(child);
		window = new Window { Title = "omp test: wpf press", Left = 40, Top = 40, Width = 300, Height = 240, Content = panel };
		other = new Window { Title = "omp test: wpf other", Left = 500, Top = 40, Width = 240, Height = 160 };
		window.SourceInitialized += (sender, e) => HwndSource.FromHwnd(Handle(window)).AddHook(Hook);
		window.ContentRendered += (sender, e) => {
			other.Show();
			window.Activated += (s, a) => Say("activated");
			Say("ready " + Handle(window) + " " + Handle(other) + " " + Centre(bump) + " " + Centre(off));
			if (other.IsActive) Say("other activated");
			else other.Activated += (s, a) => Say("other activated");
		};
		window.ShowDialog();
	}
}
'@
[Fixture]::Run()
"#;

	struct WpfPress {
		host:   std::process::Child,
		output: flume::Receiver<String>,
		window: HWND,
	}

	impl WpfPress {
		fn line(&self) -> String {
			self.output.recv().expect("the WPF fixture closed")
		}

		/// Posts `message` to the window.
		fn post(&self, message: u32) {
			use windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW;
			// SAFETY: a plain message to a window this test's fixture owns.
			assert_ne!(unsafe { PostMessageW(self.window, message, 0, 0) }, 0, "fixture post failed");
		}

		/// The lines the window prints until `line`, which a press runs from
		/// the window's dispatcher after the call returns.
		fn until(&self, line: &str) -> Vec<String> {
			let mut lines = Vec::new();
			loop {
				match self.line() {
					found if found == line => return lines,
					other => lines.push(other),
				}
			}
		}

		/// Events before an idle-priority dispatcher barrier, with event counts.
		fn printed(&self, bumps: u32, checks: u32) -> Vec<String> {
			self.post(PRESS_MARK);
			let mut lines = self.until("mark");
			assert_eq!(lines.pop(), Some(format!("counts {bumps} {checks}")));
			lines
		}
	}

	impl Drop for WpfPress {
		fn drop(&mut self) {
			let _ = self.host.kill();
			let _ = self.host.wait();
		}
	}

	/// Posted to the WPF window: it prints `mark` when it reads it.
	const PRESS_MARK: u32 = 0x8007;
	/// Posted to the WPF window: its other window moves over it.
	const COVER: u32 = 0x800c;

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn press_and_click_act_on_a_wpf_window_behind_another_and_leave_it_there() {
		use std::{process::Stdio, sync::Arc};

		use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

		use crate::desktop::{
			ParsedPointerOptions, Request, Response, Worker,
			control::{self, CancellationSource},
			error::ErrorCode,
			types::{AxQuery, CaptureCaps, DisplaySelector, Target},
		};

		let _serial = control::OWNERSHIP_TEST.lock();
		let mut host = std::process::Command::new("powershell")
			.args(["-NoProfile", "-Command", WPF_PRESS])
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		let stdout = host.stdout.take().unwrap();
		let (send, output) = flume::unbounded();
		// From here a failed assertion still closes the windows and the pipe.
		let mut app = WpfPress { host, output, window: std::ptr::null_mut() };
		std::thread::spawn(move || {
			use std::io::BufRead;
			for line in std::io::BufReader::new(stdout).lines() {
				let Ok(line) = line else { break };
				if send.send(line.trim().to_string()).is_err() {
					break;
				}
			}
		});
		let ready = app.line();
		let words = ready.split(' ').collect::<Vec<_>>();
		assert_eq!(words[0], "ready");
		let number = |word: &str| word.parse::<i32>().unwrap();
		let handle = |word: &str| with_exposed_provenance_mut(word.parse::<usize>().unwrap());
		let (window, other): (HWND, HWND) = (handle(words[1]), handle(words[2]));
		let (bump, off) =
			((number(words[3]), number(words[4])), (number(words[5]), number(words[6])));
		app.window = window;
		app.until("other activated");
		let mut worker = Worker::new(DisplaySelector::Active, Arc::default(), Arc::default());
		let token = CancellationSource::default().token();
		let target = Target::Window(window.expose_provenance().to_string());
		// SAFETY: GetForegroundWindow has no preconditions.
		let foreground = || unsafe { GetForegroundWindow() };
		let press = |worker: &mut Worker, name: &str| {
			let query = AxQuery { title: Some(name.to_string()), ..AxQuery::default() };
			let request =
				Request::AxQuery { target: target.clone(), query, reply: flume::unbounded().0 };
			let Response::Nodes(nodes) = worker.execute(&request, &token).unwrap() else {
				panic!("AxQuery returns nodes");
			};
			let request = Request::AxPerform {
				reference: nodes[0].ref_.clone(),
				action:    "press".to_string(),
				menu:      None,
				reply:     flume::unbounded().0,
			};
			worker
				.execute(&request, &token)
				.map(drop)
				.inspect_err(|error| {
					if error.code == ErrorCode::AxUnconfirmed {
						let words: Vec<&str> = error
							.message
							.split(|c: char| c.is_whitespace() || matches!(c, ';' | '(' | ')'))
							.collect();
						assert!(words.contains(&nodes[0].ref_.as_str()), "{error}");
						assert!(
							words.contains(&window.expose_provenance().to_string().as_str()),
							"{error}"
						);
					}
				})
		};

		// Behind the app's other window, a button and a check box press
		// through their default action, and the window stays behind.
		press(&mut worker, "Bump").unwrap();
		assert_eq!(app.printed(1, 0), ["bumped"]);
		press(&mut worker, "Check").unwrap();
		assert_eq!(app.printed(1, 1), ["checked True"]);
		// A row's default action is not its press (it may open the row), and a
		// disabled button takes none: neither sends anything.
		let error = press(&mut worker, "Row").unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		let error = press(&mut worker, "Off").unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		assert_eq!(app.printed(1, 1), Vec::<String>::new());
		let error = press(&mut worker, "Disabled toggle").unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		assert_eq!(app.printed(1, 1), Vec::<String>::new());
		let error = press(&mut worker, "Sticky").unwrap_err();
		let printed = app.printed(1, 1);
		assert_eq!(error.code, ErrorCode::AxUnconfirmed, "{error}; fixture events: {printed:?}");
		assert_eq!(printed, ["sticky"], "{error}; fixture events: {printed:?}");
		assert_eq!(foreground(), other, "{error}; fixture events: {printed:?}");

		// A click at a button takes the same route while the point shows it.
		let request = Request::ListWindows { reply: flume::unbounded().0 };
		let Response::Windows(windows) = worker.execute(&request, &token).unwrap() else {
			panic!("ListWindows returns windows");
		};
		let listed = windows
			.iter()
			.find(|listed| listed.id == window.expose_provenance().to_string())
			.expect("the WPF window is listed");
		let request = Request::Capture {
			target: target.clone(),
			caps:   CaptureCaps::default(),
			reply:  flume::unbounded().0,
		};
		let Response::Capture(frame) = worker.execute(&request, &token).unwrap() else {
			panic!("Capture returns a capture");
		};
		let click = |worker: &mut Worker, (x, y): (i32, i32)| {
			let scale = f64::from(frame.coordinate_width) / f64::from(listed.width);
			let request = Request::Click {
				target:  target.clone(),
				x:       f64::from(x - listed.x) * scale,
				y:       f64::from(y - listed.y) * scale,
				options: ParsedPointerOptions::parse(None).unwrap(),
				reply:   flume::unbounded().0,
			};
			worker.execute(&request, &token).map(drop)
		};
		click(&mut worker, bump).unwrap();
		assert_eq!(app.printed(2, 1), ["bumped"]);
		let error = click(&mut worker, off).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		// Covered, the point no longer shows the button: refused.
		app.post(COVER);
		assert_eq!(app.until("covered"), Vec::<String>::new());
		let error = click(&mut worker, bump).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		assert_eq!(app.printed(2, 1), Vec::<String>::new());
		assert_eq!(foreground(), other);
	}

	/// A WPF window with a slider, a combo box and a second combo box nobody
	/// opens before the test, and an unrelated window of the same app, in its
	/// own `PowerShell` process as an app's would be. It prints `ready` and
	/// the two windows' handles once they show, then what happens to its
	/// controls (`level`, `opened`, `selected`, `closed`) and `mark` for each
	/// mark posted to it.
	const WPF_VALUES: &str = r#"
Add-Type -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml,System.Windows.Forms,WindowsFormsIntegration,System.Drawing -TypeDefinition @'
using System;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Interop;
public static class Fixture {
	static Window window, other;
	static ListBox multiple;
	static bool steal;
	static void Say(string line) { Console.Out.WriteLine(line); Console.Out.Flush(); }
	static IntPtr Hook(IntPtr hwnd, int message, IntPtr w, IntPtr l, ref bool handled) {
		if (message == 0x8007) Say("mark");
		else if (message == 0x8008) steal = true;
		else if (message == 0x8009) {
			string selected = "";
			foreach (var item in multiple.SelectedItems) selected += item + ",";
			Say("multiple " + selected);
		}
		return IntPtr.Zero;
	}
	static ComboBox Combo(string name, params string[] items) {
		var combo = new ComboBox();
		foreach (var item in items) combo.Items.Add(item);
		AutomationProperties.SetName(combo, name);
		combo.DropDownOpened += (sender, e) => {
			Say("opened");
			if (steal) { steal = false; other.Activate(); }
		};
		combo.DropDownClosed += (sender, e) => Say("closed");
		combo.SelectionChanged += (sender, e) => Say("selected " + combo.SelectedItem);
		return combo;
	}
	static IntPtr Handle(Window window) { return new WindowInteropHelper(window).Handle; }
	public static void Run() {
		var level = new Slider { Minimum = 0, Maximum = 100 };
		AutomationProperties.SetName(level, "Level");
		level.ValueChanged += (sender, e) => Say("level " + e.NewValue);
		var panel = new StackPanel();
		panel.Children.Add(level);
		panel.Children.Add(Combo("Choice", "One", "Two", "Three"));
		panel.Children.Add(Combo("Cold", "Red", "Blue"));
		panel.Children.Add(Combo("Missing", "Red", "Blue"));
		var reset = Combo("Reset", "One", "Two");
		reset.DropDownClosed += (sender, e) => { reset.SelectedItem = "One"; };
		panel.Children.Add(reset);
		var commit = Combo("Commit", "One", "Two");
		commit.SelectionChanged += (sender, e) => {
			if (commit.IsDropDownOpen && (string)commit.SelectedItem == "Two") commit.SelectedItem = "One";
		};
		commit.DropDownClosed += (sender, e) => { commit.SelectedItem = "Two"; };
		panel.Children.Add(commit);
		multiple = new ListBox { SelectionMode = SelectionMode.Multiple };
		AutomationProperties.SetName(multiple, "Multiple");
		foreach (var item in new[] { "Red", "Green", "Blue" }) multiple.Items.Add(item);
		multiple.SelectedItems.Add("Red");
		multiple.SelectedItems.Add("Green");
		panel.Children.Add(multiple);
		var button = new Button { Content = "OffSide" };
		AutomationProperties.SetName(button, "OffSide");
		button.Click += (sender, e) => Say("clicked");
		var offSide = new System.Windows.Forms.Form {
			Text = "omp test: off-side", StartPosition = System.Windows.Forms.FormStartPosition.Manual,
			Left = 360, Top = 40, Width = 240, Height = 140
		};
		offSide.Controls.Add(new System.Windows.Forms.Integration.ElementHost {
			Child = button, Dock = System.Windows.Forms.DockStyle.Fill
		});
		window = new Window { Title = "omp test: wpf values", Left = 40, Top = 40, Width = 300, Height = 400, Content = panel };
		other = new Window { Title = "omp test: wpf other", ShowActivated = false, Left = 360, Top = 40, Width = 240, Height = 140 };
		window.SourceInitialized += (sender, e) => HwndSource.FromHwnd(Handle(window)).AddHook(Hook);
		window.ContentRendered += (sender, e) => {
			offSide.Show(); other.Show(); window.Activate();
			Say("ready " + Handle(window) + " " + Handle(other) + " " + offSide.Handle);
		};
		window.ShowDialog();
	}
}
'@
[Fixture]::Run()
"#;

	struct WpfValues {
		host:   std::process::Child,
		output: std::io::BufReader<std::process::ChildStdout>,
		window: HWND,
	}

	impl WpfValues {
		fn line(&mut self) -> String {
			use std::io::BufRead;
			let mut line = String::new();
			assert_ne!(self.output.read_line(&mut line).unwrap(), 0, "the WPF window closed");
			line.trim().to_string()
		}

		/// Posts `message` to the window.
		fn post(&self, message: u32) {
			use windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW;
			// SAFETY: a plain message to a window this test's fixture owns.
			unsafe { PostMessageW(self.window, message, 0, 0) };
		}

		/// What the window printed since the last call: everything that
		/// happened in it before it read a mark posted now.
		fn printed(&mut self) -> Vec<String> {
			self.post(MARK);
			let mut lines = Vec::new();
			loop {
				match self.line() {
					mark if mark == "mark" => return lines,
					line => lines.push(line),
				}
			}
		}
	}

	impl Drop for WpfValues {
		fn drop(&mut self) {
			let _ = self.host.kill();
			let _ = self.host.wait();
		}
	}

	/// Posted to the WPF window: it prints `mark` when it reads it.
	const MARK: u32 = 0x8007;
	/// Posted to the WPF window: the next list to open activates its other
	/// window, as a user switching windows would.
	const STEAL: u32 = 0x8008;

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn set_value_writes_a_wpf_slider_as_a_number_and_a_combo_box_as_its_item() {
		use std::{process::Stdio, sync::Arc, time::Duration};

		use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, SetForegroundWindow};

		use crate::desktop::{
			Request, Response, Worker,
			control::{self, CancellationSource},
			types::{AxQuery, DisplaySelector, Target},
		};

		let _serial = control::OWNERSHIP_TEST.lock();
		let mut host = std::process::Command::new("powershell")
			.args(["-NoProfile", "-Command", WPF_VALUES])
			.stdout(Stdio::piped())
			.spawn()
			.unwrap();
		let output = std::io::BufReader::new(host.stdout.take().unwrap());
		// From here a failed assertion still closes the windows.
		let mut app = WpfValues { host, output, window: std::ptr::null_mut() };
		let ready = app.line();
		let words = ready.split(' ').collect::<Vec<_>>();
		assert_eq!(words[0], "ready");
		let handle = |word: &str| with_exposed_provenance_mut(word.parse::<usize>().unwrap());
		let (window, other): (HWND, HWND) = (handle(words[1]), handle(words[2]));
		let off_side: HWND = handle(words[3]);
		app.window = window;
		let mut worker = Worker::new(DisplaySelector::Active, Arc::default(), Arc::default());
		let token = CancellationSource::default().token();
		// SAFETY: GetForegroundWindow has no preconditions.
		let foreground = || unsafe { GetForegroundWindow() };
		let mut set = |name: &str, value: &str| {
			let query = AxQuery { title: Some(name.to_string()), ..AxQuery::default() };
			let request = Request::AxQuery {
				target: Target::Window(
					if name == "OffSide" { off_side } else { window }
						.expose_provenance()
						.to_string(),
				),
				query,
				reply: flume::unbounded().0,
			};
			let Response::Nodes(nodes) = worker.execute(&request, &token).unwrap() else {
				panic!("AxQuery returns nodes");
			};
			let request = Request::AxSetValue {
				reference: nodes[0].ref_.clone(),
				value:     value.to_string(),
				reply:     flume::unbounded().0,
			};
			worker.execute(&request, &token).map(drop)
		};
		// SAFETY: a window of this test's fixture.
		unsafe { SetForegroundWindow(window) };
		assert!(
			window::wait_for_foreground(window, Duration::from_secs(2)).unwrap(),
			"the WPF window did not come to the front: run from a focused terminal"
		);

		set("Level", "0.5").unwrap();
		assert_eq!(app.printed(), ["level 0.5"]);
		// More digits than the number written holds: refused before writing.
		let error = set("Level", "0.5000000000000001").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed, "{error}");
		assert_eq!(app.printed(), Vec::<String>::new());

		let error = set("Multiple", "Blue").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed, "{error}");
		app.post(0x8009);
		assert_eq!(app.printed(), ["multiple Red,Green,"]);

		// A combo box never opened has no items until its list opens: it is
		// opened, the item selected, and the list closed again.
		set("Choice", "Two").unwrap();
		assert_eq!(app.printed(), ["opened", "selected Two", "closed"]);
		let error = set("Choice", "Four").unwrap_err();
		assert!(
			error
				.message
				.contains("the exposed items are One, Two, Three"),
			"{error}"
		);
		assert_eq!(app.printed(), Vec::<String>::new());

		let error = set("Missing", "Green").unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		assert!(error.message.contains("the list now reads closed"), "{error}");
		// UIA's Collapsed state can precede WPF's deferred DropDownClosed.
		// Wait for the event, not a posted mark, before checking what was sent.
		let mut printed = Vec::new();
		loop {
			let line = app.line();
			let closed = line == "closed";
			printed.push(line);
			if closed {
				break;
			}
		}
		assert_eq!(printed, ["opened", "closed"]);
		assert_eq!(app.printed(), Vec::<String>::new());

		let error = set("Reset", "Two").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed, "{error}");
		assert!(
			error
				.message
				.contains("after the list closed, the selection reads"),
			"{error}"
		);
		assert!(error.message.contains("selection reads [One]"), "{error}");
		assert_eq!(app.printed(), ["opened", "selected Two", "closed", "selected One"]);

		// The selected item is restored while open but committed on close.
		set("Commit", "Two").unwrap();
		assert_eq!(app.printed(), [
			"opened",
			"selected Two",
			"selected One",
			"closed",
			"selected Two"
		]);

		// The window losing the foreground once the list is open stops the
		// selection.
		app.post(STEAL);
		assert_eq!(app.printed(), Vec::<String>::new());
		let error = set("Cold", "Blue").unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		assert!(error.message.contains("lost the foreground"), "{error}");
		let printed = app.printed();
		assert!(printed.iter().any(|line| line == "opened"), "{printed:?}");
		assert!(!printed.iter().any(|line| line.starts_with("selected")), "{printed:?}");
		assert_eq!(foreground(), other);

		// Behind another window nothing is sent.
		// A covered windowless button in an unguarded WinForms host still
		// refuses for its missing writable patterns, not its foreground.
		let error = set("OffSide", "anything").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxFailed, "{error}");
		for (name, value) in [("Level", "70"), ("Choice", "Three")] {
			let error = set(name, value).unwrap_err();
			assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		}
		assert_eq!(app.printed(), Vec::<String>::new());
		assert_eq!(foreground(), other);
	}

	#[test]
	fn coordinate_click_rejects_controls_with_position_dependent_subregions() {
		for role in [
			ControlType::SplitButton,
			ControlType::TreeItem,
			ControlType::ListItem,
			ControlType::Pane,
			ControlType::Custom,
			ControlType::Document,
		] {
			assert!(!coordinate_click_supported(role), "{role:?}");
		}
		for role in [
			ControlType::Button,
			ControlType::CheckBox,
			ControlType::RadioButton,
			ControlType::TabItem,
		] {
			assert!(coordinate_click_supported(role), "{role:?}");
		}
	}
}
