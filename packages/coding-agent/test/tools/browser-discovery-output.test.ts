import { expect, it, spyOn } from "bun:test";
import * as vm from "node:vm";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import * as managedChrome from "@oh-my-pi/pi-coding-agent/tools/browser/managed-chrome";
import type { BrowserInstance, InstanceTab } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";

it("keeps browser discovery structured without implicitly printing unrelated tab titles and URLs", async () => {
	const instances: BrowserInstance[] = [{ id: "work-browser", label: "Work Chrome", connected: true }];
	const tabs: InstanceTab[] = Array.from({ length: 25 }, (_, index) => ({
		id: `discovered-${index}`,
		tabId: index + 1,
		browserId: "work-browser",
		browserLabel: "Work Chrome",
		title: index === 0 ? "Workshop reservation" : `Unrelated private page ${index}`,
		url:
			index === 0 ? "https://workshop.example.test/reservation" : `https://unrelated.example.test/private/${index}`,
		active: index === 1,
		windowId: 1,
		pinned: false,
		groupId: -1,
		ownership: "available",
	}));
	const listInstances = spyOn(managedChrome, "listChromeInstances").mockResolvedValue(instances);
	const discoverTabs = spyOn(managedChrome, "discoverChromeTabs").mockResolvedValue(tabs);
	try {
		const session: ToolSession = {
			cwd: import.meta.dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			settings: Settings.isolated({ "browser.enabled": true }),
		};
		const prelude = createBrowserPrelude(session);
		session.getEvalPreludes = () => [prelude];
		const displayed: unknown[] = [];
		const responses: unknown[] = [];
		const context = vm.createContext({
			__omp_display__: (value: unknown) => displayed.push(value),
			__omp_prelude__: async (name: string, parameters: unknown) => {
				const result = await callSessionTool("__prelude__", { name, parameters }, { session });
				responses.push(result);
				return result;
			},
		});
		vm.runInContext(prelude.javascript, context);
		const selected: unknown = await vm.runInContext(
			`(async () => {
				globalThis.instances = await browser.instances();
				globalThis.tabs = await browser.discover({ browserId: instances.find(item => item.connected).id });
				globalThis.selection = {
					browserCount: instances.length,
					tabCount: tabs.length,
					ids: tabs.filter(tab => tab.url === "https://workshop.example.test/reservation").map(tab => tab.id),
				};
				return selection;
			})()`,
			context,
		);

		// Real host results remain available to code, but their inventory does
		// not enter the facade's implicit display channel.
		expect(selected).toEqual({ browserCount: 1, tabCount: 25, ids: ["discovered-0"] });
		expect(responses).toHaveLength(2);
		expect(responses[0]).toMatchObject({ text: "" });
		expect(responses[1]).toMatchObject({ text: "" });
		expect(displayed).toEqual([]);

		// The caller can deliberately publish just the useful projection.
		vm.runInContext("__omp_display__(selection)", context);
		expect(displayed).toEqual([{ browserCount: 1, tabCount: 25, ids: ["discovered-0"] }]);
	} finally {
		discoverTabs.mockRestore();
		listInstances.mockRestore();
	}
});
