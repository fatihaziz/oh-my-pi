import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { loadSessionFile } from "../session/session-loader";

type Source = { sessionId: string; sessionPath: string };
export type ReviewTask = {
	id: string;
	nativeGoal?: Source & { id: string };
	nativeTodos?: ({ key: string; content: string } & Partial<Source>)[];
};

// A completed TODO locates work; it is not evidence that the work passed.
export function taskReviewEvidence(
	branch: readonly unknown[],
	task: Pick<ReviewTask, "id"> & { nativeGoal?: { id: string }; nativeTodos?: { key: string; content: string }[] },
	worker = false,
) {
	const evidence: Record<string, unknown>[] = [],
		decisions: Record<string, unknown>[] = [];
	const calls = new Map<string, Record<string, unknown>>();
	let active = worker,
		goal = "",
		bytes = 0,
		omitted = 0,
		started = worker;
	const todos = task.nativeTodos ?? [];
	for (const raw of branch) {
		if (!isRecord(raw)) continue;
		const entry = raw,
			data = isRecord(entry.data) ? entry.data : undefined;
		const changedGoal = isRecord(data?.goal) ? data.goal : undefined;
		if (!worker && entry.type === "mode_change" && typeof changedGoal?.id === "string") {
			goal = changedGoal.id;
			if (task.nativeGoal) {
				active = task.nativeGoal.id === goal && changedGoal.status !== "complete";
				if (active) started = true;
			} else if (
				todos.some(todo => todo.key.startsWith("goal:")) &&
				!todos.some(todo => todo.key.startsWith(`goal:${goal}:`))
			) {
				active = false;
				calls.clear();
			}
		}
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		const details = isRecord(message?.details) ? message.details : undefined;
		const phases =
			entry.type === "custom" && entry.customType === "user_todo_edit"
				? data?.phases
				: message?.role === "toolResult" &&
					  message.toolName === "todo" &&
					  !message.isError &&
					  details?.op !== "view"
					? details?.phases
					: undefined;
		if (!worker && Array.isArray(phases) && !task.nativeGoal) {
			const matches = phases
				.flatMap(p => (isRecord(p) && Array.isArray(p.tasks) ? p.tasks : []))
				.filter(isRecord)
				.filter(row =>
					todos.some(
						todo =>
							todo.content === row.content &&
							(!todo.key.startsWith("goal:") || todo.key.startsWith(`goal:${goal}:`)),
					),
				);
			if (matches.some(row => row.status === "in_progress")) {
				active = true;
				started = true;
			} else if (matches.some(row => row.status === "completed" || row.status === "abandoned")) {
				active = false;
			}
		}
		if (!active || !message) continue;
		if (message.role === "user" && message.attribution !== "agent") {
			const row = { entryId: entry.id, content: message.content };
			if (Buffer.byteLength(JSON.stringify(row)) <= 4096 && decisions.length < 8) decisions.push(row);
			else omitted++;
		}
		if (message.role === "assistant") {
			for (const part of Array.isArray(message.content) ? message.content : [])
				if (isRecord(part) && part.type === "toolCall" && typeof part.id === "string") {
					if (calls.size < 128 && Buffer.byteLength(JSON.stringify(part)) <= 8192)
						calls.set(part.id, { entryId: entry.id, ...part });
					else omitted++;
				}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const row = {
					entryId: entry.id,
					failure: message.errorMessage,
					provider: message.provider,
					model: message.model,
				};
				const size = Buffer.byteLength(JSON.stringify(row));
				if (size <= 2048 && size + bytes <= 24576 && evidence.length < 24) {
					evidence.push(row);
					bytes += size;
				} else omitted++;
			}
		}
		if (
			message.role !== "toolResult" ||
			typeof message.toolCallId !== "string" ||
			typeof message.toolName !== "string"
		)
			continue;
		const call = calls.get(message.toolCallId);
		calls.delete(message.toolCallId);
		if (
			!call ||
			["todo", "goal", "foyer_tasks", "workflow_review", "workflow_next", "delegation_review"].includes(
				message.toolName,
			)
		)
			continue;
		const row = {
			entryId: entry.id,
			call,
			result: {
				tool: message.toolName,
				content: message.content,
				isError: message.isError,
				details: message.details,
			},
		};
		const size = Buffer.byteLength(JSON.stringify(row));
		if (size > 8192 || size + bytes > 24576 || evidence.length >= 24) {
			omitted++;
			continue;
		}
		evidence.push(row);
		bytes += size;
	}
	const state = {
		evidence,
		decisions,
		started,
		omitted,
		boundary:
			"Only captured calls and results during this task's native execution are included. TODO completion, review-tool output and model claims are not proof. Omitted or absent evidence cannot support acceptance.",
	};
	return { ...state, version: createHash("sha256").update(JSON.stringify(state)).digest("hex") };
}

/** Read-only, task-linked evidence; it does not need the execution parent to be alive. */
export function createTaskReviewReader(live?: () => Source & { branch: readonly unknown[] }) {
	const branches = new Map<string, { stamp: string; sessionId: string; branch: readonly unknown[] }>();
	return async (input: unknown, signal?: AbortSignal, workerSources?: unknown) => {
		if (
			!isRecord(input) ||
			typeof input.id !== "string" ||
			(input.nativeTodos !== undefined &&
				(!Array.isArray(input.nativeTodos) ||
					input.nativeTodos.some(
						todo => !isRecord(todo) || typeof todo.key !== "string" || typeof todo.content !== "string",
					)))
		)
			throw new Error("Invalid review task");
		const task = input as ReviewTask;
		const sources = new Map<string, string>();
		const addSource = (source: Partial<Source>) => {
			if (
				typeof source.sessionPath !== "string" ||
				!isAbsolute(source.sessionPath) ||
				!source.sessionPath.endsWith(".jsonl") ||
				typeof source.sessionId !== "string" ||
				!source.sessionId
			)
				throw new Error("Invalid review source identity");
			if (sources.has(source.sessionPath) && sources.get(source.sessionPath) !== source.sessionId)
				throw new Error("Conflicting review source identity");
			sources.set(source.sessionPath, source.sessionId);
		};
		// Goal projections contain TODO summaries without source identity. Never borrow the live parent for them.
		for (const todo of task.nativeTodos ?? []) if (todo.sessionPath || todo.sessionId) addSource(todo);
		if (task.nativeGoal !== undefined) {
			if (!isRecord(task.nativeGoal) || typeof task.nativeGoal.id !== "string")
				throw new Error("Invalid review goal");
			addSource(task.nativeGoal);
		}
		const workers = new Set<string>();
		if (workerSources !== undefined) {
			if (!Array.isArray(workerSources) || workerSources.length > 32)
				throw new Error("Invalid worker review sources");
			for (const source of workerSources) {
				if (
					!isRecord(source) ||
					typeof source.path !== "string" ||
					!isAbsolute(source.path) ||
					typeof source.agentId !== "string" ||
					!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(source.agentId) ||
					basename(source.path) !== `${source.agentId}.jsonl` ||
					sources.has(source.path)
				)
					throw new Error("Invalid worker review source identity");
				// Foyer supplies only settled leases matching this exact task, attempt and assignee.
				sources.set(source.path, "");
				workers.add(source.path);
			}
		}
		if (sources.size > 32) throw new Error("Too many review sources");
		const contexts: unknown[] = [];
		for (const [path, expectedSession] of sources) {
			signal?.throwIfAborted();
			const current = live?.();
			if (current?.sessionId === expectedSession && current.sessionPath === path) {
				contexts.push(taskReviewEvidence(current.branch, task));
				continue;
			}
			const info = await stat(path),
				stamp = `${info.size}:${info.mtimeMs}`;
			let cached = branches.get(path);
			if (cached?.stamp !== stamp || cached.sessionId !== expectedSession) {
				const loaded = await loadSessionFile(path, undefined, { throwIfMissing: true });
				signal?.throwIfAborted();
				const header = loaded.entries.find(row => row.type === "session");
				if (
					loaded.invalidHeader ||
					loaded.malformedRecords ||
					!header?.id ||
					(expectedSession && header.id !== expectedSession)
				)
					throw new Error("Review transcript source identity or integrity changed");
				const entries = loaded.entries.filter(row => row.type !== "session");
				const byId = new Map(entries.map(row => [row.id, row]));
				const branch: unknown[] = [],
					seen = new Set<string>();
				let leaf = entries.at(-1);
				while (leaf) {
					if (seen.has(leaf.id)) throw new Error("Review transcript contains a branch cycle");
					seen.add(leaf.id);
					branch.push(leaf);
					if (leaf.parentId && !byId.has(leaf.parentId)) throw new Error("Review transcript branch is incomplete");
					leaf = leaf.parentId ? byId.get(leaf.parentId) : undefined;
				}
				cached = { stamp, sessionId: expectedSession, branch: branch.reverse() };
				if (branches.size >= 8) branches.delete(branches.keys().next().value!);
				branches.set(path, cached);
			}
			contexts.push(taskReviewEvidence(cached.branch, task, workers.has(path)));
		}
		signal?.throwIfAborted();
		return {
			contexts,
			boundary:
				"A stored completed task is a review candidate, never automatic acceptance. Historical sessions are loaded read-only. Missing evidence must remain pending.",
		};
	};
}
