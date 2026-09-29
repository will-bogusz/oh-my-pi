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
