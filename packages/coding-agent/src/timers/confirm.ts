/**
 * Confirm-by-repeat for the timer tool's refusals (a near-duplicate, a
 * condition that already holds, firing into the calling session): the refusal
 * is recorded, and the very same call sent again within a few minutes goes
 * through. An override flag in the schema got set on calls nothing had
 * refused; repeating a call is a choice the agent makes after reading why.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { MINUTE } from "./schedule";

/** A repeat later than this is a new call and is checked again. */
export const CONFIRM_WINDOW_MS = 10 * MINUTE;

function markerPath(key: string, root: string): string {
	return path.join(root, "refusals", Bun.hash(key).toString(36));
}

/** Stable key of a refused call: what was refused, for whom, with which arguments. */
export function refusalKey(kind: string, sessionId: string | undefined, args: unknown): string {
	return JSON.stringify([kind, sessionId ?? "", args]);
}

/** True, once, when this call was refused within {@link CONFIRM_WINDOW_MS}. */
export async function takeConfirmation(key: string, root: string, now: number): Promise<boolean> {
	const file = markerPath(key, root);
	try {
		const at = Number(await fs.readFile(file, "utf8"));
		await fs.rm(file, { force: true });
		return now - at <= CONFIRM_WINDOW_MS;
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
}

export async function recordRefusal(key: string, root: string, now: number): Promise<void> {
	const file = markerPath(key, root);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await Bun.write(file, String(now));
}
