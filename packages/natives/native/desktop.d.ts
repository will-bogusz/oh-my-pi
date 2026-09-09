import type { DesktopSession, DesktopSessionOptions, DesktopWindowRoster } from "./index.js";

/** Construct a desktop session, loading the native addon on first use. */
export declare function createDesktopSession(options: DesktopSessionOptions): DesktopSession;

/**
 * Sample the on-screen window roster across every CGWindow layer, loading the
 * native addon on first use. Empty windows array off macOS.
 */
export declare function desktopWindowRoster(): DesktopWindowRoster;
