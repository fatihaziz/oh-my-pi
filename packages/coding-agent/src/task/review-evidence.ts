import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { truncateMiddle } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { ArtifactManager } from "../session/artifacts";
import { loadSessionFile } from "../session/session-loader";

type Source = { sessionId: string; sessionPath: string };
export type ReviewTask = {
	id: string;
	nativeGoal?: Source & { id: string; entryId?: string };
	nativeTodos?: ({ key: string; content: string; entryId?: string } & Partial<Source>)[];
};

function todoRows(entry: Record<string, unknown>) {
	const data = isRecord(entry.data) ? entry.data : undefined;
	const message = isRecord(entry.message) ? entry.message : undefined;
	const details = isRecord(message?.details) ? message.details : undefined;
	const phases = entry.type === "custom" && entry.customType === "user_todo_edit"
		? data?.phases
		: message?.role === "toolResult" && message.toolName === "todo" && !message.isError && details?.op !== "view"
			? details?.phases : undefined;
	return Array.isArray(phases)
		? phases.flatMap(phase => isRecord(phase) && Array.isArray(phase.tasks) ? phase.tasks.filter(isRecord) : [])
		: undefined;
}

// Resolve a stored snapshot to one occurrence, not another task with the same title.
function anchoredTodoRanges(branch: readonly unknown[], todos: NonNullable<ReviewTask["nativeTodos"]>) {
	const ranges = new Map<string, { from: number; to: number }>();
	for (const todo of todos) {
		if (!todo.entryId) continue;
		let goal = "", mode = "", scopeChanged = false;
		const initialGoals = new Map<string, string>();
		let occurrence: { identity: string; goal: string; from: number; entryId: unknown; status: unknown } | undefined;
		for (const [index, raw] of branch.entries()) {
			if (!isRecord(raw)) continue;
			if (raw.type === "mode_change") {
				const previous = goal;
				if (isRecord(raw.data) && isRecord(raw.data.goal) && typeof raw.data.goal.id === "string")
					goal = raw.data.goal.id;
				else if (raw.mode === "none" && (mode === "goal" || mode === "goal_paused")) goal = "";
				mode = typeof raw.mode === "string" ? raw.mode : "goal";
				scopeChanged ||= previous !== goal;
			}
			const rows = todoRows(raw);
			if (!rows) continue;
			const matches = rows.filter(row => row.content === todo.content);
			if (matches.length !== 1) { occurrence = undefined; continue; }
			const row = matches[0];
			const identity = typeof row.id === "string" ? `id:${row.id}` : `content:${row.content}`;
			if (!initialGoals.has(identity)) initialGoals.set(identity, goal);
			const terminal = occurrence?.status === "completed" || occurrence?.status === "abandoned";
			if (!occurrence || occurrence.identity !== identity || ((terminal || scopeChanged) && row.status !== "completed" && row.status !== "abandoned"))
				occurrence = { identity, goal, from: index, entryId: raw.id, status: row.status };
			scopeChanged = false;
			occurrence.status = row.status;
			if (raw.id !== todo.entryId) continue;
			const hash = createHash("sha256").update(identity).digest("hex");
			const suffix = todo.key.lastIndexOf(":occurrence:");
			const base = suffix < 0 ? todo.key : todo.key.slice(0, suffix);
			const exactOccurrence = suffix < 0 || todo.key.slice(suffix + 12) === occurrence.entryId;
			if (exactOccurrence && (base === identity || base === `goal:${goal}:${hash}` || base === `goal:${occurrence.goal}:${hash}` || base === `goal:${initialGoals.get(identity)}:${hash}`))
				ranges.set(todo.key, { from: occurrence.from, to: index });
			break;
		}
	}
	return ranges;
}

const clip = (text: string, limit: number) => truncateMiddle(text, { maxBytes: limit }).content;

function boundedEvidence(row: Record<string, unknown>): Record<string, unknown> {
	if (Buffer.byteLength(JSON.stringify(row)) <= 8192) return row;
	const call = isRecord(row.call) ? row.call : undefined;
	const result = isRecord(row.result) ? row.result : undefined;
	const details = isRecord(result?.details) ? result.details : undefined;
	return {
		entryId: row.entryId, truncated: true,
		...(call ? { call: { entryId: call.entryId, id: call.id, name: call.name, type: call.type,
			arguments: clip(JSON.stringify(call.arguments) ?? "", 2048), truncated: true } } : {}),
		...(result ? { result: { tool: result.tool, isError: result.isError, truncated: true,
			content: [{ type: "text", text: clip(typeof result.content === "string" ? result.content : JSON.stringify(result.content) ?? "", 3072) }],
			details: { exitCode: details?.exitCode, asyncComplete: details?.asyncComplete, jobId: details?.jobId, status: details?.status },
		} } : {}),
		...(typeof row.text === "string" ? { text: clip(row.text, 2048) } : {}),
		...(typeof row.failure === "string" ? { failure: clip(row.failure, 2048) } : {}),
	};
}

// A burst of completions without intervening work shares its preceding window.
function todoWindows(branch: readonly unknown[], todos: NonNullable<ReviewTask["nativeTodos"]>, ranges: Map<string, { from: number; to: number }>) {
	const windows: { from: number; to: number; completed?: boolean }[] = [];
	for (const todo of todos) {
		const range = ranges.get(todo.key);
		if (todo.entryId && !range) continue;
		let goal = "", mode = "", boundary = 0, lastTodo = 0, open: number | undefined, wasCompleted = false, substantive = false;
		for (const [index, raw] of branch.entries()) {
			if (!isRecord(raw)) continue;
			if (raw.type === "mode_change") {
				if (isRecord(raw.data) && isRecord(raw.data.goal) && typeof raw.data.goal.id === "string")
					goal = raw.data.goal.id;
				else if (raw.mode === "none" && (mode === "goal" || mode === "goal_paused")) goal = "";
				mode = typeof raw.mode === "string" ? raw.mode : "goal";
			}
			const message = raw.type === "message" && isRecord(raw.message) ? raw.message : undefined;
			if (message?.role === "toolResult" && message.toolName !== "todo") substantive = true;
			if (message?.role === "assistant" && Array.isArray(message.content) && message.content.some(part =>
				isRecord(part) && ((part.type === "text" && typeof part.text === "string" && part.text.trim()) ||
				(part.type === "toolCall" && part.name !== "todo")))) substantive = true;
			const rows = todoRows(raw);
			if (!rows) continue;
			if (substantive) boundary = lastTodo;
			const matches = rows.filter(row => row.content === todo.content);
			const eligible = range ? index >= range.from && index <= range.to
				: !todo.key.startsWith("goal:") || todo.key.startsWith(`goal:${goal}:`);
			const row = eligible && matches.length === 1 ? matches[0] : undefined;
			const completed = row?.status === "completed" || row?.status === "abandoned";
			if (row?.status === "in_progress") open ??= index;
			else if (open !== undefined) { windows.push({ from: open, to: Math.min(index, range?.to ?? index), completed }); open = undefined; }
			else if (completed && !wasCompleted)
				windows.push({ from: Math.max(boundary, range?.from ?? 0), to: index, completed: true });
			wasCompleted = completed;
			lastTodo = index;
			substantive = false;
		}
		if (open !== undefined) windows.push({ from: open, to: range?.to ?? branch.length });
	}
	return windows;
}

function goalWindow(branch: readonly unknown[], target: { id: string; entryId?: string }) {
	let current: { id: string; from: number; to: number; complete: boolean } | undefined;
	let selected: typeof current, mode = "";
	for (const [index, raw] of branch.entries()) {
		if (!isRecord(raw) || raw.type !== "mode_change") continue;
		const goal = isRecord(raw.data) && isRecord(raw.data.goal) ? raw.data.goal : undefined;
		if (raw.mode === "none" && (mode === "goal" || mode === "goal_paused")) {
			if (current && !current.complete) current.to = index;
			if (current?.id === target.id && raw.id === target.entryId) selected = current;
			current = undefined;
		}
		mode = typeof raw.mode === "string" ? raw.mode : "goal";
		if (typeof goal?.id !== "string") continue;
		if (!current || current.id !== goal.id || (current.complete && goal.status !== "complete")) {
			if (current && !current.complete) current.to = index - 1;
			current = { id: goal.id, from: index, to: branch.length, complete: false };
		}
		if (goal.status === "complete" && !current.complete) { current.to = index; current.complete = true; }
		if (goal.id === target.id && (!target.entryId || raw.id === target.entryId)) selected = current;
	}
	return selected;
}

// A completed TODO locates work; it is not evidence that the work passed.
export function taskReviewEvidence(
	branch: readonly unknown[],
	task: Pick<ReviewTask, "id" | "nativeTodos"> & { nativeGoal?: { id: string; entryId?: string } },
	worker = false,
) {
	const evidence: Record<string, unknown>[] = [],
		decisions: Record<string, unknown>[] = [];
	const calls = new Map<string, Record<string, unknown>>();
	const jobs = new Map<string, { call?: Record<string, unknown>; settled: boolean; ambiguous: boolean }>();
	const seenJobs = new Set<string>();
	const registrations = new Map<string, { name: unknown }>();
	const seenCalls = new Set<string>();
	let ambiguousPending = 0;
	let active = worker,
		bytes = 0,
		omitted = 0,
		started = worker,
		failed = false,
		awaitingAnswer = false;
	const todos = task.nativeTodos ?? [];
	const goalRange = !worker && task.nativeGoal ? goalWindow(branch, task.nativeGoal) : undefined;
	const windows = !worker && !task.nativeGoal ? todoWindows(branch, todos, anchoredTodoRanges(branch, todos)) : [];
	let precedingDecision: Record<string, unknown> | undefined;
	const addDecision = (row: Record<string, unknown>) => {
		if (decisions.some(existing => existing.entryId === row.entryId)) return;
		if (Buffer.byteLength(JSON.stringify(row)) <= 4096 && decisions.length < 8) decisions.push(row);
		else omitted++;
	};
	// Keep the latest result, not just the first reads in a long implementation.
	// Any discarded evidence remains explicit and disables deterministic acceptance.
	const addEvidence = (row: Record<string, unknown>) => {
		row = boundedEvidence(row);
		const size = Buffer.byteLength(JSON.stringify(row));
		if (size > 8192) { omitted++; return; }
		while (evidence.length && (size + bytes > 24576 || evidence.length >= 24)) {
			bytes -= Buffer.byteLength(JSON.stringify(evidence.shift()));
			omitted++;
		}
		evidence.push(row);
		bytes += size;
	};
	for (const [index, raw] of branch.entries()) {
		if (!isRecord(raw)) continue;
		const entry = raw,
			data = isRecord(entry.data) ? entry.data : undefined;
		const message = entry.type === "message" && isRecord(entry.message) ? entry.message : undefined;
		if (message?.role === "user" && message.attribution !== "agent")
			precedingDecision = { entryId: entry.id, content: message.content };
		if (!worker) {
			const wasActive = active;
			active = task.nativeGoal ? !!goalRange && index >= goalRange.from && index <= goalRange.to
				: windows.some(window => index >= window.from && index <= window.to);
			if (active) started = true;
			if (active && !wasActive && precedingDecision) addDecision(precedingDecision);
			if (wasActive && !active) awaitingAnswer = task.nativeGoal ? goalRange?.complete === true
				: windows.some(window => window.to === index - 1 && window.completed);
		}
		// Only the closing turn supplies a final deliverable, not a later task.
		if (entry.type === "mode_change" && isRecord(data?.goal)) awaitingAnswer = false;
		if (entry.type === "custom_message" && entry.customType === "async-result" && isRecord(entry.details) && Array.isArray(entry.details.jobs)) {
			for (const job of entry.details.jobs) {
				if (!isRecord(job) || typeof job.jobId !== "string") continue;
				const registration = jobs.get(job.jobId);
				if (!registration) { seenJobs.add(job.jobId); continue; }
				if (!registration.call || registration.ambiguous) continue;
				const call = registration.call;
				registration.settled = true;
				const isError = job.status !== "completed" || (typeof job.exitCode === "number" && job.exitCode !== 0);
				failed ||= isError;
				const text = typeof job.result === "string" ? job.result : "";
				const content = clip(text, 4096);
				addEvidence({
					entryId: entry.id, call,
					result: { tool: call.name, content: [{ type: "text", text: content }], isError,
						details: { asyncComplete: true, jobId: job.jobId, status: job.status, exitCode: job.exitCode },
						...(content !== text ? { truncated: true } : {}) },
				});
			}
		}
		if (!message) continue;
		if (message.role === "user" && message.attribution !== "agent") awaitingAnswer = false;
		if (message.role === "assistant" && Array.isArray(message.content) && message.content.some(part =>
			isRecord(part) && part.type === "toolCall" && part.name !== "todo" && part.name !== "goal")) awaitingAnswer = false;
		if (message.role === "toolResult" && message.toolName !== "todo" && message.toolName !== "goal" &&
			!calls.has(String(message.toolCallId))) awaitingAnswer = false;
		const answer = awaitingAnswer && message.role === "assistant" && message.stopReason === "stop" &&
			Array.isArray(message.content) && !message.content.some(part => isRecord(part) && part.type === "toolCall");
		const closingFailure = awaitingAnswer && message.role === "assistant" &&
			(message.stopReason === "error" || message.stopReason === "aborted");
		if (answer || message.role === "assistant") awaitingAnswer = false;
		if (active && message.role === "user" && message.attribution !== "agent") {
			addDecision({ entryId: entry.id, content: message.content });
		}
		if (message.role === "assistant") {
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (!isRecord(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
				if (seenCalls.has(part.id)) {
					if (calls.delete(part.id)) ambiguousPending++;
					registrations.set(part.id, { name: undefined });
					if (active) { ambiguousPending++; omitted++; }
					continue;
				}
				seenCalls.add(part.id);
				if (active) {
					if (calls.size < 128) {
						const truncated = Buffer.byteLength(JSON.stringify(part)) > 4096;
						calls.set(part.id, { entryId: entry.id, ...part,
							...(truncated ? { arguments: clip(JSON.stringify(part.arguments) ?? "", 2048), truncated: true } : {}) });
					} else { omitted++; ambiguousPending++; }
				}
				registrations.set(part.id, { name: part.name });
			}
		}
		if ((active || answer || closingFailure) && message.role === "assistant") {
			for (const part of Array.isArray(message.content) ? message.content : []) {
				if (!isRecord(part)) continue;
				if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
					const text = clip(part.text, 2048);
					addEvidence({ entryId: entry.id, text, ...(text !== part.text ? { truncated: true } : {}) });
				}
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const row = {
					entryId: entry.id,
					failure: message.errorMessage,
					provider: message.provider,
					model: message.model,
				};
				failed = true;
				addEvidence(row);
			}
		}
		if (
			message.role !== "toolResult" ||
			typeof message.toolCallId !== "string" ||
			typeof message.toolName !== "string"
		)
			continue;
		// Observe sibling registrations too: a reused ID cannot settle pending owned work.
		const registration = registrations.get(message.toolCallId);
		registrations.delete(message.toolCallId);
		const call = calls.get(message.toolCallId);
		calls.delete(message.toolCallId);
		const details = isRecord(message.details) ? message.details : undefined;
		const asynchronous = isRecord(details?.async) ? details.async : undefined;
		const matched = registration?.name === message.toolName;
		if (asynchronous?.state === "running" && typeof asynchronous.jobId === "string") {
			const id = asynchronous.jobId, previous = jobs.get(id);
			const ambiguous = seenJobs.has(id);
			if (ambiguous && previous?.call && !previous.settled) { ambiguousPending++; omitted++; }
			if (ambiguous && call) { ambiguousPending++; omitted++; }
			seenJobs.add(id);
			jobs.set(id, { call: matched ? call : undefined, settled: false, ambiguous });
		}
		if (!call || !matched) {
			if (call) { ambiguousPending++; omitted++; }
			continue;
		}
		if (["todo", "goal", "foyer_tasks", "workflow_review", "workflow_next", "delegation_review"].includes(message.toolName)) continue;
		failed ||= message.isError === true;
		failed ||= typeof details?.exitCode === "number" && details.exitCode !== 0;
		const original = JSON.stringify(message.content);
		const content = Array.isArray(message.content)
			? message.content.map(part => isRecord(part) && part.type === "text" && typeof part.text === "string" ? { ...part, text: clip(part.text, 4096) } : part)
			: typeof message.content === "string" ? clip(message.content, 4096) : message.content;
		let row: Record<string, unknown> = {
			entryId: entry.id, call, result: {
				tool: message.toolName, content, isError: message.isError, details: message.details,
				...(JSON.stringify(content) !== original ? { truncated: true } : {}),
			},
		};
		if (Buffer.byteLength(JSON.stringify(row)) > 8192)
			row = { entryId: entry.id, call, result: { tool: message.toolName, content, isError: message.isError, truncated: true, details: { exitCode: details?.exitCode } } };
		addEvidence(row);
	}
	const state = {
		evidence,
		decisions,
		started,
		omitted,
		failed,
		pendingCalls: calls.size + ambiguousPending + [...jobs.values()].filter(job => job.call && !job.settled && !job.ambiguous).length,
		boundary:
			"Only captured calls and results during this task's native execution are included. TODO completion, review-tool output and model claims are not proof. Omitted or absent evidence cannot support acceptance.",
	};
	return { ...state, version: createHash("sha256").update(JSON.stringify(state)).digest("hex") };
}

async function restoreReviewEvidence(context: ReturnType<typeof taskReviewEvidence>, path: string, worker: boolean, signal?: AbortSignal) {
	const artifacts = new ArtifactManager(worker ? dirname(path) : path.slice(0, -6));
	const files = new Map<string, string>();
	const recover = async (text: string) => {
		const seen = new Set<string>();
		for (;;) {
			const reference = /^\[shaken ~\d+ tokens — recover: artifact:\/\/(\d+) \(region (\d+)\)\]$/.exec(text);
			if (!reference) return text;
			if (seen.has(text)) throw new Error("Review artifact contains a recovery cycle");
			seen.add(text);
			signal?.throwIfAborted();
			const [, id, region] = reference;
			let body = files.get(id);
			if (body === undefined) {
				const target = await artifacts.getPath(id);
				if (!target) throw new Error(`Review artifact ${id} is unavailable in its source session`);
				const before = await stat(target);
				if (!before.isFile() || before.size > 8 * 1024 * 1024) throw new Error(`Review artifact ${id} exceeds the recovery boundary`);
				body = await readFile(target, "utf8");
				const after = await stat(target);
				if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Review artifact changed during recovery");
				files.set(id, body);
			}
			const regions = [...body.matchAll(/^### region (\d+) \([^\r\n]*, ~\d+ tok\)\r?\n\r?\n/gm)];
			const index = regions.findIndex(match => match[1] === region);
			if (index < 0 || regions.filter(match => match[1] === region).length !== 1)
				throw new Error(`Review artifact ${id} has no unambiguous region ${region}`);
			const heading = regions[index];
			text = body.slice(heading.index! + heading[0].length, regions[index + 1]?.index ?? body.length).trimEnd();
		}
	};
	const evidence: Record<string, unknown>[] = [];
	let bytes = 0, omitted = context.omitted;
	for (const row of context.evidence) {
		const result = isRecord(row.result) ? row.result : undefined;
		let truncated = result?.truncated === true;
		const content = Array.isArray(result?.content) ? await Promise.all(result.content.map(async part => {
			if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return part;
			const restoredText = await recover(part.text);
			const text = clip(restoredText, 4096);
			truncated ||= text !== restoredText;
			return { ...part, text };
		})) : result?.content;
		const restored = boundedEvidence(result ? { ...row, result: { ...result, content, ...(truncated ? { truncated: true, originalContent: result.content } : {}) } } : row);
		const size = Buffer.byteLength(JSON.stringify(restored));
		if (size > 8192) { omitted++; continue; }
		while (evidence.length && size + bytes > 24576) {
			bytes -= Buffer.byteLength(JSON.stringify(evidence.shift()));
			omitted++;
		}
		evidence.push(restored);
		bytes += size;
	}
	const state = { ...context, evidence, omitted };
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
			const sourceTask = {
				id: task.id,
				nativeTodos: task.nativeTodos?.filter(todo => todo.sessionPath === path && todo.sessionId === expectedSession),
				nativeGoal: task.nativeGoal?.sessionPath === path && task.nativeGoal.sessionId === expectedSession ? task.nativeGoal : undefined,
			};
			const current = live?.();
			if (current?.sessionId === expectedSession && current.sessionPath === path) {
				contexts.push(await restoreReviewEvidence(taskReviewEvidence(current.branch, sourceTask), path, false, signal));
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
			contexts.push(await restoreReviewEvidence(taskReviewEvidence(cached.branch, sourceTask, workers.has(path)), path, workers.has(path), signal));
		}
		signal?.throwIfAborted();
		return {
			contexts,
			boundary:
				"A stored completed task is a review candidate, never automatic acceptance. Historical sessions are loaded read-only. Missing evidence must remain pending.",
		};
	};
}
