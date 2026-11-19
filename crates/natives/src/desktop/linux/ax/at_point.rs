//! Pixel clicks and scrolls on a window, carried out through the accessibility
//! element under the point.
//!
//! Where no input route reaches a background window (Wayland), a click at a
//! point can still do what the user's click would when the point resolves to
//! a control whose own action is that click: a button, check box, menu item
//! or list row. Anything else under the point (a text area, a canvas, a pane,
//! a menu whose press opens a popup) is declined before anything is sent: an
//! action there is not the same input, and firing a bare frame's default
//! action would be a false success.

use super::*;
use crate::desktop::control;

/// What a point action did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PointOutcome {
	/// The action was sent and, where the element exposes the state it
	/// changes, the change was read back.
	Done,
	/// Nothing was sent; why.
	Declined(String),
}

/// How far above a decorative leaf (a button's label, an icon) the control
/// that owns the point may sit: GTK4 and Chromium hit-test to a button's
/// label, GTK 3 to a list row's.
const LEAF_TO_CONTROL: usize = 2;
/// How far above the element under the point a scrollable ancestor may sit.
const SCROLL_DEPTH: usize = 16;
/// How long a toggled or selected state may take to show (`LibreOffice`
/// updates a toolbar toggle's state about 0.7 s after its action).
const STATE_SETTLE: Duration = Duration::from_millis(1500);

/// How a point click on an element of `role` is carried out.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ClickKind {
	/// Its activation action (`press`, `click`, `toggle`, `select` …).
	Control,
	/// A row: its activation action, or else selecting it in its parent.
	Row,
}

const fn click_kind(role: Role) -> Option<ClickKind> {
	match role {
		Role::Button
		| Role::ToggleButton
		| Role::CheckBox
		| Role::RadioButton
		| Role::Link
		| Role::PageTab
		| Role::MenuItem
		| Role::CheckMenuItem
		| Role::RadioMenuItem => Some(ClickKind::Control),
		Role::ListItem | Role::TableCell | Role::TreeItem => Some(ClickKind::Row),
		_ => None,
	}
}

/// A leaf that only shows part of a control: the label or icon a toolkit
/// hit-tests to instead of the control around it, or a childless pane drawn
/// inside it (GTK4's check box indicator).
const fn decorative(role: Role, children: i32) -> bool {
	matches!(role, Role::Label | Role::Static | Role::Image | Role::Icon)
		|| (children == 0 && matches!(role, Role::Panel | Role::Filler))
}

/// Whether a point click may act on an element in `states`: one the user can
/// operate, that is on screen, whose click neither places a caret nor opens a
/// popup (a popup grabs the user's keyboard).
fn clickable(kind: ClickKind, states: StateSet) -> Result<(), &'static str> {
	if !state_enabled(states) {
		return Err("disabled");
	}
	if !states.contains(State::Showing) {
		return Err("not showing");
	}
	if states.contains(State::Editable) {
		return Err("editable (a click there places a caret)");
	}
	if states.contains(State::HasPopup) || (kind == ClickKind::Control && states.contains(State::Expandable))
	{
		return Err("opens a popup");
	}
	Ok(())
}

/// The state a click on a `role` element flips, read back after acting.
const fn watched_state(kind: ClickKind, role: Role) -> Option<State> {
	match (kind, role) {
		(ClickKind::Row, _) => Some(State::Selected),
		(
			_,
			Role::CheckBox
			| Role::RadioButton
			| Role::CheckMenuItem
			| Role::RadioMenuItem
			| Role::ToggleButton,
		) => Some(State::Checked),
		_ => None,
	}
}

/// Whether `before` → `after` shows the click took: a toggle flipped (a
/// toggle button may report `Pressed` instead of `Checked`), a radio button or
/// row that was already on stays on, as it does after a real click.
fn took_effect(watched: State, role: Role, before: StateSet, after: StateSet) -> bool {
	let on = |states: StateSet| {
		states.contains(watched) || (watched == State::Checked && states.contains(State::Pressed))
	};
	let stays_on = matches!(role, Role::RadioButton | Role::RadioMenuItem) || watched == State::Selected;
	on(before) != on(after) || (stays_on && on(after))
}

/// Wheel detents along one axis as pixels: GTK's own wheel step for a
/// viewport of `page` pixels, `page^(2/3)` per detent.
fn detent_pixels(page: f64, detents: f64) -> f64 {
	page.max(1.0).powf(2.0 / 3.0) * detents
}

fn ax_error(context: &str, err: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("{context}: {err}"))
}

struct Element<'a> {
	object:     ObjectRefOwned,
	accessible: AccessibleProxy<'a>,
	role:       Role,
	states:     StateSet,
	name:       String,
	children:   i32,
}

impl Element<'_> {
	fn describe(&self) -> String {
		let role = normalize_role_atspi(self.role.name(), false);
		if self.name.is_empty() { role } else { format!("{role} '{}'", self.name) }
	}
}

async fn element(connection: &Connection, object: ObjectRefOwned, reply_timeout: Duration) -> CoreResult<Element<'_>> {
	const AT: &str = "AT-SPI element at point";
	let accessible = answered("the application", reply_timeout, object.clone().into_accessible_proxy(connection))
		.await?
		.map_err(|err| ax_error(AT, err))?;
	let role = answered("the application", reply_timeout, accessible.get_role())
		.await?
		.map_err(|err| ax_error(AT, err))?;
	let states = answered("the application", reply_timeout, accessible.get_state())
		.await?
		.map_err(|err| ax_error(AT, err))?;
	let name = answered("the application", reply_timeout, accessible.name())
		.await?
		.unwrap_or_default();
	let children = answered("the application", reply_timeout, accessible.child_count())
		.await?
		.unwrap_or_default();
	Ok(Element { object, accessible, role, states, name, children })
}

impl AtSpiAx {
	/// The element of `window` under screen point (`x`, `y`), resolved inside
	/// that window only: whatever covers the point on screen is not asked.
	fn hit_in(&mut self, window: &DesktopWindow, x: f64, y: f64) -> CoreResult<Result<ObjectRefOwned, String>> {
		let root = self.window_root(window)?;
		let root = Self::object(&root).clone();
		let (x, y) = (x.round() as i32, y.round() as i32);
		let Self { rt, connection, native, frames, reply_timeout } = self;
		let connection = &*connection;
		rt.block_on(cancellable(async {
			let Some(placement) = frames.claim(connection, native.as_deref(), &root, x, y).await? else {
				return Ok(Err(
					"the point is outside the window, or the window's place on screen is unknown".to_owned(),
				));
			};
			Ok(Self::descend(connection, root, placement, x, y, *reply_timeout)
				.await?
				.map(|handle| Self::object(&handle).clone())
				.ok_or_else(|| "nothing accessible is at the point".to_owned()))
		}))?
	}

	/// Clicks screen point (`x`, `y`) of `window` through the control under it
	/// ([module docs](self)). `windows` is the window list ownership is
	/// checked against.
	pub(crate) fn click_at(
		&mut self,
		window: &DesktopWindow,
		windows: &[DesktopWindow],
		x: f64,
		y: f64,
	) -> CoreResult<PointOutcome> {
		let hit = match self.hit_in(window, x, y)? {
			Ok(hit) => hit,
			Err(why) => return Ok(PointOutcome::Declined(why)),
		};
		let owner = self.window_id(&AxHandle::AtSpi(hit.clone()), windows);
		if !owner.as_ref().is_ok_and(|id| *id == window.id) {
			return Ok(PointOutcome::Declined(
				"the element under the point belongs to another window".to_owned(),
			));
		}
		let reply_timeout = self.reply_timeout;
		self.run(async {
			let connection = &self.connection;
			let mut target = element(connection, hit, reply_timeout).await?;
			let hit_description = target.describe();
			let mut kind = click_kind(target.role);
			let mut climbed = 0;
			while kind.is_none() && decorative(target.role, target.children) && climbed < LEAF_TO_CONTROL {
				let parent = answered("the application", reply_timeout, target.accessible.parent())
					.await?
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
				if parent.is_null() {
					break;
				}
				target = element(connection, parent, reply_timeout).await?;
				kind = click_kind(target.role);
				climbed += 1;
			}
			let Some(kind) = kind else {
				return Ok(PointOutcome::Declined(format!(
					"the point is on {hit_description}, which is not a control a click there can be \
					 carried out on through accessibility"
				)));
			};
			if let Err(why) = clickable(kind, target.states) {
				return Ok(PointOutcome::Declined(format!(
					"the point is on {}, which is {why}",
					target.describe()
				)));
			}
			let action = Self::action(connection, &target.object).await.ok();
			let index = match &action {
				Some(action) => resolve_action(action, &target.accessible, "press").await.ok(),
				None => None,
			};
			let watched = watched_state(kind, target.role);
			control::check()?;
			match (index, action, kind) {
				(Some(index), Some(action), _) => {
					let sent = answered("the application", reply_timeout, action.do_action(index))
						.await?
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?;
					if !sent {
						return Err(DesktopError::ax_failed(format!(
							"{} refused its accessibility action",
							target.describe()
						)));
					}
				},
				(_, _, ClickKind::Row) => {
					let parent = answered("the application", reply_timeout, target.accessible.parent())
						.await?
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
					let index = answered("the application", reply_timeout, target.accessible.get_index_in_parent())
						.await?
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI row index: {err}")))?;
					let Some(selection) = selection(connection, &parent).await else {
						return Ok(PointOutcome::Declined(format!(
							"the point is on {}, which has no action and whose list takes no \
							 accessible selection",
							target.describe()
						)));
					};
					let sent = answered("the application", reply_timeout, selection.select_child(index))
						.await?
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI select row: {err}")))?;
					if !sent {
						return Err(DesktopError::ax_failed(format!(
							"the list refused to select {}",
							target.describe()
						)));
					}
				},
				_ => {
					return Ok(PointOutcome::Declined(format!(
						"the point is on {}, which has no activation action",
						target.describe()
					)));
				},
			}
			let Some(watched) = watched else {
				return Ok(PointOutcome::Done);
			};
			let deadline = tokio::time::Instant::now() + STATE_SETTLE;
			loop {
				let after = answered("the application", reply_timeout, target.accessible.get_state())
					.await?
					.ok();
				if after.is_some_and(|after| took_effect(watched, target.role, target.states, after)) {
					return Ok(PointOutcome::Done);
				}
				if tokio::time::Instant::now() >= deadline {
					return Err(DesktopError::ax_unconfirmed(format!(
						"carried the click out on {} through accessibility, but its state did not \
						 change within {} ms; the click may not have taken effect: inspect the \
						 target before clicking again",
						target.describe(),
						STATE_SETTLE.as_millis()
					)));
				}
				tokio::time::sleep(Duration::from_millis(25)).await;
			}
		})?
	}

	/// Scrolls the scrollable element under screen point (`x`, `y`) of
	/// `window` by `dx`/`dy` wheel detents (positive: right/down): its scroll
	/// bar's value (GTK), or else `ScrollTo` on the child that far into a
	/// list that advertises scroll actions (Chromium). A detent is GTK's own wheel
	/// step, `page^(2/3)` pixels of a `page`-pixel viewport.
	pub(crate) fn scroll_at(
		&mut self,
		window: &DesktopWindow,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
	) -> CoreResult<PointOutcome> {
		let (vertical, detents) = match (dx == 0.0, dy == 0.0) {
			(true, false) => (true, dy),
			(false, true) => (false, dx),
			(true, true) => return Ok(PointOutcome::Done),
			(false, false) => {
				return Ok(PointOutcome::Declined(
					"a diagonal scroll has no accessibility route; scroll one axis at a time".to_owned(),
				));
			},
		};
		let hit = match self.hit_in(window, x, y)? {
			Ok(hit) => hit,
			Err(why) => return Ok(PointOutcome::Declined(why)),
		};
		let reply_timeout = self.reply_timeout;
		self.run(async {
			let connection = &self.connection;
			const AT: &str = "AT-SPI scroll";
			let mut current = hit;
			for _ in 0..SCROLL_DEPTH {
				let accessible = answered("the application", reply_timeout, current.as_accessible_proxy(connection))
					.await?
					.map_err(|err| ax_error(AT, err))?;
				if let Some(outcome) =
					scroll_bar_route(connection, &current, &accessible, vertical, detents, reply_timeout).await?
				{
					return Ok(outcome);
				}
				if let Some(outcome) =
					scroll_to_route(connection, &current, &accessible, vertical, detents, reply_timeout).await?
				{
					return Ok(outcome);
				}
				let role = answered("the application", reply_timeout, accessible.get_role())
					.await?
					.map_err(|err| ax_error(AT, err))?;
				if top_level_role(role, false) || role == Role::Application {
					break;
				}
				let parent = answered("the application", reply_timeout, accessible.parent())
					.await?
					.map_err(|err| ax_error(AT, err))?;
				if parent.is_null() || parent == current {
					break;
				}
				drop(accessible);
				current = parent;
			}
			Ok(PointOutcome::Declined(
				"no element under the point exposes a scroll bar value or scroll actions over \
				 accessibility"
					.to_owned(),
			))
		})?
	}
}

/// `object`'s `Selection` proxy, when it has that interface.
async fn selection<'a>(
	connection: &'a Connection,
	object: &'a ObjectRefOwned,
) -> Option<atspi::proxy::selection::SelectionProxy<'a>> {
	let accessible = object.as_accessible_proxy(connection).await.ok()?;
	if !accessible
		.get_interfaces()
		.await
		.ok()?
		.contains(atspi::Interface::Selection)
	{
		return None;
	}
	atspi::proxy::selection::SelectionProxy::builder(connection)
		.destination(object.name()?.clone())
		.ok()?
		.path(object.path().clone())
		.ok()?
		.cache_properties(CacheProperties::No)
		.build()
		.await
		.ok()
}

/// Scrolls through a showing scroll bar child of `parent` along the axis that
/// holds a `Value`, by `detents` of `parent`'s viewport. `None` when `parent`
/// has none.
async fn scroll_bar_route(
	connection: &Connection,
	parent: &ObjectRefOwned,
	accessible: &AccessibleProxy<'_>,
	vertical: bool,
	detents: f64,
	reply_timeout: Duration,
) -> CoreResult<Option<PointOutcome>> {
	let count = answered("the application", reply_timeout, accessible.child_count())
		.await?
		.ok()
		.and_then(|count| u32::try_from(count).ok());
	let Ok((children, _)) = answered("the application", reply_timeout, children_of(accessible, count, 32)).await?
	else {
		return Ok(None);
	};
	for child in children {
		let Ok(child_proxy) = child.as_accessible_proxy(connection).await else {
			continue;
		};
		if child_proxy.get_role().await.ok() != Some(Role::ScrollBar) {
			continue;
		}
		let Ok(states) = child_proxy.get_state().await else {
			continue;
		};
		let axis = if vertical { State::Vertical } else { State::Horizontal };
		if !states.contains(axis) || !states.contains(State::Showing) {
			continue;
		}
		let Some(name) = child.name() else {
			continue;
		};
		let failed = |err: zbus::Error| DesktopError::ax_failed(format!("AT-SPI scroll bar: {err}"));
		let value = atspi::proxy::value::ValueProxy::builder(connection)
			.destination(name.clone())
			.and_then(|builder| builder.path(child.path().clone()))
			.map_err(failed)?
			.cache_properties(CacheProperties::No)
			.build()
			.await
			.map_err(failed)?;
		let Ok(before) = answered("the application", reply_timeout, value.current_value()).await? else {
			continue;
		};
		let (Ok(min), Ok(max)) = futures::join!(value.minimum_value(), value.maximum_value()) else {
			continue;
		};
		if max <= min {
			continue;
		}
		let Ok((.., page_width, page_height)) = AtSpiAx::component(connection, parent)
			.await
			.map_err(DesktopError::ax_failed)?
			.get_extents(CoordType::Window)
			.await
		else {
			continue;
		};
		let page = f64::from(if vertical { page_height } else { page_width });
		let target = (before + detent_pixels(page, detents)).clamp(min, max);
		if target == before {
			// At the end already, where a wheel does nothing either.
			return Ok(Some(PointOutcome::Done));
		}
		control::check()?;
		answered("the application", reply_timeout, value.set_current_value(target))
			.await?
			.map_err(failed)?;
		let deadline = tokio::time::Instant::now() + VALUE_SETTLE;
		loop {
			let now = answered("the application", reply_timeout, value.current_value())
				.await?
				.unwrap_or(before);
			if now != before {
				return Ok(Some(PointOutcome::Done));
			}
			if tokio::time::Instant::now() >= deadline {
				return Err(DesktopError::ax_unconfirmed(format!(
					"set the scroll bar to {target} through accessibility, but it still reads {before}; \
					 the scroll may not have taken effect"
				)));
			}
			tokio::time::sleep(Duration::from_millis(25)).await;
		}
	}
	Ok(None)
}

/// Scrolls `scrollable` when it advertises scroll actions (Chromium), whose
/// own actions move a whole page: `ScrollTo` brings to the viewport's edge
/// the child that sits `detents` of the viewport past it, found by bisecting
/// the children by position. `None` when `scrollable` advertises none.
async fn scroll_to_route(
	connection: &Connection,
	scrollable: &ObjectRefOwned,
	accessible: &AccessibleProxy<'_>,
	vertical: bool,
	detents: f64,
	reply_timeout: Duration,
) -> CoreResult<Option<PointOutcome>> {
	let Ok(action) = AtSpiAx::action(connection, scrollable).await else {
		return Ok(None);
	};
	let Ok(names) = answered("the application", reply_timeout, action_names(&action)).await? else {
		return Ok(None);
	};
	let advertised = if vertical { ["scrollup", "scrolldown"] } else { ["scrollleft", "scrollright"] };
	if !names
		.iter()
		.any(|name| advertised.iter().any(|safe| folds_to(name, safe)))
	{
		return Ok(None);
	}
	let failed = |err: String| DesktopError::ax_failed(format!("AT-SPI scroll to: {err}"));
	let Ok((left, top, width, height)) = AtSpiAx::component(connection, scrollable)
		.await
		.map_err(failed)?
		.get_extents(CoordType::Window)
		.await
	else {
		return Ok(None);
	};
	let (start, page) = if vertical { (top, height) } else { (left, width) };
	let wanted = start + detent_pixels(f64::from(page), detents).round() as i32;
	let count = answered("the application", reply_timeout, accessible.child_count())
		.await?
		.unwrap_or_default();
	if count < 1 {
		return Ok(None);
	}
	// The first child starting at or past `wanted`, else the last.
	let (mut low, mut high) = (0, count);
	while low < high {
		let middle = low + (high - low) / 2;
		match child_edge(connection, accessible, middle, vertical, reply_timeout).await? {
			Some((_, at)) if at < wanted => low = middle + 1,
			Some(_) => high = middle,
			None => return Ok(None),
		}
	}
	let Some((target, before)) =
		child_edge(connection, accessible, low.min(count - 1), vertical, reply_timeout).await?
	else {
		return Ok(None);
	};
	if before == start {
		return Ok(Some(PointOutcome::Done));
	}
	let component = AtSpiAx::component(connection, &target).await.map_err(failed)?;
	let edge_type = if vertical { atspi::ScrollType::TopEdge } else { atspi::ScrollType::LeftEdge };
	control::check()?;
	answered("the application", reply_timeout, component.scroll_to(edge_type))
		.await?
		.map_err(|err| failed(err.to_string()))?;
	let deadline = tokio::time::Instant::now() + VALUE_SETTLE;
	loop {
		let moved = answered("the application", reply_timeout, component.get_extents(CoordType::Window))
			.await?
			.is_ok_and(|(x, y, ..)| (if vertical { y } else { x }) != before);
		if moved {
			return Ok(Some(PointOutcome::Done));
		}
		if tokio::time::Instant::now() >= deadline {
			return Err(DesktopError::ax_unconfirmed(
				"asked the list to scroll its row into place through accessibility, but the row did \
				 not move; the scroll may not have taken effect",
			));
		}
		tokio::time::sleep(Duration::from_millis(25)).await;
	}
}

/// Child `index` of `parent` and where it starts along the axis, in window
/// coordinates.
async fn child_edge(
	connection: &Connection,
	parent: &AccessibleProxy<'_>,
	index: i32,
	vertical: bool,
	reply_timeout: Duration,
) -> CoreResult<Option<(ObjectRefOwned, i32)>> {
	let Ok(child) = answered("the application", reply_timeout, parent.get_child_at_index(index)).await? else {
		return Ok(None);
	};
	let Ok(component) = AtSpiAx::component(connection, &child).await else {
		return Ok(None);
	};
	Ok(answered("the application", reply_timeout, component.get_extents(CoordType::Window))
		.await?
		.ok()
		.map(|(x, y, ..)| (child, if vertical { y } else { x })))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn only_controls_and_rows_take_point_clicks() {
		for role in [Role::Button, Role::CheckBox, Role::MenuItem, Role::Link, Role::PageTab] {
			assert_eq!(click_kind(role), Some(ClickKind::Control), "{role:?}");
		}
		for role in [Role::ListItem, Role::TableCell, Role::TreeItem] {
			assert_eq!(click_kind(role), Some(ClickKind::Row), "{role:?}");
		}
		for role in [
			Role::Frame,
			Role::Panel,
			Role::Filler,
			Role::ScrollPane,
			Role::Canvas,
			Role::DrawingArea,
			Role::Text,
			Role::Entry,
			Role::Paragraph,
			Role::DocumentText,
			Role::DocumentWeb,
			Role::Terminal,
			Role::Menu,
			Role::ComboBox,
			Role::Slider,
			Role::ScrollBar,
			Role::Label,
		] {
			assert_eq!(click_kind(role), None, "{role:?}");
		}
	}

	#[test]
	fn a_click_that_would_place_a_caret_or_open_a_popup_is_declined() {
		let on = StateSet::new(State::Enabled | State::Showing);
		assert_eq!(clickable(ClickKind::Control, on), Ok(()));
		for extra in [State::Editable, State::HasPopup, State::Expandable] {
			assert!(clickable(ClickKind::Control, on | StateSet::new(extra)).is_err(), "{extra:?}");
		}
		assert!(clickable(ClickKind::Row, on | StateSet::new(State::Expandable)).is_ok());
		assert!(clickable(ClickKind::Control, StateSet::new(State::Showing)).is_err());
		assert!(clickable(ClickKind::Control, StateSet::new(State::Enabled)).is_err());
	}

	#[test]
	fn a_click_took_effect_when_its_state_moved_the_way_a_real_click_moves_it() {
		let off = StateSet::new(State::Enabled);
		let checked = off | StateSet::new(State::Checked);
		assert!(took_effect(State::Checked, Role::CheckBox, off, checked));
		assert!(took_effect(State::Checked, Role::CheckBox, checked, off));
		assert!(!took_effect(State::Checked, Role::CheckBox, off, off));
		assert!(took_effect(State::Checked, Role::ToggleButton, off, off | StateSet::new(State::Pressed)));
		assert!(took_effect(State::Checked, Role::RadioButton, checked, checked));
		let selected = off | StateSet::new(State::Selected);
		assert!(took_effect(State::Selected, Role::ListItem, off, selected));
		assert!(took_effect(State::Selected, Role::ListItem, selected, selected));
		assert!(!took_effect(State::Selected, Role::ListItem, off, off));
	}

	#[test]
	fn a_detent_is_the_gtk_wheel_step_of_the_viewport() {
		assert!((detent_pixels(300.0, 1.0) - 44.81).abs() < 0.01);
		assert!((detent_pixels(300.0, -2.0) + 89.63).abs() < 0.01);
	}
}
