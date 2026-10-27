import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

export const MODEL_TASK_CATEGORIES = ["implementation", "debuggingReview", "architecturePlanning", "researchAnalysis", "writingCommunication"] as const;
export type ModelTaskCategory = (typeof MODEL_TASK_CATEGORIES)[number];
export type HostedModelCategoryWeights = Partial<Record<ModelTaskCategory, number>>;
export interface HostedModelRoutingUsage {
	entryId: string;
	selector: string;
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
}
export interface HostedModelRoutingRequest {
	sessionId: string;
	boundaryId: string;
	promptGeneration: number;
	selectionRevision: number;
	trigger: "operator" | "resume_auto" | "policy_change";
	current: { selector: string; thinking: string };
	prompt: string;
	operatorContext: string[];
	requirements: { input: string[]; contextTokens?: number; outputTokens?: number; tools: boolean; reasoning?: boolean; effort?: string };
	promptTokens: number | null;
	lastResponse: HostedModelRoutingUsage | null;
}
export interface HostedModelRoutingDiagnostics {
	coldInputTokens: number | null;
	lastCacheReadTokens: number | null;
	switchPenalty: number;
	scoreAdvantage: number;
	cacheHitRatio: number;
	unknowns: string[];
	scores: unknown[];
	learningRevision: string;
}
interface DecisionBase {
	boundaryId: string;
	policyFingerprint: string;
	reason: string;
}
export type HostedModelRoutingDecision =
	| (DecisionBase & { kind: "retain"; categoryWeights: HostedModelCategoryWeights; diagnostics: HostedModelRoutingDiagnostics })
	| (DecisionBase & { kind: "switch"; selector: string; thinking: ConfiguredThinkingLevel; categoryWeights: HostedModelCategoryWeights; diagnostics: HostedModelRoutingDiagnostics })
	| (DecisionBase & { kind: "blocked" });
export interface HostedModelRoutingPolicy {
	profileId: number;
	policyFingerprint: string;
	mode: "auto" | "manual";
	executionAuto: boolean;
	executionStopped: boolean;
}
export interface HostedModelRoutingState {
	mode: "auto" | "pinned";
	selectionRevision: number;
	profileId: number;
	policyFingerprint: string;
	executionAuto: boolean;
	executionStopped: boolean;
	current: { selector: string; thinking: string };
	state: "idle" | "selecting" | "pinned" | "blocked" | "offline";
	reason: string;
	pending?: { boundaryId: string; trigger: HostedModelRoutingRequest["trigger"] };
	diagnostics?: HostedModelRoutingDiagnostics;
}
export type HostedModelRoutingHandler = (input: HostedModelRoutingRequest, signal?: AbortSignal) => Promise<HostedModelRoutingDecision>;
const handlers = new Map<string, HostedModelRoutingHandler>();

export function registerHostedModelRouting(sessionId: string, handler: HostedModelRoutingHandler): () => void {
	if (!sessionId || handlers.has(sessionId)) throw new Error("Hosted model routing already has an owner");
	handlers.set(sessionId, handler);
	return () => { if (handlers.get(sessionId) === handler) handlers.delete(sessionId); };
}
export function hasHostedModelRouting(sessionId: string): boolean { return handlers.has(sessionId); }

function selector(value: unknown): value is string {
	return typeof value === "string" && /^[^\s/*?]+\/[^\s*?]+$/.test(value);
}
function count(value: unknown): boolean { return value === null || typeof value === "number" && Number.isFinite(value) && value >= 0; }
function finiteTree(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(finiteTree);
	if (value && typeof value === "object") return Object.values(value).every(finiteTree);
	return true;
}
export async function requestHostedModelRouting(input: HostedModelRoutingRequest, signal?: AbortSignal): Promise<HostedModelRoutingDecision | undefined> {
	const handler = handlers.get(input.sessionId);
	if (!handler) return undefined;
	if (!input.boundaryId || !selector(input.current.selector) || !count(input.promptTokens) || !Number.isSafeInteger(input.promptGeneration) || input.promptGeneration < 0 || !Number.isSafeInteger(input.selectionRevision) || input.selectionRevision < 0) throw new Error("Invalid hosted routing boundary");
	signal?.throwIfAborted();
	const result = await handler(input, signal);
	signal?.throwIfAborted();
	if (handler !== handlers.get(input.sessionId)) throw new Error("Hosted model routing owner changed");
	if (!result || !["retain", "switch", "blocked"].includes(result.kind) || result.boundaryId !== input.boundaryId || typeof result.policyFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(result.policyFingerprint) || typeof result.reason !== "string" || !result.reason || !finiteTree(result)) throw new Error("Invalid hosted model routing decision");
	if (result.kind === "blocked") return result;
	const weights = result.categoryWeights;
	if (!weights || Object.keys(weights).some(key => !MODEL_TASK_CATEGORIES.includes(key as ModelTaskCategory)) || Object.values(weights).some(value => typeof value !== "number" || value < 0) || Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) > 1e-9) throw new Error("Invalid routing category weights");
	const d = result.diagnostics;
	if (!d || !count(d.coldInputTokens) || !count(d.lastCacheReadTokens) || !count(d.switchPenalty) || typeof d.scoreAdvantage !== "number" || typeof d.cacheHitRatio !== "number" || d.cacheHitRatio < 0 || d.cacheHitRatio > 1 || !Array.isArray(d.unknowns) || !d.unknowns.every(item => typeof item === "string") || !Array.isArray(d.scores) || typeof d.learningRevision !== "string") throw new Error("Invalid routing diagnostics");
	if (result.kind === "switch" && (!selector(result.selector) || !["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(result.thinking))) throw new Error("Invalid routing model selection");
	return result;
}
