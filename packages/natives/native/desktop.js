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
 * Sample every on-screen window, popup menus and system panels included,
 * loading the native addon on first use. Needs no desktop session.
 */
export function desktopWindowRoster() {
	return loadNative().desktopWindowRoster();
}
