import { expect, it, mock } from "bun:test";
import { registerHostedJudgment, requestHostedJudgment } from "../src/session/hosted-judgment";

it("keeps judgments with the current host and propagates cancellation and host failure", async () => {
	const sessionId = Bun.randomUUIDv7();
	const request = { state: {}, questions: {} };
	const first = mock(async () => {
		throw new Error("first host unavailable");
	});
	const second = async () => {
		throw new Error("second host unavailable");
	};
	const stopFirst = registerHostedJudgment(sessionId, first);
	let stopCurrent = stopFirst;
	try {
		expect(() => registerHostedJudgment(sessionId, second)).toThrow("already has an owner");
		await expect(
			requestHostedJudgment(sessionId, request, {
				signal: AbortSignal.abort(new Error("operator stopped")),
			}),
		).rejects.toThrow("operator stopped");
		expect(first).not.toHaveBeenCalled();
		await expect(requestHostedJudgment(sessionId, request)).rejects.toThrow("first host unavailable");
		stopFirst();
		stopCurrent = registerHostedJudgment(sessionId, second);
		stopFirst();
		await expect(requestHostedJudgment(sessionId, request)).rejects.toThrow("second host unavailable");
	} finally {
		stopCurrent();
	}
	expect(await requestHostedJudgment(sessionId, request)).toBeUndefined();
});
