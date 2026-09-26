import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { context, propagation } from "@opentelemetry/api";
import { all as allSettings } from "../config/registry";
import { Settings } from "../config/settings";
import type { AgentRef } from "../registry/agent-registry";
import { createMCPProxyTools, type ExecutorOptions, type FollowUpTurnOptions } from "./executor";
import type { ExternalSubagentExecutor } from "./external-executor";
import { exportWorkerTelemetry } from "./external-telemetry";
import { initialWorkerEvalState } from "./worker-services";
import {
	prepareExternalSubagentLaunch,
	type EffectiveSubagentPolicy,
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
} from "./structured-subagent";

/** The process owner supplies transport; this adapter never starts a process. */
export interface ExternalExecutorTransport {
	request<T>(command: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
	/** Registers parent callbacks for a particular native child; throws if the callback route is unavailable. */
	bind(options: ExecutorOptions): void;
}

/** Preserve native caller contracts while leaving admission and process control with the external owner. */
export function createExternalSubagentExecutor(transport: ExternalExecutorTransport): ExternalSubagentExecutor {
	const assertSupported = (options: ExecutorOptions): void => {
		if (options.parentHindsightSessionState !== undefined) {
			throw new Error(
				"External execution cannot yet preserve shared Hindsight memory; refusing to launch with reduced native behavior",
			);
		}
		// Validate before admission so an untransferable config never reserves a worker.
		if (options.parentTelemetry) exportWorkerTelemetry(options.parentTelemetry);
	};
	const start = (options: ExecutorOptions): Promise<SingleResult> => {
		assertSupported(options);
		if (options.mcpManager && options.enableMCP !== false && !options.restrictToolNames) {
			options = {
				...options,
				customTools: [...createMCPProxyTools(options.mcpManager), ...(options.customTools ?? [])],
			};
		}
		transport.bind(options);
		const settings = options.settings ?? Settings.isolated();
		const snapshot = Object.fromEntries(allSettings().map(setting => [setting.id, setting.get(settings)]));
		const {
			signal,
			onProgress: _progress,
			eventBus: _events,
			subagentEventBus: _subevents,
			authStorage: _auth,
			modelRegistry: _models,
			settings: _settings,
			getApiKey: _key,
			mcpManager: _mcp,
			customTools,
			extensionRoots,
			preloadedPreparedExtensions: _prepared,
			localProtocolOptions: _local,
			parentArtifactManager: _artifacts,
			parentHindsightSessionState: _hindsight,
			parentMnemopiSessionState: _memory,
			parentTelemetry: _telemetry,
			onRelease: _release,
			onCleanupDeferred: _cleanup,
			parentServices: _services,
			...data
		} = options;
		return transport.request<SingleResult>(
			"start",
			{
				agentId: options.id,
				options: {
					...data,
					preloadedExtensionPaths:
						data.preloadedExtensionPaths ??
						options.preloadedPreparedExtensions?.map(extension => extension.resolvedPath),
				},
				settings: snapshot,
				telemetry: options.parentTelemetry ? exportWorkerTelemetry(options.parentTelemetry) : undefined,
				// Services stay in this process (or its own parent); the worker reaches them through the owner.
				services: {
					memory: options.parentMnemopiSessionState !== undefined || options.parentServices?.memory !== undefined,
					eval: options.parentEvalSessionId === undefined ? null : { state: initialWorkerEvalState(options) },
				},
				callbacks: {
					credentials: options.getApiKey !== undefined,
					artifacts: options.parentArtifactManager !== undefined,
					release: options.onRelease !== undefined,
				},
				localProtocol: options.localProtocolOptions
					? {
							artifactsDir: options.localProtocolOptions.getArtifactsDir?.() ?? null,
							sessionId: options.localProtocolOptions.getSessionId?.() ?? null,
						}
					: undefined,
				extensionRoots: extensionRoots?.(),
				tools: customTools?.map(tool => ({
					name: tool.name,
					label: tool.label,
					description: tool.description,
					parameters: toolWireSchema(tool),
					hidden: tool.hidden,
					loadMode: tool.loadMode,
					readsSkillUris: tool.readsSkillUris,
				})),
			},
			signal,
		);
	};
	return {
		async execute(
			request: StructuredSubagentRequest,
			policy: EffectiveSubagentPolicy,
		): Promise<StructuredSubagentResult> {
			const options = await prepareExternalSubagentLaunch(request, policy);
			assertSupported(options);
			transport.bind(options);
			// Admission runs before native launch and before any local worktree allocation.
			const admitted = await transport.request<{ cwd: string; worktree?: string }>(
				"admit",
				{
					id: options.id,
					cwd: options.cwd,
					parentAgentId: options.parentAgentId,
					sessionFile: options.sessionFile,
					isolation: { requested: policy.isIsolated, merge: policy.mergeMode, apply: policy.applyChanges },
				},
				request.signal,
			);
			const result = await start({ ...options, cwd: admitted.cwd, worktree: admitted.worktree });
			const integrated = await transport.request<{ changesApplied: boolean | null; mergeSummary: string }>(
				"integrate",
				{
					id: options.id,
					result,
					isolation: { requested: policy.isIsolated, merge: policy.mergeMode, apply: policy.applyChanges },
				},
				request.signal,
			);
			return { result, policy, ...integrated, artifactsDir: options.artifactsDir!, temporaryArtifacts: false };
		},
		start,
		followUp(options: FollowUpTurnOptions): Promise<SingleResult> {
			const { signal, onProgress: _progress, eventBus: _events, subagentEventBus: _subevents, ...data } = options;
			const trace: Record<string, string> = {};
			propagation.inject(context.active(), trace);
			return transport.request("follow_up", { ...data, agentId: options.id, trace }, signal);
		},
		deliver(ref: AgentRef, message: IrcMessage, options): Promise<IrcDeliveryReceipt> {
			return transport.request("send", { agentId: ref.id, sessionFile: ref.sessionFile, message, options });
		},
		async park(ref: AgentRef): Promise<void> {
			await transport.request("park", { agentId: ref.id, sessionFile: ref.sessionFile });
		},
		async release(ref: AgentRef, options): Promise<void> {
			await transport.request("release", { agentId: ref.id, sessionFile: ref.sessionFile, ...options });
		},
	};
}
