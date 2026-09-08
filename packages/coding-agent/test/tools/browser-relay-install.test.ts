import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { DEFAULT_RELAY_PORT, runBrowserRelayCommand } from "@oh-my-pi/pi-coding-agent/cli/browser-relay-cli";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function install(port: number): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "omp-extension-install-"));
	directories.push(directory);
	await runBrowserRelayCommand({ action: "install", dir: directory, port });
	return directory;
}

interface ExtensionStorage {
	[key: string]: unknown;
}

function event() {
	return { addListener: (_listener: (...args: unknown[]) => void) => {} };
}

/** Execute the actual installed background bundle, with Chrome owning its events. */
async function runBackground(directory: string, initial: ExtensionStorage = {}) {
	const storage = { ...initial };
	const completed = Promise.withResolvers<void>();
	const requests: string[] = [];
	let click: (() => void) | undefined;
	let optionsOpened = 0;
	const runtime = {
		getURL: (name: string) => `chrome-extension://fixture/${name}`,
		openOptionsPage: async () => {
			optionsOpened++;
		},
		onInstalled: event(),
		onStartup: event(),
		onMessage: event(),
	};
	const context = createContext({
		AbortSignal,
		crypto,
		Response,
		setTimeout: () => 0,
		clearInterval: () => {},
		fetch: async (url: string) => {
			requests.push(url);
			if (url === runtime.getURL("connection.json"))
				return new Response(Bun.file(path.join(directory, "connection.json")));
			return new Response("Older endpoint", { status: 404 });
		},
		chrome: {
			runtime,
			storage: {
				local: {
					get: async (defaults: ExtensionStorage) => ({ ...defaults, ...storage }),
					set: async (values: ExtensionStorage) => {
						Object.assign(storage, values);
						if (values.connectionError) completed.resolve();
					},
				},
			},
			action: {
				setBadgeText: async () => {},
				setBadgeBackgroundColor: async () => {},
				onClicked: {
					addListener: (listener: () => void) => {
						click = listener;
					},
				},
			},
			alarms: { create: () => {}, onAlarm: event() },
			debugger: { onEvent: event(), onDetach: event() },
			tabs: {
				onCreated: event(),
				onUpdated: event(),
				onRemoved: event(),
				onReplaced: event(),
				onActivated: event(),
			},
		},
	});
	runInContext(await Bun.file(path.join(directory, "background.js")).text(), context);
	await completed.promise;
	return { requests, storage, click: () => click?.(), optionsOpened: () => optionsOpened };
}

interface OptionsPermissions {
	contains(request: { permissions: string[] }): Promise<boolean>;
	request(request: { permissions: string[] }): Promise<boolean>;
	remove(request: { permissions: string[] }): Promise<boolean>;
}

async function runOptions(
	directory: string,
	stored: ExtensionStorage = {},
	permissions: OptionsPermissions = {
		contains: async () => false,
		request: async () => false,
		remove: async () => false,
	},
	clickDownload = false,
) {
	const ready = Promise.withResolvers<void>();
	let status = "";
	let downloadClick: (() => Promise<void> | void) | undefined;
	const elements: Record<
		string,
		{
			value: string;
			textContent: string;
			disabled: boolean;
			addEventListener: (event: string, callback: () => Promise<void> | void) => void;
		}
	> = {};
	for (const name of ["port", "label", "code", "save", "downloads", "downloads-status"])
		elements[name] = {
			value: "",
			textContent: "",
			disabled: false,
			addEventListener: (_event, callback) => {
				if (name === "downloads") downloadClick = callback;
			},
		};
	const context = createContext({
		Response,
		fetch: async () => new Response(Bun.file(path.join(directory, "connection.json"))),
		document: {
			getElementById: (name: string) =>
				name === "status"
					? {
							set textContent(value: string) {
								status = value;
								ready.resolve();
							},
						}
					: elements[name],
		},
		chrome: {
			permissions,
			runtime: { getURL: (name: string) => `chrome-extension://fixture/${name}` },
			storage: {
				local: { get: async (defaults: ExtensionStorage) => ({ ...defaults, ...stored }) },
				onChanged: event(),
			},
		},
	});
	runInContext(await Bun.file(path.join(directory, "options.js")).text(), context);
	await ready.promise;
	if (clickDownload) await downloadClick?.();
	return { port: elements.port!.value, disabled: elements.save!.disabled, status };
}

describe("browser extension installation", () => {
	it("preserves a distinct extension name when refreshing an existing export", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "omp-extension-refresh-"));
		directories.push(directory);
		await runBrowserRelayCommand({ action: "install", dir: directory, port: 19443, name: "OMP Work Browser" });
		await runBrowserRelayCommand({ action: "install", dir: directory, port: 19443 });
		const manifest = await Bun.file(path.join(directory, "manifest.json")).json();
		expect(manifest.name).toBe("OMP Work Browser");
		expect(manifest.action.default_title).toContain("OMP Work Browser");
		const saved = {
			port: 19444,
			browserLabel: "Work",
			browserId: "existing-browser-id",
			credential: "preserved-test-credential",
		};
		const background = await runBackground(directory, saved);
		expect(background.storage).toMatchObject(saved);
		expect(background.requests.at(-1)).toBe("http://127.0.0.1:19444/health");
	});

	it("requests or removes download permission only from the explicit settings button", async () => {
		const directory = await install(DEFAULT_RELAY_PORT);
		let granted = false;
		const actions: string[] = [];
		const permissions: OptionsPermissions = {
			contains: async () => granted,
			request: async ({ permissions }) => {
				actions.push(`request:${permissions.join(",")}`);
				granted = true;
				return true;
			},
			remove: async ({ permissions }) => {
				actions.push(`remove:${permissions.join(",")}`);
				granted = false;
				return true;
			},
		};
		await runOptions(directory, {}, permissions);
		expect(actions).toEqual([]);
		await runOptions(directory, {}, permissions, true);
		expect(actions).toEqual(["request:downloads"]);
		await runOptions(directory, {}, permissions, true);
		expect(actions).toEqual(["request:downloads", "remove:downloads"]);
	});
	it.each([DEFAULT_RELAY_PORT, 19443])(
		"uses install port %i for the first connection and settings page",
		async port => {
			const directory = await install(port);
			expect(await Bun.file(path.join(directory, "connection.json")).json()).toEqual({ port });
			const background = await runBackground(directory);
			expect(background.requests).toEqual([
				"chrome-extension://fixture/connection.json",
				`http://127.0.0.1:${port}/health`,
			]);
			expect(await runOptions(directory)).toEqual({ port: String(port), disabled: false, status: "Not paired yet" });
			expect(background.optionsOpened()).toBe(0);
			background.click();
			expect(background.optionsOpened()).toBe(1);
		},
	);

	it("preserves the saved endpoint and pairing when installation defaults change", async () => {
		const directory = await install(19443);
		const saved = {
			port: 19444,
			credential: "existing-profile-credential",
			browserLabel: "Existing Chrome",
			browserId: "existing-id",
		};
		const background = await runBackground(directory, saved);
		expect(background.requests).toEqual([
			"chrome-extension://fixture/connection.json",
			"http://127.0.0.1:19444/health",
		]);
		expect(background.storage).toMatchObject(saved);
		expect(await runOptions(directory, saved)).toEqual({ port: "19444", disabled: false, status: "Paired" });
	});

	it("fails closed for corrupt install configuration instead of contacting a different port", async () => {
		const directory = await install(19443);
		await Bun.write(path.join(directory, "connection.json"), JSON.stringify({ port: 0 }));
		const background = await runBackground(directory);
		expect(background.requests).toEqual(["chrome-extension://fixture/connection.json"]);
		expect(String(background.storage.connectionError)).toContain("Invalid extension connection configuration");
		const options = await runOptions(directory);
		expect(options.disabled).toBe(true);
		expect(options.status).toContain("Invalid extension connection configuration");
	});

	it("rejects a whitespace-only extension name before writing any files", async () => {
		const directory = await mkdtemp(path.join(tmpdir(), "omp-extension-invalid-name-"));
		directories.push(directory);
		await expect(
			runBrowserRelayCommand({ action: "install", dir: directory, port: DEFAULT_RELAY_PORT, name: " \t\n " }),
		).rejects.toThrow("Extension name must not be empty");
		expect(await readdir(directory)).toEqual([]);
	});

	it.each([0, -1, 65536, 1.5])("rejects invalid install port %i before writing files", async port => {
		const directory = await mkdtemp(path.join(tmpdir(), "omp-extension-invalid-port-"));
		directories.push(directory);
		await expect(runBrowserRelayCommand({ action: "install", dir: directory, port })).rejects.toThrow(
			"Port must be between 1 and 65535",
		);
		expect(await Bun.file(path.join(directory, "manifest.json")).exists()).toBe(false);
	});
});
