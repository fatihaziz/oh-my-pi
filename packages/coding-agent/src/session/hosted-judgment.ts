import type { Judge, JudgeOptions, JudgmentRequest, JudgmentResult, Questions } from "@oh-my-pi/pi-ai";

const owners = new Map<string, Judge["judge"]>();

/** The authenticated host owns judgments until its session adapter closes. */
export function registerHostedJudgment(sessionId: string, handler: Judge["judge"]): () => void {
	if (!sessionId || owners.has(sessionId)) throw new Error("Hosted judgment already has an owner");
	owners.set(sessionId, handler);
	return () => {
		if (owners.get(sessionId) === handler) owners.delete(sessionId);
	};
}

export async function requestHostedJudgment<Q extends Questions>(
	sessionId: string,
	request: JudgmentRequest<Q>,
	options: JudgeOptions = {},
): Promise<JudgmentResult<Q> | undefined> {
	const handler = owners.get(sessionId);
	if (!handler) return undefined;
	options.signal?.throwIfAborted();
	const result = await handler(request, options);
	options.signal?.throwIfAborted();
	if (owners.get(sessionId) !== handler) throw new Error("Hosted judgment owner changed");
	return result;
}
