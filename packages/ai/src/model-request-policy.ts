import type { FetchImpl, Model, StreamOptions } from "./types";
import { AssistantMessageEventStream } from "./utils/event-stream";

/** The host supplies current policy; the inference runtime does not select models. */
let requestPolicy: ((selector: string, signal?: AbortSignal) => Promise<void>) | undefined;

export function setModelRequestPolicy(policy: ((selector: string, signal?: AbortSignal) => Promise<void>) | undefined): void {
	requestPolicy = policy;
}

export async function checkModelRequestPolicy(selector: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	await requestPolicy?.(selector, signal);
}

export function withModelRequestPolicy<T extends Pick<StreamOptions, "fetch" | "signal"> & { fallbacks?: readonly { model: string }[] }>(
	model: Model,
	options: T | undefined,
	dispatch: (options: T | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	if (!requestPolicy) return dispatch(options);
	const selector = `${model.provider}/${model.id}`;
	const baseFetch = options?.fetch ?? fetch;
	const denied = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, denied.signal]) : denied.signal;
	const checkRequest = async (signal?: AbortSignal) => {
		await checkModelRequestPolicy(selector, signal);
		if (options?.fallbacks) for (const fallback of options.fallbacks) {
			await checkModelRequestPolicy(`${model.provider}/${fallback.model}`, signal);
		}
	};
	const guardedFetch: FetchImpl = Object.assign(async (input: Parameters<FetchImpl>[0], init?: Parameters<FetchImpl>[1]) => {
		try {
			await checkRequest(init?.signal ?? signal);
		} catch (error) {
			denied.abort(error);
			throw error;
		}
		return baseFetch(input, init);
	}, { preconnect: baseFetch.preconnect });
	const outer = new AssistantMessageEventStream();
	void (async () => {
		try {
			await checkRequest(options?.signal);
			const inner = dispatch({ ...options, signal, fetch: guardedFetch } as T);
			for await (const event of inner) {
				if (denied.signal.aborted) throw denied.signal.reason;
				outer.push(event);
				if (outer.done) return;
			}
			if (denied.signal.aborted) throw denied.signal.reason;
			if (!outer.done) outer.end(await inner.result());
		} catch (error) {
			outer.fail(error);
		}
	})();
	return outer;
}
