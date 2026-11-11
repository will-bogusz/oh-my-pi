//! Real Xlib translation, rather than inspecting the sender's planned symbols.
use std::{
	ffi::CString,
	io::{BufRead, BufReader},
	os::raw::{c_char, c_int, c_long, c_ulong, c_void},
	process::{Child, Command, Stdio},
	sync::Arc,
};

use x11rb::{connection::Connection, protocol::xproto::ConnectionExt as _};
use xkeysym::Keysym;

use super::{input::X11Input, keymap::Keymap};
use crate::desktop::{backend::DeliveryMode, control, types::Target};

#[link(name = "X11")]
unsafe extern "C" {
	fn XOpenDisplay(name: *const c_char) -> *mut c_void;
	fn XCloseDisplay(display: *mut c_void) -> c_int;
	fn XDefaultRootWindow(display: *mut c_void) -> c_ulong;
	fn XCreateSimpleWindow(display: *mut c_void, parent: c_ulong, x: c_int, y: c_int, width: u32, height: u32, border_width: u32, border: c_ulong, background: c_ulong) -> c_ulong;
	fn XSelectInput(display: *mut c_void, window: c_ulong, mask: c_long) -> c_int;
	fn XMapWindow(display: *mut c_void, window: c_ulong) -> c_int;
	fn XSetInputFocus(display: *mut c_void, window: c_ulong, revert: c_int, time: c_ulong) -> c_int;
	fn XSync(display: *mut c_void, discard: c_int) -> c_int;
	fn XNextEvent(display: *mut c_void, event: *mut c_long) -> c_int;
	fn XRefreshKeyboardMapping(event: *mut c_long) -> c_int;
	fn XLookupString(event: *mut c_long, buffer: *mut c_char, size: c_int, symbol: *mut c_ulong, compose: *mut c_void) -> c_int;
}

struct Server(Child);
impl Drop for Server {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

fn server() -> (Server, String) {
	let mut server = Server(Command::new("Xvfb")
		.args(["-displayfd", "1", "-screen", "0", "320x240x24", "-nolisten", "tcp"])
		.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("Xvfb starts"));
	let mut number = String::new();
	BufReader::new(server.0.stdout.take().unwrap()).read_line(&mut number).unwrap();
	(server, format!(":{}", number.trim()))
}

/// XLookupString refreshes its cached map on MappingNotify exactly as an Xlib
/// client does. The receiving thread translates while the sender is running.
#[test]
#[ignore = "starts Xvfb and uses Xlib"]
fn remapped_xtest_text_is_translated_before_the_empty_rows_are_restored() {
	let (_server, display) = server();
	let receiver_display = CString::new(display.clone()).unwrap();
	let (ready, started) = std::sync::mpsc::channel();
	let receiver = std::thread::spawn(move || {
		// SAFETY: this thread owns the Display and its XEvent storage, which is
		// Xlib's 24-long union. Every event passed to XLookupString is KeyPress.
		unsafe {
			let display = XOpenDisplay(receiver_display.as_ptr());
			assert!(!display.is_null());
			let window = XCreateSimpleWindow(display, XDefaultRootWindow(display), 0, 0, 100, 100, 0, 0, 0);
			XSelectInput(display, window, 1);
			XMapWindow(display, window);
			XSetInputFocus(display, window, 1, 0);
			XSync(display, 0);
			ready.send(window as u32).unwrap();
			let mut text = String::new();
			while text.chars().count() < "héllo wörld ✓".chars().count() {
				let mut event = [0 as c_long; 24];
				XNextEvent(display, event.as_mut_ptr());
				match event[0] as c_int {
					34 => { XRefreshKeyboardMapping(event.as_mut_ptr()); },
					2 => {
						let mut symbol = 0;
						let mut buffer = [0; 32];
						XLookupString(event.as_mut_ptr(), buffer.as_mut_ptr(), 32, &mut symbol, std::ptr::null_mut());
						text.push(Keysym::new(symbol as u32).key_char().expect("a text keysym"));
					},
					33 => break,
					_ => {},
				}
			}
			XCloseDisplay(display);
			(text, std::time::Instant::now())
		}
	});
	let window = started.recv().unwrap();
	let (conn, screen) = x11rb::connect(Some(&display)).unwrap();
	let root = conn.setup().roots[screen].root;
	let conn = Arc::new(conn);
	let before = conn.get_keyboard_mapping(conn.setup().min_keycode, conn.setup().max_keycode - conn.setup().min_keycode + 1).unwrap().reply().unwrap();
	let mut input = X11Input::new(Arc::clone(&conn), root).unwrap();
	let sent = std::time::Instant::now();
	let result = input.type_text(&Target::Desktop, "héllo wörld ✓", DeliveryMode::Foreground);
	if result.is_err() {
		use x11rb::protocol::xproto::{ClientMessageEvent, EventMask};
		conn.send_event(false, window, EventMask::NO_EVENT, ClientMessageEvent::new(32, window, 0u32, [0u32; 5])).unwrap().check().unwrap();
	}
	let (received, translated) = receiver.join().unwrap();
	result.unwrap();
	assert_eq!(received, "héllo wörld ✓");
	eprintln!("Xlib translated the complete text run in {:?}; remap grace is 100ms", translated.duration_since(sent));
	let after = conn.get_keyboard_mapping(conn.setup().min_keycode, conn.setup().max_keycode - conn.setup().min_keycode + 1).unwrap().reply().unwrap();
	assert_eq!(after.keysyms, before.keysyms, "the core mapping is restored");
	// Planning again must need the same temporary bindings, not find leftovers
	// on the XTEST slave after the core map was restored.
	assert!(Keymap::xtest(&conn).unwrap().plan_text("✓").is_err());
}

#[test]
#[ignore = "starts Xvfb"]
fn remapped_text_restores_empty_rows_on_cancellation_and_unwind() {
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	let before = conn.get_keyboard_mapping(conn.setup().min_keycode, conn.setup().max_keycode - conn.setup().min_keycode + 1).unwrap().reply().unwrap();
	let mut map = Keymap::xtest(&conn).unwrap();
	let source = control::CancellationSource::default();
	let token = source.token();
	let error = control::with_token_for_test(&token, || {
		let mapping = map.bind_text(Arc::clone(&conn), "✓✓").unwrap();
		let steps = map.plan_text("✓✓").unwrap();
		let result = super::keymap::run_steps(&steps, |step| {
			use x11rb::protocol::xtest::ConnectionExt as _;
			conn.xtest_fake_input(if step.press { 2 } else { 3 }, step.keycode, 0, conn.setup().roots[0].root, 0, 0, 0)
				.unwrap().check().unwrap();
			if step.press { source.cancel(); }
			Ok(())
		});
		mapping.finish(result)
	}).unwrap_err();
	assert!(error.message.to_lowercase().contains("cancel"), "{}", error.message);
	assert!(Keymap::xtest(&conn).unwrap().plan_text("✓").is_err());
	let after = conn.get_keyboard_mapping(conn.setup().min_keycode, conn.setup().max_keycode - conn.setup().min_keycode + 1).unwrap().reply().unwrap();
	assert_eq!(after.keysyms, before.keysyms, "cancel restores the original empty core rows");
	let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
		let mut map = Keymap::xtest(&conn).unwrap();
		let _mapping = map.bind_text(Arc::clone(&conn), "✓").unwrap();
		panic!("injected unwind");
	}));
	assert!(result.is_err());
	assert!(Keymap::xtest(&conn).unwrap().plan_text("✓").is_err());
	let after = conn.get_keyboard_mapping(conn.setup().min_keycode, conn.setup().max_keycode - conn.setup().min_keycode + 1).unwrap().reply().unwrap();
	assert_eq!(after.keysyms, before.keysyms, "unwind restores the original empty core rows");
}

#[test]
#[ignore = "starts Xvfb"]
fn remapped_device_text_restores_both_slave_and_master() {
	use x11rb::protocol::xinput::{ConnectionExt as _, Device, DeviceType, HierarchyChange, HierarchyChangeData, HierarchyChangeDataAddMaster};
	let (_server, display) = server();
	let (conn, _) = x11rb::connect(Some(&display)).unwrap();
	let conn = Arc::new(conn);
	conn.xinput_xi_query_version(2, 0).unwrap().reply().unwrap();
	let name = b"remap fixture";
	conn.xinput_xi_change_hierarchy(&[HierarchyChange {
		len: ((8 + name.len()).div_ceil(4)) as u16,
		data: HierarchyChangeData::AddMaster(HierarchyChangeDataAddMaster {
			name: name.to_vec(), send_core: false, enable: true,
		}),
	}]).unwrap().check().unwrap();
	let devices = conn.xinput_xi_query_device(Device::ALL).unwrap().reply().unwrap();
	let master = devices.infos.iter().find(|info| info.name == b"remap fixture keyboard" && info.type_ == DeviceType::MASTER_KEYBOARD).unwrap().deviceid;
	let slave = devices.infos.iter().find(|info| info.attachment == master && info.type_ == DeviceType::SLAVE_KEYBOARD).unwrap().deviceid;
	let mut map = Keymap::mpx(&conn, slave, master).unwrap();
	let mapping = map.bind_text(Arc::clone(&conn), "✓").unwrap();
	assert!(Keymap::device(&conn, slave).unwrap().plan_text("✓").is_ok());
	assert!(Keymap::device(&conn, master).unwrap().plan_text("✓").is_ok());
	mapping.finish(Ok(())).unwrap();
	assert!(Keymap::device(&conn, slave).unwrap().plan_text("✓").is_err());
	assert!(Keymap::device(&conn, master).unwrap().plan_text("✓").is_err());
}
