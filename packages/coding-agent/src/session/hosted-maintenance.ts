export interface HostedMaintenanceRequest {
	phase: "assess" | "checkpoint";
	sessionId: string;
	contextTokens: number;
	contextWindow: number;
	thresholdTokens?: number;
	recoverableTokens?: number;
	reason: string;
}
export interface HostedMaintenanceResult { compact: boolean; checkpoint?: string }
type Handler = (request: HostedMaintenanceRequest, signal?: AbortSignal) => Promise<HostedMaintenanceResult>;
const handlers = new Map<string, Handler>();

/** Registration follows the authenticated pane session, not a turn or model request. */
export function registerHostedMaintenance(sessionId: string, handler: Handler): () => void {
	if (!sessionId || handlers.has(sessionId)) throw new Error("Hosted maintenance already has an owner");
	handlers.set(sessionId, handler);
	return () => { if (handlers.get(sessionId) === handler) handlers.delete(sessionId); };
}
export function hasHostedMaintenance(sessionId: string): boolean { return handlers.has(sessionId); }
export async function requestHostedMaintenance(request: HostedMaintenanceRequest, signal?: AbortSignal): Promise<HostedMaintenanceResult | undefined> {
	const handler = handlers.get(request.sessionId);
	if (!handler) return undefined;
	signal?.throwIfAborted();
	const result = await handler(request, signal);
	signal?.throwIfAborted();
	if (handler !== handlers.get(request.sessionId)) throw new Error("Hosted maintenance owner changed");
	if (typeof result?.compact !== "boolean") throw new Error("Invalid hosted maintenance decision");
	if (request.phase === "checkpoint" && (!result.compact || !/^[a-f0-9]{40,64}$/.test(result.checkpoint ?? ""))) {
		throw new Error("Foyer did not commit the session tracker; context is retained");
	}
	return result;
}
