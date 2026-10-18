import type { Connection } from "puppeteer-core";

/** Puppeteer's protocol map has no entry for relay-private methods; its `send` is otherwise generic. */
interface RelayConnection {
	send(method: "OMP.claimTarget", params: { targetId: string }): Promise<unknown>;
	send(method: "OMP.releaseTarget", params: { targetId: string }): Promise<{ detached?: boolean }>;
}

/**
 * Make `targetId` this connection's own on the omp browser relay, which attaches and announces only
 * the tabs a connection created or claimed, and adds it to the per-window "omp" tab group.
 */
export async function claimRelayTarget(connection: Connection, targetId: string): Promise<void> {
	await (connection as unknown as RelayConnection).send("OMP.claimTarget", { targetId });
}

/**
 * Let go of the relay's debugger on `targetId`, a tab this connection owns, while keeping it owned and
 * grouped. Resolves whether the attachment came off (it stays while another client holds a session).
 */
export async function releaseRelayTarget(connection: Connection, targetId: string): Promise<boolean> {
	const reply = await (connection as unknown as RelayConnection).send("OMP.releaseTarget", { targetId });
	return reply.detached === true;
}
