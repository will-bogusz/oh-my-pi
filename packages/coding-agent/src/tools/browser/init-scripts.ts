import type { Page } from "puppeteer-core";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

/** Serializable description of an init script registered on one tab. */
export interface InitScriptInfo {
	id: string;
	source: string;
}

/**
 * Registers, removes, and lists document-start scripts for one page. Ids are the manager's own, not CDP's, so a
 * script put back on a new attachment ({@link InitScriptManager.restore}) keeps the id its caller holds.
 */
export class InitScriptManager {
	readonly #page: Page;
	/** Public id -> the script and its identifier on this page's CDP session. */
	readonly #scripts = new Map<string, { info: InitScriptInfo; registered: string }>();
	#lastId = 0;

	constructor(page: Page) {
		this.#page = page;
	}

	/** Register source for every future document and return its stable identifier. */
	async add(source: string): Promise<{ id: string }> {
		if (typeof source !== "string") throw new ToolError("tab.addInitScript(source) requires a string");
		const registered = await this.#page.evaluateOnNewDocument(source);
		const info = { id: String(++this.#lastId), source };
		this.#scripts.set(info.id, { info, registered: registered.identifier });
		return { id: info.id };
	}

	/** Register scripts a previous attachment of this page had, under the ids it returned for them. */
	async restore(scripts: readonly InitScriptInfo[]): Promise<void> {
		for (const { id, source } of scripts) {
			const registered = await this.#page.evaluateOnNewDocument(source);
			this.#scripts.set(id, { info: { id, source }, registered: registered.identifier });
			const numeric = Number(id);
			if (Number.isInteger(numeric)) this.#lastId = Math.max(this.#lastId, numeric);
		}
	}

	/** Remove one previously registered script. */
	async remove(id: string): Promise<void> {
		if (typeof id !== "string" || id.length === 0) {
			throw new ToolError("tab.removeInitScript(id) requires a non-empty script id");
		}
		const script = this.#scripts.get(id);
		if (!script) throw new ToolError(`Unknown init script ${JSON.stringify(id)}`);
		await this.#page.removeScriptToEvaluateOnNewDocument(script.registered);
		this.#scripts.delete(id);
	}

	/** Return registered scripts in registration order. */
	list(): InitScriptInfo[] {
		return [...this.#scripts.values()].map(({ info }) => ({ ...info }));
	}
}
