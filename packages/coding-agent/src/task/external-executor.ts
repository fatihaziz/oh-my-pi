import * as path from "node:path";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import { AgentRegistry, type AgentRef } from "../registry/agent-registry";
import type { AgentStatus } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { isRecord } from "@oh-my-pi/pi-utils";
import type {
	EffectiveSubagentPolicy,
	StructuredSubagentRequest,
	StructuredSubagentResult,
} from "./structured-subagent";
import type { ExecutorOptions, FollowUpTurnOptions } from "./executor";

/** An external owner must implement the entire lifecycle; errors never select a native fallback. */
export interface ExternalSubagentExecutor {
	execute(request: StructuredSubagentRequest, policy: EffectiveSubagentPolicy): Promise<StructuredSubagentResult>;
	/** Direct native callers (for example Vibe) retain their resolved executor options. */
	start(options: ExecutorOptions): Promise<SingleResult>;
	followUp(options: FollowUpTurnOptions): Promise<SingleResult>;
	deliver(
		ref: AgentRef,
		message: IrcMessage,
		options?: { expectsReply?: boolean; suppressRelay?: boolean },
	): Promise<IrcDeliveryReceipt>;
	park(ref: AgentRef): Promise<void>;
	release(ref: AgentRef, options?: { tombstone?: boolean }): Promise<void>;
}

const owners = new Map<string, ExternalSubagentExecutor | null>();

function canonical(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Bind one native root transcript to an external lifecycle owner. The returned
 * disposer fences future requests; it does not authorize a native fallback.
 * Hosts must release their workers before unregistering the owner.
 */
export function registerExternalSubagentExecutor(
	rootSessionFile: string,
	executor: ExternalSubagentExecutor,
): () => void {
	if (!path.isAbsolute(rootSessionFile) || !rootSessionFile.endsWith(".jsonl")) {
		throw new Error("External executor requires an absolute native root transcript path");
	}
	const root = canonical(rootSessionFile);
	if (owners.get(root)) throw new Error("A lifecycle owner is already registered for this root session");
	owners.set(root, executor);
	let disconnected = false;
	return () => {
		if (disconnected) return;
		disconnected = true;
		if (owners.get(root) !== executor) return;
		owners.set(root, null);
	};
}

/** The longest native transcript ancestor owns a request; sibling roots never match. */
export function externalExecutorForSession(
	sessionFile: string | null | undefined,
	includeRoot = true,
): ExternalSubagentExecutor | undefined {
	if (!sessionFile) return undefined;
	const file = canonical(sessionFile);
	let selected: ExternalSubagentExecutor | null | undefined;
	let length = -1;
	for (const [root, executor] of owners) {
		const children = root.slice(0, -".jsonl".length) + path.sep;
		if (((includeRoot && file === root) || file.startsWith(children)) && root.length > length) {
			selected = executor;
			length = root.length;
		}
	}
	if (selected === null) throw new Error("External lifecycle owner disconnected; native fallback is forbidden");
	return selected;
}

export function externalExecutorForAgent(id: string): ExternalSubagentExecutor | undefined {
	return externalExecutorForSession(AgentRegistry.global().get(id)?.sessionFile, false);
}

const HOSTED_STATUSES: Record<AgentStatus, true> = { running: true, idle: true, parked: true, aborted: true };

/**
 * Mirror one registry change reported by a hosted child into this process, so
 * park, release, hub waits and teardown see it as they see an in-process child.
 * Only direct children of a root bound to an external owner are accepted: a
 * grandchild belongs to its parent worker's registry, and a local agent is
 * never overwritten. Returns false when `ref` is not this process's direct child.
 */
export function mirrorHostedRegistryChange(change: string, ref: unknown): boolean {
	if (
		!isRecord(ref) ||
		typeof ref.id !== "string" ||
		typeof ref.sessionFile !== "string" ||
		typeof ref.displayName !== "string" ||
		typeof ref.status !== "string" ||
		!(ref.status in HOSTED_STATUSES)
	)
		throw new Error("Invalid hosted registry change");
	const directory = path.dirname(canonical(ref.sessionFile)) + path.sep;
	const owned = [...owners].some(
		([root, executor]) => executor !== null && root.slice(0, -".jsonl".length) + path.sep === directory,
	);
	if (!owned) return false;
	const registry = AgentRegistry.global();
	const current = registry.get(ref.id);
	if (current?.session) throw new Error(`Agent "${ref.id}" is hosted locally; a remote change cannot replace it`);
	if (change === "removed") {
		if (current) registry.unregister(ref.id, current);
		return true;
	}
	const status = ref.status as AgentStatus;
	if (!current) {
		registry.register({
			id: ref.id,
			displayName: ref.displayName,
			kind: "sub",
			parentId: typeof ref.parentId === "string" ? ref.parentId : undefined,
			session: null,
			sessionFile: ref.sessionFile,
			status,
		});
		return true;
	}
	registry.setStatus(ref.id, status, current);
	return true;
}
