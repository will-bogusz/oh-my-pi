import type { DesktopSystemWindow } from "@oh-my-pi/pi-natives";
import { desktopWindowRoster } from "@oh-my-pi/pi-natives/desktop";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { ComputerInterruption, ComputerWindowKind } from "./types";

/**
 * Detection of system UI that takes the screen away from the agent's target.
 *
 * macOS draws authentication, permission and lock UI from separate processes on
 * CGWindow layers above 0. Neither window inventory the worker already has can
 * see it: the Cua driver enumerates layer 0 only, and pi-natives'
 * `DesktopSession.listWindows` drops unshared and untitled records and reports
 * no layer. Observed ground truth for a login-keychain prompt (batch-1 lane
 * `static/modal`): owner `SecurityAgent`, layer 1000, alpha 1, empty title,
 * `NSWorkspace.frontmostApplication` flipping back to the previous app while
 * the panel stayed up. Owner plus layer is the durable signal; frontmost is
 * not, so nothing here depends on it.
 *
 * Input keeps flowing to the target while such a panel is up — background
 * routes are pid-addressed and AX value writes bypass the WindowServer
 * entirely — so the agent gets `effect: "confirmed"` while the user is being
 * asked for a password. Refusing is a policy choice, not a capability limit.
 */

/**
 * CGWindow owner name (`kCGWindowOwnerName`, lowercased) to what its window
 * means. Owner names, not bundle ids: `CGWindowListCopyWindowInfo` reports the
 * process name and `SecurityAgent` runs as uid 92, where no AX or bundle
 * lookup is possible.
 */
const KIND_BY_OWNER: Record<string, ComputerWindowKind> = {
	// Keychain, admin-rights and app-signature prompts.
	securityagent: "auth",
	// LocalAuthentication: Touch ID, password sheets, sudo Touch ID.
	coreautha: "auth",
	coreauthd: "auth",
	localauthenticationremoteservice: "auth",
	// TCC consent dialogs, and the separate accessibility-permission warning.
	// UserNotificationCenter also hosts CFUserNotification alerts and macOS
	// crash reports (observed), so the refusal points at the window and tells
	// the caller to read it rather than asserting which question it is asking.
	usernotificationcenter: "permission",
	universalaccessauthwarn: "permission",
	// Lock screen, fast user switching, screen saver.
	loginwindow: "lock",
	screensaverengine: "lock",
	// ViewBridge panels hosted for another process: open/save and share sheets.
	// The owner name is the service's display name; the bundle-style form
	// appears when the service is launched directly.
	"open and save panel service": "app-modal",
	openandsavepanelservice: "app-modal",
	"com.apple.appkit.xpc.openandsavepanelservice": "app-modal",
};

/**
 * Kinds that block: the user is being asked something, or the session is
 * locked. `app-modal` does not block — an open/save panel is usually the
 * agent's own doing — and `other` covers menus, tooltips, the Dock and every
 * other accessory window that shares the upper layers.
 */
const BLOCKING: Record<ComputerWindowKind, boolean> = {
	auth: true,
	permission: true,
	lock: true,
	"app-modal": false,
	desktop: false,
	other: false,
};

export interface WindowRosterSample {
	/** Unreliable while a SecurityAgent panel is up; kept for reporting only. */
	frontmostPid?: number;
	/** On-screen records, front to back. */
	windows: readonly DesktopSystemWindow[];
	/** Cost of the underlying WindowServer read, milliseconds. */
	elapsedMs: number;
}

/** Owner classification. Layer is reported, never required: an auth panel is one whoever draws it. */
export function classifyWindow(window: { app: string }): ComputerWindowKind {
	return KIND_BY_OWNER[window.app.trim().toLowerCase()] ?? "other";
}

/**
 * The interruption this window represents, or undefined. Zero-alpha and
 * degenerate rectangles are excluded: the login window keeps invisible
 * placeholder windows around at all times, and blocking on those would refuse
 * every action forever.
 */
export function windowInterruption(window: DesktopSystemWindow): ComputerInterruption | undefined {
	const kind = classifyWindow(window);
	if (!BLOCKING[kind] || window.alpha <= 0 || window.width < 1 || window.height < 1) return undefined;
	return Object.freeze({ app: window.app, pid: window.pid, windowId: window.id, title: window.title, kind });
}

/** The topmost blocking window in a sample; the roster is ordered front to back. */
export function rosterInterruption(sample: WindowRosterSample): ComputerInterruption | undefined {
	for (const window of sample.windows) {
		const interruption = windowInterruption(window);
		if (interruption) return interruption;
	}
	return undefined;
}

export function describeInterruption(interruption: ComputerInterruption): string {
	const what: Record<ComputerWindowKind, string> = {
		auth: "a system authentication prompt",
		permission: "a system permission dialog",
		lock: "the lock screen",
		"app-modal": "an app-modal panel",
		desktop: "the desktop",
		other: "a system window",
	};
	const title = interruption.title ? ` "${interruption.title}"` : "";
	return `${what[interruption.kind]} from ${interruption.app}${title} (pid ${interruption.pid}, window ${interruption.windowId}) is on screen`;
}

/** One WindowServer read: 5 ms median, 14 ms worst of 60 samples at 4 Hz on an M4 Pro. */
export function sampleWindowRoster(): WindowRosterSample {
	const started = performance.now();
	try {
		const roster = desktopWindowRoster();
		return {
			frontmostPid: roster.frontmostPid ?? undefined,
			windows: roster.windows,
			elapsedMs: performance.now() - started,
		};
	} catch (error) {
		throw new ToolError(
			`Interruption check failed: the WindowServer roster is unreadable (${error instanceof Error ? error.message : String(error)})`,
		);
	}
}
