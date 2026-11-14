//! The control a background drag presses first, read before and after the
//! drag so a drag that moved nothing is not reported as done, and what any
//! other background drag can read at its two ends, so one that changed
//! nothing readable says so.

use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFBoolean, CFNumber, CFRetained, CFString};

use super::{
	AxBounds, PROBE_TIMEOUT_SECONDS, TextSurface, bounds, copy_attribute, copy_attribute_result,
	copy_element, copy_elements, copy_string, copy_strings_from_action_names, open_menu::hit_test,
	perform_action, probe_application, text_surface, window_id,
};
use crate::desktop::error::CoreResult;

/// The element of `pid` at global point `(x, y)`, where a background drag
/// presses.
pub(crate) struct Pressed {
	element: CFRetained<AXUIElement>,
	role:    Option<String>,
}

pub(crate) fn pressed_at(pid: libc::pid_t, x: f64, y: f64) -> Option<Pressed> {
	let app = probe_application(pid)?;
	let element = hit_test(&app, x, y)?;
	let role = copy_string(&element, "AXRole");
	Some(Pressed { element, role })
}

impl Pressed {
	/// The control whose value the press moves, and that value: the element
	/// itself, or for a value indicator (a slider's knob, a scroll bar's
	/// thumb) its control. `None` when it publishes no numeric `AXValue`.
	pub(crate) fn control(&self) -> Option<(Control, f64)> {
		let element = if self.role.as_deref() == Some("AXValueIndicator") {
			copy_element(&self.element, "AXParent")?
		} else {
			self.element.clone()
		};
		let value = number(&element, "AXValue")?;
		let role = copy_string(&element, "AXRole")?;
		// A scroll bar's value is the fraction scrolled, 0 to 1.
		let range = number(&element, "AXMinValue")
			.zip(number(&element, "AXMaxValue"))
			.or_else(|| (role == "AXScrollBar").then_some((0.0, 1.0)));
		let vertical =
			copy_string(&element, "AXOrientation").as_deref() == Some("AXVerticalOrientation");
		let steps = (role == "AXSlider" && text_surface(&element) == TextSurface::Web)
			.then(|| {
				let actions = copy_strings_from_action_names(&element).ok()?;
				let steps = ["AXIncrement", "AXDecrement"]
					.iter()
					.all(|action| actions.iter().any(|name| name == action));
				steps.then(|| bounds(&element)).flatten()
			})
			.flatten();
		Some((Control { element, role, range, vertical, steps }, value))
	}
}

/// A control that tracks a drag itself and publishes its position as a
/// number: a slider, a scroll bar, a splitter.
pub(crate) struct Control {
	element:             CFRetained<AXUIElement>,
	pub(crate) role:     String,
	/// `AXMinValue` and `AXMaxValue`, when it publishes both.
	pub(crate) range:    Option<(f64, f64)>,
	pub(crate) vertical: bool,
	/// For a slider a web page draws that takes `AXIncrement` and
	/// `AXDecrement`, its frame: a page may take none of a background drag's
	/// moves, so a drag that leaves it short is stepped on.
	pub(crate) steps:    Option<AxBounds>,
}

impl Control {
	pub(crate) fn value(&self) -> Option<f64> {
		number(&self.element, "AXValue")
	}

	/// Signed distance from the thumb's centre to the release, clamped to
	/// the track. Positive means an increment moves toward the release.
	pub(crate) fn distance_to(&self, x: f64, y: f64) -> Option<f64> {
		let frame = self.steps?;
		let thumb = copy_elements(&self.element, "AXChildren")
			.ok()?
			.into_iter()
			.find(|child| copy_string(child, "AXRole").as_deref() == Some("AXValueIndicator"))?;
		let thumb = bounds(&thumb)?;
		thumb_distance(frame, thumb, self.vertical, x, y)
	}

	/// Moves the control one step up (`AXIncrement`) or down (`AXDecrement`).
	pub(crate) fn step(&self, up: bool) -> CoreResult<()> {
		perform_action(&self.element, if up { "AXIncrement" } else { "AXDecrement" })
	}

	/// Whether a pointer moving by `(dx, dy)` moves the control toward its
	/// maximum: rightward on a horizontal slider or scroll bar, up on a
	/// vertical slider (its maximum is at the top), down on a vertical scroll
	/// bar. `None` for any other control (a splitter, a stepper), whose
	/// direction its orientation does not tell.
	pub(crate) fn toward_max(&self, dx: f64, dy: f64) -> Option<bool> {
		match (self.role.as_str(), self.vertical) {
			("AXSlider" | "AXScrollBar", false) => Some(dx > 0.0),
			("AXSlider", true) => Some(dy < 0.0),
			("AXScrollBar", true) => Some(dy > 0.0),
			_ => None,
		}
	}
}

fn number(element: &AXUIElement, attribute: &str) -> Option<f64> {
	copy_attribute(element, attribute)?
		.downcast::<CFNumber>()
		.ok()?
		.as_f64()
		.filter(|value| value.is_finite())
}

/// What accessibility shows of one element: its role, title (or
/// description), value and frame. Two reads that are equal show no change.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Seen {
	pub(crate) role: Option<String>,
	title:           Option<String>,
	value:           Option<String>,
	frame:           Option<(f64, f64, f64, f64)>,
}

/// What accessibility shows of `element`, or `None` when its application
/// does not answer within [`PROBE_TIMEOUT_SECONDS`], which is set on the
/// element itself: a timeout set on the application element covers only
/// that element.
fn seen(element: &AXUIElement) -> Option<Seen> {
	// SAFETY: sets the messaging timeout of this one element (AXUIElement.h).
	let _ = unsafe { element.set_messaging_timeout(PROBE_TIMEOUT_SECONDS) };
	let role = match copy_attribute_result(element, "AXRole") {
		Err(AXError::CannotComplete) => return None,
		Ok(value) => value
			.and_then(|value| value.downcast::<CFString>().ok())
			.map(|role| role.to_string()),
		Err(_) => None,
	};
	Some(Seen {
		role,
		title: copy_string(element, "AXTitle").or_else(|| copy_string(element, "AXDescription")),
		value: value_text(element),
		frame: bounds(element).map(|frame| (frame.x, frame.y, frame.width, frame.height)),
	})
}

/// An element's `AXValue` as text, when it is a string, number or boolean.
fn value_text(element: &AXUIElement) -> Option<String> {
	let value = copy_attribute(element, "AXValue")?;
	let value = match value.downcast::<CFString>() {
		Ok(text) => return Some(text.to_string()),
		Err(value) => value,
	};
	let value = match value.downcast::<CFNumber>() {
		Ok(number) => return number.as_f64().map(|number| number.to_string()),
		Err(value) => value,
	};
	value
		.downcast::<CFBoolean>()
		.ok()
		.map(|flag| flag.as_bool().to_string())
}

/// The two ends of a background drag that starts on no control the drag
/// check tracks: the element under each end, read before anything posts, so
/// the same reads after the release show whether anything readable changed.
/// Only elements of the window the drag goes to count: another window of the
/// application above it would answer the hit-test instead.
pub(crate) struct DragEnds {
	pid:      libc::pid_t,
	wid:      u32,
	points:   [(f64, f64); 2],
	elements: [Option<CFRetained<AXUIElement>>; 2],
}

impl DragEnds {
	pub(crate) fn at(pid: libc::pid_t, wid: u32, start: (f64, f64), end: (f64, f64)) -> Self {
		let app = probe_application(pid);
		let ends = Self { pid, wid, points: [start, end], elements: [None, None] };
		let elements = [ends.under(app.as_deref(), start), ends.under(app.as_deref(), end)];
		Self { elements, ..ends }
	}

	/// The element of window `wid` under `(x, y)`.
	fn under(
		&self,
		app: Option<&AXUIElement>,
		(x, y): (f64, f64),
	) -> Option<CFRetained<AXUIElement>> {
		hit_test(app?, x, y).filter(|element| {
			copy_element(element, "AXWindow").and_then(|window| window_id(&window)) == Some(self.wid)
		})
	}

	/// What the two elements read before show now, then what is under each
	/// end now: a value that changed, an element that moved, or another
	/// element under an end all differ from the read before the drag.
	pub(crate) fn read(&self) -> [Option<Seen>; 4] {
		let app = probe_application(self.pid);
		let under = |point| {
			self
				.under(app.as_deref(), point)
				.and_then(|element| seen(&element))
		};
		[
			self.elements[0].as_deref().and_then(seen),
			self.elements[1].as_deref().and_then(seen),
			under(self.points[0]),
			under(self.points[1]),
		]
	}
}

fn thumb_distance(frame: AxBounds, thumb: AxBounds, vertical: bool, x: f64, y: f64) -> Option<f64> {
	let (start, length, centre, half, end) = if vertical {
		(frame.y, frame.height, thumb.y + thumb.height / 2.0, thumb.height / 2.0, y)
	} else {
		(frame.x, frame.width, thumb.x + thumb.width / 2.0, thumb.width / 2.0, x)
	};
	if length <= 2.0 * half {
		return None;
	}
	let distance = end.clamp(start + half, start + length - half) - centre;
	Some(if vertical { -distance } else { distance })
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn a_slider_path_past_the_track_finishes_at_its_limit() {
		let frame = AxBounds { x: 0.0, y: 0.0, width: 100.0, height: 16.0 };
		let thumb = AxBounds { x: 90.0, y: 0.0, width: 10.0, height: 16.0 };
		assert_eq!(thumb_distance(frame, thumb, false, 150.0, 8.0), Some(0.0));
	}
}
