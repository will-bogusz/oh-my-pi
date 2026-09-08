/** Page-owned JavaScript dialogs only; native and permission panels are separate targets. */
export interface BrowserDialog {
	id: string;
	type: "alert" | "confirm" | "prompt" | "beforeunload";
	message: string;
	url: string;
	defaultPrompt: string;
}

export type DialogRequest = { action?: "inspect" } | { action: "accept" | "dismiss"; id: string; promptText?: string };
export interface DialogState {
	status: "unobserved" | "closed" | "open";
	dialog: BrowserDialog | null;
}

export function parseDialogRequest(value: unknown): DialogRequest {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid dialog request");
	const request = value as Record<string, unknown>;
	if (Object.keys(request).some(key => !["action", "id", "promptText"].includes(key)))
		throw new Error("Unknown dialog request field");
	if (request.action === undefined || request.action === "inspect") {
		if (request.id !== undefined || request.promptText !== undefined)
			throw new Error("Inspect cannot answer a dialog");
		return { action: "inspect" };
	}
	if (
		!["accept", "dismiss"].includes(String(request.action)) ||
		typeof request.id !== "string" ||
		!request.id ||
		(request.promptText !== undefined && typeof request.promptText !== "string")
	)
		throw new Error("Accept/dismiss requires the current dialog id and optional promptText string");
	return {
		action: request.action as "accept" | "dismiss",
		id: request.id,
		promptText: request.promptText as string | undefined,
	};
}

/** One exact debugger attachment owns the journal; detach invalidates every capability. */
export class DialogJournal {
	#status: DialogState["status"] = "unobserved";
	#current: BrowserDialog | null = null;
	#resolving = false;

	opened(params: Record<string, unknown>): void {
		if (
			!["alert", "confirm", "prompt", "beforeunload"].includes(String(params.type)) ||
			typeof params.message !== "string"
		)
			return;
		this.#current = {
			id: crypto.randomUUID(),
			type: params.type as BrowserDialog["type"],
			message: params.message,
			url: typeof params.url === "string" ? params.url : "",
			defaultPrompt: typeof params.defaultPrompt === "string" ? params.defaultPrompt : "",
		};
		this.#status = "open";
	}
	closed(): void {
		this.#current = null;
		this.#status = "closed";
	}
	reset(): void {
		this.#current = null;
		this.#status = "unobserved";
	}
	snapshot(): DialogState {
		return { status: this.#status, dialog: this.#current ? { ...this.#current } : null };
	}
	async resolve(
		request: Exclude<DialogRequest, { action?: "inspect" }>,
		dispatch: (params: { accept: boolean; promptText?: string }) => Promise<unknown>,
	): Promise<DialogState> {
		const current = this.#current;
		if (!current || current.id !== request.id)
			throw new Error("Dialog id is stale or belongs to another tab; inspect the current dialog before answering");
		if (this.#resolving)
			throw new Error("A dialog response is already in flight; inspect its outcome before retrying");
		if (request.promptText !== undefined && (request.action !== "accept" || current.type !== "prompt"))
			throw new Error("promptText is valid only when accepting a prompt");
		this.#resolving = true;
		try {
			await dispatch({
				accept: request.action === "accept",
				...(request.promptText === undefined ? {} : { promptText: request.promptText }),
			});
			if (this.#current?.id === current.id) this.closed();
			return this.snapshot();
		} catch (error) {
			// A reply may have been lost after delivery. A new observation/decision is required.
			if (this.#current?.id === current.id) this.reset();
			throw new Error(`Dialog response outcome is uncertain; do not blindly retry: ${String(error)}`);
		} finally {
			this.#resolving = false;
		}
	}
}
