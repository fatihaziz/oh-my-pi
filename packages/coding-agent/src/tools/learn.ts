import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { sanitizeSkillName, writeManagedSkill } from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import { isHindsightConfigured, loadHindsightConfig } from "../hindsight/config";
import { localBackend } from "../memory-backend/local-backend";
import learnDescription from "../prompts/tools/learn.md" with { type: "text" };
import type { ToolSession } from ".";

import { cfgAutolearnEnabled } from "../autolearn/settings";
import { cfgSkillsEnabled } from "../extensibility/settings";
import { cfgMemoryBackend } from "../memory-backend/settings";
import { isGlobalMemoryScopeAvailable } from "../mnemopi/settings";

const learnSkillSchema = type({
	action: "'create' | 'update'",
	name: type("string").describe("kebab-case skill name"),
	description: type("string").describe("one-line description of when to use the skill"),
	body: type("string").describe("the SKILL.md body in markdown (no frontmatter)"),
}).describe("also create or enhance a managed skill in the same call");

const learnSchemaBase = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"skill?": learnSkillSchema,
});

/** Offered only where a shared bank exists; see {@link isGlobalMemoryScopeAvailable}. */
const learnSchemaWithScope = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"scope?": type("'project' | 'global'").describe(
		"storage scope; defaults to project, global is for durable cross-project knowledge",
	),
	"skill?": learnSkillSchema,
});
const learnMemoryOnly = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
});
const learnMemoryWithScope = type({
	memory: type("string").describe("the durable, self-contained lesson to remember (what, when, why)"),
	"context?": type("string").describe("optional source context for the lesson"),
	"scope?": type("'project' | 'global'").describe("storage scope; defaults to project"),
});


type LearnSchema = typeof learnSchemaBase | typeof learnSchemaWithScope | typeof learnMemoryOnly | typeof learnMemoryWithScope;

export type LearnParams = typeof learnSchemaWithScope.infer;

/**
 * Orchestrating "learn" tool: persists a lesson to long-term memory and,
 * given a `skill` payload, mints/enhances a managed skill via the shared
 * `writeManagedSkill` primitive. Gated behind `autolearn.enabled` plus a live
 * memory backend — `hindsight`/`mnemopi` (remote/SQLite) or `local` (the
 * file-based rollout backend, where lessons append to `learned.md`).
 */
export class LearnTool implements AgentTool<LearnSchema> {
	readonly name = "learn";
	/** A global lesson reaches every project's recall, so it needs the same approval as a file write. */
	readonly approval = (args: unknown) => {
		const params = args as Partial<LearnParams>;
		return params.skill || params.scope === "global" || cfgMemoryBackend.get(this.session.settings) === "local"
			? "write"
			: "read";
	};
	readonly label = "Learn";
	get description(): string {
		return prompt.render(learnDescription, { globalScope: isGlobalMemoryScopeAvailable(this.session.settings), skills: cfgSkillsEnabled.get(this.session.settings) });
	}
	get parameters(): LearnSchema {
		const global = isGlobalMemoryScopeAvailable(this.session.settings);
		return cfgSkillsEnabled.get(this.session.settings)
			? (global ? learnSchemaWithScope : learnSchemaBase)
			: (global ? learnMemoryWithScope : learnMemoryOnly);
	}
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Capture a reusable lesson to memory (and optionally a managed skill)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): LearnTool | null {
		if (!cfgAutolearnEnabled.get(session.settings)) return null;
		const backend = cfgMemoryBackend.get(session.settings);
		if (backend !== "hindsight" && backend !== "mnemopi" && backend !== "local") return null;
		if (backend === "hindsight" && !isHindsightConfigured(loadHindsightConfig(session.settings))) return null;
		return new LearnTool(session);
	}

	async execute(_id: string, params: LearnParams, signal?: AbortSignal): Promise<AgentToolResult> {
		if (params.skill && !cfgSkillsEnabled.get(this.session.settings)) {
			throw new Error("Skills are disabled; managed skills cannot be created or updated.");
		}
		const parentMemory = this.session.getParentServices?.()?.memory;
		if (parentMemory) return parentMemory.executeTool(this.name, _id, params, this.session, signal);
		// 1) Persist or queue the lesson to long-term memory (mirrors MemoryRetainTool).
		const backend = cfgMemoryBackend.get(this.session.settings);
		if (params.scope === "global" && backend !== "mnemopi") {
			throw new Error("Global memory scope is only available with the Mnemopi backend.");
		}
		let memoryMessage = "Lesson stored";
		if (backend === "mnemopi") {
			const state = this.session.getMnemopiSessionState?.();
			if (!state) {
				throw new Error("Mnemopi backend is not initialised for this session.");
			}
			// Resolve the target before writing, so an unsupported scoping mode is not reported as a storage failure.
			const target = params.scope === "global" ? state.getGlobalRetainTarget() : undefined;
			// A failed write throws (closed DB / disk error). Fail loudly with the
			// cause rather than reporting (and minting a skill for) a lesson that was
			// never stored.
			try {
				state.rememberScoped(
					params.memory,
					{
						source: "coding-agent-learn",
						importance: 0.8,
						metadata: {
							session_id: this.session.getSessionId?.() ?? state.sessionId,
							cwd: this.session.cwd,
							context: params.context ?? null,
							tool: "learn",
						},
						scope: "bank",
						extract: true,
						extractEntities: true,
						veracity: "tool",
						memoryType: "fact",
					},
					target,
				);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new Error(`Mnemopi did not store the lesson: ${reason}`, { cause: error });
			}
		} else if (backend === "local") {
			const result = await localBackend.save?.(
				{ agentDir: this.session.settings.getAgentDir(), cwd: this.session.cwd },
				{ content: params.memory, context: params.context, source: "coding-agent-learn", importance: 0.8 },
			);
			if (!result || result.stored === 0) {
				throw new Error("Lesson was empty after sanitization; nothing stored.");
			}
		} else {
			const state = this.session.getHindsightSessionState?.();
			if (!state) {
				throw new Error("Hindsight backend is not initialised for this session.");
			}
			state.enqueueRetain(params.memory, params.context);
			memoryMessage = "Lesson queued for retention";
		}

		// 2) Optionally mint/enhance a managed skill. A failure here is surfaced
		// as a partial outcome — the lesson is already stored or queued.
		if (params.skill) {
			// A managed skill resolves below any authored skill of the same name, so
			// minting one under a claimed name writes a file that never surfaces. The
			// lesson is already stored/queued; refuse the skill rather than report a
			// false "Created" (mirrors ManageSkillTool).
			let safeSkillName: string | undefined;
			try {
				safeSkillName = sanitizeSkillName(params.skill.name);
			} catch {
				safeSkillName = undefined;
			}
			if (params.skill.action === "create" && safeSkillName && isNameClaimedByAuthoredSkill(safeSkillName)) {
				return {
					content: [
						{
							type: "text",
							text: `${memoryMessage}. Did not create managed skill "${params.skill.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
						},
					],
					isError: true,
					details: { skill: null, shadowed: true },
				};
			}
			try {
				await writeManagedSkill(params.skill);
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(`${memoryMessage}, but the managed skill could not be written: ${reason}`);
			}
			const verb = params.skill.action === "create" ? "Created" : "Updated";
			try {
				await this.session.refreshSkills?.();
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				throw new Error(
					`${memoryMessage}. ${verb} managed skill "${params.skill.name}", but refreshing session skills failed: ${reason}`,
				);
			}
			return {
				content: [{ type: "text", text: `${memoryMessage}. ${verb} managed skill "${params.skill.name}".` }],
				details: { skill: params.skill.name },
			};
		}

		return {
			content: [{ type: "text", text: `${memoryMessage}.` }],
			details: { skill: null },
		};
	}
}
