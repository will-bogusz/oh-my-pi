/** `getTargets().attached` includes other debuggers; only our command channel proves ownership. */
export async function ownedDebuggerTabs(
	targets: ReadonlyArray<{ attached: boolean; tabId?: number }>,
	probe: (tabId: number) => Promise<unknown>,
): Promise<number[]> {
	const owned = await Promise.all(
		targets.map(async target => {
			if (!target.attached || target.tabId === undefined) return undefined;
			try {
				await probe(target.tabId);
				return target.tabId;
			} catch {
				return undefined;
			}
		}),
	);
	return owned.filter((tabId): tabId is number => tabId !== undefined);
}
