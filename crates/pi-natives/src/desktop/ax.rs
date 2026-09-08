use std::{
	collections::{BTreeMap, HashMap},
	fmt::Write as _,
};

use super::{
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::{AxNode, AxQuery, AxSnapshot, AxSnapshotOptions, DesktopWindow},
};

#[derive(Clone)]
pub enum AxHandle {
	#[cfg(target_os = "macos")]
	Mac(objc2_core_foundation::CFRetained<objc2_application_services::AXUIElement>),
	#[cfg(target_os = "windows")]
	Uia(uiautomation::UIElement),
	#[cfg(target_os = "linux")]
	AtSpi(atspi::ObjectRefOwned),
	#[cfg(test)]
	Test(u64),
}

#[derive(Debug, Clone)]
pub struct AxProps {
	pub role:        String,
	pub native_role: String,
	pub title:       Option<String>,
	pub value:       Option<String>,
	pub description: Option<String>,
	pub enabled:     Option<bool>,
	pub focused:     bool,
	pub bounds:      Option<AxBounds>,
	pub actions:     Vec<String>,
	pub child_count: u32,
}

#[derive(Debug, Clone, Copy)]
pub struct AxBounds {
	pub x:      f64,
	pub y:      f64,
	pub width:  f64,
	pub height: f64,
}

struct Registered {
	handle:     AxHandle,
	target_key: String,
	generation: u64,
}

pub struct AxRegistry {
	next_ref:    u64,
	generations: HashMap<String, u64>,
	entries:     BTreeMap<u64, Registered>,
}

impl Default for AxRegistry {
	fn default() -> Self {
		Self { next_ref: 1, generations: HashMap::new(), entries: BTreeMap::new() }
	}
}

impl AxRegistry {
	pub(crate) fn begin_snapshot(&mut self, target: &str) -> u64 {
		let generation = self.generations.entry(target.to_string()).or_default();
		*generation = generation.saturating_add(1);
		let current = *generation;
		self.entries.retain(|_, entry| {
			entry.target_key != target || entry.generation.saturating_add(1) >= current
		});
		current
	}

	pub(crate) fn current_generation(&mut self, target: &str) -> u64 {
		*self.generations.entry(target.to_string()).or_insert(1)
	}

	pub(crate) fn register(&mut self, target: &str, generation: u64, handle: AxHandle) -> String {
		let id = self.next_ref;
		self.next_ref = self.next_ref.saturating_add(1);
		self
			.entries
			.insert(id, Registered { handle, target_key: target.to_string(), generation });
		self.enforce_cap();
		format!("e{id}")
	}

	pub(crate) fn resolve(&self, reference: &str) -> CoreResult<AxHandle> {
		let id = reference
			.strip_prefix('e')
			.and_then(|id| id.parse::<u64>().ok());
		id.and_then(|id| self.entries.get(&id))
			.map(|entry| entry.handle.clone())
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	pub(crate) fn target(&self, reference: &str) -> CoreResult<String> {
		let id = reference
			.strip_prefix('e')
			.and_then(|id| id.parse::<u64>().ok());
		id.and_then(|id| self.entries.get(&id))
			.map(|entry| entry.target_key.clone())
			.ok_or_else(|| DesktopError::stale_ref(format!("{reference} expired; re-run ax()/find()")))
	}

	fn enforce_cap(&mut self) {
		while self.entries.len() > 5_000 {
			// Monotonic refs preserve the most recently registered batch. Evicting
			// an entire generation here could evict the snapshot being returned.
			self.entries.pop_first();
		}
	}
}

#[derive(Clone)]
struct WalkNode {
	handle:   AxHandle,
	props:    AxProps,
	children: Vec<Self>,
}

struct WalkState {
	visited:   u32,
	skipped:   u32,
	max_nodes: u32,
	max_depth: u32,
	truncated: bool,
}

fn walk_raw(
	backend: &mut dyn AxBackend,
	handle: AxHandle,
	depth: u32,
	state: &mut WalkState,
) -> CoreResult<Option<WalkNode>> {
	if depth > state.max_depth || state.visited >= state.max_nodes {
		state.truncated = true;
		return Ok(None);
	}
	state.visited += 1;
	let props = match backend.props(&handle) {
		Ok(props) => props,
		Err(_) if depth > 0 => {
			state.skipped = state.skipped.saturating_add(1);
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	let child_handles = match backend.children(&handle) {
		Ok(children) => children,
		Err(_) if depth > 0 => {
			state.skipped = state.skipped.saturating_add(1);
			return Ok(None);
		},
		Err(error) => return Err(error),
	};
	let mut children = Vec::new();
	for child in child_handles {
		if let Some(child) = walk_raw(backend, child, depth + 1, state)? {
			children.push(child);
		}
		if state.truncated && state.visited >= state.max_nodes {
			break;
		}
	}
	Ok(Some(WalkNode { handle, props, children }))
}

fn named(props: &AxProps) -> bool {
	[&props.title, &props.value, &props.description]
		.into_iter()
		.flatten()
		.any(|value| !value.trim().is_empty())
}
/// Display and match name for a node. Many toolbar controls — Chrome's
/// Back/Forward/Reload among them — carry no `AXTitle` and name themselves
/// through `AXDescription` alone.
fn label(props: &AxProps) -> Option<&str> {
	[props.title.as_deref(), props.description.as_deref()]
		.into_iter()
		.flatten()
		.map(str::trim)
		.find(|label| !label.is_empty())
}
fn interactable(props: &AxProps) -> bool {
	!props.actions.is_empty()
		|| matches!(
			props.role.as_str(),
			"button"
				| "checkbox"
				| "radio"
				| "textfield"
				| "textarea"
				| "link" | "menuitem"
				| "tab" | "slider"
				| "combobox"
				| "popupbutton"
				| "listitem"
				| "outlineitem"
				| "cell"
		)
}
fn structural(role: &str) -> bool {
	matches!(
		role,
		"window"
			| "group"
			| "webarea"
			| "list"
			| "table"
			| "row"
			| "menu"
			| "menubar"
			| "tabgroup"
			| "toolbar"
			| "scrollarea"
			| "outline"
	)
}

fn filter_node(mut node: WalkNode, all: bool) -> Option<WalkNode> {
	node.children = node
		.children
		.into_iter()
		.filter_map(|child| filter_node(child, all))
		.collect();
	if all {
		return Some(node);
	}
	let keep_self = interactable(&node.props) || named(&node.props);
	if !keep_self && node.props.role == "group" && node.children.len() == 1 {
		return node.children.pop();
	}
	if keep_self || (structural(&node.props.role) && !node.children.is_empty()) {
		Some(node)
	} else {
		None
	}
}

fn escaped_truncated(value: &str, max: usize) -> String {
	let mut out: String = value.chars().take(max).collect();
	if value.chars().count() > max {
		out.push('…');
	}
	out.replace('\\', "\\\\")
		.replace('"', "\\\"")
		.replace('\n', " ")
}

fn node_to_napi(reference: String, props: AxProps) -> AxNode {
	let (x, y, width, height) = props
		.bounds
		.map_or((None, None, None, None), |b| (Some(b.x), Some(b.y), Some(b.width), Some(b.height)));
	AxNode {
		ref_: reference,
		role: props.role,
		native_role: props.native_role,
		title: props.title,
		value: props.value,
		description: props.description,
		enabled: props.enabled,
		focused: props.focused,
		x,
		y,
		width,
		height,
		actions: (!props.actions.is_empty()).then_some(props.actions),
		child_count: props.child_count,
	}
}

fn format_tree(
	node: WalkNode,
	depth: usize,
	window: &DesktopWindow,
	registry: &mut AxRegistry,
	target: &str,
	generation: u64,
	text: &mut String,
	nodes: &mut Vec<AxNode>,
) {
	let reference = registry.register(target, generation, node.handle);
	if !text.is_empty() {
		text.push('\n');
	}
	text.push_str(&"  ".repeat(depth));
	text.push_str("- ");
	text.push_str(&node.props.role);
	if let Some(label) = label(&node.props) {
		let _ = write!(text, " \"{}\"", escaped_truncated(label, 80));
	}
	let _ = write!(text, " [ref={reference}]");
	if depth == 0 {
		let _ = write!(text, " app={}", window.app);
	}
	if let Some(value) = node
		.props
		.value
		.as_deref()
		.filter(|value| !value.is_empty())
	{
		let _ = write!(text, ": \"{}\"", escaped_truncated(value, 80));
	}
	if node.props.enabled == Some(false) {
		text.push_str(" (disabled)");
	}
	// The root's own AXFocused only reflects app-local focus; report the global
	// roster flag instead.
	let focused = if depth == 0 {
		window.focused
	} else {
		node.props.focused
	};
	if focused {
		text.push_str(" (focused)");
	}
	nodes.push(node_to_napi(reference, node.props));
	for child in node.children {
		format_tree(child, depth + 1, window, registry, target, generation, text, nodes);
	}
}

pub fn snapshot(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	options: &AxSnapshotOptions,
) -> CoreResult<AxSnapshot> {
	let target = &window.id;
	let generation = registry.begin_snapshot(target);
	let root = backend.window_root(window)?;
	let mut state = WalkState {
		visited:   0,
		skipped:   0,
		max_nodes: options.max_nodes.unwrap_or(800).clamp(1, 5_000),
		max_depth: options.max_depth.unwrap_or(24),
		truncated: false,
	};
	let root = walk_raw(backend, root, 0, &mut state)?
		.and_then(|node| filter_node(node, options.all.unwrap_or(false)));
	let mut text = String::new();
	let mut nodes = Vec::new();
	if let Some(root) = root {
		format_tree(root, 0, window, registry, target, generation, &mut text, &mut nodes);
	}
	if state.truncated {
		if !text.is_empty() {
			text.push('\n');
		}
		let _ = write!(text, "… truncated ({} nodes)", state.visited);
	}
	if state.skipped > 0 {
		if !text.is_empty() {
			text.push('\n');
		}
		let _ = write!(text, "… skipped {} unreadable nodes", state.skipped);
	}
	Ok(AxSnapshot {
		text,
		node_count: nodes.len() as u32,
		nodes,
		truncated: state.truncated,
		skipped: state.skipped,
	})
}

pub fn query(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	window: &DesktopWindow,
	query: &AxQuery,
) -> CoreResult<Vec<AxNode>> {
	let target = &window.id;
	let generation = registry.current_generation(target);
	let root = backend.window_root(window)?;
	let mut state =
		WalkState { visited: 0, skipped: 0, max_nodes: 5_000, max_depth: 24, truncated: false };
	let Some(root) = walk_raw(backend, root, 0, &mut state)? else {
		return Ok(Vec::new());
	};
	let role = query.role.as_deref().map(str::to_lowercase);
	let title = query.title.as_deref().map(str::to_lowercase);
	let value = query.value.as_deref().map(str::to_lowercase);
	let limit = query.limit.unwrap_or(100).min(5_000) as usize;
	let mut result = Vec::new();
	let mut stack = vec![root];
	while let Some(node) = stack.pop() {
		stack.extend(node.children.iter().rev().cloned());
		let contains = |actual: Option<&str>, expected: Option<&String>| {
			expected
				.is_none_or(|needle| actual.is_some_and(|text| text.to_lowercase().contains(needle)))
		};
		if contains(Some(&node.props.role), role.as_ref())
			&& contains(label(&node.props), title.as_ref())
			&& contains(node.props.value.as_deref(), value.as_ref())
		{
			let reference = registry.register(target, generation, node.handle);
			result.push(node_to_napi(reference, node.props));
			if result.len() >= limit {
				break;
			}
		}
	}
	Ok(result)
}

pub fn register_node(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	handle: AxHandle,
) -> CoreResult<AxNode> {
	let props = backend.props(&handle)?;
	let generation = registry.current_generation(target);
	let reference = registry.register(target, generation, handle);
	Ok(node_to_napi(reference, props))
}
pub fn element_at_node(
	backend: &mut dyn AxBackend,
	registry: &mut AxRegistry,
	target: &str,
	x: f64,
	y: f64,
) -> CoreResult<Option<AxNode>> {
	let Some(handle) = backend.element_at(x, y)? else {
		return Ok(None);
	};
	register_node(backend, registry, target, handle).map(Some)
}

pub fn ax_press(backend: &mut dyn AxBackend, handle: &AxHandle) -> CoreResult<()> {
	backend.perform(handle, "press")
}

/// Maps a raw `AX*` macOS accessibility role onto the cross-platform role
/// vocabulary. Compiled only where it has a caller (macOS backend + tests).
#[cfg(any(target_os = "macos", test))]
pub fn normalize_role_macos(native: &str) -> String {
	match native {
		"AXTextArea" => "textarea",
		"AXTextField" => "textfield",
		"AXPopUpButton" => "popupbutton",
		"AXRadioButton" => "radio",
		"AXCheckBox" => "checkbox",
		"AXStaticText" => "statictext",
		"AXScrollArea" => "scrollarea",
		"AXTabGroup" => "tabgroup",
		"AXWebArea" => "webarea",
		"AXRow" => "row",
		"AXCell" => "cell",
		"AXOutline" => "outline",
		_ => native.strip_prefix("AX").unwrap_or(native),
	}
	.to_ascii_lowercase()
}
#[cfg(any(target_os = "windows", test))]
pub fn normalize_role_uia(native: &str) -> String {
	match native {
		"Edit" => "textfield",
		"Document" => "textarea",
		"Text" => "statictext",
		"Hyperlink" => "link",
		"Pane" => "group",
		"TabItem" => "tab",
		"Tab" => "tabgroup",
		"DataItem" => "listitem",
		"DataGrid" => "table",
		"SplitButton" => "popupbutton",
		other => return other.to_ascii_lowercase(),
	}
	.to_string()
}
#[cfg(any(target_os = "linux", test))]
pub fn normalize_role_atspi(native: &str, multiline: bool) -> String {
	match native.to_ascii_lowercase().as_str() {
		"push button" | "toggle button" => "button".into(),
		"entry" | "text" if multiline => "textarea".into(),
		"entry" | "text" => "textfield".into(),
		"label" => "statictext".into(),
		"page tab" => "tab".into(),
		"page tab list" => "tabgroup".into(),
		"table cell" => "cell".into(),
		"tree" => "outline".into(),
		"tree item" => "outlineitem".into(),
		"frame" | "dialog" => "window".into(),
		other => other.replace(' ', ""),
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap;

	use super::*;

	struct Mock {
		props:    HashMap<u64, AxProps>,
		children: HashMap<u64, Vec<u64>>,
	}
	impl AxBackend for Mock {
		fn window_root(&mut self, _: &DesktopWindow) -> CoreResult<AxHandle> {
			Ok(AxHandle::Test(1))
		}

		fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
			let AxHandle::Test(id) = h else {
				unreachable!()
			};
			self
				.props
				.get(id)
				.cloned()
				.ok_or_else(|| DesktopError::ax_failed(format!("unreadable test node {id}")))
		}

		fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
			let AxHandle::Test(id) = h else {
				unreachable!()
			};
			Ok(self
				.children
				.get(id)
				.into_iter()
				.flatten()
				.map(|id| AxHandle::Test(*id))
				.collect())
		}

		fn parent(&mut self, _: &AxHandle) -> CoreResult<Option<AxHandle>> {
			Ok(None)
		}

		fn perform(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			Ok(())
		}

		fn set_value(&mut self, _: &AxHandle, _: &str) -> CoreResult<()> {
			Ok(())
		}

		fn focus(&mut self, _: &AxHandle) -> CoreResult<()> {
			Ok(())
		}

		fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
			Ok(self.props.iter().find_map(|(id, props)| {
				props
					.bounds
					.filter(|bounds| {
						x >= bounds.x
							&& x < bounds.x + bounds.width
							&& y >= bounds.y
							&& y < bounds.y + bounds.height
					})
					.map(|_| AxHandle::Test(*id))
			}))
		}

		fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
			Ok(None)
		}

		fn attributes(&mut self, _: &AxHandle) -> CoreResult<Vec<(String, String)>> {
			Ok(Vec::new())
		}
	}
	fn p(role: &str, title: Option<&str>) -> AxProps {
		AxProps {
			role:        role.into(),
			native_role: role.into(),
			title:       title.map(str::to_string),
			value:       None,
			description: None,
			enabled:     Some(true),
			focused:     false,
			bounds:      None,
			actions:     Vec::new(),
			child_count: 0,
		}
	}
	fn window() -> DesktopWindow {
		DesktopWindow {
			id:      "7".into(),
			title:   "Title".into(),
			app:     "Safari".into(),
			pid:     None,
			x:       0,
			y:       0,
			width:   100,
			height:  100,
			focused: true,
		}
	}
	#[test]
	fn generations_keep_current_and_previous() {
		let mut r = AxRegistry::default();
		for g in 1..=3 {
			let generation = r.begin_snapshot("x");
			r.register("x", generation, AxHandle::Test(g));
		}
		assert!(r.resolve("e1").is_err());
		assert!(r.resolve("e2").is_ok());
		assert!(r.resolve("e3").is_ok());
	}
	#[test]
	fn hard_cap_preserves_newest_refs() {
		let mut r = AxRegistry::default();
		let g = r.current_generation("x");
		for n in 0..5_001 {
			r.register("x", g, AxHandle::Test(n));
		}
		assert!(r.entries.len() <= 5_000);
		assert!(r.resolve("e1").is_err());
		assert!(r.resolve("e5001").is_ok());
	}
	#[test]
	fn oversized_snapshot_returns_only_live_refs_and_reports_bound() {
		let mut m = Mock {
			props:    (1..=6_000)
				.map(|id| (id, p("button", Some("Control"))))
				.collect(),
			children: [(1, (2..=6_000).collect())].into(),
		};
		let mut registry = AxRegistry::default();
		for id in 0..5_000 {
			registry.register("other", 1, AxHandle::Test(id));
		}
		let result = snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions {
			max_nodes: Some(10_000),
			all: Some(true),
			..Default::default()
		})
		.unwrap();
		assert!(result.truncated);
		assert_eq!(result.node_count, 5_000);
		assert_eq!(result.skipped, 0);
		for node in result.nodes {
			assert!(registry.resolve(&node.ref_).is_ok());
		}
	}
	#[test]
	fn snapshot_nodes_preserve_values_and_registered_identity() {
		let mut m = Mock {
			props:    [
				(1, p("window", Some("Title"))),
				(2, p("group", None)),
				(3, p("button", Some("Go"))),
			]
			.into(),
			children: [(1, vec![2]), (2, vec![3])].into(),
		};
		let value = format!("\n  {}  \n", "文🦀".repeat(300));
		m.props.get_mut(&3).unwrap().value = Some(value.clone());
		let mut registry = AxRegistry::default();
		m.props.get_mut(&3).unwrap().actions.push("press".into());
		let s = snapshot(&mut m, &mut registry, &window(), &AxSnapshotOptions::default()).unwrap();
		assert_eq!(s.nodes[1].value.as_deref(), Some(value.as_str()));
		assert!(matches!(registry.resolve(&s.nodes[1].ref_).unwrap(), AxHandle::Test(3)));
		assert_eq!(s.nodes[0].role, "window");
		assert_eq!(s.nodes[1].role, "button");
		assert_eq!(s.node_count, 2);
		assert_eq!(s.nodes.len(), s.node_count as usize);
	}
	#[test]
	fn description_labels_unnamed_controls_without_changing_raw_title() {
		let mut reload = p("button", None);
		reload.description = Some("Reload".into());
		reload.actions.push("press".into());
		let mut m = Mock {
			props:    [(1, p("window", Some("Title"))), (2, reload)].into(),
			children: [(1, vec![2])].into(),
		};
		let snapshot =
			snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
				.unwrap();
		assert!(snapshot.text.contains("- button \"Reload\""));

		let nodes = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  Some("button".into()),
			title: Some("reload".into()),
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].title, None);
		assert_eq!(nodes[0].description.as_deref(), Some("Reload"));
	}
	#[test]
	fn truncation_sets_flag_and_trailer() {
		let mut m = Mock {
			props:    [(1, p("window", Some("Title"))), (2, p("button", Some("A")))].into(),
			children: [(1, vec![2])].into(),
		};
		let s = snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions {
			max_nodes: Some(1),
			..Default::default()
		})
		.unwrap();
		assert!(s.truncated);
		assert!(s.text.ends_with("… truncated (1 nodes)"));
	}
	#[test]
	fn unreadable_subtree_is_skipped_with_trailer() {
		let mut m = Mock {
			props:    [(1, p("window", Some("Title"))), (3, p("button", Some("Ready")))].into(),
			children: [(1, vec![2, 3])].into(),
		};
		let s =
			snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions::default())
				.unwrap();
		assert_eq!(s.skipped, 1);
		assert!(!s.truncated);
		assert_eq!(s.node_count, 2);
		let limited = snapshot(&mut m, &mut AxRegistry::default(), &window(), &AxSnapshotOptions {
			max_nodes: Some(2),
			..Default::default()
		})
		.unwrap();
		assert!(limited.truncated);
		assert_eq!(limited.skipped, 1);
		let nodes = query(&mut m, &mut AxRegistry::default(), &window(), &AxQuery {
			role:  Some("button".into()),
			title: None,
			value: None,
			limit: None,
		})
		.unwrap();
		assert_eq!(nodes.len(), 1);
		assert_eq!(nodes[0].title.as_deref(), Some("Ready"));
	}
	#[test]
	fn bounds_center_hit_test_is_global_and_frameless() {
		let bounds = AxBounds { x: -420.0, y: 75.0, width: 80.0, height: 50.0 };
		let mut hit = p("button", Some("Global"));
		hit.bounds = Some(bounds);
		let mut m = Mock {
			props:    [(1, p("window", Some("Title"))), (2, hit)].into(),
			children: HashMap::new(),
		};
		let mut registry = AxRegistry::default();
		let node = element_at_node(
			&mut m,
			&mut registry,
			"desktop",
			bounds.x + bounds.width / 2.0,
			bounds.y + bounds.height / 2.0,
		)
		.unwrap()
		.unwrap();
		assert_eq!(node.ref_, "e1");
		assert_eq!(
			(node.x, node.y, node.width, node.height),
			(Some(-420.0), Some(75.0), Some(80.0), Some(50.0))
		);
		assert!(matches!(registry.resolve("e1").unwrap(), AxHandle::Test(2)));
	}
	#[test]
	fn normalization_tables() {
		for (native, role) in [
			("AXTextArea", "textarea"),
			("AXTextField", "textfield"),
			("AXPopUpButton", "popupbutton"),
			("AXRadioButton", "radio"),
			("AXCheckBox", "checkbox"),
			("AXStaticText", "statictext"),
			("AXScrollArea", "scrollarea"),
			("AXTabGroup", "tabgroup"),
			("AXWebArea", "webarea"),
			("AXRow", "row"),
			("AXCell", "cell"),
			("AXOutline", "outline"),
			("AXButton", "button"),
		] {
			assert_eq!(normalize_role_macos(native), role);
		}
		for (native, role) in [
			("Edit", "textfield"),
			("Document", "textarea"),
			("Text", "statictext"),
			("Hyperlink", "link"),
			("Pane", "group"),
			("TabItem", "tab"),
			("Tab", "tabgroup"),
			("DataItem", "listitem"),
			("DataGrid", "table"),
			("SplitButton", "popupbutton"),
			("Button", "button"),
		] {
			assert_eq!(normalize_role_uia(native), role);
		}
		for (native, multiline, role) in [
			("push button", false, "button"),
			("toggle button", false, "button"),
			("entry", false, "textfield"),
			("text", true, "textarea"),
			("label", false, "statictext"),
			("page tab", false, "tab"),
			("page tab list", false, "tabgroup"),
			("table cell", false, "cell"),
			("tree", false, "outline"),
			("tree item", false, "outlineitem"),
			("frame", false, "window"),
			("dialog", false, "window"),
			("list item", false, "listitem"),
		] {
			assert_eq!(normalize_role_atspi(native, multiline), role);
		}
	}
}
