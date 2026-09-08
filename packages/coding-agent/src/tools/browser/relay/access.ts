import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBrowserRelayDir } from "@oh-my-pi/pi-utils";

export interface PairedBrowser {
	id: string;
	label: string;
	credentialHash: string;
}
interface PairingCode {
	hash: string;
	expiresAt: number;
}
interface AccessState {
	version: 1;
	controlToken: string;
	browsers: PairedBrowser[];
	codes: PairingCode[];
}
export interface BrowserAuthentication {
	id: string;
	label: string;
	credential?: string;
	pairingCode?: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
function matches(value: string, expectedHash: string): boolean {
	const actual = Buffer.from(hash(value));
	const expected = Buffer.from(expectedHash);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const secret = (): string => randomBytes(32).toString("base64url");

/** Per-endpoint state is shared across OMP project profiles, but readable only by its OS user. */
export function relayAccessPath(port: number): string {
	return path.join(getBrowserRelayDir(), "endpoints", `${port}.json`);
}

export function readRelayControlToken(url: string): string {
	const parsed = new URL(url);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname))
		throw new Error("Managed browser access requires a local paired endpoint");
	try {
		const state = JSON.parse(fs.readFileSync(relayAccessPath(Number(parsed.port || 80)), "utf8")) as AccessState;
		if (state.version !== 1 || typeof state.controlToken !== "string") throw new Error("Invalid access state");
		return state.controlToken;
	} catch {
		throw new Error(
			`Browser endpoint ${parsed.origin} has no local access credential. Preserve the running service until its active tasks finish, then repair its persisted access state with the current OMP installation or use another endpoint. Setup commands must target --port ${Number(parsed.port || 80)}; pairing a different/default endpoint cannot restore this service's control credential.`,
		);
	}
}

/** Authentication is an OS-user boundary; it does not sandbox arbitrary code running as that user. */
export class RelayAccess {
	#state: AccessState;
	#file?: string;

	constructor(file?: string) {
		this.#file = file;
		this.#state = { version: 1, controlToken: secret(), browsers: [], codes: [] };
		if (!file) return;
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		if (!fs.existsSync(file)) {
			const temporary = `${file}.${crypto.randomUUID()}.tmp`;
			fs.writeFileSync(temporary, JSON.stringify(this.#state), { mode: 0o600 });
			try {
				fs.linkSync(temporary, file);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
			} finally {
				fs.unlinkSync(temporary);
			}
		}
		this.#state = JSON.parse(fs.readFileSync(file, "utf8")) as AccessState;
		if (
			this.#state.version !== 1 ||
			typeof this.#state.controlToken !== "string" ||
			!Array.isArray(this.#state.browsers) ||
			!Array.isArray(this.#state.codes)
		)
			throw new Error("Invalid browser access state; preserve it and repair setup before continuing");
		fs.chmodSync(file, 0o600);
	}

	get controlToken(): string {
		return this.#state.controlToken;
	}
	authorized(header: string | null): boolean {
		return !!header?.startsWith("Bearer ") && matches(header.slice(7), hash(this.#state.controlToken));
	}
	browsers(): PairedBrowser[] {
		return this.#state.browsers.map(browser => ({ ...browser }));
	}

	issueCode(now = Date.now()): { code: string; expiresAt: number } {
		const code = randomBytes(12).toString("base64url");
		const expiresAt = now + 10 * 60_000;
		this.#state.codes = this.#state.codes.filter(candidate => candidate.expiresAt > now);
		this.#state.codes.push({ hash: hash(code), expiresAt });
		this.#save();
		return { code, expiresAt };
	}

	authenticate(auth: BrowserAuthentication, now = Date.now()): { browser: PairedBrowser; credential?: string } {
		if (!/^[a-zA-Z0-9_-]{16,128}$/.test(auth.id)) throw new Error("Invalid browser instance id");
		const label = auth.label?.trim();
		if (!label || label.length > 80 || /[\x00-\x1f\x7f]/.test(label))
			throw new Error("Choose a browser label of 1–80 characters in extension settings");
		const existing = this.#state.browsers.find(browser => browser.id === auth.id);
		if (existing) {
			if (!auth.credential || !matches(auth.credential, existing.credentialHash))
				throw new Error("Browser credential is invalid; existing pairing was preserved");
			return { browser: { ...existing, label } };
		}
		const index = this.#state.codes.findIndex(
			code => code.expiresAt > now && !!auth.pairingCode && matches(auth.pairingCode, code.hash),
		);
		if (index < 0) throw new Error("Pairing code is invalid or expired. Run omp browser-relay pair");
		const credential = secret();
		const browser = { id: auth.id, label, credentialHash: hash(credential) };
		this.#state.codes.splice(index, 1);
		this.#state.browsers.push(browser);
		this.#save();
		return { browser: { ...browser }, credential };
	}

	setLabel(id: string, label: string): void {
		const browser = this.#state.browsers.find(candidate => candidate.id === id);
		if (!browser) throw new Error("Browser pairing is no longer valid");
		browser.label = label;
		this.#save();
	}

	unpair(id: string): void {
		if (!this.#state.browsers.some(browser => browser.id === id)) throw new Error("Unknown paired browser");
		this.#state.browsers = this.#state.browsers.filter(browser => browser.id !== id);
		this.#save();
	}

	#save(): void {
		if (!this.#file) return;
		fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
		const temporary = `${this.#file}.${crypto.randomUUID()}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(this.#state), { mode: 0o600 });
		fs.renameSync(temporary, this.#file);
	}
}
