import type { CDPSession } from "puppeteer-core";

/**
 * Follows the JavaScript dialogs a page shows, through one CDP session that has the Page domain enabled. While a
 * dialog is open the page's renderer answers no command (scripts, bindings, evaluation, file chooser interception)
 * until someone answers it, so a change meant for the page waits for the dialog to close instead of for the page.
 */
export class DialogStop {
	readonly #session: CDPSession;
	#open = false;
	/** Ends the waits for changes in flight when a dialog opens. */
	readonly #onOpen = new Set<() => void>();
	readonly #onClose = new Set<() => void>();

	constructor(session: CDPSession) {
		this.#session = session;
		session.on("Page.javascriptDialogOpening", this.#opened);
		session.on("Page.javascriptDialogClosed", this.#closed);
	}

	/** Whether a dialog stops the page now. */
	get open(): boolean {
		return this.#open;
	}

	/** Waits for `change` to reach the page; false, at once, when a dialog stops the page first or already does. */
	async settle(change: Promise<unknown>): Promise<boolean> {
		if (this.#open) return false;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const stop = (): void => resolve(false);
		this.#onOpen.add(stop);
		try {
			return await Promise.race([change.then(() => true), promise]);
		} finally {
			this.#onOpen.delete(stop);
		}
	}

	/** Calls `listener` each time a dialog closes; returns the unsubscribe. */
	onClose(listener: () => void): () => void {
		this.#onClose.add(listener);
		return () => this.#onClose.delete(listener);
	}

	dispose(): void {
		this.#session.off("Page.javascriptDialogOpening", this.#opened);
		this.#session.off("Page.javascriptDialogClosed", this.#closed);
		this.#onClose.clear();
	}

	readonly #opened = (): void => {
		this.#open = true;
		for (const stop of this.#onOpen) stop();
	};

	readonly #closed = (): void => {
		this.#open = false;
		for (const listener of this.#onClose) listener();
	};
}
