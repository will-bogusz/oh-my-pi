//! The agent cursor: a coloured arrow and name badge drawn where an agent's
//! input lands, so a person watching sees which agent acts where. One overlay
//! helper per process draws every session's cursor (macOS only; other
//! platforms draw none). Input never waits on it: events go through a bounded
//! queue that drops what it cannot hold, and the helper starts on the first
//! event that queue's thread takes.
#![cfg_attr(
	not(target_os = "macos"),
	allow(dead_code, reason = "only macOS draws the cursor; elsewhere its events go nowhere")
)]

#[cfg(target_os = "macos")]
use std::sync::LazyLock;
use std::sync::{
	Arc,
	mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
};

use parking_lot::Mutex;
use serde::Serialize;

use super::types::DesktopCursor;

/// Events the queue holds before it drops new ones.
const QUEUE_CAPACITY: usize = 64;

/// What the agent did at the point; it picks the cursor's animation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CursorKind {
	Move,
	Click,
	Drag,
	Scroll,
	Type,
	Key,
	/// Removes the agent's cursor at once rather than after its idle fade.
	Hide,
}

/// One cursor event; the point is in global top-left points, the space
/// `map_point` maps window coordinates into.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CursorEvent {
	pub agent: Arc<DesktopCursor>,
	pub kind:  CursorKind,
	pub point: Option<(f64, f64)>,
}

/// One display's bounds in global top-left points.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Screen {
	pub id:     u32,
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
}

/// The display holding global point `(x, y)`, and the point relative to that
/// display's top-left corner. Bounds are in points whatever a display's pixel
/// scale, so a Retina display beside a 1x one maps without scaling.
pub(crate) fn locate(screens: &[Screen], x: f64, y: f64) -> Option<(u32, f64, f64)> {
	screens
		.iter()
		.find(|screen| {
			x >= screen.x
				&& y >= screen.y
				&& x < screen.x + screen.width
				&& y < screen.y + screen.height
		})
		.map(|screen| (screen.id, x - screen.x, y - screen.y))
}

#[derive(Serialize)]
struct Line<'a> {
	agent:   &'a str,
	label:   &'a str,
	color:   &'a str,
	kind:    CursorKind,
	#[serde(skip_serializing_if = "Option::is_none")]
	display: Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	x:       Option<f64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	y:       Option<f64>,
}

/// The helper's input line for `event`; `None` when its point lies on no
/// display in `screens`.
pub(crate) fn encode(event: &CursorEvent, screens: &[Screen]) -> Option<Vec<u8>> {
	let placed = match event.point {
		Some((x, y)) => Some(locate(screens, x, y)?),
		None => None,
	};
	let mut line = serde_json::to_vec(&Line {
		agent:   &event.agent.id,
		label:   &event.agent.label,
		color:   &event.agent.color,
		kind:    event.kind,
		display: placed.map(|(display, ..)| display),
		x:       placed.map(|(_, x, _)| x),
		y:       placed.map(|(.., y)| y),
	})
	.ok()?;
	line.push(b'\n');
	Some(line)
}

/// A bounded event queue whose sender never blocks.
pub(crate) struct Queue(SyncSender<CursorEvent>);

impl Queue {
	pub(crate) fn new(capacity: usize) -> (Self, Receiver<CursorEvent>) {
		let (tx, rx) = sync_channel(capacity);
		(Self(tx), rx)
	}

	/// Queues `event`, or drops it when the queue is full or its reader gone.
	pub(crate) fn offer(&self, event: CursorEvent) -> bool {
		match self.0.try_send(event) {
			Ok(()) => true,
			Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => false,
		}
	}
}

/// The process's queue to its overlay helper, read through `send`: the
/// thread that drains it starts on the first event.
#[cfg(target_os = "macos")]
static QUEUE: LazyLock<Option<Queue>> = LazyLock::new(|| {
	let (queue, events) = Queue::new(QUEUE_CAPACITY);
	std::thread::Builder::new()
		.name("omp-agent-cursor".into())
		.spawn(move || super::macos::cursor::serve(&events))
		.ok()?;
	Some(queue)
});

#[derive(Default)]
struct State {
	agent: Option<Arc<DesktopCursor>>,
	last:  Option<(f64, f64)>,
}

/// One session's cursor: the agent it draws, if any, and where its input
/// last landed, which typing and keys without a point reuse.
pub(crate) struct AgentCursor {
	state: Mutex<State>,
	/// Where its events go; `None` on a platform that draws no cursor.
	sink:  Option<fn(CursorEvent)>,
}

impl Default for AgentCursor {
	fn default() -> Self {
		#[cfg(target_os = "macos")]
		let sink: Option<fn(CursorEvent)> = Some(send);
		#[cfg(not(target_os = "macos"))]
		let sink = None;
		Self { state: Mutex::default(), sink }
	}
}

impl AgentCursor {
	/// A cursor whose events go to `sink`.
	#[cfg(test)]
	pub(crate) fn with_sink(sink: fn(CursorEvent)) -> Self {
		Self { state: Mutex::default(), sink: Some(sink) }
	}

	/// Draws `agent`'s cursor from the next input on; `None` stops drawing and
	/// removes the cursor already drawn.
	pub(crate) fn set(&self, agent: Option<DesktopCursor>) {
		let mut state = self.state.lock();
		if state.agent.as_deref() == agent.as_ref() {
			return;
		}
		if let Some(previous) = state.agent.take() {
			self.emit(CursorEvent { agent: previous, kind: CursorKind::Hide, point: None });
		}
		state.agent = agent.map(Arc::new);
	}

	/// Whether input is drawn: a cursor is set, on a platform that draws one.
	/// Reads that exist only to place the cursor check it first.
	pub(crate) fn active(&self) -> bool {
		self.sink.is_some() && self.state.lock().agent.is_some()
	}

	/// Input of `kind` landing at global point `(x, y)`.
	pub(crate) fn at(&self, kind: CursorKind, x: f64, y: f64) {
		let mut state = self.state.lock();
		let Some(agent) = state.agent.clone() else {
			return;
		};
		state.last = Some((x, y));
		self.emit(CursorEvent { agent, kind, point: Some((x, y)) });
	}

	/// Input of `kind` without a point, drawn where the last input landed.
	pub(crate) fn here(&self, kind: CursorKind) {
		let state = self.state.lock();
		if let (Some(agent), Some(point)) = (state.agent.clone(), state.last) {
			self.emit(CursorEvent { agent, kind, point: Some(point) });
		}
	}

	/// Removes the cursor now; the session is closing.
	pub(crate) fn hide(&self) {
		let agent = self.state.lock().agent.clone();
		if let Some(agent) = agent {
			self.emit(CursorEvent { agent, kind: CursorKind::Hide, point: None });
		}
	}

	fn emit(&self, event: CursorEvent) {
		if let Some(sink) = self.sink {
			sink(event);
		}
	}
}

/// Queues `event` for this process's overlay helper without waiting.
#[cfg(target_os = "macos")]
fn send(event: CursorEvent) {
	if let Some(queue) = QUEUE.as_ref() {
		queue.offer(event);
	}
}

#[cfg(test)]
mod tests {
	use serde_json::{Value, json};

	use super::*;

	fn screen(id: u32, x: f64, y: f64, width: f64, height: f64) -> Screen {
		Screen { id, x, y, width, height }
	}

	fn agent() -> Arc<DesktopCursor> {
		Arc::new(DesktopCursor {
			id:    "CursorChecks.Scout".into(),
			label: "Scout".into(),
			color: "#d9620f".into(),
		})
	}

	#[test]
	fn locate_maps_global_points_onto_displays_left_of_and_above_the_main_one() {
		// Main 1920x1080 at the origin, a 1512x982-point Retina display to its
		// left and a 1x display above it.
		let screens = [
			screen(1, 0.0, 0.0, 1920.0, 1080.0),
			screen(2, -1512.0, 98.0, 1512.0, 982.0),
			screen(3, 200.0, -1440.0, 2560.0, 1440.0),
		];
		assert_eq!(locate(&screens, 400.0, 300.0), Some((1, 400.0, 300.0)));
		assert_eq!(locate(&screens, -1512.0, 98.0), Some((2, 0.0, 0.0)));
		assert_eq!(locate(&screens, -10.5, 1079.0), Some((2, 1501.5, 981.0)));
		assert_eq!(locate(&screens, 200.0, -1.0), Some((3, 0.0, 1439.0)));
		assert_eq!(locate(&screens, 2759.0, -1440.0), Some((3, 2559.0, 0.0)));
		// A display's right and bottom edges belong to its neighbour, or to none.
		assert_eq!(locate(&screens, 0.0, 500.0), Some((1, 0.0, 500.0)));
		assert_eq!(locate(&screens, 1920.0, 0.0), None);
		assert_eq!(locate(&screens, -20.0, 50.0), None);
		assert_eq!(locate(&screens, 100.0, -1.0), None);
	}

	#[test]
	fn encode_writes_one_line_in_display_points() {
		let screens = [screen(1, 0.0, 0.0, 1920.0, 1080.0), screen(2, -1512.0, 98.0, 1512.0, 982.0)];
		let event =
			CursorEvent { agent: agent(), kind: CursorKind::Click, point: Some((-12.0, 120.5)) };
		let line = encode(&event, &screens).expect("the point is on a display");
		let (newline, json) = line.split_last().unwrap();
		assert_eq!(*newline, b'\n');
		assert!(!json.contains(&b'\n'), "one event is one line");
		let value: Value = serde_json::from_slice(&line).unwrap();
		assert_eq!(
			value,
			json!({
				"agent": "CursorChecks.Scout",
				"label": "Scout",
				"color": "#d9620f",
				"kind": "click",
				"display": 2,
				"x": 1500.0,
				"y": 22.5,
			})
		);
	}

	#[test]
	fn encode_sends_hide_without_a_point_and_drops_points_off_every_display() {
		let screens = [screen(1, 0.0, 0.0, 1920.0, 1080.0)];
		let hide = CursorEvent { agent: agent(), kind: CursorKind::Hide, point: None };
		let value: Value = serde_json::from_slice(&encode(&hide, &screens).unwrap()).unwrap();
		assert_eq!(value["kind"], "hide");
		assert!(value.get("display").is_none() && value.get("x").is_none());
		let off = CursorEvent { agent: agent(), kind: CursorKind::Move, point: Some((5000.0, 5.0)) };
		assert_eq!(encode(&off, &screens), None);
	}

	#[test]
	fn a_full_or_closed_queue_drops_events() {
		let (queue, events) = Queue::new(2);
		let event = CursorEvent { agent: agent(), kind: CursorKind::Move, point: Some((1.0, 1.0)) };
		assert!(queue.offer(event.clone()));
		assert!(queue.offer(event.clone()));
		// Nothing drains the queue, so an offer that waited for room would hang
		// here.
		assert!(!queue.offer(event.clone()));
		assert_eq!(events.try_iter().count(), 2);
		drop(events);
		assert!(!queue.offer(event));
	}
}
