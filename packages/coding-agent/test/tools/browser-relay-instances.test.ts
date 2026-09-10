import { expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RelayAccess } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/access";
import type { RelaySocket } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/bridge";
import { BrowserInstances, EXPECTED_EXTENSION_BUILD_ID } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/instances";

const hello = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/150",
	attachedTabIds: [],
	tabs: [
		{
			tabId: 1,
			windowId: 1,
			title: "Same title",
			url: "https://example.com",
			active: true,
			groupId: -1,
			pinned: false,
		},
	],
};
class Socket implements RelaySocket {
	messages: Array<Record<string, unknown>> = [];
	closed = false;
	send(raw: string): void {
		this.messages.push(JSON.parse(raw));
	}
	close(): void {
		this.closed = true;
	}
}
function pair(
	instances: BrowserInstances,
	id: string,
	label: string,
	extensionBuildId?: string,
): { socket: Socket; credential: string } {
	const socket = new Socket();
	instances.extConnected(socket);
	instances.extMessage(
		socket,
		JSON.stringify({ t: "authenticate", auth: { id, label, pairingCode: instances.access.issueCode().code } }),
	);
	const credential = socket.messages[0]!.credential as string;
	instances.extMessage(socket, JSON.stringify({ ...hello, extensionBuildId }));
	return { socket, credential };
}

it("keeps paired instances concurrent and isolates identical physical tab numbers and reconnects", () => {
	const instances = new BrowserInstances(new RelayAccess());
	try {
		const first = pair(instances, "profile_instance_a", "Work Chrome", EXPECTED_EXTENSION_BUILD_ID);
		const second = pair(instances, "profile_instance_b", "Personal Chrome", EXPECTED_EXTENSION_BUILD_ID);
		expect(first.socket.closed).toBe(false);
		expect(instances.list().filter(browser => browser.connected)).toHaveLength(2);
		expect(() => instances.select()).toThrow("Multiple browsers");
		const tabs = instances.discover("actor");
		expect(tabs[0]!.id).not.toBe(tabs[1]!.id);
		const a = instances.claim(tabs[0]!.id, "actor");
		const b = instances.claim(tabs[1]!.id, "actor");
		expect(() => instances.claim(tabs[0]!.id, "other", undefined, undefined, "profile_instance_b")).toThrow(
			"different browser",
		);
		const generationB = instances.list()[1]!.generation;
		const replacement = new Socket();
		instances.extConnected(replacement);
		instances.extMessage(
			replacement,
			JSON.stringify({
				t: "authenticate",
				auth: { id: "profile_instance_a", label: "Work Chrome", credential: first.credential },
			}),
		);
		expect(first.socket.closed).toBe(false);
		instances.extMessage(replacement, JSON.stringify({ ...hello, extensionBuildId: EXPECTED_EXTENSION_BUILD_ID }));
		expect(first.socket.closed).toBe(true);
		expect(second.socket.closed).toBe(false);
		expect(instances.forLease(a.id)).toBeUndefined();
		expect(instances.get(b.id, "actor").browserId).toBe("profile_instance_b");
		expect(instances.list()[1]!.generation).toBe(generationB);
		instances.extClosed(replacement);
		expect(instances.select().id).toBe("profile_instance_b");
	} finally {
		instances.close();
	}
});

it("cannot evict or relabel a healthy instance with invalid credentials or malformed hello", () => {
	const instances = new BrowserInstances(new RelayAccess());
	try {
		const healthy = pair(instances, "profile_instance_a", "Work Chrome");
		for (const credential of ["wrong", healthy.credential]) {
			const attempt = new Socket();
			instances.extConnected(attempt);
			instances.extMessage(
				attempt,
				JSON.stringify({ t: "authenticate", auth: { id: "profile_instance_a", label: "Wrong label", credential } }),
			);
			instances.extMessage(attempt, JSON.stringify({ t: "hello", tabs: "invalid" }));
			expect(attempt.closed).toBe(true);
			expect(healthy.socket.closed).toBe(false);
			expect(instances.list()[0]!.label).toBe("Work Chrome");
		}
	} finally {
		instances.close();
	}
});

it("reports the connected worker build and never carries that claim across disconnect or legacy reconnect", () => {
	const instances = new BrowserInstances(new RelayAccess());
	try {
		const first = pair(instances, "profile_instance_a", "Work Chrome");
		expect(instances.list()[0]!.extension?.status).toBe("unknown");
		const expected = instances.list()[0]!.extension!.expectedBuildId;
		const connect = (extensionBuildId?: string) => {
			const socket = new Socket();
			instances.extConnected(socket);
			instances.extMessage(
				socket,
				JSON.stringify({
					t: "authenticate",
					auth: { id: "profile_instance_a", label: "Work Chrome", credential: first.credential },
				}),
			);
			instances.extMessage(socket, JSON.stringify({ ...hello, extensionBuildId }));
			return socket;
		};
		const matching = connect(expected);
		expect(instances.list()[0]!.extension).toMatchObject({ status: "matching", loadedBuildId: expected });
		const malformed = connect("not-a-build-id");
		expect(malformed.closed).toBe(true);
		expect(matching.closed).toBe(false);
		expect(instances.list()[0]!.extension?.status).toBe("matching");
		instances.extClosed(matching);
		expect(instances.list()[0]!.extension).toMatchObject({ status: "unknown", loadedBuildId: undefined });
		connect("0".repeat(64));
		expect(instances.list()[0]!.extension?.status).toBe("different");
		connect();
		expect(instances.list()[0]!.extension).toMatchObject({ status: "unknown", loadedBuildId: undefined });
	} finally {
		instances.close();
	}
});

it("uses one-time expiring pairing codes and separate control and instance credentials", () => {
	const access = new RelayAccess();
	const code = access.issueCode(1000);
	const auth = access.authenticate({ id: "profile_instance_a", label: "Work", pairingCode: code.code }, 1001);
	expect(access.authorized(`Bearer ${auth.credential}`)).toBe(false);
	expect(access.authorized(`Bearer ${access.controlToken}`)).toBe(true);
	expect(access.authorized(null)).toBe(false);
	expect(() =>
		access.authenticate({ id: "profile_instance_b", label: "Other", pairingCode: code.code }, 1002),
	).toThrow("invalid or expired");
	const expired = access.issueCode(1000);
	expect(() =>
		access.authenticate({ id: "profile_instance_c", label: "Other", pairingCode: expired.code }, expired.expiresAt),
	).toThrow("expired");
});

it("persists pairing and the same control credential in a private endpoint file", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "omp-browser-access-"));
	try {
		const file = path.join(root, "access.json");
		const access = new RelayAccess(file);
		const auth = access.authenticate({
			id: "profile_instance_a",
			label: "Work",
			pairingCode: access.issueCode().code,
		});
		const reopened = new RelayAccess(file);
		expect(reopened.controlToken).toBe(access.controlToken);
		expect(
			reopened.authenticate({ id: "profile_instance_a", label: "Work", credential: auth.credential }).browser.label,
		).toBe("Work");
		if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("revokes pending reconnects before allowing the same browser to pair afresh", () => {
	const instances = new BrowserInstances(new RelayAccess());
	try {
		const first = pair(instances, "profile_instance_a", "Work Chrome");
		const pending = new Socket();
		instances.extConnected(pending);
		instances.extMessage(
			pending,
			JSON.stringify({
				t: "authenticate",
				auth: { id: "profile_instance_a", label: "Old label", credential: first.credential },
			}),
		);
		instances.unpair("profile_instance_a");
		expect(pending.closed).toBe(true);
		const fresh = pair(instances, "profile_instance_a", "Fresh pairing");
		instances.extMessage(pending, JSON.stringify(hello));
		expect(fresh.socket.closed).toBe(false);
		expect(instances.list()[0]!.label).toBe("Fresh pairing");
	} finally {
		instances.close();
	}
});

it("holds a fresh relay's first request until the paired extension reconnects, and never waits when nothing is paired", async () => {
	const unpaired = new BrowserInstances(new RelayAccess());
	try {
		const started = performance.now();
		await unpaired.settled(2000);
		expect(performance.now() - started).toBeLessThan(200);
	} finally {
		unpaired.close();
	}
	const access = new RelayAccess();
	const instances = new BrowserInstances(access);
	try {
		// Pair, then drop the socket: the relay knows a browser exists but it is
		// not connected, which is exactly the state right after a daemon start.
		const paired = pair(instances, "profile_instance_a", "Work Chrome");
		instances.extClosed(paired.socket);
		expect(instances.ready).toBe(false);
		const waited = instances.settled(2000).then(() => performance.now());
		const started = performance.now();
		const replacement = new Socket();
		instances.extConnected(replacement);
		instances.extMessage(
			replacement,
			JSON.stringify({
				t: "authenticate",
				auth: { id: "profile_instance_a", label: "Work Chrome", credential: paired.credential },
			}),
		);
		instances.extMessage(replacement, JSON.stringify(hello));
		expect((await waited) - started).toBeLessThan(200);
		expect(instances.ready).toBe(true);
		// Once connected, settled never blocks.
		const again = performance.now();
		await instances.settled(2000);
		expect(performance.now() - again).toBeLessThan(50);
		instances.extClosed(replacement);
		// Still disconnected after the grace: give up rather than hang the request.
		const grace = performance.now();
		await instances.settled(150);
		expect(performance.now() - grace).toBeGreaterThanOrEqual(140);
	} finally {
		instances.close();
	}
});

it("refuses to hand out a tab from a Chrome running another extension build, and says how to fix it", () => {
	const instances = new BrowserInstances(new RelayAccess());
	instances.port = 54_837;
	try {
		const stale = "0".repeat(64);
		const { socket } = pair(instances, "profile_instance_a", "Work Chrome", stale);
		// The handshake carries the expected build so the extension can reload itself.
		expect(socket.messages[0]).toMatchObject({
			t: "authenticated",
			expectedBuildId: EXPECTED_EXTENSION_BUILD_ID,
		});
		const found = instances.discover()[0]!;
		for (const acquire of [
			() => instances.claim(found.id, "owner"),
			() => instances.create("https://example.com/", "owner", "task"),
		]) {
			expect(acquire).toThrow(stale);
			expect(acquire).toThrow(EXPECTED_EXTENSION_BUILD_ID);
			expect(acquire).toThrow("omp browser-relay install");
			expect(acquire).toThrow("--port 54837");
		}
		// A build too old to report an id is skew too: nothing here can be trusted.
		pair(instances, "profile_instance_b", "Personal Chrome");
		const legacy = instances.discover().find(candidate => candidate.browserId === "profile_instance_b")!;
		expect(() => instances.claim(legacy.id, "owner")).toThrow("too old to report its id");
	} finally {
		instances.close();
	}
});

it("hands out a tab and keeps holding it while the extension build matches", () => {
	const instances = new BrowserInstances(new RelayAccess());
	try {
		pair(instances, "profile_instance_a", "Work Chrome", EXPECTED_EXTENSION_BUILD_ID);
		const lease = instances.claim(instances.discover()[0]!.id, "owner");
		expect(instances.get(lease.id, "owner").tab.tabId).toBe(1);
	} finally {
		instances.close();
	}
});
