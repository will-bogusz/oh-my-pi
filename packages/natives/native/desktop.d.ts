import type { DesktopSession, DesktopSessionOptions, DesktopWindowRoster } from "./index.js";

/** Construct a desktop session, loading the native addon on first use. */
export declare function createDesktopSession(options: DesktopSessionOptions): DesktopSession;

/**
 * Sample every on-screen window, popup menus and system panels included,
 * loading the native addon on first use. Empty off macOS.
 */
export declare function desktopWindowRoster(): DesktopWindowRoster;
