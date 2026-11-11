use std::hash::{DefaultHasher, Hash, Hasher};

use super::super::{
	ax::AxProps,
	error::{DesktopError, ErrorCode},
};

// UIA_E_ELEMENTNOTAVAILABLE also describes unrealized virtualized items.
pub(super) const ELEMENT_NOT_AVAILABLE: i32 = -2_147_220_991;

pub(super) const fn destroyed(virtualized_pattern_error: Option<i32>) -> bool {
	matches!(virtualized_pattern_error, Some(ELEMENT_NOT_AVAILABLE))
}

pub(super) fn uia_error(code: i32, message: String) -> DesktopError {
	if code == ELEMENT_NOT_AVAILABLE {
		DesktopError::stale_ref(message)
	} else {
		DesktopError::ax_failed(message)
	}
}

pub(super) fn walk_error(error: DesktopError) -> DesktopError {
	if error.code == ErrorCode::StaleRef {
		DesktopError::ax_failed(error.message)
	} else {
		error
	}
}

pub(super) fn with_children<T, E>(
	mut props: AxProps,
	children: Result<Vec<T>, E>,
) -> (AxProps, Vec<T>) {
	let children = if let Ok(children) = children {
		children
	} else {
		props.partial = true;
		Vec::new()
	};
	props.child_count = children.len().min(u32::MAX as usize) as u32;
	(props, children)
}

pub(super) fn toggle_value(value: Option<String>, toggle: Option<i32>) -> Option<String> {
	value
		.filter(|value| !value.is_empty())
		.or_else(|| match toggle {
			Some(0) => Some("0".into()),
			Some(1) => Some("1".into()),
			Some(2) => Some("2".into()),
			_ => None,
		})
}

pub(super) fn selected(role: &str, selected: bool) -> bool {
	selected && matches!(role, "DataItem" | "ListItem" | "TreeItem" | "TabItem" | "RadioButton")
}

pub(super) const fn expanded(state: Option<i32>) -> Option<bool> {
	match state {
		Some(0) => Some(false),
		Some(1 | 2) => Some(true),
		_ => None,
	}
}

pub(super) fn identity(
	role: &str,
	fields: &[Result<Option<&str>, ()>],
	toggle: Result<Option<i32>, ()>,
) -> Option<u64> {
	let mut hash = DefaultHasher::new();
	role.hash(&mut hash);
	for field in fields {
		field
			.as_ref()
			.ok()?
			.filter(|value| !value.is_empty())
			.hash(&mut hash);
	}
	toggle.ok()?.hash(&mut hash);
	Some(hash.finish())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn destroyed_elements_report_stale_instead_of_generic_failure() {
		use super::super::super::error::ErrorCode;
		assert_eq!(uia_error(ELEMENT_NOT_AVAILABLE, "gone".into()).code, ErrorCode::StaleRef);
		assert_eq!(uia_error(-1, "failed".into()).code, ErrorCode::AxFailed);
		assert!(destroyed(Some(ELEMENT_NOT_AVAILABLE)));
		assert!(!destroyed(None));
		assert!(!destroyed(Some(-1)));
	}
	#[test]
	fn checkbox_states_preserve_other_values() {
		assert_eq!(toggle_value(None, Some(0)).as_deref(), Some("0"));
		assert_eq!(toggle_value(None, Some(1)).as_deref(), Some("1"));
		assert_eq!(toggle_value(Some(String::new()), Some(2)).as_deref(), Some("2"));
		assert_eq!(toggle_value(Some("custom".into()), Some(1)).as_deref(), Some("custom"));
		assert_eq!(toggle_value(None, None), None);
	}

	#[test]
	fn children_read_failures_keep_the_node_partial() {
		let props = AxProps {
			role:        "checkbox".into(),
			native_role: "CheckBox".into(),
			title:       Some("Remember me".into()),
			value:       Some("1".into()),
			description: None,
			enabled:     true,
			focused:     false,
			bounds:      None,
			actions:     Vec::new(),
			child_count: 0,
			identity:    Some(7),
			partial:     false,
			selected:    false,
			expanded:    None,
			role_name:   None,
		};
		let (props, children) = with_children(props, Err::<Vec<u8>, _>(()));
		assert!(props.partial);
		assert_eq!(props.title.as_deref(), Some("Remember me"));
		assert_eq!(props.value.as_deref(), Some("1"));
		assert_eq!(props.child_count, 0);
		assert!(children.is_empty());
		let (props, children) = with_children(props, Ok::<_, ()>(vec![1_u8]));
		assert!(props.partial);
		assert_eq!(props.child_count, 1);
		assert_eq!(children, [1]);
	}

	#[test]
	fn selection_and_expansion_states_are_not_invented() {
		assert!(selected("ListItem", true));
		assert!(!selected("ListItem", false));
		assert!(!selected("Window", true));
		assert_eq!(expanded(Some(0)), Some(false));
		assert_eq!(expanded(Some(1)), Some(true));
		assert_eq!(expanded(Some(2)), Some(true));
		assert_eq!(expanded(Some(3)), None);
		assert_eq!(expanded(None), None);
	}

	#[test]
	fn recreated_controls_match_only_fully_read_identity() {
		let fields = [
			Ok(Some("Remember me")),
			Ok(Some("remember")),
			Ok(Some("Button")),
			Ok(None),
			Ok(None),
			Ok(None),
		];
		let original = identity("CheckBox", &fields, Ok(Some(0))).unwrap();
		assert_eq!(identity("CheckBox", &fields, Ok(Some(0))), Some(original));
		assert_ne!(identity("RadioButton", &fields, Ok(Some(0))), Some(original));
		assert_ne!(identity("CheckBox", &fields, Ok(Some(1))), Some(original));
		assert_eq!(identity("CheckBox", &fields, Err(())), None);
		let mut changed = fields;
		changed[1] = Ok(Some("other"));
		assert_ne!(identity("CheckBox", &changed, Ok(Some(0))), Some(original));
		changed[1] = Err(());
		assert_eq!(identity("CheckBox", &changed, Ok(Some(0))), None);
	}

	#[test]
	fn unavailable_walk_nodes_are_not_reported_as_vanished() {
		let error = walk_error(DesktopError::stale_ref("not available"));
		assert_eq!(error.code, ErrorCode::AxFailed);
		assert_eq!(error.message, "not available");
		assert_eq!(
			walk_error(DesktopError::window_not_found("closed")).code,
			ErrorCode::WindowNotFound,
		);
	}
}
