/**
 * Headless delivery: start `omp --mode rpc --resume <session>` whose own
 * mailbox watcher claims the mail and runs the turn, wait for it to settle,
 * then stop the host.
 *
 * Engine-branch stub of the Delivery worker's module with the same signature:
 * the prototype's RpcClient loop, moved here so the runner has one call site.
 * The merge takes the Delivery implementation (eager ownership claim, exit 75).
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "../modes/rpc/rpc-client";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { listNewMail } from "./mailbox";
import { TIMER_HEADLESS_RUN_ENV } from "./paths";

/** How long the headless host gets to claim its mail before the run is recorded held. */
const CLAIM_TIMEOUT_MS = 90_000;
/** After the mail left `new/`, how long the host gets to start the turn before another consumer is assumed. */
const TURN_START_TIMEOUT_MS = 30_000;

export interface HeadlessDeliveryInput {
	sessionId: string;
	sessionRef: string;
	cwd: string;
	mailId: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface HeadlessDeliveryResult {
	outcome: "delivered" | "live" | "held" | "failed";
	detail?: string;
	error?: string;
}

function lastAssistantError(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		return message.stopReason === "error" ? (message.errorMessage ?? "model error") : undefined;
	}
	return undefined;
}

export async function deliverHeadless(input: HeadlessDeliveryInput): Promise<HeadlessDeliveryResult> {
	const client = new RpcClient({
		command: resolveCliEntryCmd(),
		cwd: input.cwd,
		env: { ...input.env, [TIMER_HEADLESS_RUN_ENV]: input.mailId },
		args: ["--resume", input.sessionRef],
	});
	const settled = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let turnError: string | undefined;
	let sawTurn = false;
	client.onEvent(event => {
		if (event.type === "agent_start") {
			sawTurn = true;
			started.resolve();
		}
		if (event.type === "agent_end") turnError = lastAssistantError(event.messages);
	});
	client.onSessionSettled(() => {
		if (sawTurn) settled.resolve();
	});
	try {
		await client.start();
		const mailName = `${input.mailId}.json`;
		const claimDeadline = Date.now() + CLAIM_TIMEOUT_MS;
		while ((await listNewMail(input.sessionId)).includes(mailName)) {
			if (Date.now() > claimDeadline) return { outcome: "held", detail: "headless host did not claim the mail" };
			await Bun.sleep(500);
		}
		const turnStarted = await Promise.race([
			started.promise.then(() => true),
			Bun.sleep(TURN_START_TIMEOUT_MS).then(() => false),
		]);
		if (!turnStarted) return { outcome: "live", detail: "mail claimed by another consumer" };
		const timeoutMs = input.timeoutMs ?? 30 * 60_000;
		const timedOut = await Promise.race([settled.promise.then(() => false), Bun.sleep(timeoutMs).then(() => true)]);
		if (timedOut) return { outcome: "failed", error: `run exceeded ${Math.round(timeoutMs / 60_000)}m` };
		return turnError ? { outcome: "failed", error: turnError } : { outcome: "delivered" };
	} catch (err) {
		return { outcome: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
	} finally {
		await client.stop();
	}
}
