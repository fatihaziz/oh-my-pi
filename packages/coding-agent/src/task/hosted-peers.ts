import * as path from "node:path";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { isRecord } from "@oh-my-pi/pi-utils/type-guards";
import type { AgentRef, AgentRegistry, AgentStatus } from "../registry/agent-registry";

export interface HostedPeer {
	generation: string;
	ref: Pick<AgentRef, "id" | "displayName" | "kind" | "parentId" | "status" | "sessionFile">;
}

type DeliveryOptions = { expectsReply?: boolean; suppressRelay?: boolean; activeOnly?: boolean };
const routes = new WeakMap<AgentRef, HostedPeerRegistry>();
const statuses = new Set<AgentStatus>(["running", "idle", "parked", "aborted"]);
const canonical = (file: string): string => {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/** A remote peer is addressable, but this process never owns its lifecycle. */
export function hostedPeerRoute(ref: AgentRef | undefined): HostedPeerRegistry | undefined {
	return ref ? routes.get(ref) : undefined;
}

export class HostedPeerRegistry {
	readonly #peers = new Map<string, { generation: string; ref: AgentRef }>();
	#closed = false;

	constructor(
		readonly registry: AgentRegistry,
		readonly localId: string,
		readonly localSessionFile: string,
		readonly rootSessionFile: string,
		readonly send: (peer: HostedPeer, message: IrcMessage, options?: DeliveryOptions) => Promise<IrcDeliveryReceipt>,
	) {
		if (
			!path.isAbsolute(rootSessionFile) ||
			!rootSessionFile.endsWith(".jsonl") ||
			!canonical(localSessionFile).startsWith(canonical(rootSessionFile).slice(0, -6) + path.sep)
		) {
			throw new Error("Peer registry requires the worker's native root transcript");
		}
	}

	get connected(): boolean {
		return !this.#closed;
	}

	apply(change: string, value: unknown): void {
		if (this.#closed) throw new Error("Native peer owner disconnected");
		if (
			!["registered", "status_changed", "metadata_changed", "removed"].includes(change) ||
			!isRecord(value) ||
			typeof value.generation !== "string" ||
			!value.generation ||
			!isRecord(value.ref)
		) {
			throw new Error("Invalid native peer change");
		}
		const ref = value.ref;
		if (
			typeof ref.id !== "string" ||
			!ref.id ||
			typeof ref.displayName !== "string" ||
			(ref.kind !== "main" && ref.kind !== "sub") ||
			typeof ref.status !== "string" ||
			!statuses.has(ref.status as AgentStatus) ||
			typeof ref.sessionFile !== "string" ||
			!path.isAbsolute(ref.sessionFile) ||
			!ref.sessionFile.endsWith(".jsonl") ||
			(ref.parentId !== undefined && typeof ref.parentId !== "string")
		) {
			throw new Error("Invalid native peer identity");
		}
		const file = canonical(ref.sessionFile),
			root = canonical(this.rootSessionFile),
			local = canonical(this.localSessionFile);
		if (file !== root && !file.startsWith(root.slice(0, -6) + path.sep))
			throw new Error("Peer belongs to another root session");
		// The local executor and its direct-owner mirrors keep their own registry refs.
		if (ref.id === this.localId || file === local || file.startsWith(local.slice(0, -6) + path.sep)) return;
		const owned = this.#peers.get(ref.id);
		const current = this.registry.get(ref.id);
		if (current?.session || (owned && current !== owned.ref))
			throw new Error("Peer registry identity changed locally");
		if (owned && (owned.generation !== value.generation || canonical(owned.ref.sessionFile!) !== file)) {
			throw new Error("Peer generation changed without retiring its previous identity");
		}
		if (change === "removed") {
			if (owned) {
				this.registry.unregister(ref.id, owned.ref);
				this.#peers.delete(ref.id);
			}
			return;
		}
		if (owned) {
			this.registry.setStatus(ref.id, ref.status as AgentStatus, owned.ref);
			return;
		}
		if (current && (current.status !== "parked" || canonical(current.sessionFile ?? "") !== file)) {
			throw new Error("Peer would replace another native identity");
		}
		if (current) this.registry.unregister(ref.id, current);
		const registered = this.registry.register({
			id: ref.id,
			displayName: ref.displayName,
			kind: ref.kind,
			parentId: ref.parentId as string | undefined,
			sessionFile: ref.sessionFile,
			status: ref.status as AgentStatus,
			session: null,
		});
		this.#peers.set(ref.id, { generation: value.generation, ref: registered });
		routes.set(registered, this);
	}

	async deliver(ref: AgentRef, message: IrcMessage, options?: DeliveryOptions): Promise<IrcDeliveryReceipt> {
		const peer = this.#peers.get(ref.id);
		if (this.#closed || !peer || peer.ref !== ref || this.registry.get(ref.id) !== ref)
			throw new Error("Native peer generation is unavailable");
		if (message.from !== this.localId || message.to !== ref.id)
			throw new Error("Native peer sender or recipient identity changed");
		return this.send({ generation: peer.generation, ref }, message, options);
	}

	close(): void {
		this.#closed = true;
		for (const { ref } of this.#peers.values()) this.registry.unregister(ref.id, ref);
		this.#peers.clear();
	}
}
