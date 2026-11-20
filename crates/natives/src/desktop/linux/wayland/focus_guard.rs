//! Keeps the user's keyboard while a background accessibility action makes
//! its app open or activate a window (Hyprland).
//!
//! Hyprland focuses every new window, and with `misc:focus_on_activate`
//! (Omarchy sets it) every window that asks to be activated, so a dialog that
//! a background press opens takes the keys the user is typing elsewhere, and
//! a typed Space or Enter answers it. Around each action this watches
//! Hyprland's event socket; when a window of the acted-on process, or of a
//! desktop portal backend showing a dialog for it, takes focus because it
//! appeared, or asked for activation, during the watch, focus goes back to
//! the user's window. Where the compositor runs a Lua config, the
//! hand-back is also armed inside it (`hl.on("window.active")`), so it runs in
//! the same compositor turn as the steal and no key reaches the dialog; the
//! socket watcher then only confirms and reports. Nothing persists: the hook
//! removes itself when the watch ends, when the user moves focus anywhere
//! else, on `hyprctl reload`, or after [`HOOK_LIFETIME_MS`] if this process
//! dies. Nothing is written to the user's configuration.

use std::{
	collections::{HashMap, HashSet},
	io::{BufRead, BufReader, ErrorKind},
	os::unix::net::UnixStream,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::Deserialize;

use super::{hyprland::Hyprland, sway::SwayGuard};
use crate::desktop::{
	ax::{AxHandle, AxProps, WalkBounds},
	backend::AxBackend,
	error::CoreResult,
	linux::ax::AtSpiAx,
	text_range::TextSelectRequest,
	types::{AxTextSelection, DesktopWindow, DesktopWindowFocus, DesktopWindowOpened},
};

/// How long an action's call waits after the action returns for a window it
/// opens, so the call itself reports it. On Omarchy 4.5, GTK and Electron
/// dialogs appeared 20-55 ms after an AT-SPI press returned and Qt's 115-175
/// ms; `LibreOffice`'s, 0.3 s and later, are reported by the next call.
const SETTLE: Duration = Duration::from_millis(200);
/// How long after the action returns the watch keeps handing focus back:
/// `LibreOffice` built its Paragraph dialog 0.3-1.7 s after the press.
const WATCH: Duration = Duration::from_millis(2500);
/// How long after a window appears, or asks for activation, focus moving to
/// it counts as the action's doing; later it is the user's click.
const FRESH: Duration = Duration::from_millis(500);
/// When the compositor hook removes itself if this process never does.
const HOOK_LIFETIME_MS: u32 = 15_000;
/// How often the watcher checks whether it should stop; the next action's
/// watch waits up to this long for the previous one to end.
pub(super) const POLL: Duration = Duration::from_millis(20);
/// Window classes of the desktop portal backends (`xdg-desktop-portal-gtk`,
/// `-kde`, `-gnome`, ...). They show dialogs on an app's behalf: Electron's
/// file chooser on Omarchy 4.5 is an `xdg-desktop-portal-gtk` window, so a new
/// one during the watch counts as the action's as well.
const PORTAL_CLASS: &str = "xdg-desktop-portal";

/// One line of Hyprland's event socket that the guard reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Event {
	Open {
		address: String,
		class:   String,
		title:   String,
	},
	/// Focus moved to this window; `None` when to no window.
	Active(Option<String>),
	Urgent(String),
	Title {
		address: String,
		title:   String,
	},
}

/// Hyprland writes addresses without `0x` on the event socket and with it in
/// its JSON.
fn address(raw: &str) -> String {
	if raw.starts_with("0x") {
		raw.to_owned()
	} else {
		format!("0x{raw}")
	}
}

fn parse(line: &str) -> Option<Event> {
	let (name, data) = line.split_once(">>")?;
	match name {
		"openwindow" => {
			let mut parts = data.splitn(4, ',');
			let addr = parts.next()?;
			let _workspace = parts.next()?;
			Some(Event::Open {
				address: address(addr),
				class:   parts.next()?.to_owned(),
				title:   parts.next().unwrap_or_default().to_owned(),
			})
		},
		"activewindowv2" => Some(Event::Active((!data.is_empty()).then(|| address(data)))),
		"urgent" => Some(Event::Urgent(address(data))),
		"windowtitlev2" => {
			let (addr, title) = data.split_once(',')?;
			Some(Event::Title { address: address(addr), title: title.to_owned() })
		},
		_ => None,
	}
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct Client {
	pub(super) address: String,
	#[serde(default)]
	pub(super) pid:     i64,
	#[serde(default)]
	pub(super) class:   String,
	#[serde(default)]
	pub(super) title:   String,
}

/// A window of the target the watch has seen appear or ask for activation.
#[derive(Debug)]
struct Seen {
	address:    String,
	/// The window's own process: the target's, or a portal backend's.
	pid:        u32,
	class:      String,
	title:      String,
	opened:     bool,
	first:      Instant,
	/// When it last asked for activation (or appeared), while that counts.
	fresh:      Instant,
	/// When it last took focus, while it holds it.
	focused_at: Option<Instant>,
	took_focus: bool,
	held:       Option<Duration>,
	left:       bool,
}

/// What the watch decides about a focus move.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Verdict {
	Nothing,
	/// Give focus back to the user's window.
	HandBack,
}

/// The guard's reading of the events, apart from any IO, so it can be tested.
pub(super) struct Tracker {
	user:    Client,
	target:  u32,
	known:   HashSet<String>,
	started: Instant,
	seen:    Vec<Seen>,
	/// The user moved focus somewhere the action did not: no more hand-backs.
	picked:  bool,
}

impl Tracker {
	pub(super) const fn new(
		user: Client,
		target: u32,
		known: HashSet<String>,
		started: Instant,
	) -> Self {
		Self { user, target, known, started, seen: Vec::new(), picked: false }
	}

	fn seen(&mut self, address: &str) -> Option<&mut Seen> {
		self.seen.iter_mut().find(|seen| seen.address == address)
	}

	/// Whether `client` shows windows for the acted-on app: its own process,
	/// or a portal backend.
	fn for_target(&self, client: &Client) -> bool {
		client.pid == i64::from(self.target) || client.class.starts_with(PORTAL_CLASS)
	}

	/// Records a window of the target that appeared, or asked for activation,
	/// at `now`.
	fn note(&mut self, address: &str, client: &Client, now: Instant) {
		if let Some(seen) = self.seen(address) {
			seen.fresh = now;
			return;
		}
		self.seen.push(Seen {
			address:    address.to_owned(),
			pid:        u32::try_from(client.pid).unwrap_or(self.target),
			class:      client.class.clone(),
			title:      client.title.clone(),
			opened:     !self.known.contains(address),
			first:      now,
			fresh:      now,
			focused_at: None,
			took_focus: false,
			held:       None,
			left:       false,
		});
	}

	/// Reads one event at `now`; `client` resolves a window's process, class
	/// and title.
	pub(super) fn event(
		&mut self,
		event: &Event,
		now: Instant,
		client: &mut impl FnMut(&str) -> Option<Client>,
	) -> Verdict {
		match event {
			Event::Open { address, class, title } => {
				if !self.known.contains(address)
					&& self.seen(address).is_none()
					&& let Some(found) = client(address)
				{
					let found = Client { class: class.clone(), title: title.clone(), ..found };
					if self.for_target(&found) {
						self.note(address, &found, now);
					}
				}
			},
			Event::Urgent(address) => {
				if let Some(found) = client(address)
					&& self.for_target(&found)
				{
					self.note(address, &found, now);
				}
			},
			Event::Title { address, title } => {
				if let Some(seen) = self.seen(address) {
					seen.title.clone_from(title);
				}
			},
			Event::Active(Some(address)) if *address == self.user.address => {
				for seen in &mut self.seen {
					if let Some(at) = seen.focused_at.take() {
						seen.held = Some(seen.held.unwrap_or_default() + now.duration_since(at));
					}
				}
			},
			Event::Active(Some(address)) => {
				if !self.picked {
					// A window that appeared before Hyprland posted openwindow
					// (it focuses first) is new when the watch began without it.
					if !self.known.contains(address)
						&& self.seen(address).is_none()
						&& let Some(found) = client(address)
						&& self.for_target(&found)
					{
						self.note(address, &found, now);
					}
					if let Some(seen) = self.seen(address)
						&& now.duration_since(seen.fresh) <= FRESH
					{
						seen.took_focus = true;
						seen.focused_at.get_or_insert(now);
						return Verdict::HandBack;
					}
				}
				self.pick(now);
			},
			Event::Active(None) => self.pick(now),
		}
		Verdict::Nothing
	}

	/// The user (or something other than the action) moved focus: what holds
	/// it now is their choice.
	fn pick(&mut self, now: Instant) {
		self.picked = true;
		for seen in &mut self.seen {
			if let Some(at) = seen.focused_at.take() {
				seen.held = Some(seen.held.unwrap_or_default() + now.duration_since(at));
				seen.left = true;
			}
		}
	}

	/// Each window seen so far, by address, with what it did to focus.
	pub(super) fn report(&self) -> Vec<(String, DesktopWindowOpened)> {
		let user_window = format!("{}: {}", self.user.class, self.user.title);
		self
			.seen
			.iter()
			.map(|seen| {
				let focus = if !seen.took_focus {
					DesktopWindowFocus::Kept
				} else if seen.focused_at.is_some() {
					DesktopWindowFocus::NotReturned
				} else if seen.left {
					DesktopWindowFocus::LeftAsChosen
				} else {
					DesktopWindowFocus::HandedBack
				};
				(seen.address.clone(), DesktopWindowOpened {
					app: seen.class.clone(),
					pid: seen.pid,
					title: seen.title.clone(),
					opened: seen.opened,
					after_ms: millis(seen.first.saturating_duration_since(self.started)),
					focus,
					held_ms: match focus {
						DesktopWindowFocus::HandedBack | DesktopWindowFocus::LeftAsChosen => {
							seen.held.map(millis)
						},
						_ => None,
					},
					user_window: user_window.clone(),
				})
			})
			.collect()
	}
}

fn millis(duration: Duration) -> u32 {
	u32::try_from(duration.as_millis()).unwrap_or(u32::MAX)
}

/// The compositor-side hand-back for process `pid` and the user's window
/// `user`, registered as `omp_focus_guard[id]` (a function that removes it).
fn hook(id: &str, pid: u32, user: &str) -> String {
	format!(
		r#"local id, pid, user, fresh_ms, portal = "{id}", {pid}, "{user}", {fresh}, "{PORTAL_CLASS}"
omp_focus_guard = omp_focus_guard or {{}}
local known, fresh, subs = {{}}, {{}}, {{}}
for _, w in ipairs(hl.get_windows()) do known[w.address] = true end
local function stop()
  for _, s in ipairs(subs) do s:remove() end
  omp_focus_guard[id] = nil
end
local function freshen(address)
  fresh[address] = (fresh[address] or 0) + 1
  local n = fresh[address]
  hl.timer(function() if fresh[address] == n then fresh[address] = nil end end, {{ timeout = fresh_ms, type = "oneshot" }})
end
local function ours(w)
  return w.pid == pid or (w.class or ""):find(portal, 1, true) == 1
end
subs[1] = hl.on("window.urgent", function(w) if w and ours(w) then freshen(w.address) end end)
subs[2] = hl.on("window.active", function(w)
  if not w or w.address == user then return end
  if ours(w) and not known[w.address] and not fresh[w.address] then
    known[w.address] = true
    freshen(w.address)
  end
  if ours(w) and fresh[w.address] then
    hl.dispatch(hl.dsp.focus({{ window = "address:" .. user }}))
  else
    stop()
  end
end)
omp_focus_guard[id] = stop
hl.timer(function() if omp_focus_guard[id] then stop() end end, {{ timeout = {lifetime}, type = "oneshot" }})"#,
		fresh = FRESH.as_millis(),
		lifetime = HOOK_LIFETIME_MS,
	)
}

fn unhook(id: &str) -> String {
	format!(r#"if omp_focus_guard and omp_focus_guard["{id}"] then omp_focus_guard["{id}"]() end"#)
}

/// What one action's watch has seen, shared between its thread and the
/// guard.
#[derive(Default)]
pub(super) struct Shared {
	/// Every window seen so far, by address.
	pub(super) report: Vec<(String, DesktopWindowOpened)>,
	/// Window outcomes already handed to the caller.
	pub(super) given:  HashSet<(String, DesktopWindowFocus)>,
	pub(super) done:   bool,
}

/// Watches Hyprland around background actions; see the module docs.
pub(super) struct FocusGuard {
	hyprland: Hyprland,
	/// Whether the compositor takes Lua (`hyprctl eval`); `None` until tried.
	lua:      Option<bool>,
	/// Watches whose reports have not all been handed to the caller.
	watches:  Vec<Arc<Mutex<Shared>>>,
	/// The latest watch's thread, while it runs; ended by the next watch.
	running:  Option<(Arc<AtomicBool>, thread::JoinHandle<()>)>,
	next_id:  u64,
}

impl FocusGuard {
	pub(super) const fn new(hyprland: Hyprland) -> Self {
		Self { hyprland, lua: None, watches: Vec::new(), running: None, next_id: 0 }
	}

	/// What windows actions opened did to focus, each outcome once: a window
	/// still being watched is reported again only when its outcome changes.
	pub(super) fn take(&mut self) -> Vec<DesktopWindowOpened> {
		let mut out = Vec::new();
		self.watches.retain(|watch| {
			let mut shared = watch.lock();
			let Shared { report, given, done } = &mut *shared;
			for (address, entry) in report.iter() {
				if given.insert((address.clone(), entry.focus)) {
					out.push(entry.clone());
				}
			}
			!*done
		});
		out
	}

	/// Runs `action` on process `pid` under a watch, then waits up to
	/// [`SETTLE`] for a window it opens. The watch keeps going for [`WATCH`]
	/// after the action returns. An action on the app the user has focused,
	/// or one when Hyprland cannot be read, runs unwatched: the first is the
	/// user's own app, and the second must not stop their work.
	pub(super) fn run<T>(&mut self, pid: u32, action: impl FnOnce() -> T) -> T {
		let Some(watch) = self.arm(pid) else {
			return action();
		};
		let result = action();
		watch.finish();
		result
	}

	fn arm(&mut self, pid: u32) -> Option<Watch> {
		if let Some((stop, thread)) = self.running.take() {
			stop.store(true, Ordering::Release);
			let _ = thread.join();
		}
		let user: Client = self.hyprland.json("j/activewindow").ok()?;
		if user.pid <= 0 || user.pid == i64::from(pid) {
			return None;
		}
		let clients: Vec<Client> = self.hyprland.json("j/clients").ok()?;
		let known = clients.into_iter().map(|client| client.address).collect();
		let events = UnixStream::connect(self.hyprland.events_socket()).ok()?;
		events.set_read_timeout(Some(POLL)).ok()?;
		self.next_id += 1;
		let id = format!("{}-{}", std::process::id(), self.next_id);
		if self.lua != Some(false) {
			let reply = self
				.hyprland
				.request(&format!("eval {}", hook(&id, pid, &user.address)));
			self.lua = Some(reply.is_ok_and(|reply| reply == b"ok"));
		}
		let started = Instant::now();
		let ends = Arc::new(AtomicU64::new(u64::MAX));
		let stop = Arc::new(AtomicBool::new(false));
		let shared = Arc::new(Mutex::new(Shared::default()));
		let watcher = Watcher {
			hyprland: self.hyprland.clone(),
			lua: self.lua == Some(true),
			tracker: Tracker::new(user, pid, known, started),
			started,
			ends: Arc::clone(&ends),
			stop: Arc::clone(&stop),
			shared: Arc::clone(&shared),
		};
		let thread = thread::Builder::new()
			.name("hyprland-focus-guard".into())
			.spawn(move || {
				let (lua, hyprland) = (watcher.lua, watcher.hyprland.clone());
				watcher.watch(events);
				if lua {
					let _ = hyprland.request(&format!("eval {}", unhook(&id)));
				}
			})
			.ok()?;
		self.running = Some((stop, thread));
		self.watches.push(Arc::clone(&shared));
		Some(Watch { ends, started, shared })
	}
}

/// One action's watch, until its action returns.
pub(super) struct Watch {
	/// Nanoseconds after `started` at which the watch ends; `u64::MAX` while
	/// the action runs.
	pub(super) ends:    Arc<AtomicU64>,
	pub(super) started: Instant,
	pub(super) shared:  Arc<Mutex<Shared>>,
}

impl Watch {
	/// Marks the action done, then waits up to [`SETTLE`] for a window it
	/// opens, and once one has, a moment for its focus outcome.
	pub(super) fn finish(self) {
		let ends = self.started.elapsed() + WATCH;
		self
			.ends
			.store(u64::try_from(ends.as_nanos()).unwrap_or(u64::MAX), Ordering::Release);
		let until = Instant::now() + SETTLE;
		let seen = || !self.shared.lock().report.is_empty();
		while Instant::now() < until && !seen() {
			thread::sleep(Duration::from_millis(5));
		}
		// A hand-back lands within a compositor turn or one IPC round trip.
		if seen() {
			thread::sleep(Duration::from_millis(20));
		}
	}
}

struct Watcher {
	hyprland: Hyprland,
	lua:      bool,
	tracker:  Tracker,
	started:  Instant,
	ends:     Arc<AtomicU64>,
	stop:     Arc<AtomicBool>,
	shared:   Arc<Mutex<Shared>>,
}

impl Watcher {
	fn over(&self) -> bool {
		self.stop.load(Ordering::Acquire)
			|| u64::try_from(self.started.elapsed().as_nanos()).unwrap_or(u64::MAX)
				>= self.ends.load(Ordering::Acquire)
	}

	fn watch(mut self, events: UnixStream) {
		let mut reader = BufReader::new(events);
		let mut line = Vec::new();
		let mut clients: HashMap<String, Client> = HashMap::new();
		// When the bytes of the line being read arrived: a line already whole
		// in the buffer came with the read that filled it, so the time spent
		// on earlier lines (client lookups, the hand-back) does not count as
		// time the window held focus.
		let mut read_at = Instant::now();
		while !self.over() {
			let buffered = reader.buffer().contains(&b'\n');
			// A timed-out read keeps the bytes it had read in `line`; they are
			// decoded once the line is whole.
			match reader.read_until(b'\n', &mut line) {
				Ok(0) => break,
				Ok(_) => {},
				Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
					continue;
				},
				Err(_) => break,
			}
			if !buffered {
				read_at = Instant::now();
			}
			let event = parse(String::from_utf8_lossy(&line).trim_end());
			line.clear();
			let Some(event) = event else { continue };
			let hyprland = &self.hyprland;
			let mut client = |address: &str| {
				if !clients.contains_key(address) {
					let listed: Vec<Client> = hyprland.json("j/clients").ok()?;
					clients.extend(listed.into_iter().map(|c| (c.address.clone(), c)));
				}
				clients.get(address).cloned()
			};
			let verdict = self.tracker.event(&event, read_at, &mut client);
			if verdict == Verdict::HandBack {
				self.hand_back();
			}
			self.shared.lock().report = self.tracker.report();
		}
		let mut shared = self.shared.lock();
		shared.report = self.tracker.report();
		shared.done = true;
	}

	/// Puts focus back on the user's window unless the compositor hook
	/// already did.
	fn hand_back(&self) {
		let user = &self.tracker.user.address;
		if self.lua
			&& let Ok(active) = self.hyprland.json::<Client>("j/activewindow")
			&& active.address == *user
		{
			return;
		}
		let command = if self.lua {
			format!(r#"dispatch hl.dsp.focus({{ window = "address:{user}" }})"#)
		} else {
			format!("dispatch focuswindow address:{user}")
		};
		let _ = self.hyprland.request(&command);
	}
}

/// The guard for the running compositor.
pub(super) enum Guard {
	Hyprland(FocusGuard),
	Sway(SwayGuard),
}

impl Guard {
	fn run<T>(&mut self, pid: u32, action: impl FnOnce() -> T) -> T {
		match self {
			Self::Hyprland(guard) => guard.run(pid, action),
			Self::Sway(guard) => guard.run(pid, action),
		}
	}

	fn take(&mut self) -> Vec<DesktopWindowOpened> {
		match self {
			Self::Hyprland(guard) => guard.take(),
			Self::Sway(guard) => guard.take(),
		}
	}

	/// Which guard keeps the user's keyboard, for capabilities.
	#[allow(dead_code, reason = "capabilities name the active guard once that lands")]
	pub(super) const fn kind(&self) -> &'static str {
		match self {
			Self::Hyprland(FocusGuard { lua: Some(false), .. }) => "Hyprland socket watcher",
			Self::Hyprland(_) => "Hyprland hook",
			Self::Sway(_) => "sway watcher",
		}
	}
}

/// The AT-SPI backend with each action that can open a window run under the
/// compositor's [`Guard`] (Hyprland or sway); reads pass straight through.
pub(super) struct GuardedAx {
	ax:    AtSpiAx,
	guard: Option<Guard>,
}

impl GuardedAx {
	pub(super) const fn new(ax: AtSpiAx, guard: Option<Guard>) -> Self {
		Self { ax, guard }
	}

	/// Runs `action` under the guard for process `pid`; unguarded when the
	/// process is unknown or the compositor has no guard.
	pub(super) fn guarded<T>(
		&mut self,
		pid: Option<u32>,
		action: impl FnOnce(&mut AtSpiAx) -> T,
	) -> T {
		match (&mut self.guard, pid) {
			(Some(guard), Some(pid)) => guard.run(pid, || action(&mut self.ax)),
			_ => action(&mut self.ax),
		}
	}

	/// [`Self::guarded`] for an action on element `h`.
	pub(super) fn on_element<T>(
		&mut self,
		h: &AxHandle,
		action: impl FnOnce(&mut AtSpiAx) -> T,
	) -> T {
		let pid = if self.guard.is_some() {
			self.ax.element_pid(h).ok()
		} else {
			None
		};
		self.guarded(pid, action)
	}

	/// See [`FocusGuard::take`].
	pub(super) fn take_windows_opened(&mut self) -> Vec<DesktopWindowOpened> {
		self.guard.as_mut().map_or_default(Guard::take)
	}
}

impl std::ops::Deref for GuardedAx {
	type Target = AtSpiAx;

	fn deref(&self) -> &AtSpiAx {
		&self.ax
	}
}

impl std::ops::DerefMut for GuardedAx {
	fn deref_mut(&mut self) -> &mut AtSpiAx {
		&mut self.ax
	}
}

impl AxBackend for GuardedAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		self.ax.window_root(win)
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		self.ax.window_id(h, windows)
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		self.ax.props(h)
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		self.ax.children(h)
	}

	fn walk_node(
		&mut self,
		h: &AxHandle,
		bounds: WalkBounds,
		max_children: u32,
	) -> CoreResult<(AxProps, Vec<AxHandle>)> {
		self.ax.walk_node(h, bounds, max_children)
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		self.ax.parent(h)
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		self.on_element(h, |ax| ax.perform(h, action))
	}

	fn perform_menu(&mut self, h: &AxHandle, action: &str, path: &[String]) -> CoreResult<()> {
		self.on_element(h, |ax| ax.perform_menu(h, action, path))
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		self.on_element(h, |ax| ax.set_value(h, value))
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		self.on_element(h, |ax| ax.focus(h))
	}

	fn select_text(
		&mut self,
		h: &AxHandle,
		request: &TextSelectRequest,
	) -> CoreResult<AxTextSelection> {
		self.ax.select_text(h, request)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		self.ax.element_at(x, y)
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.ax.focused_element()
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		self.ax.attributes(h)
	}

	fn alive(&mut self, h: &AxHandle) -> bool {
		self.ax.alive(h)
	}

	fn destroyed(&mut self, h: &AxHandle) -> bool {
		self.ax.destroyed(h)
	}

	fn focused_within(&mut self, h: &AxHandle) -> Option<AxHandle> {
		self.ax.focused_within(h)
	}

	fn value_settable(&mut self, h: &AxHandle) -> Option<bool> {
		self.ax.value_settable(h)
	}

	fn pending(&mut self, h: &AxHandle) -> bool {
		self.ax.pending(h)
	}

	fn settle(&mut self, h: &AxHandle) -> CoreResult<()> {
		self.ax.settle(h)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const USER: &str = "0xa";
	const TARGET: u32 = 20;

	fn client(address: &str, pid: i64, class: &str, title: &str) -> Client {
		Client { address: address.to_owned(), pid, class: class.to_owned(), title: title.to_owned() }
	}

	struct Run {
		tracker: Tracker,
		t0:      Instant,
		clients: Vec<Client>,
	}

	impl Run {
		fn new() -> Self {
			let t0 = Instant::now();
			let known = [USER, "0xb", "0xc"].map(str::to_owned).into();
			Self {
				tracker: Tracker::new(client(USER, 10, "typist", "notes"), TARGET, known, t0),
				t0,
				clients: vec![
					client(USER, 10, "typist", "notes"),
					client("0xb", 20, "tdlg.py", "Main"),
					client("0xc", 30, "other", "Other"),
					client("0xd", 20, "tdlg.py", "Allow?"),
					client("0xe", 20, "tdlg.py", "Sure?"),
				],
			}
		}

		fn at(&mut self, ms: u64, line: &str) -> Verdict {
			let clients = &self.clients;
			let mut lookup = |address: &str| {
				clients
					.iter()
					.find(|c| c.address == address)
					.map(|c| client(&c.address, c.pid, &c.class, &c.title))
			};
			let event = parse(line).expect("a guarded event");
			self
				.tracker
				.event(&event, self.t0 + Duration::from_millis(ms), &mut lookup)
		}

		fn focus(&self) -> Vec<(String, DesktopWindowFocus, Option<u32>)> {
			self
				.tracker
				.report()
				.into_iter()
				.map(|(_, r)| (r.title, r.focus, r.held_ms))
				.collect()
		}
	}

	#[test]
	fn a_dialog_the_action_opens_is_handed_back_and_its_hold_reported() {
		let mut run = Run::new();
		// Hyprland may focus the new window before it posts openwindow.
		assert_eq!(run.at(30, "activewindowv2>>d"), Verdict::HandBack);
		assert_eq!(run.at(30, "openwindow>>d,1,tdlg.py,Allow?"), Verdict::Nothing);
		assert_eq!(run.at(42, "activewindowv2>>a"), Verdict::Nothing);
		// The chained second dialog is the action's too.
		assert_eq!(run.at(600, "openwindow>>e,1,tdlg.py,Sure?"), Verdict::Nothing);
		assert_eq!(run.at(600, "activewindowv2>>e"), Verdict::HandBack);
		assert_eq!(run.at(601, "activewindowv2>>a"), Verdict::Nothing);
		assert_eq!(run.focus(), vec![
			("Allow?".to_owned(), DesktopWindowFocus::HandedBack, Some(12)),
			("Sure?".to_owned(), DesktopWindowFocus::HandedBack, Some(1)),
		]);
		assert!(
			run.tracker
				.report()
				.iter()
				.all(|(_, r)| r.opened && r.user_window == "typist: notes")
		);
	}

	#[test]
	fn an_existing_window_asking_for_activation_is_handed_back_but_a_click_is_the_users() {
		let mut run = Run::new();
		// LibreOffice asks to activate its main window before it builds a dialog.
		assert_eq!(run.at(1, "urgent>>b"), Verdict::Nothing);
		assert_eq!(run.at(1, "activewindowv2>>b"), Verdict::HandBack);
		assert_eq!(run.at(3, "activewindowv2>>a"), Verdict::Nothing);
		// Later the user clicks the app themselves: no urgent, so it stays.
		assert_eq!(run.at(900, "activewindowv2>>b"), Verdict::Nothing);
		// A dialog that opens after their pick is theirs too.
		assert_eq!(run.at(950, "activewindowv2>>d"), Verdict::Nothing);
		let report = run.tracker.report();
		assert_eq!(report.len(), 1);
		assert_eq!(report[0].1.focus, DesktopWindowFocus::HandedBack);
		assert!(!report[0].1.opened);
	}

	#[test]
	fn a_window_focused_after_it_stopped_being_fresh_is_left_and_unreturned_focus_is_said() {
		let mut run = Run::new();
		// Opened without focus (a no_initial_focus rule), clicked a second later.
		assert_eq!(run.at(40, "openwindow>>d,1,tdlg.py,Allow?"), Verdict::Nothing);
		assert_eq!(run.at(1040, "activewindowv2>>d"), Verdict::Nothing);
		assert_eq!(run.focus(), vec![("Allow?".to_owned(), DesktopWindowFocus::Kept, None)]);

		let mut run = Run::new();
		assert_eq!(run.at(40, "activewindowv2>>d"), Verdict::HandBack);
		// The hand-back never arrived.
		assert_eq!(run.focus(), vec![("Allow?".to_owned(), DesktopWindowFocus::NotReturned, None)]);
		// Another app's window: the user moved on, and the dialog's hold ends
		// there.
		assert_eq!(run.at(70, "activewindowv2>>c"), Verdict::Nothing);
		assert_eq!(run.focus(), vec![(
			"Allow?".to_owned(),
			DesktopWindowFocus::LeftAsChosen,
			Some(30)
		)]);
	}

	#[test]
	fn other_processes_windows_are_not_the_actions() {
		let mut run = Run::new();
		run.clients.push(client("0xf", 30, "other", "Popup"));
		assert_eq!(run.at(30, "openwindow>>f,1,other,Popup"), Verdict::Nothing);
		assert_eq!(run.at(30, "activewindowv2>>f"), Verdict::Nothing);
		assert!(run.tracker.report().is_empty());
		assert!(run.tracker.picked);
	}

	#[test]
	fn a_portal_dialog_shown_for_the_app_is_the_actions() {
		let mut run = Run::new();
		// Electron's file chooser is the GTK portal backend's window, asking
		// for activation with the app's token before it maps.
		run.clients
			.push(client("0xf", 40, "xdg-desktop-portal-gtk", "Open"));
		assert_eq!(run.at(110, "urgent>>f"), Verdict::Nothing);
		assert_eq!(run.at(118, "openwindow>>f,1,xdg-desktop-portal-gtk,Open"), Verdict::Nothing);
		assert_eq!(run.at(118, "activewindowv2>>f"), Verdict::HandBack);
		assert_eq!(run.at(119, "activewindowv2>>a"), Verdict::Nothing);
		let report = run.tracker.report();
		assert_eq!(report.len(), 1);
		assert_eq!((report[0].1.pid, report[0].1.app.as_str()), (40, "xdg-desktop-portal-gtk"));
		assert_eq!(report[0].1.focus, DesktopWindowFocus::HandedBack);
	}

	#[test]
	fn event_lines_parse_with_commas_in_titles() {
		assert_eq!(
			parse("openwindow>>55f6,1,soffice,Paragraph, indents"),
			Some(Event::Open {
				address: "0x55f6".into(),
				class:   "soffice".into(),
				title:   "Paragraph, indents".into(),
			})
		);
		assert_eq!(parse("activewindowv2>>"), Some(Event::Active(None)));
		assert_eq!(parse("activewindow>>foot,x"), None);
	}
}
