/**
 * The host side of the `/timers` sheet: synchronous snapshots of the timer
 * store that the sheet reads every frame, refreshed in the background, and
 * the sheet's actions (fire, pause/resume, remove) run against the store.
 */
import type {
	TimersPanelDetail,
	TimersPanelSnapshot,
	TimersSheetSource,
	TimersSheetView,
} from "@oh-my-pi/pi-tui/overlays/timers-panel";
import { logger } from "@oh-my-pi/pi-utils";
import {
	describeTicker,
	fireTimerNow,
	listTimers,
	loadTimerRow,
	readTickerStatus,
	removeTimer,
	requireTimer,
	setPaused,
} from "../timers";
import { readTimerRunLog, timerCardView, timerListRowView } from "../tools/timer-view";

interface CachedDetail {
	generation: number;
	detail: TimersPanelDetail;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class TimersSheetData implements Omit<TimersSheetSource, "close"> {
	#snapshot: TimersPanelSnapshot = { rows: [], loading: true };
	#notice: string | undefined;
	/** Bumped by every refresh; details from an older generation reload in the background. */
	#generation = 0;
	#details = new Map<string, CachedDetail>();
	#pending = new Set<string>();
	#refreshing: Promise<void> | undefined;

	/**
	 * @param sessionId The viewing session: its own timers' cards read "this session".
	 * @param changed Called whenever a snapshot, detail or notice changes (repaint, pill refresh).
	 */
	constructor(
		readonly sessionId: string | undefined,
		readonly changed: () => void,
	) {}

	load(): TimersPanelSnapshot {
		return this.#snapshot;
	}

	/** Re-read the store. Concurrent calls share one read. */
	refresh(): Promise<void> {
		this.#refreshing ??= this.#read().finally(() => {
			this.#refreshing = undefined;
		});
		return this.#refreshing;
	}

	async #read(): Promise<void> {
		const now = Date.now();
		try {
			const [{ rows }, ticker] = await Promise.all([listTimers(now), readTickerStatus()]);
			this.#snapshot = {
				rows: rows.map(row => timerListRowView(row, now)),
				ticker: `ticker: ${describeTicker(ticker, now)}`,
				notice: this.#notice,
			};
		} catch (error) {
			logger.warn("timers sheet: listing failed", { error: errorText(error) });
			this.#snapshot = { ...this.#snapshot, loading: false, notice: `Could not read timers: ${errorText(error)}` };
		}
		this.#generation++;
		this.changed();
	}

	inspect(id: string, view: TimersSheetView): TimersPanelDetail | undefined {
		const key = `${id}\0${view}`;
		const cached = this.#details.get(key);
		if ((!cached || cached.generation < this.#generation) && !this.#pending.has(key)) {
			this.#pending.add(key);
			void this.#loadDetail(id, view, key);
		}
		return cached?.detail;
	}

	async #loadDetail(id: string, view: TimersSheetView, key: string): Promise<void> {
		const generation = this.#generation;
		let detail: TimersPanelDetail;
		try {
			if (view === "logs") {
				detail = { log: await readTimerRunLog(id) };
			} else {
				const now = Date.now();
				const row = await loadTimerRow(await requireTimer(id), now);
				const ticker = await readTickerStatus();
				detail = { card: timerCardView(row, { verb: "", selfSessionId: this.sessionId, ticker, now }) };
			}
		} catch (error) {
			detail = { log: errorText(error) };
		} finally {
			this.#pending.delete(key);
		}
		this.#details.set(key, { generation, detail });
		this.changed();
	}

	fire(id: string): void {
		this.#run(async () => {
			const line = await fireTimerNow(id);
			return `timer ${line.id} ${line.action}${line.runId ? ` (${line.runId})` : ""}${line.detail ? `: ${line.detail}` : ""}`;
		});
	}

	togglePause(id: string): void {
		const paused = this.#snapshot.rows.find(row => row.id === id)?.status === "paused";
		this.#run(async () => {
			await setPaused(id, !paused);
			return `timer ${id} ${paused ? "resumed" : "paused"}`;
		});
	}

	remove(id: string): void {
		this.#run(async () => {
			if (!(await removeTimer(id))) throw new Error(`No timer "${id}"`);
			return `timer ${id} removed (run history kept)`;
		});
	}

	/** Run one sheet action, record its outcome as the footer notice, and re-read the store. */
	#run(action: () => Promise<string>): void {
		void action()
			.then(
				notice => {
					this.#notice = notice;
				},
				error => {
					this.#notice = `Failed: ${errorText(error)}`;
				},
			)
			.then(() => this.refresh());
	}
}
