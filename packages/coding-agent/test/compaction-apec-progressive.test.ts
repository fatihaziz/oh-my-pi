import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	buildFactLedger,
	type CompactionSettings,
	computeMaxApecPrefixTokens,
	canExtendApecEpoch,
	DEFAULT_COMPACTION_SETTINGS,
	formatApecCombinedSummary,
	parseApecPrefixState,
	renderFactLedger,
	stripSegmentSuffixes,
	withApecPrefixPreserveData,
} from "@oh-my-pi/pi-agent-core/compaction";
import * as ai from "@oh-my-pi/pi-ai";
import type { AssistantMessage, Context, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	cfgCompactionExperimentalContextManagement,
	cfgCompactionExperimentalRollover,
	cfgCompactionModels,
	cfgCompactionProgressiveEnabled,
} from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { CompactionEntry, SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionMaintenance, type SessionMaintenanceHost } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function msgEntry(
	id: string,
	parentId: string | null,
	role: "user" | "assistant",
	text: string,
	ts: number,
): SessionEntry {
	const message: AgentMessage =
		role === "user"
			? ({ role: "user", content: [{ type: "text", text }], timestamp: ts } satisfies UserMessage)
			: ({
					role: "assistant",
					content: [{ type: "text", text }],
					api: "openai-codex-responses",
					provider: "openai-codex",
					model: "gpt-6.1-terra",
					stopReason: "stop",
					usage: {
						input: 1000,
						output: 100,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 1100,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: ts,
				} satisfies AssistantMessage);
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(ts).toISOString(),
		message,
	};
}

describe("APEC progressive replay and epoch consolidation", () => {
	it("keeps S1..S(k-1) bitwise identical across 3 compactions and consolidates on cap", () => {
		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			thresholdTokens: 477_000,
			keepRecentTokens: 177_000,
			progressiveEnabled: true,
		};
		const s1Text = "## Goal\nImplement feature X\n\n## Key Decisions\n- Keep auth in src/auth.ts";
		const s2Text = "## Findings\n- Added validator in src/val.ts";
		const s3Text = "## Findings\n- Verified tests pass";

		const t1 = "2026-11-13T01:00:00.000Z";
		const t2 = "2026-11-13T02:00:00.000Z";
		const t3 = "2026-11-13T03:00:00.000Z";

		const entriesBase: SessionEntry[] = [
			msgEntry("u1", null, "user", "Always use bun test before commit.", 1000),
			msgEntry("a1", "u1", "assistant", "Working on it", 2000),
			msgEntry("u2", "a1", "user", "Check src/auth.ts next", 3000),
		];
		const ledger1 = renderFactLedger(buildFactLedger(entriesBase, -1));
		const state1 = {
			epochId: "ep-1",
			segments: [{ id: "seg-1", summary: stripSegmentSuffixes(s1Text), timestamp: t1, tokens: 40 }],
		};
		const c1: CompactionEntry = {
			type: "compaction",
			id: "cmp1",
			parentId: "u2",
			timestamp: t1,
			summary: `${formatApecCombinedSummary(state1.segments)}\n\n${ledger1}`,
			firstKeptEntryId: "u2",
			tokensBefore: 100_000,
			method: "soft",
			preserveData: withApecPrefixPreserveData(undefined, state1),
		};

		const entriesAfter1 = [...entriesBase, c1];
		const ctx1 = convertToLlm(buildSessionContext(entriesAfter1, "cmp1", undefined, { transcript: false }).messages);

		const u3 = msgEntry("u3", "cmp1", "user", "Jangan pakai npm lagi.", 4000);
		const ledger2 = renderFactLedger(buildFactLedger([...entriesAfter1, u3], -1));
		const state2 = {
			epochId: "ep-1",
			segments: [
				...state1.segments,
				{ id: "seg-2", summary: stripSegmentSuffixes(s2Text), timestamp: t2, tokens: 40 },
			],
		};
		const c2: CompactionEntry = {
			type: "compaction",
			id: "cmp2",
			parentId: "u3",
			timestamp: t2,
			summary: `${formatApecCombinedSummary(state2.segments)}\n\n${ledger2}`,
			firstKeptEntryId: "u3",
			tokensBefore: 200_000,
			method: "soft",
			preserveData: withApecPrefixPreserveData(undefined, state2),
		};
		const entriesAfter2 = [...entriesAfter1, u3, c2];
		const ctx2 = convertToLlm(buildSessionContext(entriesAfter2, "cmp2", undefined, { transcript: false }).messages);

		const u4 = msgEntry("u4", "cmp2", "user", "Continue with tests", 5000);
		const ledger3 = renderFactLedger(buildFactLedger([...entriesAfter2, u4], -1));
		const state3 = {
			epochId: "ep-1",
			segments: [
				...state2.segments,
				{ id: "seg-3", summary: stripSegmentSuffixes(s3Text), timestamp: t3, tokens: 40 },
			],
		};
		const c3: CompactionEntry = {
			type: "compaction",
			id: "cmp3",
			parentId: "u4",
			timestamp: t3,
			summary: `${formatApecCombinedSummary(state3.segments)}\n\n${ledger3}`,
			firstKeptEntryId: "u4",
			tokensBefore: 300_000,
			method: "soft",
			preserveData: withApecPrefixPreserveData(undefined, state3),
		};
		const entriesAfter3 = [...entriesAfter2, u4, c3];
		const ctx3 = convertToLlm(buildSessionContext(entriesAfter3, "cmp3", undefined, { transcript: false }).messages);

		expect(ctx2[0]).toEqual(ctx1[0]);
		expect(ctx3[0]).toEqual(ctx1[0]);
		expect(ctx3[1]).toEqual(ctx2[1]);

		const transcriptCtx = buildSessionContext(entriesAfter3, "cmp3", undefined, {
			transcript: true,
			collapseCompactedHistory: true,
		});
		const compactionMsgs = transcriptCtx.messages.filter(m => m.role === "compactionSummary");
		expect(compactionMsgs.length).toBe(1);
		expect(compactionMsgs[0].role === "compactionSummary" ? compactionMsgs[0].summary : "").toContain(
			"### Segment 2",
		);

		const maxTokens = computeMaxApecPrefixTokens(settings.thresholdTokens!, 0.8, settings.keepRecentTokens, 16_384);
		expect(canExtendApecEpoch(state3, maxTokens)).toBe(true);
		const oversizedState = {
			epochId: "ep-1",
			segments: [{ id: "seg-1", summary: "big", timestamp: t1, tokens: maxTokens }],
		};
		expect(canExtendApecEpoch(oversizedState, maxTokens)).toBe(false);
		expect(parseApecPrefixState({ apecPrefix: { broken: true } })).toBeUndefined();
	});
});

describe("experimentalContextManagement routing and Hydrogen->Terra->Opus candidate chain", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessionManager: SessionManager;
	let agent: Agent;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("openai-codex", "codex-key");
		authStorage.keys.setRuntime("google-antigravity", "antigravity-key");
		authStorage.keys.setRuntime("anthropic", "anthropic-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
	});

	it("keeps history://current/full active while routing compaction through soft summarization and fallback models", async () => {
		const terraModel = getBundledModel("openai-codex", "gpt-5.6-sol")!;
		const hydrogenModel = getBundledModel("google-antigravity", "gemini-4-hydrogen") ?? terraModel;
		const opusModel = getBundledModel("anthropic", "claude-opus-5-5") ?? terraModel;

		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.experimentalContextManagement": true,
			"compaction.experimentalRollover": false,
			"compaction.progressiveEnabled": true,
			"compaction.methodOrder": ["soft", "handoff", "remote"],
			"compaction.models": [
				`${hydrogenModel.provider}/${hydrogenModel.id}`,
				`${terraModel.provider}/${terraModel.id}`,
				`${opusModel.provider}/${opusModel.id}`,
			],
			"compaction.thresholdTokens": 477_000,
			"compaction.keepRecentTokens": 1,
			"compaction.autoContinue": false,
		});

		expect(cfgCompactionExperimentalContextManagement.get(settings)).toBe(true);
		expect(cfgCompactionExperimentalRollover.get(settings)).toBe(false);
		expect(cfgCompactionProgressiveEnabled.get(settings)).toBe(true);
		expect(cfgCompactionModels.get(settings).length).toBe(3);

		agent = new Agent({ initialState: { model: terraModel, systemPrompt: ["Sys"], tools: [], messages: [] } });
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Always verify tests before push. ".repeat(20) }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Understood." }],
			api: terraModel.api,
			provider: terraModel.provider,
			model: terraModel.id,
			stopReason: "stop",
			usage: {
				input: 1000,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1050,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Next message" }],
			timestamp: Date.now(),
		});

		const fullResource = await InternalUrlRouter.instance().resolve("history://current/full", {
			experimentalContextManagement: true,
			getSessionBranch: () => sessionManager.getBranch(),
		});
		expect(fullResource.content).toContain("Always verify tests before push.");

		const seenModels: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (m: Model) => {
			seenModels.push(`${m.provider}/${m.id}`);
			if (seenModels.length === 1 && hydrogenModel.id !== terraModel.id) {
				throw new Error("429 Too Many Requests: usage limit reached");
			}
			return {
				role: "assistant",
				content: [{ type: "text", text: "## Goal\nVerify tests\n\n## Next Steps\n1. Run bun test" }],
				api: m.api,
				provider: m.provider,
				model: m.id,
				stopReason: "stop",
				usage: {
					input: 200,
					output: 40,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 240,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
		});

		const host = {
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: undefined,
			sideStreamFn: async () => {
				throw new Error("unexpected sideStreamFn");
			},
			providerSessionState: new Map(),
			preferWebsockets: () => undefined,
			model: () => terraModel,
			thinkingLevel: () => undefined,
			isDisposed: () => false,
			isStreaming: () => false,
			isGeneratingHandoff: () => false,
			promptGeneration: () => 0,
			hasExperimentalContextRolloverTools: () => true,
			takeExperimentalContextRolloverRequest: () => false,
			queueExperimentalContextNotesReminder: () => {},
			sessionId: () => sessionManager.getSessionId(),
			messages: () => agent.state.messages,
			baseSystemPrompt: () => ["Sys"],
			goalModeState: () => undefined,
			planReferencePath: () => "",
			nonMessageTokenSource: () => ({}),
			memoryBackendSession: () => undefined,
			emitSessionEvent: async () => {},
			emitNotice: () => {},
			scheduleAgentContinue: () => {},
			scheduleCompactionContinuation: () => false,
			persistTurnMessagesForMidRunCompaction: async () => true,
			findLastAssistantMessage: () => undefined,
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			drainStrandedQueuedMessages: () => {},
			buildDisplaySessionContext: () => sessionManager.buildSessionContext(),
			replaceMessagesFromSessionContext: (messages: AgentMessage[]) => agent.replaceMessages(messages),
			persistEvalStateContext: () => {},
			convertToLlmForSideRequest: (messages: AgentMessage[]) => convertToLlm(messages),
			buildLiveProviderContext: async (): Promise<Context> => ({ messages: [] }),
			obfuscateTextForProvider: (text: string | undefined) => text,
			obfuscatePreparationForProvider: <T>(preparation: T) => preparation,
			getPromptCacheKeyForModel: () => undefined,
			closeCodexProviderSessionsForHistoryRewrite: () => {},
			resetCodexProviderAfterCompaction: () => {},
			resetPlanReference: () => {},
			syncTodoPhasesFromBranch: () => {},
			resetAdvisorRuntimes: () => {},
			rebaseAfterCompaction: () => {},
			recordAnchoredHistoryRewrite: () => {},
			getContextBreakdown: () => undefined,
			getContextUsage: () => undefined,
			shake: async () => ({ modified: false, tokensRemoved: 0 }),
			dropImages: async () => ({ removed: 0 }),
			generateHandoffDocument: async () => undefined,
			removeAssistantMessageFromActiveContext: () => {},
			dropPersistedAssistantTurn: async () => undefined,
			runRecoveryCompactionWithRollback: async () => ({ continuationScheduled: false }),
			parseRetryAfterMsFromError: () => undefined,
			setModelTemporary: async () => {},
			abort: async () => {},
			abortHandoff: () => {},
		} as unknown as SessionMaintenanceHost;

		const maintenance = new SessionMaintenance(host);
		const candidates = maintenance.resolveCompactionModelCandidates(terraModel, modelRegistry.getAvailable());
		expect(candidates[0]?.id).toBe(hydrogenModel.id);

		await maintenance.runAutoCompaction("threshold", false, { explicitNewContextRequest: true });
		const latestCompaction = sessionManager
			.getBranch()
			.findLast((e): e is CompactionEntry => e.type === "compaction");
		expect(latestCompaction).toBeDefined();
		expect(latestCompaction?.summary).toContain("<ledger>");
		expect(latestCompaction?.summary).toContain("Always verify tests before push.");
		expect(parseApecPrefixState(latestCompaction?.preserveData)?.segments.length).toBe(1);
		if (hydrogenModel.id !== terraModel.id) {
			expect(seenModels[0]).toBe(`${hydrogenModel.provider}/${hydrogenModel.id}`);
			expect(seenModels).toContain(`${terraModel.provider}/${terraModel.id}`);
		}
	});
});
