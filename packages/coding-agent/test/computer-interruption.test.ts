import { describe, expect, it } from "bun:test";
import type { DesktopSystemWindow } from "@oh-my-pi/pi-natives";
import {
	classifyWindow,
	describeInterruption,
	rosterInterruption,
	windowInterruption,
	type WindowRosterSample,
} from "@oh-my-pi/pi-coding-agent/tools/computer/interruption";

// Rows below are real `CGWindowListCopyWindowInfo` observations from this
// machine (batch-1 lane static/modal and the roster probe), not invented shapes.
function window(row: Partial<DesktopSystemWindow>): DesktopSystemWindow {
	return {
		id: "1",
		pid: 1,
		app: "TextEdit",
		title: "",
		x: 0,
		y: 0,
		width: 400,
		height: 300,
		layer: 0,
		alpha: 1,
		zIndex: 0,
		...row,
	};
}
function sample(...windows: DesktopSystemWindow[]): WindowRosterSample {
	return { windows, elapsedMs: 1 };
}

const keychainPrompt = window({
	id: "50468",
	pid: 84307,
	app: "SecurityAgent",
	title: "",
	x: 647,
	y: 260,
	width: 434,
	height: 186,
	layer: 1000,
});

describe("system window classification", () => {
	it("classifies the owners that draw system prompts", () => {
		expect(classifyWindow({ app: "SecurityAgent" })).toBe("auth");
		expect(classifyWindow({ app: "coreautha" })).toBe("auth");
		expect(classifyWindow({ app: "UserNotificationCenter" })).toBe("permission");
		expect(classifyWindow({ app: "loginwindow" })).toBe("lock");
		expect(classifyWindow({ app: "Open and Save Panel Service" })).toBe("app-modal");
		expect(classifyWindow({ app: "TextEdit" })).toBe("other");
	});

	it("matches the whole owner name, so an ordinary app never reads as a prompt", () => {
		// Keychain Access is the user's app; SecurityAgentHelper is not the panel.
		expect(classifyWindow({ app: "Keychain Access" })).toBe("other");
		expect(classifyWindow({ app: "SecurityAgentHelper" })).toBe("other");
		expect(classifyWindow({ app: " securityagent " })).toBe("auth");
	});

	it("does not treat the upper layers as evidence by themselves", () => {
		// Observed: a menu-bar utility parks a status panel at the same layer 1000
		// macOS gives SecurityAgent. Layer-based detection would refuse every
		// action while it is up.
		expect(classifyWindow(window({ app: "Wispr Flow", title: "Status", layer: 1000 }))).toBe("other");
		expect(classifyWindow(window({ app: "Control Center", title: "WiFi", layer: 25 }))).toBe("other");
	});
});

describe("interruption detection", () => {
	it("reports an on-screen keychain panel with its identity", () => {
		expect(windowInterruption(keychainPrompt)).toEqual({
			app: "SecurityAgent",
			pid: 84307,
			windowId: "50468",
			title: "",
			kind: "auth",
		});
	});

	it("ignores the invisible placeholders system agents keep permanently", () => {
		// loginwindow always owns windows; blocking on those refuses every action
		// forever, which is the failure mode that matters most here.
		expect(windowInterruption(window({ app: "loginwindow", alpha: 0, width: 500, height: 500 }))).toBeUndefined();
		expect(windowInterruption(window({ app: "loginwindow", width: 0, height: 0 }))).toBeUndefined();
		expect(windowInterruption(window({ app: "loginwindow", width: 1728, height: 1117 }))).toBeDefined();
	});

	it("does not block on a panel the agent's own file dialog opened", () => {
		expect(windowInterruption(window({ app: "Open and Save Panel Service", layer: 0 }))).toBeUndefined();
	});

	it("returns nothing for an ordinary desktop and the topmost prompt otherwise", () => {
		const ordinary = sample(
			window({ id: "148", app: "iTerm", title: "shell" }),
			window({ id: "50626", app: "OMP TCC Fixture" }),
		);
		expect(rosterInterruption(ordinary)).toBeUndefined();

		const interrupted = sample(
			window({ id: "9", app: "UserNotificationCenter", title: "", layer: 1000, zIndex: 0 }),
			keychainPrompt,
			window({ id: "148", app: "iTerm", title: "shell", zIndex: 2 }),
		);
		expect(rosterInterruption(interrupted)?.app).toBe("UserNotificationCenter");
	});

	it("names the app and the kind so the model can tell the user what is asking", () => {
		expect(describeInterruption(windowInterruption(keychainPrompt)!)).toBe(
			"a system authentication prompt from SecurityAgent (pid 84307, window 50468) is on screen",
		);
	});
});
