import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTaskReviewReader, taskReviewEvidence } from "../src/task/review-evidence";

const content = "Verify delivery";
const hash = createHash("sha256").update(`content:${content}`).digest("hex");
const goal = (id: string) => ({ type: "mode_change", mode: "goal", data: { goal: { id, status: "active" } } });
const todo = (id: string, status: string, present = true) => ({ id, type: "custom", customType: "user_todo_edit", data: { phases: [{ tasks: present ? [{ content, status }] : [] }] } });
const proof = (id: string, isError = false) => [
	{ id: `call-${id}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: "verify delivery" } }] } },
	{ id: `result-${id}`, type: "message", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: isError ? "verification failed" : "delivery verified" }], isError } },
];
const user = { id: "request", type: "message", message: { role: "user", content: [{ type: "text", text: "Verify the delivered package; do not install it." }] } };
const task = { id: "review", nativeTodos: [{ key: `goal:later:${hash}`, content, entryId: "anchor" }] };

test("carried completed TODOs retain their actual execution and preceding user instruction", () => {
	const branch = [goal("original"), user, todo("start", "in_progress"), ...proof("owned"), todo("finish", "completed"), goal("later"), todo("anchor", "completed"), ...proof("unrelated")];
	const result = taskReviewEvidence(branch, task);
	expect(result.evidence.map(row => row.entryId)).toEqual(["result-owned"]);
	expect(result.decisions).toEqual([{ entryId: "request", content: user.message.content }]);
	expect(result.started).toBe(true);
	expect(taskReviewEvidence(branch, { ...task, nativeTodos: [{ ...task.nativeTodos[0], entryId: "missing" }] }).evidence).toEqual([]);
	expect(taskReviewEvidence(branch, { ...task, nativeTodos: [{ ...task.nativeTodos[0], key: "goal:later:forged" }] }).evidence).toEqual([]);
});

test("a removed or restarted occurrence cannot borrow earlier same-title success", () => {
	for (const boundary of [todo("removed", "completed", false), todo("restart", "pending")]) {
		const branch = [goal("original"), todo("start", "in_progress"), ...proof("old"), todo("finish", "completed"), goal("later"), boundary, todo("anchor", "completed")];
		expect(taskReviewEvidence(branch, task).evidence).toEqual([]);
	}
});

test("captured failures survive provenance recovery and completion never supplies proof", () => {
	const branch = [goal("original"), todo("start", "in_progress"), ...proof("failure", true), todo("finish", "completed"), goal("later"), todo("anchor", "completed")];
	expect(taskReviewEvidence(branch, task).evidence).toEqual([{ entryId: "result-failure", call: { entryId: "call-failure", ...proof("failure", true)[0].message.content[0] }, result: { tool: "bash", content: proof("failure", true)[1].message.content, isError: true, details: undefined } }]);
	expect(taskReviewEvidence([goal("later"), todo("anchor", "completed")], task).evidence).toEqual([]);
});

test("Goal reviews retain the request that preceded Goal creation", () => {
	const result = taskReviewEvidence([user, goal("original"), ...proof("owned")], { id: "goal-review", nativeGoal: { id: "original" } });
	expect(result.decisions).toEqual([{ entryId: "request", content: user.message.content }]);
});

test("historical review restores the exact session artifact region and refuses missing recovery", async () => {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(resolve("tmp/review-evidence-"));
	try {
		const path = resolve(root, "source.jsonl");
		await mkdir(path.slice(0, -6));
		await writeFile(resolve(path.slice(0, -6), "7.shake.log"), [
			"### region 1 (tool result, ~10 tok)\n\nVerification failed: missing executable",
			`### region 2 (tool result, ~3000 tok)\n\n${"y".repeat(6000)}`,
		].join("\n"));
		const rows = [...proof("archived", true), ...proof("archived-large", true)];
		rows[1].message.content = [{ type: "text", text: "[shaken ~10 tokens — recover: artifact://7 (region 1)]" }];
		rows[3].message.content = [{ type: "text", text: "[shaken ~3000 tokens — recover: artifact://7 (region 2)]" }];
		const branch = [goal("original"), todo("start", "in_progress"), ...rows, todo("finish", "completed"), goal("later"), todo("anchor", "completed")];
		const reader = createTaskReviewReader(() => ({ sessionId: "source", sessionPath: path, branch }));
		const input = { ...task, nativeTodos: [{ ...task.nativeTodos[0], sessionId: "source", sessionPath: path }] };
		const recovered = await reader(input);
		expect(recovered.contexts[0]).toMatchObject({ evidence: [
			{ result: { isError: true, content: [{ type: "text", text: "Verification failed: missing executable" }] } },
			{ result: { truncated: true, originalContent: [{ type: "text", text: "[shaken ~3000 tokens — recover: artifact://7 (region 2)]" }] } },
		] });
		expect(JSON.stringify(recovered.contexts[0])).not.toContain("y".repeat(6000));
		await rm(resolve(path.slice(0, -6), "7.shake.log"));
		await expect(reader(input)).rejects.toThrow("unavailable in its source session");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
const rowTool = (row: Record<string, unknown>): unknown =>
	row.result && typeof row.result === "object" && "tool" in row.result ? row.result.tool : undefined;
const rowTruncated = (row: Record<string, unknown>): unknown =>
	row.result && typeof row.result === "object" && "truncated" in row.result ? row.result.truncated : undefined;
test("captures completed work windows without in_progress and keeps oversized results clipped", () => {
	const ordinary = taskReviewEvidence([
		todo("init", "pending"),
		{ id: "work", type: "message", message: { role: "assistant", content: [{ type: "text", text: "Running work" }] } },
		...proof("closed"),
		todo("finish", "completed"),
	], { id: "closed", nativeTodos: [{ key: "todo:closed", content }] });
	expect(ordinary.started).toBe(true);
	expect(ordinary.evidence.map(row => row.text ?? rowTool(row))).toEqual(["Running work", "bash"]);
	const largeRows = proof("large");
	largeRows[1].message.content = [{ type: "text", text: "x".repeat(20000) }];
	const large = taskReviewEvidence([
		todo("start", "in_progress"),
		...largeRows,
		todo("finish", "completed"),
	], { id: "large", nativeTodos: [{ key: "todo:large", content }] });
	expect(large.evidence).toHaveLength(1);
	expect(rowTruncated(large.evidence[0])).toBe(true);
	expect(large.omitted).toBe(0);
});

test("retains latest evidence and reports omissions, failures, and unresolved calls", () => {
	const branch: unknown[] = [todo("start", "in_progress")];
	for (let i = 0; i < 26; i++) branch.push(...proof(`latest-${i}`, i === 0));
	branch.push(todo("finish", "completed"));
	const retained = taskReviewEvidence(branch, { id: "latest", nativeTodos: [{ key: "todo:latest", content }] });
	expect(retained.evidence).toHaveLength(24);
	expect(retained.evidence[0].entryId).toBe("result-latest-2");
	expect(retained.evidence.at(-1)?.entryId).toBe("result-latest-25");
	expect(retained.omitted).toBe(2);
	expect(retained.failed).toBe(true);

	const pending = taskReviewEvidence([
		todo("start", "in_progress"),
		{ id: "pending-call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "pending-id", name: "bash", arguments: {} }] } },
		todo("finish", "completed"),
	], { id: "pending", nativeTodos: [{ key: "todo:pending", content }] });
	expect(pending.pendingCalls).toBe(1);
});

test("pairs async results and captures the final answer after a TODO closes", () => {
	const branch = [
		todo("start", "in_progress"),
		{ id: "async-call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "async-call-id", name: "bash", arguments: { command: "verify" } }] } },
		{ id: "async-start", type: "message", message: { role: "toolResult", toolCallId: "async-call-id", toolName: "bash", isError: false, details: { async: { state: "running", jobId: "job-1" } }, content: [{ type: "text", text: "started" }] } },
		{ id: "async-done", type: "custom_message", customType: "async-result", details: { jobs: [{ jobId: "job-1", status: "completed", exitCode: 0, result: "verified" }] } },
		todo("finish", "completed"),
		{ id: "answer", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Verification is complete." }] } },
	];
	const result = taskReviewEvidence(branch, { id: "async", nativeTodos: [{ key: "todo:async", content }] });
	expect(result.pendingCalls).toBe(0);
	expect(result.failed).toBe(false);
	expect(result.evidence).toContainEqual(expect.objectContaining({
		entryId: "async-done",
		result: expect.objectContaining({ tool: "bash", details: expect.objectContaining({ asyncComplete: true, jobId: "job-1" }) }),
	}));
	expect(result.evidence).toContainEqual({ entryId: "answer", text: "Verification is complete." });
});

const asyncStart = (id: string, jobId = "shared") => [
	{ id: `call-${id}`, type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: {} }] } },
	{ id: `registered-${id}`, type: "message", message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [], details: { async: { state: "running", jobId } } } },
];
const settlement = (id: string, status = "completed", jobId = "shared") => ({
	id, type: "custom_message", customType: "async-result", details: { jobs: [{ jobId, status, exitCode: status === "completed" ? 0 : 1, result: status }] },
});
const finalAnswer = { id: "final", type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Delivered explanation" }] } };
const plainTask = { id: "plain", nativeTodos: [{ key: "todo:plain", content }] };

test("anchored occurrences stop at their snapshot and cannot borrow a reopened sibling", () => {
	const branch = [todo("start", "in_progress"), ...proof("first"), todo("anchor", "completed"),
		todo("restart", "in_progress"), ...proof("second"), todo("second-end", "completed")];
	const first = { id: "first", nativeTodos: [{ key: `content:${content}`, content, entryId: "anchor" }] };
	expect(taskReviewEvidence(branch, first).evidence.map(row => row.entryId)).toEqual(["result-first"]);
	const second = { id: "second", nativeTodos: [{ key: `content:${content}:occurrence:restart`, content, entryId: "second-end" }] };
	expect(taskReviewEvidence(branch, second).evidence.map(row => row.entryId)).toEqual(["result-second"]);
	expect(taskReviewEvidence(branch, { ...second, nativeTodos: [{ ...second.nativeTodos[0], key: `content:${content}:occurrence:anchor` }] }).started).toBe(false);
});

test("each TODO window excludes sibling-only work and duplicate titles are ambiguous", () => {
	const snapshot = (id: string, own: string, sibling: string) => ({ id, type: "custom", customType: "user_todo_edit", data: { phases: [{ tasks: [
		{ content, status: own }, { content: "Sibling", status: sibling },
	] }] } });
	const branch = [snapshot("start", "in_progress", "pending"), ...proof("owned"), snapshot("anchor", "completed", "in_progress"), ...proof("sibling"), snapshot("end", "completed", "completed")];
	expect(taskReviewEvidence(branch, { id: "one", nativeTodos: [{ key: `content:${content}`, content, entryId: "anchor" }] }).evidence.map(row => row.entryId)).toEqual(["result-owned"]);
	const duplicate = { id: "anchor", type: "custom", customType: "user_todo_edit", data: { phases: [{ tasks: [{ content, status: "completed" }, { content, status: "completed" }] }] } };
	expect(taskReviewEvidence([todo("start", "in_progress"), ...proof("ambiguous"), duplicate], { id: "one", nativeTodos: [{ key: `content:${content}`, content, entryId: "anchor" }] }).started).toBe(false);
});

test("batched completions retain shared work and explanation-only delivery", () => {
	const secondContent = "Explain delivery";
	const snapshot = (id: string, first: string, second: string) => ({ id, type: "custom", customType: "user_todo_edit", data: { phases: [{ tasks: [{ content, status: first }, { content: secondContent, status: second }] }] } });
	const branch = [snapshot("pending", "pending", "pending"), ...proof("batch"), snapshot("first", "completed", "pending"), snapshot("second", "completed", "completed"), finalAnswer];
	const result = taskReviewEvidence(branch, { id: "batch", nativeTodos: [{ key: `content:${secondContent}`, content: secondContent, entryId: "second" }] });
	expect(result.evidence.map(row => row.entryId)).toEqual(["result-batch", "final"]);
	expect(taskReviewEvidence([todo("start", "in_progress"), finalAnswer, todo("end", "completed")], plainTask).evidence).toEqual([{ entryId: "final", text: "Delivered explanation" }]);
});

test("Goal entry fences select only the named execution, not later reused IDs", () => {
	const start = { ...goal("same"), id: "first-goal" };
	const complete = { id: "first-complete", type: "mode_change", mode: "goal", data: { goal: { id: "same", status: "complete" } } };
	const branch = [start, ...proof("first"), complete, { ...goal("same"), id: "second-goal" }, ...proof("second")];
	expect(taskReviewEvidence(branch, { id: "goal", nativeGoal: { id: "same", entryId: "first-complete" } }).evidence.map(row => row.entryId)).toEqual(["result-first"]);
	expect(taskReviewEvidence(branch, { id: "goal", nativeGoal: { id: "same", entryId: "missing" } }).started).toBe(false);
	expect(taskReviewEvidence([start, complete, { type: "mode_change", mode: "none" }, finalAnswer], { id: "goal", nativeGoal: { id: "same", entryId: "first-complete" } }).evidence).toEqual([{ entryId: "final", text: "Delivered explanation" }]);
});

test("post-close async settlement survives interruption and late failure stays failed", () => {
	const result = taskReviewEvidence([todo("start", "in_progress"), ...asyncStart("owned"),
		{ id: "abort", type: "message", message: { role: "assistant", stopReason: "aborted", content: [], errorMessage: "Interrupted" } },
		todo("end", "completed"), settlement("success"), settlement("late-failure", "failed")], plainTask);
	expect(result.pendingCalls).toBe(0);
	expect(result.failed).toBe(true);
	expect(result.evidence.map(row => row.entryId)).toContain("late-failure");
	const pending = taskReviewEvidence([todo("start", "in_progress"), ...asyncStart("owned"), todo("end", "completed")], plainTask);
	expect(pending.pendingCalls).toBe(1);
});

test("transcript-wide async ID collisions never settle owned work with sibling results", () => {
	for (const before of [true, false]) {
		const branch = before
			? [...asyncStart("sibling"), todo("start", "in_progress"), ...asyncStart("owned"), todo("end", "completed"), settlement("wrong")]
			: [todo("start", "in_progress"), ...asyncStart("owned"), todo("end", "completed"), ...asyncStart("sibling"), settlement("wrong")];
		const result = taskReviewEvidence(branch, plainTask);
		expect(result.evidence.map(row => row.entryId)).not.toContain("wrong");
		expect(result.pendingCalls).toBeGreaterThan(0);
		expect(result.omitted).toBeGreaterThan(0);
	}
	const reused = taskReviewEvidence([todo("start", "in_progress"), ...asyncStart("owned"), settlement("first"), todo("end", "completed"), ...asyncStart("sibling"), settlement("wrong")], plainTask);
	expect(reused.evidence.map(row => row.entryId)).not.toContain("wrong");
	expect(reused.pendingCalls).toBe(0);
	expect(reused.omitted).toBe(0);
	const repeated = taskReviewEvidence([todo("start", "in_progress"), ...asyncStart("owned"), ...asyncStart("owned"), settlement("wrong"), todo("end", "completed")], plainTask);
	expect(repeated.evidence.map(row => row.entryId)).not.toContain("wrong");
	expect(repeated.pendingCalls).toBeGreaterThan(0);
});

test("unrelated work, user turns, Goal changes and removal invalidate closing answers", () => {
	for (const unrelated of [[...proof("sibling")], [user], [goal("other")]]) {
		const result = taskReviewEvidence([todo("start", "in_progress"), ...proof("owned"), todo("end", "completed"), ...unrelated, finalAnswer], plainTask);
		expect(result.evidence.map(row => row.entryId)).not.toContain("final");
	}
	expect(taskReviewEvidence([todo("start", "in_progress"), todo("removed", "pending", false), finalAnswer], plainTask).evidence).toEqual([]);
});

test("reader filters every TODO anchor by exact source and rejects source-less projected summaries", async () => {
	await mkdir("tmp", { recursive: true });
	const root = await mkdtemp(resolve("tmp/review-source-"));
	try {
		const first = resolve(root, "first.jsonl"), second = resolve(root, "second.jsonl");
		const firstBranch = [todo("first-start", "in_progress"), ...proof("first"), todo("first-end", "completed")];
		const secondBranch = [todo("second-start", "in_progress"), ...proof("second"), todo("second-end", "completed")];
		await writeFile(second, [
			{ type: "session", version: 3, id: "second", timestamp: "2026-10-15T00:00:00.000Z", cwd: root },
			...secondBranch.map((row, index) => ({ ...row, parentId: index ? secondBranch[index - 1].id : null, timestamp: "2026-10-15T00:00:00.000Z" })),
		].map(row => JSON.stringify(row)).join("\n") + "\n");
		const reader = createTaskReviewReader(() => ({ sessionId: "first", sessionPath: first, branch: firstBranch }));
		const result = await reader({ id: "sources", nativeTodos: [
			{ key: `content:${content}`, content, entryId: "first-end", sessionId: "first", sessionPath: first },
			{ key: `content:${content}`, content, entryId: "second-end", sessionId: "second", sessionPath: second },
		] });
		expect(result.contexts).toHaveLength(2);
		expect(result.contexts[0]).toMatchObject({ evidence: [{ entryId: "result-first" }] });
		expect(result.contexts[1]).toMatchObject({ evidence: [{ entryId: "result-second" }] });
		const projected = await reader({ id: "projected", nativeGoal: { id: "missing", entryId: "missing", sessionId: "first", sessionPath: first }, nativeTodos: [{ key: "todo:summary", content }] });
		expect(projected.contexts[0]).toMatchObject({ started: false, evidence: [] });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("recurrence suffix preserves its initial Goal base across scope changes and carried terminal snapshots", () => {
	const branch = [goal("original"), todo("initial", "in_progress"), ...proof("old"), todo("closed", "completed"),
		goal("later"), todo("restart", "blocked"), todo("working", "in_progress"), ...proof("new"), todo("finished", "completed"),
		goal("carried"), todo("anchor", "completed")];
	const result = taskReviewEvidence(branch, { id: "recur", nativeTodos: [{ key: `goal:original:${hash}:occurrence:restart`, content, entryId: "anchor" }] });
	expect(result.evidence.map(row => row.entryId)).toEqual(["result-new"]);
});

test("Goal exit fences work while plan exit preserves its enclosing Goal scope", () => {
	const drop = { id: "drop", type: "mode_change", mode: "none" };
	const result = taskReviewEvidence([goal("owned"), ...proof("owned"), drop, ...proof("unrelated"), finalAnswer],
		{ id: "dropped", nativeGoal: { id: "owned", entryId: "drop" } });
	expect(result.evidence.map(row => row.entryId)).toEqual(["result-owned"]);
	for (const plan of [false, true]) {
		const branch = [goal("owned"), todo("first", "in_progress"), ...proof("old"),
			...(plan ? [{ type: "mode_change", mode: "plan" }] : []), drop,
			todo("second", "in_progress"), ...proof("new"), todo("anchor", "completed")];
		const key = plan ? `goal:owned:${hash}` : `content:${content}:occurrence:second`;
		expect(taskReviewEvidence(branch, { id: "scope", nativeTodos: [{ key, content, entryId: "anchor" }] }).evidence.map(row => row.entryId))
			.toEqual(plan ? ["result-old", "result-new"] : ["result-new"]);
	}
});

test("large paired evidence remains bounded and failures remain visible", () => {
	const result = taskReviewEvidence([todo("start", "in_progress"),
		{ id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "large", name: "bash", arguments: { command: "x".repeat(12000) } }] } },
		{ id: "result", type: "message", message: { role: "toolResult", toolCallId: "large", toolName: "bash", isError: true, details: { exitCode: 9 },
			content: [{ type: "text", text: "failure ".repeat(2000) }, { type: "text", text: "output ".repeat(2000) }] } },
		todo("end", "completed")], plainTask);
	expect(result.omitted).toBe(0);
	expect(result.pendingCalls).toBe(0);
	expect(result.failed).toBe(true);
	expect(result.evidence).toEqual([expect.objectContaining({ entryId: "result", truncated: true,
		call: expect.objectContaining({ id: "large", entryId: "call", truncated: true }),
		result: expect.objectContaining({ isError: true, truncated: true, details: expect.objectContaining({ exitCode: 9 }) }),
	})]);
	expect(Buffer.byteLength(JSON.stringify(result.evidence[0]))).toBeLessThanOrEqual(8192);
});

test("an interrupted closing answer remains a failed deliverable", () => {
	for (const stopReason of ["aborted", "error"]) {
		const interrupted = { id: "interrupted-answer", type: "message", message: { role: "assistant", content: [], stopReason, errorMessage: "Delivery interrupted" } };
		const result = taskReviewEvidence([todo("start", "in_progress"), ...proof("owned"), todo("end", "completed"), interrupted], plainTask);
		expect(result.failed).toBe(true);
		expect(result.evidence).toContainEqual(expect.objectContaining({ entryId: "interrupted-answer", failure: "Delivery interrupted" }));
	}
});
