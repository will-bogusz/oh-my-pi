import type { Dialog, Frame, Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Automatic JavaScript-dialog policy. */
export type DialogPolicy = "accept" | "dismiss";

/** JSON-safe description of what the page is waiting on: a JavaScript dialog or a file chooser omp holds. */
export interface DialogState {
	/** Whether the page is waiting for an answer. */
	open: boolean;
	/** `alert`, `confirm`, `prompt`, `beforeunload`, or `file-chooser`. */
	type?: string;
	/** Page-provided dialog message. */
	message?: string;
	/** Page-provided prompt default. */
	defaultValue?: string;
	/** File chooser: whether it takes more than one file. */
	multiple?: boolean;
	/** File chooser: the input's `accept` filter, when it has one. */
	accept?: string;
	/** File chooser: whether it picks a folder. */
	folder?: boolean;
}

/** A call refused or ended because the page waits on a dialog or a held file chooser. */
export class PageWaitError extends ToolError {}

/** How to answer what the page waits on, for errors and notices. */
export function describeAnswer(state: DialogState): string {
	switch (state.type) {
		case "file-chooser":
			return `Answer it with tab.handleDialog({ accept: true, files: ${state.folder ? "[folderPath]" : "[path, ...]"} }) or cancel it with tab.handleDialog({ accept: false }).`;
		case "prompt":
			return 'Answer it with tab.handleDialog({ accept: true, text: "..." }) or tab.handleDialog({ accept: false }).';
		case "alert":
			return "Close it with tab.handleDialog({ accept: true }).";
		default:
			return "Answer it with tab.handleDialog({ accept: true }) or tab.handleDialog({ accept: false }).";
	}
}

/** What the page waits on, in a phrase: `a confirm("Delete?")` or `a file chooser (one file, accepting "image/*")`. */
export function describeWaiting(state: DialogState): string {
	if (state.type === "file-chooser") {
		const what = state.folder ? "a folder" : state.multiple ? "one or more files" : "one file";
		const accept = state.accept ? `, accepting ${JSON.stringify(state.accept)}` : "";
		return `a file chooser (${what}${accept})`;
	}
	return `${state.type === "alert" ? "an" : "a"} ${state.type}(${JSON.stringify(state.message?.slice(0, 80) ?? "")})`;
}

/** Runtime controller for automatic and explicitly handled JavaScript dialogs. */
export class RuntimeDialogController {
	readonly #page: Page;
	readonly #logFailure: (message: string, details: Record<string, unknown>) => void;
	/** Alerts nobody else can see are closed at once; in the user's own browser they wait for an answer. */
	readonly #autoAcceptAlerts: boolean;
	readonly #onPending = new Set<(state: DialogState) => void>();
	#policy: DialogPolicy | undefined;
	#pending: Dialog | undefined;
	/** The pending dialog a call's result already named. */
	#reported: Dialog | undefined;
	#installed = false;

	constructor(
		page: Page,
		logFailure: (message: string, details: Record<string, unknown>) => void,
		autoAcceptAlerts: boolean,
	) {
		this.#page = page;
		this.#logFailure = logFailure;
		this.#autoAcceptAlerts = autoAcceptAlerts;
	}

	/** Install the page listeners exactly once. */
	observe(): void {
		if (this.#installed) return;
		this.#page.on("dialog", this.#onDialog);
		this.#page.on("framenavigated", this.#onFrameNavigated);
		this.#page.mainFrame().client.on("Page.javascriptDialogClosed", this.#onDialogClosed);
		this.#installed = true;
	}

	/** Remove listeners and forget any dialog that can no longer be handled. */
	dispose(): void {
		if (!this.#installed) return;
		this.#page.off("dialog", this.#onDialog);
		this.#page.off("framenavigated", this.#onFrameNavigated);
		this.#page.mainFrame().client.off("Page.javascriptDialogClosed", this.#onDialogClosed);
		this.#installed = false;
		this.#pending = undefined;
		this.#onPending.clear();
	}

	/** Return the current runtime dialog policy. */
	get policy(): DialogPolicy | undefined {
		return this.#policy;
	}

	/** Return a JSON-safe snapshot of the pending dialog. */
	state(): DialogState {
		const dialog = this.#pending;
		if (!dialog) return { open: false };
		const type = dialog.type();
		return {
			open: true,
			type,
			message: dialog.message(),
			...(type === "prompt" ? { defaultValue: dialog.defaultValue() } : {}),
		};
	}

	/** The pending dialog's state the first time a call's result asks, so it is reported once, not by every call. */
	takeUnreported(): DialogState | undefined {
		const dialog = this.#pending;
		if (!dialog || dialog === this.#reported) return undefined;
		this.#reported = dialog;
		return this.state();
	}

	/** Call `listener` when a dialog starts waiting for an answer; returns the unsubscribe. */
	onPending(listener: (state: DialogState) => void): () => void {
		this.#onPending.add(listener);
		return () => this.#onPending.delete(listener);
	}

	/** Change the automatic policy and settle an already-pending decision when enabled. */
	async setPolicy(policy: DialogPolicy | null): Promise<void> {
		this.#policy = policy ?? undefined;
		if (!this.#policy || !this.#pending) return;
		await this.#settle(this.#pending, this.#policy === "accept", undefined);
	}

	/** Explicitly accept or dismiss the pending dialog. */
	async handle(options: { accept: boolean; text?: string }): Promise<void> {
		const dialog = this.#pending;
		if (!dialog) throw new ToolError("tab.handleDialog() found no pending dialog");
		await this.#settle(dialog, options.accept, options.text);
	}

	readonly #onDialog = (dialog: Dialog): void => {
		const policy = this.#policy;
		if (policy) {
			void this.#settle(dialog, policy === "accept", undefined).catch(error => this.#report(error, policy));
			return;
		}
		const type = dialog.type();
		if (type === "beforeunload" || (type === "alert" && this.#autoAcceptAlerts)) {
			void this.#settle(dialog, true, undefined).catch(error => this.#report(error, "accept"));
			return;
		}
		this.#pending = dialog;
		const state = this.state();
		for (const listener of this.#onPending) listener(state);
	};

	readonly #onFrameNavigated = (frame: Frame): void => {
		if (frame === this.#page.mainFrame()) this.#pending = undefined;
	};

	/** The user answered it in their own browser, or omp did. */
	readonly #onDialogClosed = (): void => {
		this.#pending = undefined;
	};

	async #settle(dialog: Dialog, accept: boolean, text: string | undefined): Promise<void> {
		try {
			if (accept) await dialog.accept(text);
			else await dialog.dismiss();
		} finally {
			if (this.#pending === dialog) this.#pending = undefined;
		}
	}

	#report(error: unknown, policy: DialogPolicy): void {
		this.#logFailure("Dialog auto-handler failed", {
			policy,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
