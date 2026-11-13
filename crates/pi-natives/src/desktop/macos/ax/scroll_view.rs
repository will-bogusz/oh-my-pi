//! The scroll view under a background scroll, read before and after it so a
//! scroll that moved nothing is not reported as done.

use objc2_application_services::AXUIElement;
use objc2_core_foundation::{CFNumber, CFRetained};

use super::{
	bounds, copy_attribute, copy_element, copy_elements_optional, copy_string, open_menu::hit_test,
	probe_application,
};

/// How many ancestors of the element under the pointer are searched for its
/// scroll view.
const MAX_ASCENT: usize = 12;

/// A rectangle in global points, top-left origin.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Frame {
	pub(crate) x:      f64,
	pub(crate) y:      f64,
	pub(crate) width:  f64,
	pub(crate) height: f64,
}

/// Where a scroll view is scrolled. Its scroll bars publish how far on each
/// axis (0 at the top or left end, 1 at the bottom or right end; `None` for
/// an axis with no scroll bar), and the content it scrolls (`AXContents`)
/// sits at `content` while the view spans `view`. A scroll bar's value can
/// lag behind the content: one scrolled in code without telling its scroll
/// view keeps showing where it was until the next scroll, while the
/// content's frame follows at once.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScrollPosition {
	pub(crate) horizontal: Option<f64>,
	pub(crate) vertical:   Option<f64>,
	pub(crate) content:    Option<Frame>,
	pub(crate) view:       Option<Frame>,
}

/// The innermost `AXScrollArea` of `pid` at global point `(x, y)`, which a
/// wheel event there scrolls first. A web page's scrolling element has none:
/// Chromium puts it straight under the `AXWebArea`, with no scroll bars or
/// other scroll position, so a scroll in web content goes unchecked.
pub(crate) struct ScrollView {
	area: CFRetained<AXUIElement>,
}

pub(crate) fn at(pid: libc::pid_t, x: f64, y: f64) -> Option<ScrollView> {
	let app = probe_application(pid)?;
	let mut element = hit_test(&app, x, y)?;
	for _ in 0..MAX_ASCENT {
		match copy_string(&element, "AXRole").as_deref() {
			Some("AXScrollArea") => return Some(ScrollView { area: element }),
			Some("AXWindow" | "AXApplication") | None => return None,
			Some(_) => element = copy_element(&element, "AXParent")?,
		}
	}
	None
}

impl ScrollView {
	/// Where the view is scrolled, or `None` when it publishes no scroll bar
	/// value on either axis.
	pub(crate) fn position(&self) -> Option<ScrollPosition> {
		let position = ScrollPosition {
			horizontal: bar(&self.area, "AXHorizontalScrollBar"),
			vertical:   bar(&self.area, "AXVerticalScrollBar"),
			content:    copy_elements_optional(&self.area, "AXContents")
				.and_then(|contents| contents.first().and_then(|content| frame(content))),
			view:       frame(&self.area),
		};
		(position.horizontal.is_some() || position.vertical.is_some()).then_some(position)
	}
}

fn frame(element: &AXUIElement) -> Option<Frame> {
	bounds(element).map(|bounds| Frame {
		x:      bounds.x,
		y:      bounds.y,
		width:  bounds.width,
		height: bounds.height,
	})
}

fn bar(area: &AXUIElement, attribute: &str) -> Option<f64> {
	let bar = copy_element(area, attribute)?;
	copy_attribute(&bar, "AXValue")?
		.downcast::<CFNumber>()
		.ok()?
		.as_f64()
		.filter(|value| value.is_finite())
}
