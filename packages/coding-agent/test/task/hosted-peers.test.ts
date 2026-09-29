import { afterEach, expect, test } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { IrcBus } from "../../src/irc/bus";
import { IrcBridge } from "../../src/session/irc-bridge";
import { HostedPeerRegistry, type HostedPeer } from "../../src/task/hosted-peers";

const root = path.resolve("tmp/peers/root.jsonl");
const self = path.resolve("tmp/peers/root/Writer.jsonl");
const sibling = path.resolve("tmp/peers/root/Checker.jsonl");
const closers: (() => void)[] = [];
afterEach(() => {
	for (const close of closers.splice(0)) close();
});
function member(id: string, sessionFile: string, status: HostedPeer["ref"]["status"] = "running"): HostedPeer {
	return {
		generation: `generation-${id}`,
		ref: { id, displayName: id, kind: id === "main" ? "main" : "sub", sessionFile, status },
	};
}

test("worker messages reach native parent and sibling mailboxes once without claiming their lifecycle", async () => {
	const registry = new AgentRegistry();
	const destination = new AgentRegistry();
	const targetBus = new IrcBus(destination);
	const peers = new HostedPeerRegistry(registry, "Writer", self, root, (_peer, message, options) =>
		targetBus.deliver(message, options),
	);
	closers.push(() => peers.close());
	for (const peer of [member("main", root), member("Checker", sibling)]) {
		destination.register({ ...peer.ref, session: null });
		peers.apply("registered", peer);
		const ref = registry.get(peer.ref.id)!;
		expect(registry.isRunning(ref)).toBe(true);
		const pending = targetBus.wait(peer.ref.id, { from: "Writer" }, 1000);
		const message = {
			id: `message-${peer.ref.id}`,
			ts: 1,
			from: "Writer",
			to: peer.ref.id,
			body: "writer file read back",
		};
		expect((await new IrcBus(registry).deliver(message)).outcome).toBe("injected");
		expect(await pending).toEqual(message);
		expect(targetBus.unreadCount(peer.ref.id)).toBe(0);
		const lifecycle = new AgentLifecycleManager(registry);
		await expect(lifecycle.park(peer.ref.id)).rejects.toThrow("belongs to its owner");
		await expect(lifecycle.release(peer.ref.id)).rejects.toThrow("belongs to its owner");
		await lifecycle.dispose();
		expect(registry.get(peer.ref.id)).toBe(ref);
	}
	peers.close();
	expect((await new IrcBus(registry).send({ from: "Writer", to: "main", body: "late" })).outcome).toBe("failed");
});

test("peer identity, root and generation guards reject cross-session delivery", async () => {
	const registry = new AgentRegistry();
	const peers = new HostedPeerRegistry(registry, "Writer", self, root, async () => {
		throw new Error("must not dispatch");
	});
	closers.push(() => peers.close());
	peers.apply("registered", member("Checker", sibling));
	expect(() => peers.apply("registered", member("Foreign", path.resolve("tmp/peers/other/Foreign.jsonl")))).toThrow(
		"another root",
	);
	expect(() => peers.apply("status_changed", { ...member("Checker", sibling), generation: "new-generation" })).toThrow(
		"generation changed",
	);
	const result = await new IrcBus(registry).send({ from: "Spoofed", to: "Checker", body: "not mine" });
	expect(result.outcome).toBe("failed");
	expect(result.error).toContain("sender or recipient");
	peers.apply("status_changed", member("Checker", sibling, "aborted"));
	expect((await new IrcBus(registry).send({ from: "Writer", to: "Checker", body: "after abort" })).error).toContain(
		"hard-aborted",
	);
});

test("local child mirrors and live sessions cannot be overwritten by peer snapshots", () => {
	const registry = new AgentRegistry();
	const peers = new HostedPeerRegistry(registry, "Writer", self, root, async () => {
		throw new Error("unused");
	});
	closers.push(() => peers.close());
	const local = registry.register({
		...member("Writer.Child", path.resolve("tmp/peers/root/Writer/Writer.Child.jsonl")).ref,
		session: null,
	});
	peers.apply("registered", member("Writer.Child", local.sessionFile!));
	expect(registry.get(local.id)).toBe(local);
	const live = registry.register({ ...member("Checker", sibling).ref, session: { isStreaming: true } as never });
	expect(() => peers.apply("registered", member("Checker", sibling))).toThrow("changed locally");
	expect(registry.get("Checker")).toBe(live);
});

test("active-only operator messages cannot wake a worker after its turn ends", async () => {
	const registry = new AgentRegistry();
	let streaming = true;
	let disposed = false;
	let wakes = 0;
	const bridge = new IrcBridge({
		agent: {} as never,
		sessionManager: {} as never,
		isDisposed: () => disposed,
		isStreaming: () => streaming,
		planModeEnabled: () => false,
		emitSessionEvent: async () => {},
		wakeForIrc: () => {
			wakes++;
		},
	});
	registry.register({
		id: "OperatorControlWorker",
		displayName: "OperatorControlWorker",
		kind: "sub",
		status: "running",
		session: {
			get isStreaming() {
				return streaming;
			},
			deliverIrcMessage: (message: Parameters<IrcBridge["deliver"]>[0]) => bridge.deliver(message),
		} as never,
	});
	const bus = new IrcBus(registry);
	const message = { from: "Main", to: "OperatorControlWorker", body: "Keep the requested file scope." };
	expect((await bus.send(message, { activeOnly: true })).outcome).toBe("injected");
	expect(bridge.drainInboxMessages(message.to).map(record => record.body)).toEqual([message.body]);
	streaming = false;
	expect((await bus.send(message, { activeOnly: true })).outcome).toBe("failed");
	expect(wakes).toBe(0);
	expect(bus.unreadCount(message.to)).toBe(0);
	expect((await bus.send(message)).outcome).toBe("woken");
	expect(wakes).toBe(1);
	streaming = true;
	disposed = true;
	expect((await bus.send(message, { activeOnly: true })).outcome).toBe("failed");
	expect(bus.unreadCount(message.to)).toBe(0);
	expect(wakes).toBe(1);
});
