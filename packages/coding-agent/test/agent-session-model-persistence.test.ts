import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, type Context, Effort, type ImageContent, type Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EPHEMERAL_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { registerHostedModelRouting, type HostedModelRoutingDecision } from "@oh-my-pi/pi-coding-agent/session/hosted-model-routing";
import { setModelRequestPolicy } from "@oh-my-pi/pi-ai/model-request-policy";
import { SessionMaintenance } from "@oh-my-pi/pi-coding-agent/session/session-maintenance";
import { encodeRawPng } from "@oh-my-pi/pi-coding-agent/utils/png-encode";
import { AUTO_THINKING, resolveProvisionalAutoLevel } from "@oh-my-pi/pi-tui/thinking";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { createAssistantMessage } from "./helpers/agent-session-setup";

describe("AgentSession model persistence", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let sessionSettings: Settings;
	// Auth storage (SQLite DB) and the model registry are immutable across these tests:
	// every test sets the same anthropic/zai runtime keys and only ever reads the bundled model
	// list. Building them once avoids ~12 SQLite opens + registry constructions.
	let sharedDir: TempDir;
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-persistence-shared-");
		sharedAuthStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		sharedAuthStorage.keys.setRuntime("anthropic", "test-key");
		sharedAuthStorage.keys.setRuntime("zai", "test-key");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		sharedAuthStorage.close();
		sharedDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-model-persistence-");
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		tempDir.removeSync();
	});

	function getAnthropicModelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function modelValue(model: Model<Api>): string {
		return `${model.provider}/${model.id}`;
	}

	async function writeRoleModelSession(
		defaultRoleValue: string,
		smolRoleValue: string,
		lastRole = "smol",
	): Promise<string> {
		const targetSessionFile = path.join(tempDir.path(), `target-${Bun.nanoseconds()}.jsonl`);
		const timestamp = "2026-06-01T00:00:00.000Z";
		await Bun.write(
			targetSessionFile,
			`${[
				{ type: "session", version: 3, id: "target-session", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "default-model",
					parentId: null,
					timestamp,
					model: defaultRoleValue,
					role: "default",
				},
				{
					type: "model_change",
					id: "smol-model",
					parentId: "default-model",
					timestamp,
					model: smolRoleValue,
					role: lastRole,
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		return targetSessionFile;
	}
	async function createSession(options?: {
		initialModel?: Model<Api>;
		selectInitialModel?: (availableModels: Model<Api>[]) => Model<Api>;
		modelRoles?: Record<string, string>;
		persist?: boolean;
	}): Promise<{ modelRegistry: ModelRegistry; settings: Settings; session: AgentSession }> {
		const modelRegistry = sharedModelRegistry;
		const model =
			options?.initialModel ??
			options?.selectInitialModel?.(modelRegistry.getAvailable()) ??
			getAnthropicModelOrThrow("claude-sonnet-4-5");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});

		sessionSettings = Settings.isolated();
		const modelRoles = options?.modelRoles;
		if (modelRoles) {
			for (const role in modelRoles) {
				const modelRoleValue = modelRoles[role];
				if (modelRoleValue !== undefined) {
					sessionSettings.setModelRole(role, modelRoleValue);
				}
			}
		}
		session = new AgentSession({
			agent,
			sessionManager: options?.persist
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active"))
				: SessionManager.inMemory(),
			settings: sessionSettings,
			modelRegistry,
		});

		return { modelRegistry, settings: sessionSettings, session };
	}

	async function createStartupResumeSession(
		targetSessionFile: string,
		settings: Settings = Settings.isolated(),
	): Promise<CreateAgentSessionResult> {
		const sessionManager = await SessionManager.open(targetSessionFile, path.join(tempDir.path(), "startup"));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		return result;
	}
	it("switches the active model without persisting by default", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
		});
		let modelChangedCount = 0;
		created.session.subscribe(event => {
			if (event.type === "model_changed") modelChangedCount++;
		});

		await created.session.setModel(nextModel);

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(modelChangedCount).toBe(1);

		await created.session.setModel(nextModel);
		expect(modelChangedCount).toBe(1);
	});

	it("persists the default role when explicitly requested", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		await created.session.setModel(nextModel, "default", { persist: true });

		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("switches the active model even when the live context is over the target window", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const nextModel = getAnthropicModelOrThrow("claude-sonnet-4-6");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: modelValue(defaultModel) },
		});

		const targetWindow = nextModel.contextWindow ?? 0;
		expect(targetWindow).toBeGreaterThan(0);

		const result = await created.session.setModel(nextModel, "default", { persist: true });

		expect(result).toEqual({ switched: true });
		expect(created.session.model?.id).toBe(nextModel.id);
		expect(created.settings.getModelRole("default")).toBe(modelValue(nextModel));
	});

	it("cycles role models without rewriting configured roles", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = `${modelValue(slowModel)}:high`;

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const result = await created.session.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model.id).toBe(slowModel.id);
		expect(created.session.model?.id).toBe(slowModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles role models backward from the current role", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const slowModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const slowRoleValue = modelValue(slowModel);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: {
				default: defaultRoleValue,
				slow: slowRoleValue,
			},
		});

		const forward = await created.session.cycleRoleModels(["default", "slow"], "forward");
		const backward = await created.session.cycleRoleModels(["default", "slow"], "backward");

		expect(forward?.role).toBe("slow");
		expect(backward?.role).toBe("default");
		expect(created.session.model?.id).toBe(defaultModel.id);
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
		expect(created.settings.getModelRole("slow")).toBe(slowRoleValue);
	});

	it("cycles available models without persisting the default role", async () => {
		const created = await createSession({
			selectInitialModel: availableModels => {
				if (availableModels.length <= 1 || !availableModels[0]) {
					throw new Error("Expected at least two available models");
				}
				return availableModels[0];
			},
		});
		const initialModel = created.session.model;
		if (!initialModel) throw new Error("Expected initial model to be set");
		const defaultRoleValue = modelValue(initialModel);
		created.settings.setModelRole("default", defaultRoleValue);

		const result = await created.session.cycleModel();

		if (!result) throw new Error("Expected cycleModel to return a new model");
		expect(modelValue(result.model)).not.toBe(defaultRoleValue);
		const activeModel = created.session.model;
		if (!activeModel) throw new Error("Expected active model after cycleModel");
		expect(modelValue(activeModel)).toBe(modelValue(result.model));
		expect(created.settings.getModelRole("default")).toBe(defaultRoleValue);
	});

	it("restores the last active role model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);

		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue, smol: smolRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(smolModel.id);
	});

	it("restores the last active role model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const smolModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const smolRoleValue = modelValue(smolModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, smolRoleValue);

		const result = await createStartupResumeSession(targetSessionFile);

		expect(result.session.model?.id).toBe(smolModel.id);
	});

	it("falls back to the saved default model when switch-session role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const previousModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");

		const created = await createSession({
			initialModel: previousModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when switch-session last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);

		const created = await createSession({
			initialModel: fallbackModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(defaultModel.id);
	});

	it("falls back to the saved default model when startup role restore is unavailable", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settingsFallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, "anthropic/not-loaded-anymore");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(settingsFallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores the saved default model when startup last role is fallback", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const fallbackModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(
			defaultRoleValue,
			modelValue(fallbackModel),
			EPHEMERAL_MODEL_CHANGE_ROLE,
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(fallbackModel));

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
	});

	it("restores a temporary model when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");

		const created = await createSession({
			initialModel: defaultModel,
			modelRoles: { default: defaultRoleValue },
			persist: true,
		});

		await expect(created.session.switchSession(targetSessionFile)).resolves.toBe(true);
		expect(created.session.model?.id).toBe(temporaryModel.id);
	});

	it("restores a temporary model during startup resume", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const temporaryModel = getAnthropicModelOrThrow("claude-sonnet-4-6");
		const defaultRoleValue = modelValue(defaultModel);
		const targetSessionFile = await writeRoleModelSession(defaultRoleValue, modelValue(temporaryModel), "temporary");
		const settings = Settings.isolated();
		settings.setModelRole("default", defaultRoleValue);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(temporaryModel.id);
	});

	it("activates auto thinking on startup resume when modelRoles.default carries an explicit :auto suffix", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const targetSessionFile = await writeRoleModelSession(
			modelValue(defaultModel),
			modelValue(defaultModel),
			"default",
		);
		const settings = Settings.isolated();
		settings.setModelRole("default", `${modelValue(defaultModel)}:auto`);

		const result = await createStartupResumeSession(targetSessionFile, settings);

		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(result.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
	});

	it("keeps DEFAULT-role auto thinking on a fresh session when the model declares defaultLevel (#16370)", async () => {
		const model = getBundledModel("zai", "glm-5.3");
		if (!model) throw new Error("Expected zai/glm-5.3 to exist");
		expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		// The /model hub stores DEFAULT-role `auto` as a bare role plus `defaultThinkingLevel: auto`.
		const settings = Settings.isolated({ defaultThinkingLevel: AUTO_THINKING });
		settings.setModelRole("default", modelValue(model));
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "fresh-auto")),
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;

		expect(result.session.model?.id).toBe(model.id);
		expect(result.session.configuredThinkingLevel()).toBe(AUTO_THINKING);
		expect(result.session.thinkingLevel).toBe(resolveProvisionalAutoLevel(model));
		expect(result.session.thinkingLevel).not.toBe(Effort.Max);
	});

	it("marks an incomplete process-exit transcript aborted during SDK resume without dropping history", async () => {
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted"));
		const interruptedAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "state.txt" } }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendMessage(interruptedAssistant);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "preserved partial result" }],
			isError: false,
			timestamp: Date.now(),
		});
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected interrupted session file");

		const result = await createStartupResumeSession(sessionFile);
		const messages = result.session.sessionManager.buildSessionContext({ transcript: true }).messages;
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [],
			stopReason: "aborted",
			errorMessage: "Previous OMP process exited before completing the turn.",
		});
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.content.some(part => part.type === "text" && part.text === "preserved partial result"),
			),
		).toBe(true);
		expect(messages.filter(message => message.role === "assistant" && message.stopReason === "aborted")).toHaveLength(
			1,
		);
	});

	it("marks a first user-message process-exit tail aborted with the selected model", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "interrupted-user"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		sessionManager.appendMessage({ role: "user", content: "inspect state", timestamp: Date.now() });
		sessionManager.appendCustomEntry("session_exit", {
			reason: "exit",
			kind: "process_exit",
			recordedAt: "2026-07-11T02:20:08.800Z",
		});
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage: sharedAuthStorage,
			modelRegistry: sharedModelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = result.session;
		expect(result.session.model?.id).toBe(defaultModel.id);
		expect(
			result.session.sessionManager
				.getBranch()
				.find(entry => entry.type === "message" && entry.message.role === "assistant"),
		).toMatchObject({
			type: "message",
			message: {
				role: "assistant",
				api: defaultModel.api,
				provider: defaultModel.provider,
				model: defaultModel.id,
				stopReason: "aborted",
			},
		});
	});

	/** A valid 800x500 RGB PNG of noise deflate cannot shrink: ~1.6 MB of base64, decodable by the send path's image checks. */
	function framePng(seed: number): string {
		const pixels = new Uint32Array((800 * 500 * 3) / 4);
		let state = seed;
		for (let i = 0; i < pixels.length; i++) {
			// xorshift32, so every run encodes the same bytes.
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			pixels[i] = state;
		}
		return encodeRawPng(new Uint8Array(pixels.buffer), 800, 500, 3).toString("base64");
	}

	/** Appends a 4.8 MB three-frame archive: over the 3 MB default, inside half of Anthropic's 24 MB inline-image budget. */
	function appendFrameArchive(sessionManager: SessionManager, firstKeptEntryId: string): void {
		const frame = (seed: number) => ({
			data: framePng(seed),
			mimeType: "image/png",
			cols: 8,
			rows: 8,
			chars: 8,
		});
		sessionManager.appendCompaction("Archived history.", "archive", firstKeptEntryId, 150_000, {
			preserveData: {
				[snapcompact.PRESERVE_KEY]: {
					frames: [frame(0x40), frame(0x80), frame(0xc0)],
					totalChars: 24,
					truncatedChars: 0,
				},
			},
		});
	}

	function archiveImages(messages: readonly AgentMessage[]): number {
		const summary = messages.find(message => message.role === "compactionSummary");
		if (summary?.role !== "compactionSummary") throw new Error("Expected a restored compaction summary");
		return summary.blocks?.filter(block => block.type === "image").length ?? 0;
	}

	/** Resumes a session whose archive was compacted on the official Anthropic API. */
	async function resumeArchivedSession(
		authStorage: AuthStorage,
		modelRegistry: ModelRegistry,
	): Promise<CreateAgentSessionResult> {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const settings = Settings.isolated();
		settings.setModelRole("default", modelValue(defaultModel));
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "archived"));
		sessionManager.appendModelChange(modelValue(defaultModel));
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "continue",
			timestamp: Date.now(),
		});
		appendFrameArchive(sessionManager, firstKeptEntryId);
		return createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			sessionManager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
	}

	it("restores a snapcompact archive at the resumed model's frame payload budget", async () => {
		const result = await resumeArchivedSession(sharedAuthStorage, sharedModelRegistry);
		session = result.session;

		expect(archiveImages(result.session.messages)).toBe(3);
	});

	/** Switches a session archived on the official Anthropic API to `target`, then returns the archive frames of its next request. */
	async function archiveFramesAfterSwitch(
		target: Model<Api>,
		switchModel: (session: AgentSession, target: Model<Api>) => Promise<unknown>,
	): Promise<ImageContent[]> {
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			for (const provider of ["anthropic", "openrouter", "amazon-bedrock"]) {
				authStorage.keys.setRuntime(provider, "test-key");
			}
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const result = await resumeArchivedSession(authStorage, modelRegistry);
			session = result.session;
			const summary = session.messages.find(message => message.role === "compactionSummary");

			await switchModel(session, target);
			let request: Context | undefined;
			session.agent.streamFn = (_model, context) => {
				request = context;
				const stream = new AssistantMessageEventStream();
				const message = createAssistantMessage("done");
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			await session.agent.continue();

			// The agent keeps the archive it was built with; only the request is capped.
			expect(session.messages.find(message => message.role === "compactionSummary")).toBe(summary);
			const requestSummary = request?.messages.find(
				message => message.role === "user" && message.historyRewriteAt !== undefined,
			);
			if (requestSummary?.role !== "user" || !Array.isArray(requestSummary.content)) {
				throw new Error("Expected the archive summary in the request");
			}
			return requestSummary.content.filter((block): block is ImageContent => block.type === "image");
		} finally {
			await session?.dispose();
			session = undefined;
			authStorage.close();
		}
	}

	it.each([
		["setModel", getBundledModel("openrouter", "anthropic/claude-sonnet-4.5")],
		["setModelTemporary", getBundledModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")],
	] as const)(
		"after %s from the official Anthropic API to a host without a byte budget, the next request carries only the newest archive frame",
		async (switchPath, target) => {
			const frames = await archiveFramesAfterSwitch(target, (active, model) =>
				switchPath === "setModel"
					? active.setModel(model)
					: active.setModelTemporary(model, undefined, { ephemeral: true }),
			);

			expect(frames).toHaveLength(1);
			expect(frames.reduce((bytes, frame) => bytes + frame.data.length, 0)).toBeLessThanOrEqual(
				snapcompact.DEFAULT_FRAME_DATA_BYTES_BUDGET,
			);
		},
	);

	it("keeps every archive frame in the next request after a switch between official Anthropic models", async () => {
		const frames = await archiveFramesAfterSwitch(
			getAnthropicModelOrThrow("claude-sonnet-4-5-20250929"),
			(active, model) => active.setModel(model),
		);

		expect(frames).toHaveLength(3);
	});

	it.each([
		["a proxy to the official Anthropic API", "anthropic-proxy", "anthropic", 3],
		["the official Anthropic API to a proxy", "anthropic", "anthropic-proxy", 1],
	] as const)(
		"switching sessions from %s installs the archive at the resumed model's frame payload budget",
		async (_, fromProvider, toProvider, frames) => {
			const modelsPath = path.join(tempDir.path(), "models.yml");
			await Bun.write(
				modelsPath,
				`providers:
  anthropic-proxy:
    api: anthropic-messages
    baseUrl: https://anthropic-proxy.example.com
    apiKey: test-key
    models:
      - id: claude-sonnet-4-5
        input: [text, image]
        contextWindow: 200000
        maxTokens: 64000
`,
			);
			const modelRegistry = new ModelRegistry(sharedAuthStorage, modelsPath);
			const findModel = (provider: string): Model<Api> => {
				const model = modelRegistry.find(provider, "claude-sonnet-4-5");
				if (!model) throw new Error(`Expected ${provider}/claude-sonnet-4-5`);
				return model;
			};
			const targetModel = findModel(toProvider);
			const target = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "target"));
			target.appendModelChange(modelValue(targetModel));
			const firstKeptEntryId = target.appendMessage({ role: "user", content: "continue", timestamp: Date.now() });
			target.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				api: targetModel.api,
				provider: targetModel.provider,
				model: targetModel.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			});
			appendFrameArchive(target, firstKeptEntryId);
			await target.flush();
			const targetFile = target.getSessionFile();
			if (!targetFile) throw new Error("Expected target session file");
			session = new AgentSession({
				agent: new Agent({
					initialState: {
						model: findModel(fromProvider),
						systemPrompt: ["Test"],
						tools: [],
						messages: [],
						thinkingLevel: Effort.Medium,
					},
				}),
				sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "active")),
				settings: Settings.isolated(),
				modelRegistry,
			});

			await expect(session.switchSession(targetFile)).resolves.toBe(true);

			expect(session.model?.provider).toBe(toProvider);
			expect(archiveImages(session.messages)).toBe(frames);
		},
	);

	it("marks an interrupted first turn aborted when switching sessions", async () => {
		const defaultModel = getAnthropicModelOrThrow("claude-sonnet-4-5");
		const created = await createSession({ initialModel: defaultModel, persist: true });
		const targetFile = path.join(tempDir.path(), "switch-interrupted-user.jsonl");
		const timestamp = "2026-07-11T02:20:08.800Z";
		await Bun.write(
			targetFile,
			`${[
				{ type: "session", version: 3, id: "switch-target", timestamp, cwd: tempDir.path() },
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp,
					model: modelValue(defaultModel),
				},
				{
					type: "message",
					id: "user",
					parentId: "model",
					timestamp,
					message: { role: "user", content: "inspect state", timestamp: Date.parse(timestamp) },
				},
				{
					type: "custom",
					id: "exit",
					parentId: "user",
					timestamp,
					customType: "session_exit",
					data: { reason: "exit", kind: "process_exit", recordedAt: timestamp },
				},
			]
				.map(entry => JSON.stringify(entry))
				.join("\n")}\n`,
		);

		await expect(created.session.switchSession(targetFile)).resolves.toBe(true);

		expect(created.session.sessionManager.buildSessionContext({ transcript: true }).messages.at(-1)).toMatchObject({
			role: "assistant",
			api: defaultModel.api,
			provider: defaultModel.provider,
			model: defaultModel.id,
			stopReason: "aborted",
		});
	});

	it("lists restorable temporary model before the default fallback", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					temporary: "anthropic/claude-sonnet-4-6",
				},
				"temporary",
			),
		).toEqual(["anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-5"]);
	});

	it("lists only the default model for ephemeral fallback restores", () => {
		expect(
			getRestorableSessionModels(
				{
					default: "anthropic/claude-sonnet-4-5",
					[EPHEMERAL_MODEL_CHANGE_ROLE]: "anthropic/claude-sonnet-4-6",
				},
				EPHEMERAL_MODEL_CHANGE_ROLE,
			),
		).toEqual(["anthropic/claude-sonnet-4-5"]);
	});
	describe("hosted routing", () => {
		const fingerprint = "a".repeat(64);
		const diagnostics = { coldInputTokens: 0, lastCacheReadTokens: null, switchPenalty: 5, scoreAdvantage: 30, cacheHitRatio: 1, unknowns: [], scores: [], learningRevision: "fixture" };
		let unregister: (() => void) | undefined;
		const originalFetch = globalThis.fetch;
		beforeEach(() => {
			globalThis.fetch = Object.assign(async () => { throw new Error("Real provider transport is forbidden in hosted routing fixtures"); }, { preconnect() {} }) as typeof fetch;
			setModelRequestPolicy(async () => {});
		});
		afterEach(() => { unregister?.(); unregister = undefined; setModelRequestPolicy(undefined); globalThis.fetch = originalFetch; });

		it("selects before the first provider snapshot, preserves settings, and does not reroute a continuation", async () => {
			const { session, settings } = await createSession();
			const target = getAnthropicModelOrThrow("claude-sonnet-4-6");
			let calls = 0;
			unregister = registerHostedModelRouting(session.sessionId, async input => {
				calls++;
				return { kind: "switch", boundaryId: input.boundaryId, policyFingerprint: fingerprint, selector: modelValue(target),
					thinking: Effort.High, reason: "Fixture capability advantage.", categoryWeights: { implementation: 1 }, diagnostics };
			});
			session.updateHostedModelRoutingPolicy({ profileId: 1, policyFingerprint: fingerprint, mode: "auto", executionAuto: true, executionStopped: false });
			const selected: string[] = [];
			session.agent.streamFn = (model) => {
				selected.push(modelValue(model));
				expect(session.thinkingLevel).toBe(Effort.High);
				const stream = new AssistantMessageEventStream();
				const message = { ...createAssistantMessage("done"), provider: model.provider, model: model.id };
				if(selected.length===1){message.content=[{type:"toolCall",id:"fixture-read",name:"absent_fixture_tool",arguments:{}}];message.stopReason="toolUse";}
				stream.push({ type: "done", reason: selected.length === 1 ? "toolUse" : "stop", message }); stream.end(message); return stream;
			};
			const previous = settings.getModelRole("default");
			await session.prompt("Implement this local fixture.");
			expect(selected).toEqual([modelValue(target), modelValue(target)]);
			expect(calls).toBe(1);
			expect(settings.getModelRole("default")).toBe(previous);
			expect(session.getHostedModelRoutingState().mode).toBe("auto");
		});

		it.each(["manual", "effort", "stop", "policy", "disconnect", "abort"] as const)("rejects a late decision after %s", async action => {
			const { session } = await createSession();
			const initial = session.model!;
			const target = getAnthropicModelOrThrow("claude-sonnet-4-6");
			const waiting = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let acknowledged = 0;
			session.subscribeHostedModelRouting((_state,decision)=>{if(decision)acknowledged++;});
			unregister = registerHostedModelRouting(session.sessionId, async input => {
				waiting.resolve(); await release.promise;
				return { kind: "switch", boundaryId: input.boundaryId, policyFingerprint: fingerprint, selector: modelValue(target),
					thinking: Effort.High, reason: "Late fixture.", categoryWeights: { implementation: 1 }, diagnostics };
			});
			const policy = { profileId: 1, policyFingerprint: fingerprint, mode: "auto" as const, executionAuto: true, executionStopped: false };
			session.updateHostedModelRoutingPolicy(policy);
			session.agent.streamFn = model => {
				expect(modelValue(model)).toBe(modelValue(initial));
				const stream = new AssistantMessageEventStream(); const message=createAssistantMessage("done");
				stream.push({type:"done",reason:"stop",message});stream.end(message);return stream;
			};
			const running = session.prompt("Run the offline boundary.").catch(error=>{if(action!=="abort")throw error;});
			await waiting.promise;
			if(action==="manual")await session.setModelTemporary(initial);
			if(action==="effort")session.setThinkingLevel(Effort.Low);
			if(action==="stop")session.updateHostedModelRoutingPolicy({...policy,executionStopped:true});
			if(action==="policy")session.updateHostedModelRoutingPolicy({...policy,policyFingerprint:"b".repeat(64)});
			if(action==="disconnect"){unregister();unregister=undefined;session.disconnectHostedModelRouting();}
			const abort=action==="abort"?session.abort():undefined;
			release.resolve();await running;await abort;
			expect(session.model?.id).toBe(initial.id);
			expect(acknowledged).toBe(0);
			if(action==="manual"||action==="effort")expect(session.getHostedModelRoutingState().mode).toBe("pinned");
		});

		it("keeps a same-model manual pin while automatic metadata is awaiting", async () => {
			const {session,modelRegistry,settings}=await createSession();
			const initial=session.model!,target=getAnthropicModelOrThrow("claude-sonnet-4-6");
			const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
			const original=modelRegistry.refreshSelectedModelMetadata.bind(modelRegistry);
			const metadata=spyOn(modelRegistry,"refreshSelectedModelMetadata").mockImplementation(async model=>{
				if(model.id===target.id){entered.resolve();await release.promise;}
				return original(model);
			});
			unregister=registerHostedModelRouting(session.sessionId,async input=>({kind:"switch",boundaryId:input.boundaryId,policyFingerprint:fingerprint,selector:modelValue(target),thinking:Effort.High,reason:"metadata race",categoryWeights:{implementation:1},diagnostics}));
			session.updateHostedModelRoutingPolicy({profileId:1,policyFingerprint:fingerprint,mode:"auto",executionAuto:true,executionStopped:false});
			const dispatched:string[]=[];
			session.agent.streamFn=model=>{
				dispatched.push(modelValue(model));
				const stream=new AssistantMessageEventStream(),message={...createAssistantMessage("done"),provider:model.provider,model:model.id};
				stream.push({type:"done",reason:"stop",message});stream.end(message);return stream;
			};
			const before=settings.getModelRole("default");
			try{
				const running=session.prompt("Route this fixture.");
				await entered.promise;
				await session.setModelTemporary(initial);
				release.resolve();await running;
				expect(dispatched).toEqual([modelValue(initial)]);
				expect(session.getHostedModelRoutingState().mode).toBe("pinned");
				expect(settings.getModelRole("default")).toBe(before);
				expect(session.sessionManager.getBranch().some(entry=>entry.type==="custom"&&entry.customType==="foyer:model-routing-decision")).toBe(false);
			}finally{release.resolve();metadata.mockRestore();}
		});

		it.each(["effort","stop"] as const)("does not publish stale automatic state after %s during reconciliation",async action=>{
			const {session}=await createSession();
			const target=getAnthropicModelOrThrow("claude-sonnet-4-6");
			const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
			let held=false,acknowledged=0;
			const original=SessionMaintenance.prototype.renderArchiveForModel;
			const archive=spyOn(SessionMaintenance.prototype,"renderArchiveForModel").mockImplementation(async function(this: SessionMaintenance, messages){
				if(!held&&session.model?.id===target.id){held=true;entered.resolve();await release.promise;}
				return original.call(this,messages);
			});
			unregister=registerHostedModelRouting(session.sessionId,async input=>({kind:"switch",boundaryId:input.boundaryId,policyFingerprint:fingerprint,selector:modelValue(target),thinking:Effort.High,reason:"reconciliation race",categoryWeights:{implementation:1},diagnostics}));
			const policy={profileId:1,policyFingerprint:fingerprint,mode:"auto" as const,executionAuto:true,executionStopped:false};
			session.updateHostedModelRoutingPolicy(policy);
			session.subscribeHostedModelRouting((_state,decision)=>{if(decision)acknowledged++;});
			session.agent.streamFn=model=>{
				const stream=new AssistantMessageEventStream(),message={...createAssistantMessage("done"),provider:model.provider,model:model.id};
				stream.push({type:"done",reason:"stop",message});stream.end(message);return stream;
			};
			const before=session.configuredThinkingLevel();
			try{
				const running=session.prompt("Route this fixture.");
				await entered.promise;
				if(action==="effort")session.setThinkingLevel(Effort.Low);else session.updateHostedModelRoutingPolicy({...policy,executionStopped:true});
				release.resolve();await running;
				expect(session.configuredThinkingLevel()).toBe(action==="effort"?Effort.Low:before);
				expect(acknowledged).toBe(0);
				expect(session.sessionManager.getBranch().some(entry=>entry.type==="custom"&&entry.customType==="foyer:model-routing-decision")).toBe(false);
			}finally{release.resolve();archive.mockRestore();}
		});

		it("retains the warm cache and transport for an unchanged route",async()=>{
			const {session}=await createSession();
			const initial=session.model!,thinking=session.configuredThinkingLevel()??"off";
			let closed=0;
			const transport={close(){closed++;}};
			session.providerSessionState.set(`anthropic:${initial.provider}`,transport);
			session.agent.promptCacheKey="fixture-warm-cache";
			unregister=registerHostedModelRouting(session.sessionId,async input=>({kind:"switch",boundaryId:input.boundaryId,policyFingerprint:fingerprint,selector:modelValue(initial),thinking,reason:"same route",categoryWeights:{implementation:1},diagnostics}));
			session.updateHostedModelRoutingPolicy({profileId:1,policyFingerprint:fingerprint,mode:"auto",executionAuto:true,executionStopped:false});
			session.agent.streamFn=model=>{
				expect(session.agent.promptCacheKey).toBe("fixture-warm-cache");
				const stream=new AssistantMessageEventStream(),message={...createAssistantMessage("done"),provider:model.provider,model:model.id};
				stream.push({type:"done",reason:"stop",message});stream.end(message);return stream;
			};
			await session.prompt("Continue on the same route.");
			expect(closed).toBe(0);
			expect(session.providerSessionState.get(`anthropic:${initial.provider}`)).toBe(transport);
		});

		it("blocks an undersized target before dispatch",async()=>{
			const {session,modelRegistry}=await createSession();
			const initial=session.model!,target=getAnthropicModelOrThrow("claude-sonnet-4-6");
			const original=modelRegistry.find.bind(modelRegistry);
			const find=spyOn(modelRegistry,"find").mockImplementation((provider,id)=>id===target.id?{...target,contextWindow:1}:original(provider,id));
			unregister=registerHostedModelRouting(session.sessionId,async input=>({kind:"switch",boundaryId:input.boundaryId,policyFingerprint:fingerprint,selector:modelValue(target),thinking:Effort.High,reason:"undersized fixture",categoryWeights:{implementation:1},diagnostics}));
			session.updateHostedModelRoutingPolicy({profileId:1,policyFingerprint:fingerprint,mode:"auto",executionAuto:true,executionStopped:false});
			let dispatched=0;session.agent.streamFn=()=>{dispatched++;throw Error("Undersized model reached provider");};
			try{
				await session.prompt("This context cannot fit in one token.").catch(()=>{});
				expect(dispatched).toBe(0);
				expect(session.model?.id).toBe(initial.id);
				expect(session.getHostedModelRoutingState().state).toBe("blocked");
			}finally{find.mockRestore();}
		});

		it("restores an explicit pin without restoring execution authority",async()=>{
			const {session}=await createSession();
			session.sessionManager.appendCustomEntry("foyer:model-routing-mode",{mode:"pinned"});
			unregister=registerHostedModelRouting(session.sessionId,async()=>{throw Error("A restored pin cannot auto-route");});
			session.updateHostedModelRoutingPolicy({profileId:1,policyFingerprint:fingerprint,mode:"auto",executionAuto:false,executionStopped:true});
			expect(session.getHostedModelRoutingState()).toMatchObject({mode:"pinned",executionAuto:false,executionStopped:true});
			session.setHostedModelRoutingMode("auto");
			expect(session.sessionManager.getBranch().filter(entry=>entry.type==="custom"&&entry.customType==="foyer:model-routing-mode").at(-1)).toMatchObject({data:{mode:"auto"}});
		});

		it("rejects a pending decision when switching the session",async()=>{
			const {session}=await createSession({persist:true});
			const target=getAnthropicModelOrThrow("claude-sonnet-4-6"),initial=session.model!;
			const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),aborted=Promise.withResolvers<void>();
			unregister=registerHostedModelRouting(session.sessionId,async(input,signal)=>{
				signal?.addEventListener("abort",()=>aborted.resolve(),{once:true});entered.resolve();await release.promise;
				return {kind:"switch",boundaryId:input.boundaryId,policyFingerprint:fingerprint,selector:modelValue(target),thinking:Effort.High,reason:"late session",categoryWeights:{implementation:1},diagnostics};
			});
			session.updateHostedModelRoutingPolicy({profileId:1,policyFingerprint:fingerprint,mode:"auto",executionAuto:true,executionStopped:false});
			session.agent.streamFn=()=>{throw Error("Switched session dispatched stale work");};
			const file=await writeRoleModelSession(modelValue(initial),modelValue(initial),"default");
			const running=session.prompt("Switch before routing completes.").catch(()=>{});
			await entered.promise;
			const switching=session.switchSession(file);
			await aborted.promise;release.resolve();await running;await switching;
			expect(session.sessionManager.getSessionFile()).toBe(file);
			expect(session.model?.id).toBe(initial.id);
			expect(session.getHostedModelRoutingState().state).toBe("offline");
			expect(session.sessionManager.getBranch().some(entry=>entry.type==="custom"&&entry.customType==="foyer:model-routing-decision")).toBe(false);
		});

		it("Use Auto does not resume stopped execution or execution Auto OFF", async () => {
			const { session } = await createSession();
			let calls=0;
			unregister=registerHostedModelRouting(session.sessionId,async input=>{
				calls++;
				return {kind:"retain",boundaryId:input.boundaryId,policyFingerprint:fingerprint,reason:"retain",categoryWeights:{implementation:1},diagnostics} satisfies HostedModelRoutingDecision;
			});
			session.updateHostedModelRoutingPolicy({profileId:1,policyFingerprint:fingerprint,mode:"manual",executionAuto:false,executionStopped:true});
			session.setHostedModelRoutingMode("auto");
			expect(session.getHostedModelRoutingState()).toMatchObject({mode:"auto",executionAuto:false,executionStopped:true});
			expect(session.getHostedModelRoutingState().pending).toBeUndefined();
			expect(calls).toBe(0);
		});
	});
});
