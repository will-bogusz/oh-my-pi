/**
 * App notes: what an app's windows need that its tree and pixels cannot say
 * (iPhone Mirroring publishes no iOS tree, and drags there never scroll).
 * One markdown file per bundle id in `app-notes/`, imported as text so a
 * compiled binary carries it. A session prints each app's note once, beside
 * the header of the first window of that app it acquires. App knowledge lives
 * here, never in input code.
 */
import screenContinuity from "./app-notes/com.apple.ScreenContinuity.md" with { type: "text" };

/** Keyed by lower-cased bundle id. */
const APP_NOTES: Record<string, string> = {
	"com.apple.screencontinuity": screenContinuity,
};

/** The note for a bundle id, as printed with its first window; absent when the app has none. */
export function appNote(bundleId: string): string | undefined {
	const note = APP_NOTES[bundleId.toLowerCase()];
	return note === undefined ? undefined : `App note for ${bundleId} (printed once per session):\n${note.trim()}`;
}

/**
 * The bundle id Launch Services files a running pid under; undefined for a
 * process that is no app. `lsappinfo` answers in ~25 ms, where the driver's
 * `list_apps` also scans every installed bundle and took ~0.8 s — too slow to
 * pay on each app's first acquisition for a note most apps do not have.
 */
export async function launchServicesBundleId(pid: number): Promise<string | undefined> {
	try {
		const child = Bun.spawn(["lsappinfo", "info", "-only", "bundleid", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const [text] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		return /"CFBundleIdentifier"="([^"]+)"/.exec(text)?.[1];
	} catch {
		return undefined;
	}
}
