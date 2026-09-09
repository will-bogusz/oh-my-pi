import { adaptDesktopSession } from "./desktop-adapter.js";
import { loadNative } from "./loader-state.js";

let DesktopSession;

/**
 * Construct a desktop session without loading the native addon until the
 * computer worker receives its initialization message.
 */
export function createDesktopSession(options) {
	DesktopSession ??= adaptDesktopSession(loadNative().DesktopSession);
	return new DesktopSession(options);
}

/**
 * Sample the on-screen window roster across every CGWindow layer, through the
 * same lazy addon load as createDesktopSession. Needs no desktop session: the
 * Cua-backed worker calls this without owning one.
 */
export function desktopWindowRoster() {
	return loadNative().desktopWindowRoster();
}
