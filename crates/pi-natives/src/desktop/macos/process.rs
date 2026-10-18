//! Classifies target processes whose input stack cannot honour a particular
//! background delivery route, so the route can refuse instead of reporting a
//! silent drop as success.

use std::{
	collections::HashMap,
	ffi::{CStr, OsStr},
	fs::{self, File},
	io::{Read, Seek, SeekFrom},
	mem,
	os::unix::ffi::OsStrExt,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::{NSBundle, ns_string};
use parking_lot::Mutex;

/// `proc_pidinfo` flavor for file-backed regions only
/// (`PROC_PIDREGIONPATHINFO2`, private in `<sys/proc_info_private.h>`); skips
/// anonymous memory.
const PROC_PIDREGIONPATHINFO2: libc::c_int = 22;
/// Public `proc_pidinfo` flavor that walks every region.
const PROC_PIDREGIONPATHINFO: libc::c_int = 8;
/// Bounds the region walk so a pathological address space cannot stall input.
const MAX_REGIONS: usize = 65_536;

/// `struct proc_regioninfo` from `<sys/proc_info.h>`.
#[repr(C)]
struct ProcRegionInfo {
	protection:               u32,
	max_protection:           u32,
	inheritance:              u32,
	flags:                    u32,
	offset:                   u64,
	behavior:                 u32,
	user_wired_count:         u32,
	user_tag:                 u32,
	pages_resident:           u32,
	pages_shared_now_private: u32,
	pages_swapped_out:        u32,
	pages_dirtied:            u32,
	ref_count:                u32,
	shadow_depth:             u32,
	share_mode:               u32,
	private_pages_resident:   u32,
	shared_pages_resident:    u32,
	obj_id:                   u32,
	depth:                    u32,
	address:                  u64,
	size:                     u64,
}

/// `struct proc_regionwithpathinfo`: region info followed by
/// `struct vnode_info_path` (152-byte `vnode_info`, then a `MAXPATHLEN` path).
#[repr(C)]
struct ProcRegionWithPathInfo {
	region:     ProcRegionInfo,
	vnode_info: [u8; 152],
	path:       [libc::c_char; 1024],
}

/// Whether `pid` maps a Tk toolkit that places presses at the hardware
/// pointer: Tk 8.6 and later, or a Tk whose version cannot be read.
///
/// Tk 9's macOS backend translates every mouse event through the global
/// hardware pointer position rather than the event's own location, so a
/// pid-routed background press lands wherever the user's pointer happens to
/// be, or nowhere; macOS's own Tk 8.5 places it at the event location.
/// Detection walks the target's file-backed regions (same-user, no task
/// port); a Tk image loaded only from the dyld shared cache, as macOS's Tk 8.5
/// is, is invisible here, so Python's `_tkinter` is judged by the Tk it links.
pub(super) fn reads_hardware_pointer(pid: libc::pid_t) -> bool {
	walk_regions(pid, PROC_PIDREGIONPATHINFO2)
		.or_else(|| walk_regions(pid, PROC_PIDREGIONPATHINFO))
		.unwrap_or(false)
}

/// Walks `pid`'s mapped regions with `flavor`. `None` means the kernel
/// rejected the flavor before any region was read.
fn walk_regions(pid: libc::pid_t, flavor: libc::c_int) -> Option<bool> {
	let size = mem::size_of::<ProcRegionWithPathInfo>();
	let size_arg = libc::c_int::try_from(size).ok()?;
	let mut address = 0u64;
	let mut read_any = false;
	// An image maps several segments; its verdict is read once.
	let mut cleared = String::new();
	for _ in 0..MAX_REGIONS {
		// SAFETY: An all-zero bit pattern is valid for this plain C struct.
		let mut info: ProcRegionWithPathInfo = unsafe { mem::zeroed() };
		// SAFETY: The buffer is exactly the kernel structure size and outlives
		// the synchronous call.
		let written =
			unsafe { libc::proc_pidinfo(pid, flavor, address, (&raw mut info).cast(), size_arg) };
		if !usize::try_from(written).is_ok_and(|written| written >= size) {
			break;
		}
		read_any = true;
		// SAFETY: The kernel NUL-terminates `path` within its MAXPATHLEN buffer.
		let path = unsafe { CStr::from_ptr(info.path.as_ptr()) }.to_string_lossy();
		if path != cleared
			&& let Some(image) = tk_image(&path)
		{
			if reads_pointer(image, || read_image(path.as_ref()).and_then(|binary| linked_tk(&binary)))
			{
				return Some(true);
			}
			cleared = path.into_owned();
		}
		let next = info.region.address.saturating_add(info.region.size);
		if next <= address {
			break;
		}
		address = next;
	}
	read_any.then_some(false)
}

/// A mapped image that is, or carries, the Tk toolkit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TkImage {
	/// A Tk library or framework of this (major, minor) version.
	Version(u32, u32),
	/// A Tk library or framework whose path names no version.
	Unversioned,
	/// Python's `_tkinter` extension, which links or embeds Tk.
	Tkinter,
}

/// Classifies `Tk.framework` bundles, Tk shared libraries (`libtk8.6.dylib`,
/// Tk 9's `libtcl9tk9.0.dylib`), and Python's `_tkinter` extension.
fn tk_image(path: &str) -> Option<TkImage> {
	if let Some((_, inside)) = path.split_once("/Tk.framework/") {
		return Some(
			inside
				.strip_prefix("Versions/")
				.and_then(|rest| rest.split('/').next())
				.and_then(tk_version)
				.unwrap_or(TkImage::Unversioned),
		);
	}
	let file = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
	if file
		.strip_suffix(".so")
		.is_some_and(|stem| stem.starts_with("_tkinter"))
	{
		return Some(TkImage::Tkinter);
	}
	let stem = file.strip_suffix(".dylib")?.strip_prefix("lib")?;
	let stem = match stem.strip_prefix("tcl") {
		Some(after_tcl) => {
			let digits = after_tcl.bytes().take_while(u8::is_ascii_digit).count();
			if digits == 0 {
				return None;
			}
			&after_tcl[digits..]
		},
		None => stem,
	};
	let version = stem.strip_prefix("tk")?;
	if !version
		.bytes()
		.next()
		.is_some_and(|byte| byte.is_ascii_digit())
	{
		return None;
	}
	Some(tk_version(version).unwrap_or(TkImage::Unversioned))
}

/// Parses `major.minor` with an optional patch level.
fn tk_version(version: &str) -> Option<TkImage> {
	let mut parts = version.split('.');
	let major = parts.next()?.parse().ok()?;
	let minor = parts.next()?.parse().ok()?;
	Some(TkImage::Version(major, minor))
}

/// Whether a mapped Tk `image` places presses at the hardware pointer. A
/// `_tkinter` extension is judged by the Tk `linked` reads from its load
/// commands; one that links no Tk embeds a Tk of unknown version.
fn reads_pointer(image: TkImage, linked: impl FnOnce() -> Option<TkImage>) -> bool {
	let image = match image {
		TkImage::Tkinter => linked().unwrap_or(TkImage::Unversioned),
		image => image,
	};
	match image {
		TkImage::Version(major, minor) => (major, minor) > (8, 5),
		TkImage::Unversioned | TkImage::Tkinter => true,
	}
}

/// Whether `pid` runs inside an Electron app bundle, whose renderer drops
/// pid-routed wheel events while its window is in the background.
pub(super) fn is_electron(pid: libc::pid_t) -> bool {
	// `<App>.app/Contents/MacOS/<exe>` ships its runtime beside it in
	// `<App>.app/Contents/Frameworks`.
	executable_path(pid)
		.as_deref()
		.and_then(Path::parent)
		.and_then(Path::parent)
		.is_some_and(|contents| {
			contents
				.join("Frameworks/Electron Framework.framework")
				.exists()
		})
}

fn executable_path(pid: libc::pid_t) -> Option<PathBuf> {
	let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
	let capacity = u32::try_from(buffer.len()).ok()?;
	// SAFETY: `buffer` is writable for `capacity` bytes for the synchronous
	// call.
	let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), capacity) };
	let executable = buffer.get(..usize::try_from(length).ok()?)?;
	Some(Path::new(OsStr::from_bytes(executable)).to_path_buf())
}

/// Use process identity, not a substring of the display name ("Arc" also
/// matches Archive Utility). Electron applications have arbitrary bundle ids.
pub(super) fn is_chromium(pid: libc::pid_t) -> bool {
	is_electron(pid)
		|| NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			.and_then(|app| app.bundleIdentifier())
			.is_some_and(|bundle| is_chromium_bundle(&bundle.to_string()))
}

fn is_chromium_bundle(bundle: &str) -> bool {
	[
		"com.google.Chrome",
		"com.google.chrome.for.testing",
		"org.chromium.Chromium",
		"com.brave.Browser",
		"com.microsoft.edgemac",
		"company.thebrowser.Browser",
		"com.vivaldi.Vivaldi",
		"com.operasoftware.Opera",
	]
	.iter()
	.any(|base| {
		bundle == *base
			|| bundle
				.strip_prefix(*base)
				.is_some_and(|suffix| suffix.starts_with('.'))
	})
}

const MH_MAGIC_64: u32 = 0xfeed_facf;
const FAT_MAGIC: u32 = 0xcafe_babe;
const FAT_MAGIC_64: u32 = 0xcafe_babf;
const LC_REQ_DYLD: u32 = 0x8000_0000;
/// `LC_LOAD_DYLIB`, `LC_LOAD_WEAK_DYLIB`, `LC_REEXPORT_DYLIB`,
/// `LC_LAZY_LOAD_DYLIB`, `LC_LOAD_UPWARD_DYLIB`: commands whose payload is a
/// `dylib_command` naming a library the image links.
const DYLIB_COMMANDS: [u32; 5] =
	[0x0c, 0x18 | LC_REQ_DYLD, 0x1f | LC_REQ_DYLD, 0x20, 0x23 | LC_REQ_DYLD];
/// `sizeof(struct mach_header_64)`.
const MACH_HEADER_64: usize = 32;
/// `sizeof(struct dylib_command)`, where the install name may start.
const DYLIB_COMMAND: usize = 24;
/// Largest `_tkinter` image read for its load commands; Python's are about
/// 100 KiB. A larger one counts as unreadable.
const MAX_IMAGE_BYTES: u64 = 16 << 20;

/// The bytes of the image at `path`, unless it is larger than
/// [`MAX_IMAGE_BYTES`] or unreadable.
fn read_image(path: &str) -> Option<Vec<u8>> {
	let file = fs::File::open(path).ok()?;
	if file.metadata().ok()?.len() > MAX_IMAGE_BYTES {
		return None;
	}
	let mut binary = Vec::new();
	file.take(MAX_IMAGE_BYTES).read_to_end(&mut binary).ok()?;
	Some(binary)
}

/// The Tk library a Mach-O image (thin 64-bit or universal) links, from its
/// dylib load commands. A universal image counts only when every slice that
/// names a Tk names the same one. Malformed headers read as `None`, which
/// [`reads_pointer`] treats as a Tk of unknown version.
fn linked_tk(binary: &[u8]) -> Option<TkImage> {
	let be = |at: usize| -> Option<u32> {
		Some(u32::from_be_bytes(binary.get(at..at.checked_add(4)?)?.try_into().ok()?))
	};
	let slices: Vec<&[u8]> = match be(0)? {
		magic @ (FAT_MAGIC | FAT_MAGIC_64) => {
			let wide = magic == FAT_MAGIC_64;
			let entry = if wide { 32 } else { 20 };
			let count = usize::try_from(be(4)?).ok()?;
			if count.checked_mul(entry)?.checked_add(8)? > binary.len() {
				return None;
			}
			(0..count)
				.map(|index| {
					let at = 8 + index * entry;
					let (offset, size) = if wide {
						let read = |at: usize| -> Option<usize> {
							usize::try_from(u64::from_be_bytes(binary.get(at..at + 8)?.try_into().ok()?))
								.ok()
						};
						(read(at + 8)?, read(at + 16)?)
					} else {
						(usize::try_from(be(at + 8)?).ok()?, usize::try_from(be(at + 12)?).ok()?)
					};
					binary.get(offset..offset.checked_add(size)?)
				})
				.collect::<Option<_>>()?
		},
		_ => vec![binary],
	};
	let mut found = None;
	for slice in slices {
		let Some(image) = linked_libraries(slice)?
			.into_iter()
			.find_map(|name| tk_image(&name))
		else {
			continue;
		};
		if found.is_some_and(|seen| seen != image) {
			return Some(TkImage::Unversioned);
		}
		found = Some(image);
	}
	found
}

/// Install names from a thin little-endian 64-bit Mach-O image's dylib load
/// commands, read only inside the header's `sizeofcmds`; empty for anything
/// but such an image, and `None` when its load commands are malformed.
fn linked_libraries(image: &[u8]) -> Option<Vec<String>> {
	let le = |at: usize| -> Option<usize> {
		let bytes = image.get(at..at.checked_add(4)?)?;
		usize::try_from(u32::from_le_bytes(bytes.try_into().ok()?)).ok()
	};
	let mut names = Vec::new();
	if le(0) != usize::try_from(MH_MAGIC_64).ok() {
		return Some(names);
	}
	let count = le(16)?;
	let end = MACH_HEADER_64.checked_add(le(20)?)?;
	if end > image.len() {
		return None;
	}
	let mut at = MACH_HEADER_64;
	for _ in 0..count {
		let command = u32::try_from(le(at)?).ok()?;
		let size = le(at + 4)?;
		let next = at.checked_add(size)?;
		if size < 8 || next > end {
			return None;
		}
		if DYLIB_COMMANDS.contains(&command) {
			let offset = le(at + 8)?;
			if !(DYLIB_COMMAND..size).contains(&offset) {
				return None;
			}
			let name = &image[at + offset..next];
			let length = name
				.iter()
				.position(|&byte| byte == 0)
				.unwrap_or(name.len());
			names.push(String::from_utf8_lossy(&name[..length]).into_owned());
		}
		at = next;
	}
	Some(names)
}

/// How a client that shows another computer or device forwards input to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RemoteScreen {
	/// Sends each key event's key code to the remote computer (Screen
	/// Sharing), with the modifiers the physical keyboard holds rather than
	/// any the event carries.
	KeyEvents,
	/// Streams HID report state, modifier keys included, to a paired device
	/// (iPhone Mirroring), which misses a key or button transition shorter
	/// than its report interval.
	HidReports,
}

/// Remote-screen linkage of the executables processes run, keyed by pid and
/// executable path so a reused pid is read afresh.
type LinkageCache = Mutex<HashMap<(libc::pid_t, PathBuf), Option<RemoteScreen>>>;

/// Every input event classifies its target, so each process's executable is
/// read once.
static LINKAGE: LazyLock<LinkageCache> = LazyLock::new(LinkageCache::default);
/// Processes whose linkage is kept before the cache starts over.
const MAX_CACHED_LINKAGES: usize = 64;

/// Whether `pid` shows a remote screen. Such a client forwards a key event's
/// key code and ignores its Unicode text.
pub(super) fn remote_screen(pid: libc::pid_t) -> Option<RemoteScreen> {
	let bundle = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleIdentifier())
		.map(|bundle| bundle.to_string());
	classify_remote_screen(bundle.as_deref(), || {
		cached_linkage(&LINKAGE, pid, executable_path(pid)?, |executable| {
			linked_dylibs(&mut File::open(executable).ok()?)
		})
	})
}

/// Apple's own clients are known by bundle identifier, so an executable that
/// cannot be read (replaced by an update, say) never hides them; any other
/// application is judged by the Apple screen-sharing framework it links.
fn classify_remote_screen(
	bundle: Option<&str>,
	linkage: impl FnOnce() -> Option<RemoteScreen>,
) -> Option<RemoteScreen> {
	match bundle {
		Some("com.apple.ScreenSharing") => Some(RemoteScreen::KeyEvents),
		Some("com.apple.ScreenContinuity") => Some(RemoteScreen::HidReports),
		_ => linkage(),
	}
}

/// The linkage `cache` holds for `pid` running `executable`, otherwise the
/// one `linked_dylibs` reads. An executable that cannot be read is not kept,
/// so the next event reads it again.
fn cached_linkage(
	cache: &LinkageCache,
	pid: libc::pid_t,
	executable: PathBuf,
	linked_dylibs: impl FnOnce(&Path) -> Option<Vec<Vec<u8>>>,
) -> Option<RemoteScreen> {
	let key = (pid, executable);
	if let Some(&linkage) = cache.lock().get(&key) {
		return linkage;
	}
	let linkage = remote_screen_linkage(&linked_dylibs(&key.1)?);
	let mut cache = cache.lock();
	if cache.len() >= MAX_CACHED_LINKAGES {
		cache.clear();
	}
	cache.insert(key, linkage);
	linkage
}

fn remote_screen_linkage(dylibs: &[Vec<u8>]) -> Option<RemoteScreen> {
	let links = |framework: &[u8]| {
		dylibs
			.iter()
			.any(|dylib| dylib.windows(framework.len()).any(|part| part == framework))
	};
	if links(b"/ScreenSharingKit.framework/") {
		Some(RemoteScreen::HidReports)
	} else if links(b"/ScreenSharing.framework/") {
		Some(RemoteScreen::KeyEvents)
	} else {
		None
	}
}

const FAT_MAGIC: u32 = 0xcafe_babe;
const FAT_MAGIC_64: u32 = 0xcafe_babf;
const MH_MAGIC_64: u32 = 0xfeed_facf;
#[cfg(target_arch = "aarch64")]
const NATIVE_CPU_TYPE: u32 = 0x0100_000c;
#[cfg(not(target_arch = "aarch64"))]
const NATIVE_CPU_TYPE: u32 = 0x0100_0007;
/// `LC_LOAD_DYLIB` and its weak, re-export, lazy and upward variants.
const DYLIB_COMMANDS: [u32; 5] = [0xc, 0x8000_0018, 0x8000_001f, 0x20, 0x8000_0023];
/// Bounds the load-command read of a malformed executable.
const MAX_LOAD_COMMANDS: usize = 1 << 20;

/// Install names of the dylibs a 64-bit Mach-O executable links, read from
/// the slice for this CPU (or the first slice) of a universal binary.
fn linked_dylibs(file: &mut (impl Read + Seek)) -> Option<Vec<Vec<u8>>> {
	let mut start = [0u8; 8];
	file.read_exact(&mut start).ok()?;
	let slice = match be_u32(&start, 0)? {
		fat @ (FAT_MAGIC | FAT_MAGIC_64) => {
			// `fat_arch` holds a 32-bit offset at 8; `fat_arch_64` a 64-bit one.
			let entry_size = if fat == FAT_MAGIC { 20 } else { 32 };
			let count = usize::try_from(be_u32(&start, 4)?).ok()?.min(16);
			let mut entries = vec![0u8; entry_size * count];
			file.read_exact(&mut entries).ok()?;
			let mut slices = entries.chunks_exact(entry_size);
			let entry = slices
				.clone()
				.find(|entry| be_u32(entry, 0) == Some(NATIVE_CPU_TYPE))
				.or_else(|| slices.next())?;
			if fat == FAT_MAGIC {
				u64::from(be_u32(entry, 8)?)
			} else {
				u64::from_be_bytes(entry.get(8..16)?.try_into().ok()?)
			}
		},
		_ => 0,
	};
	// `mach_header_64`: magic at 0, `ncmds` at 16, `sizeofcmds` at 20.
	let mut header = [0u8; 32];
	file.seek(SeekFrom::Start(slice)).ok()?;
	file.read_exact(&mut header).ok()?;
	if le_u32(&header, 0)? != MH_MAGIC_64 {
		return None;
	}
	let size = usize::try_from(le_u32(&header, 20)?).ok()?;
	if size > MAX_LOAD_COMMANDS {
		return None;
	}
	let mut commands = vec![0u8; size];
	file.read_exact(&mut commands).ok()?;
	let mut dylibs = Vec::new();
	let mut rest = commands.as_slice();
	for _ in 0..le_u32(&header, 16)? {
		// Every load command starts with its kind and total size; a dylib
		// command's install name sits at the offset stored at 8.
		let length = usize::try_from(le_u32(rest, 4)?).ok()?;
		let command = rest.get(..length).filter(|_| length >= 8)?;
		if DYLIB_COMMANDS.contains(&le_u32(command, 0)?) {
			let name = command.get(usize::try_from(le_u32(command, 8)?).ok()?..)?;
			dylibs.push(name.split(|&byte| byte == 0).next()?.to_vec());
		}
		rest = &rest[length..];
	}
	Some(dylibs)
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

/// Whether `pid` is a `UIKit` app such as Mac Catalyst: its bundle declares
/// `UIDeviceFamily`, which `AppKit` apps' do not. The session
/// thread has no autorelease pool of its own, so the lookup brings one.
pub(super) fn is_uikit(pid: libc::pid_t) -> bool {
	autoreleasepool(|_| {
		NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			.and_then(|app| app.bundleURL())
			.and_then(|url| NSBundle::bundleWithURL(&url))
			.is_some_and(|bundle| {
				bundle
					.objectForInfoDictionaryKey(ns_string!("UIDeviceFamily"))
					.is_some()
			})
	})
}

/// Terminal AX text areas represent a rendered grid, not the pty input. Even a
/// successful AXSelectedText/AXValue write is not proof that the shell received
/// it.
pub(super) fn is_terminal(pid: libc::pid_t) -> bool {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleIdentifier())
		.is_some_and(|bundle| {
			matches!(
				bundle.to_string().as_str(),
				"co.zeit.hyper"
					| "com.apple.Terminal"
					| "com.github.wez.wezterm"
					| "com.googlecode.iterm2"
					| "com.mitchellh.ghostty"
					| "dev.warp.Warp-Stable"
					| "dev.zed.Zed.Helper"
					| "io.alacritty"
					| "net.kovidgoyal.kitty"
					| "org.alacritty"
			)
		})
}

/// `pid`'s application name as the Dock shows it.
pub(super) fn application_name(pid: libc::pid_t) -> Option<String> {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?
		.localizedName()
		.map(|name| name.to_string())
}

/// When `pid` started, in microseconds since the epoch: a later process that
/// reuses the id has a later start.
pub(in crate::desktop) fn started(pid: libc::pid_t) -> Option<u64> {
	let size = libc::c_int::try_from(mem::size_of::<libc::proc_bsdinfo>()).ok()?;
	// SAFETY: An all-zero bit pattern is valid for this plain C struct.
	let mut info: libc::proc_bsdinfo = unsafe { mem::zeroed() };
	// SAFETY: The buffer is exactly the kernel structure size and outlives the
	// synchronous call.
	let written =
		unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
	(written == size).then(|| {
		info
			.pbi_start_tvsec
			.saturating_mul(1_000_000)
			.saturating_add(info.pbi_start_tvusec)
	})
}

#[cfg(test)]
mod tests {
	use std::{
		io::{BufRead, BufReader},
		path::Path,
		process::{Command, Stdio},
	};

	use super::*;

	#[test]
	fn tk_images_match_with_their_versions_and_neighbours_do_not() {
		for (path, image) in [
			("/Library/Frameworks/Tk.framework/Versions/8.6/Tk", TkImage::Version(8, 6)),
			("/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk", TkImage::Version(8, 5)),
			("/opt/homebrew/Cellar/tcl-tk/9.0.2/lib/libtcl9tk9.0.dylib", TkImage::Version(9, 0)),
			("/opt/homebrew/opt/tcl-tk@8/lib/libtk8.6.dylib", TkImage::Version(8, 6)),
			("/Applications/Foo.app/Contents/Frameworks/Tk.framework/Tk", TkImage::Unversioned),
			("/usr/local/lib/libtk86.dylib", TkImage::Unversioned),
			("/usr/local/lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so", TkImage::Tkinter),
		] {
			assert_eq!(tk_image(path), Some(image), "{path}");
		}
		for path in [
			"",
			"/opt/homebrew/lib/libtcl9.0.dylib",
			"/opt/homebrew/lib/libtkrzw.dylib",
			"/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit",
			"/usr/lib/python3/_tkinter_helper.py",
			"/Applications/Foo.app/Contents/MacOS/tk8.6",
		] {
			assert_eq!(tk_image(path), None, "{path}");
		}
	}

	#[test]
	fn chromium_identity_does_not_match_unrelated_display_names() {
		assert!(is_chromium_bundle("com.google.Chrome.canary"));
		assert!(is_chromium_bundle("company.thebrowser.Browser"));
		assert!(is_chromium_bundle("com.google.chrome.for.testing"));
		assert!(!is_chromium_bundle("com.apple.archiveutility"));
		assert!(!is_chromium_bundle("com.google.ChromeNotABrowser"));
	}

	#[test]
	fn only_tk_newer_than_8_5_or_of_unknown_version_reads_the_hardware_pointer() {
		let unread = || -> Option<TkImage> { panic!("only _tkinter reads its linked Tk") };
		assert!(!reads_pointer(TkImage::Version(8, 5), unread));
		assert!(!reads_pointer(TkImage::Version(8, 4), unread));
		assert!(reads_pointer(TkImage::Version(8, 6), unread));
		assert!(reads_pointer(TkImage::Version(9, 1), unread));
		assert!(reads_pointer(TkImage::Unversioned, unread));
		// macOS's /usr/bin/python3 links the system Tk 8.5, which lives only in
		// the dyld shared cache, so its _tkinter is the one image the walk sees.
		assert!(!reads_pointer(TkImage::Tkinter, || Some(TkImage::Version(8, 5))));
		assert!(reads_pointer(TkImage::Tkinter, || Some(TkImage::Version(9, 0))));
		assert!(reads_pointer(TkImage::Tkinter, || Some(TkImage::Unversioned)));
		// A _tkinter that links no Tk embeds one of unknown version.
		assert!(reads_pointer(TkImage::Tkinter, || None));
	}

	/// A thin arm64 Mach-O image whose load commands link `libraries`, after a
	/// segment command that names no library.
	fn macho(libraries: &[&str]) -> Vec<u8> {
		let mut commands = Vec::new();
		let mut segment = vec![0u8; 72];
		segment[..4].copy_from_slice(&0x19u32.to_le_bytes());
		segment[4..8].copy_from_slice(&72u32.to_le_bytes());
		commands.push(segment);
		for library in libraries {
			let size = (24 + library.len() + 1).next_multiple_of(8);
			let mut command = vec![0u8; size];
			command[..4].copy_from_slice(&0x0cu32.to_le_bytes());
			command[4..8].copy_from_slice(&u32::try_from(size).unwrap().to_le_bytes());
			command[8..12].copy_from_slice(&24u32.to_le_bytes());
			command[24..24 + library.len()].copy_from_slice(library.as_bytes());
			commands.push(command);
		}
		let commands = commands.concat();
		let mut image = vec![0u8; 32];
		image[..4].copy_from_slice(&MH_MAGIC_64.to_le_bytes());
		image[16..20].copy_from_slice(&u32::try_from(libraries.len() + 1).unwrap().to_le_bytes());
		image[20..24].copy_from_slice(&u32::try_from(commands.len()).unwrap().to_le_bytes());
		image.extend(commands);
		image
	}

	/// `image` with the little-endian `u32` at `at` replaced by `value`.
	fn patched(image: &[u8], at: usize, value: u32) -> Vec<u8> {
		let mut image = image.to_vec();
		image[at..at + 4].copy_from_slice(&value.to_le_bytes());
		image
	}

	/// A universal image holding `slices` back to back after a 32-bit fat
	/// header.
	fn universal(slices: &[Vec<u8>]) -> Vec<u8> {
		let mut header = FAT_MAGIC.to_be_bytes().to_vec();
		header.extend(u32::try_from(slices.len()).unwrap().to_be_bytes());
		let mut offset = 8 + 20 * slices.len();
		for slice in slices {
			header.extend([0u8; 8]);
			header.extend(u32::try_from(offset).unwrap().to_be_bytes());
			header.extend(u32::try_from(slice.len()).unwrap().to_be_bytes());
			header.extend([0u8; 4]);
			offset += slice.len();
		}
		header.extend(slices.concat());
		header
	}

	#[test]
	fn tkinter_is_judged_by_the_tk_its_load_commands_link() {
		const SYSTEM_TK: &str = "/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk";
		const SYSTEM_TCL: &str = "/System/Library/Frameworks/Tcl.framework/Versions/8.5/Tcl";
		const BREW_TK: &str = "/opt/homebrew/opt/tcl-tk/lib/libtcl9tk9.1.dylib";
		let system = macho(&[SYSTEM_TCL, SYSTEM_TK, "/usr/lib/libSystem.B.dylib"]);
		assert_eq!(linked_tk(&system), Some(TkImage::Version(8, 5)));
		assert_eq!(linked_tk(&macho(&[BREW_TK])), Some(TkImage::Version(9, 1)));
		assert_eq!(linked_tk(&macho(&["/usr/lib/libSystem.B.dylib"])), None);
		assert_eq!(
			linked_tk(&universal(&[system.clone(), system.clone()])),
			Some(TkImage::Version(8, 5))
		);
		assert_eq!(
			linked_tk(&universal(&[system.clone(), macho(&[BREW_TK])])),
			Some(TkImage::Unversioned),
		);
		// Truncated or foreign bytes link nothing.
		assert_eq!(linked_tk(&system[..40]), None);
		assert_eq!(linked_tk(b"#!/bin/sh\n"), None);
		assert_eq!(linked_tk(&[]), None);
	}

	#[test]
	fn malformed_mach_o_headers_link_no_known_tk() {
		const SYSTEM_TK: &str = "/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk";
		let system = macho(&[SYSTEM_TK]);
		let segment_end = 32 + 72;
		// Load commands outside `sizeofcmds`, or running past it.
		assert_eq!(linked_tk(&patched(&system, 20, 0)), None);
		assert_eq!(linked_tk(&patched(&system, 20, 72)), None);
		assert_eq!(linked_tk(&patched(&system, 20, u32::MAX)), None);
		// A dylib command too small for its header, or whose name starts
		// inside the header or beyond the command.
		assert_eq!(linked_tk(&patched(&system, segment_end + 4, 4)), None);
		assert_eq!(linked_tk(&patched(&system, segment_end + 8, 8)), None);
		assert_eq!(linked_tk(&patched(&system, segment_end + 8, 4096)), None);
		// A command count beyond what `sizeofcmds` holds.
		assert_eq!(linked_tk(&patched(&system, 16, u32::MAX)), None);
		// Universal headers whose architecture table or slices lie outside
		// the file, including a huge advertised count, are rejected at once.
		for magic in [FAT_MAGIC, FAT_MAGIC_64] {
			let mut fat = magic.to_be_bytes().to_vec();
			fat.extend(u32::MAX.to_be_bytes());
			let started = std::time::Instant::now();
			assert_eq!(linked_tk(&fat), None);
			assert!(started.elapsed() < std::time::Duration::from_millis(100));
		}
		let mut beyond = universal(std::slice::from_ref(&system));
		beyond[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
		assert_eq!(linked_tk(&beyond), None);
		// A conservative verdict follows: an unknown Tk reads the pointer.
		assert!(reads_pointer(TkImage::Tkinter, || linked_tk(&patched(&system, 20, 0))));
	}

	/// A Python whose `_tkinter` links macOS's own Tk 8.5: the developer tools'
	/// Python, which `/usr/bin/python3` runs once they are installed.
	fn system_tk_python() -> Option<&'static str> {
		[
			"/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/\
			 Current/bin/python3",
			"/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/\
			 Versions/Current/bin/python3",
		]
		.into_iter()
		.find(|path| Path::new(path).exists())
	}

	/// Kills and reaps the child on every exit from the test.
	struct Reaped(std::process::Child);

	impl Drop for Reaped {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	#[test]
	fn a_live_process_on_macos_tk_8_5_does_not_read_the_hardware_pointer() {
		let Some(python) = system_tk_python() else {
			eprintln!("skipped: no developer-tools Python with macOS's Tk 8.5");
			return;
		};
		// Isolated mode ignores PYTHONPATH, PYTHONHOME and user site-packages,
		// so the module imported is the developer tools' own extension.
		let mut child = Reaped(
			Command::new(python)
				.args([
					"-I",
					"-c",
					"import _tkinter, time; print(_tkinter.__file__, flush=True); time.sleep(30)",
				])
				.stdout(Stdio::piped())
				.spawn()
				.expect("spawn python"),
		);
		let mut extension = String::new();
		BufReader::new(child.0.stdout.take().expect("stdout"))
			.read_line(&mut extension)
			.expect("read the _tkinter path");
		let extension = extension.trim();
		let linked = read_image(extension).and_then(|binary| linked_tk(&binary));
		if !extension.contains("/Python3.framework/") || linked != Some(TkImage::Version(8, 5)) {
			eprintln!("skipped: {python} imported {extension:?}, which links {linked:?}");
			return;
		}
		let pid = libc::pid_t::try_from(child.0.id()).expect("pid");
		// The walk sees only `_tkinter`; the Tk 8.5 it links lives in the dyld
		// shared cache. That Tk places presses at the event location.
		assert!(!reads_hardware_pointer(pid), "{extension} judged as reading the hardware pointer");
	}

	#[test]
	fn region_record_matches_kernel_layout() {
		assert_eq!(mem::size_of::<ProcRegionInfo>(), 96);
		assert_eq!(mem::size_of::<ProcRegionWithPathInfo>(), 1272);
	}

	const KIT: &str =
		"/System/Library/PrivateFrameworks/ScreenSharingKit.framework/Versions/A/ScreenSharingKit";
	const VNC: &str =
		"/System/Library/PrivateFrameworks/ScreenSharing.framework/Versions/A/ScreenSharing";
	const APPKIT: &str = "/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit";

	/// A thin 64-bit Mach-O for `cpu` whose load commands are a UUID, then
	/// alternately strong and weak links to `dylibs`.
	fn macho(cpu: u32, dylibs: &[&str]) -> Vec<u8> {
		let mut commands = [0x1b_u32, 24].map(u32::to_le_bytes).concat();
		commands.resize(24, 0);
		for (index, name) in dylibs.iter().enumerate() {
			let kind = if index % 2 == 0 {
				DYLIB_COMMANDS[0]
			} else {
				DYLIB_COMMANDS[1]
			};
			let size = (24 + name.len() + 1).next_multiple_of(8);
			let start = commands.len();
			commands.extend([kind, size as u32, 24].map(u32::to_le_bytes).concat());
			commands.resize(start + 24, 0);
			commands.extend(name.as_bytes());
			commands.resize(start + size, 0);
		}
		let count = dylibs.len() as u32 + 1;
		let mut file = [MH_MAGIC_64, cpu, 0, 2, count, commands.len() as u32, 0, 0]
			.map(u32::to_le_bytes)
			.concat();
		file.extend(commands);
		file
	}

	/// A universal binary holding `slices` at 4 KiB-aligned offsets.
	fn universal(slices: &[(u32, Vec<u8>)]) -> Vec<u8> {
		let mut file = [FAT_MAGIC, slices.len() as u32]
			.map(u32::to_be_bytes)
			.concat();
		let mut offset = 4096;
		for (cpu, slice) in slices {
			file.extend(
				[*cpu, 0, offset, slice.len() as u32, 12]
					.map(u32::to_be_bytes)
					.concat(),
			);
			offset += (slice.len() as u32).next_multiple_of(4096);
		}
		for (_, slice) in slices {
			file.resize(file.len().next_multiple_of(4096), 0);
			file.extend(slice);
		}
		file
	}

	fn classify(file: Vec<u8>) -> Option<RemoteScreen> {
		remote_screen_linkage(&linked_dylibs(&mut std::io::Cursor::new(file))?)
	}

	#[test]
	fn remote_screens_are_recognised_by_the_screen_sharing_framework_they_link() {
		let native = NATIVE_CPU_TYPE;
		let mirror = ["@rpath/ScreenContinuityUI.framework/Versions/A/ScreenContinuityUI", KIT];
		assert_eq!(classify(macho(native, &mirror)), Some(RemoteScreen::HidReports));
		assert_eq!(classify(macho(native, &[APPKIT, VNC])), Some(RemoteScreen::KeyEvents));
		assert_eq!(classify(macho(native, &[APPKIT])), None);
		assert_eq!(
			classify(macho(native, &["/Library/Frameworks/MyScreenSharing.framework/A"])),
			None
		);
	}

	#[test]
	fn universal_binaries_are_read_from_this_cpus_slice() {
		let other = if NATIVE_CPU_TYPE == 0x0100_000c {
			0x0100_0007
		} else {
			0x0100_000c
		};
		let file = universal(&[
			(other, macho(other, &[APPKIT])),
			(NATIVE_CPU_TYPE, macho(NATIVE_CPU_TYPE, &[KIT])),
		]);
		assert_eq!(classify(file), Some(RemoteScreen::HidReports));
		let mut truncated = macho(NATIVE_CPU_TYPE, &[KIT]);
		truncated.truncate(truncated.len() - 16);
		assert_eq!(linked_dylibs(&mut std::io::Cursor::new(truncated)), None);
	}

	#[test]
	fn apple_clients_are_remote_screens_even_when_their_executable_is_unreadable() {
		let unreadable = || None;
		assert_eq!(
			classify_remote_screen(Some("com.apple.ScreenSharing"), unreadable),
			Some(RemoteScreen::KeyEvents)
		);
		assert_eq!(
			classify_remote_screen(Some("com.apple.ScreenContinuity"), unreadable),
			Some(RemoteScreen::HidReports)
		);
		assert_eq!(classify_remote_screen(Some("com.example.Viewer"), unreadable), None);
		assert_eq!(
			classify_remote_screen(Some("com.example.Viewer"), || Some(RemoteScreen::HidReports)),
			Some(RemoteScreen::HidReports)
		);
	}

	#[test]
	fn each_process_executable_is_read_once() {
		let cache = LinkageCache::default();
		let reads = std::cell::Cell::new(0);
		let read = |_: &Path| {
			reads.set(reads.get() + 1);
			Some(vec![KIT.as_bytes().to_vec()])
		};
		let viewer = PathBuf::from("/Applications/Viewer.app/Contents/MacOS/Viewer");
		assert_eq!(cached_linkage(&cache, 7, viewer.clone(), read), Some(RemoteScreen::HidReports));
		let again = cached_linkage(&cache, 7, viewer.clone(), |_| panic!("read again"));
		assert_eq!(again, Some(RemoteScreen::HidReports));
		// A reused pid running another executable is read afresh.
		let other = cached_linkage(&cache, 7, PathBuf::from("/bin/ls"), |_| {
			Some(vec![APPKIT.as_bytes().to_vec()])
		});
		assert_eq!(other, None);
		// An executable that cannot be read is read again on the next event.
		assert_eq!(cached_linkage(&cache, 8, viewer.clone(), |_| None), None);
		assert_eq!(cached_linkage(&cache, 8, viewer, read), Some(RemoteScreen::HidReports));
		assert_eq!(reads.get(), 2);
	}

	#[test]
	fn linkage_cache_starts_over_when_full() {
		let cache = LinkageCache::default();
		let executable = PathBuf::from("/Applications/Viewer.app/Contents/MacOS/Viewer");
		for pid in 0..=MAX_CACHED_LINKAGES as libc::pid_t {
			cached_linkage(&cache, pid, executable.clone(), |_| Some(Vec::new()));
		}
		assert_eq!(cache.lock().len(), 1);
	}

	#[test]
	fn this_test_binary_links_system_libraries_but_no_screen_sharing_framework() {
		let pid = libc::pid_t::try_from(std::process::id()).unwrap();
		let mut executable = File::open(executable_path(pid).unwrap()).unwrap();
		let dylibs = linked_dylibs(&mut executable).unwrap();
		assert!(
			dylibs
				.iter()
				.any(|dylib| dylib.starts_with(b"/usr/lib/libSystem")),
			"{dylibs:?}"
		);
		assert_eq!(remote_screen(pid), None);
	}
}
