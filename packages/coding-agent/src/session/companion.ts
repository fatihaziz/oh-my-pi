import { isPromise } from "node:util/types";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type {
	CompanionAnswer,
	CompanionCommandInfo,
	CompanionContext,
	CompanionSnapshot,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogSubmitResult,
} from "../extensibility/extensions/types";

type Owner = { getSessionId?: () => string };
type Actions = {
	submit(text: string): Promise<void>;
	commands(): CompanionCommandInfo[];
	interrupt(): Promise<void>;
};
type PendingQuestion = {
	requestId: string;
	sessionId: string;
	questions: ExtensionAskDialogQuestion[];
	signal: AbortSignal;
	resolve(result: ExtensionAskDialogResult | undefined): void;
	cancel(): void;
};

/** One bridge per real session manager: extensions and builtin Ask share the same owner. */
class CompanionBridge {
	#snapshot: CompanionSnapshot;
	#listeners = new Set<(snapshot: CompanionSnapshot) => void>();
	#actions?: Actions;
	#pending?: PendingQuestion;
	#disposed = false;
	#interrupted = false;

	constructor(readonly owner: Owner) {
		this.#snapshot = this.#initial();
	}

	#initial(): CompanionSnapshot {
		return {
			eventId: `foyer-companion-v1:${crypto.randomUUID()}`,
			sessionId: this.owner.getSessionId?.() ?? "",
			state: "unknown",
			text: "",
		};
	}

	bind(actions: Actions): void {
		this.#actions = actions;
	}

	snapshot(): CompanionSnapshot {
		if (this.#snapshot.sessionId !== this.owner.getSessionId?.()) {
			this.cancel();
			this.#snapshot = this.#initial();
		}
		return structuredClone(this.#snapshot);
	}

	context(): CompanionContext {
		const sessionId = this.snapshot().sessionId;
		const assertLive = () => {
			if (this.#disposed || !this.#actions || !sessionId || sessionId !== this.owner.getSessionId?.()) {
				throw new Error("Companion session is no longer active");
			}
		};
		return {
			snapshot: () => this.snapshot(),
			subscribe: listener => {
				this.#listeners.add(listener);
				return () => this.#listeners.delete(listener);
			},
			submit: async text => {
				assertLive();
				if (typeof text !== "string" || !text.trim()) throw new Error("Companion message must not be empty");
				await this.#actions!.submit(text);
			},
			commands: () => {
				assertLive();
				return this.#actions!.commands();
			},
			interrupt: async () => {
				assertLive();
				// The final settle reads this: an aborted turn whose provider reports
				// `error` instead of `aborted` is still an interrupt, not a failure.
				this.#interrupted = true;
				await this.#actions!.interrupt();
			},
			answer: async (requestId, answers) => {
				assertLive();
				this.#answer(requestId, answers);
			},
		};
	}

	/**
	 * Snapshots reach subscribers only. A session entry is the wrong channel:
	 * `appendCustomEntry` advances the session leaf, so a state write lands
	 * between the turn's real entries and becomes the leaf a branch, a tree
	 * move, or the next prompt attaches to.
	 */
	#publish(state: CompanionSnapshot["state"], text = "", question?: CompanionSnapshot["question"]): void {
		if (this.#disposed) return;
		this.#snapshot = {
			...this.#initial(),
			state,
			text,
			...(question ? { question } : {}),
		};
		for (const listener of this.#listeners) {
			try {
				const result: unknown = listener(this.snapshot());
				if (isPromise(result)) void result.catch(error => logger.warn("Companion listener rejected", { error }));
			} catch (error) {
				logger.warn("Companion listener failed", { error });
			}
		}
	}

	/** Called only by AgentSession's public event sink, after its final continuation downgrade. */
	observe(event: { type: string; isTerminal?: boolean; messages?: AgentMessage[] }): void {
		if (event.type === "agent_start") {
			this.#interrupted = false;
			this.#publish("working");
		} else if (event.type === "agent_end" && event.isTerminal === true) {
			this.cancel();
			const message = event.messages?.findLast(item => item.role === "assistant");
			if (!message || message.role !== "assistant") {
				this.#publish("unknown");
				return;
			}
			const text = message.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\n");
			const state =
				message.stopReason === "error"
					? "failed"
					: this.#interrupted || message.stopReason === "aborted"
						? "interrupted"
						: message.stopReason === "stop"
							? "completed"
							: "failed";
			this.#publish(
				state,
				text ||
					(state === "failed"
						? "OMP stopped before normal completion."
						: state === "interrupted"
							? "The run was interrupted."
							: ""),
			);
		}
	}

	/** Session branch or tree navigation drops the old turn's state. */
	reset(): void {
		this.cancel();
		this.#interrupted = false;
		this.#publish("unknown");
	}

	cancel(): void {
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.cancel();
	}

	dispose(): void {
		this.#disposed = true;
		this.cancel();
		this.#listeners.clear();
		this.#actions = undefined;
	}

	#answer(requestId: string, answers: CompanionAnswer[]): void {
		const pending = this.#pending;
		if (
			!pending ||
			pending.requestId !== requestId ||
			pending.sessionId !== this.owner.getSessionId?.() ||
			pending.signal.aborted
		) {
			throw new Error("Companion question is stale or already answered");
		}
		if (!Array.isArray(answers) || answers.length !== pending.questions.length)
			throw new Error("Answer every requested question exactly once");
		const results: ExtensionAskDialogSubmitResult["results"] = pending.questions.map((question, index) => {
			const answer = answers[index];
			if (
				!answer ||
				answer.id !== question.id ||
				!Array.isArray(answer.selectedOptions) ||
				answer.selectedOptions.some(
					label => typeof label !== "string" || !question.options.some(option => option.label === label),
				) ||
				new Set(answer.selectedOptions).size !== answer.selectedOptions.length ||
				(answer.customInput !== undefined &&
					(typeof answer.customInput !== "string" || !answer.customInput.trim())) ||
				(answer.selectedOptions.length === 0 && !answer.customInput?.trim()) ||
				(!question.multi && answer.selectedOptions.length + (answer.customInput === undefined ? 0 : 1) !== 1)
			) {
				throw new Error("Answer does not match the requested question choices");
			}
			return {
				id: question.id,
				question: question.question,
				options: question.options.map(option => option.label),
				multi: question.multi ?? false,
				selectedOptions: [...answer.selectedOptions],
				...(answer.customInput !== undefined ? { customInput: answer.customInput } : {}),
			};
		});
		this.#pending = undefined;
		pending.resolve({ kind: "submit", results });
	}

	/** Local and remote answers settle this one dialog; abort closes the losing local UI. */
	async ask(
		questions: ExtensionAskDialogQuestion[],
		show: (signal: AbortSignal) => Promise<ExtensionAskDialogResult | undefined>,
		signal?: AbortSignal,
	): Promise<ExtensionAskDialogResult | undefined> {
		this.cancel();
		const controller = new AbortController();
		const dialogSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const remote = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
		const requestId = crypto.randomUUID();
		const sessionId = this.snapshot().sessionId;
		const cancel = () => {
			remote.resolve(undefined);
			controller.abort();
		};
		this.#pending = {
			requestId,
			sessionId,
			questions: structuredClone(questions),
			signal: dialogSignal,
			resolve: remote.resolve,
			cancel,
		};
		const onAbort = () => {
			if (this.#pending?.requestId === requestId) this.#pending = undefined;
			cancel();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		let local: Promise<ExtensionAskDialogResult | undefined> | undefined;
		try {
			if (dialogSignal.aborted) return undefined;
			local = show(dialogSignal);
			this.#publish("waiting", "", {
				requestId,
				questions: questions.map(q => ({
					id: q.id,
					question: q.question,
					options: q.options.map(option => ({ label: option.label })),
					...(q.multi !== undefined ? { multi: q.multi } : {}),
				})),
			});
			return await Promise.race([local, remote.promise]);
		} finally {
			if (this.#pending?.requestId === requestId) this.#pending = undefined;
			signal?.removeEventListener("abort", onAbort);
			controller.abort();
			// Wait for the existing dialog's abort cleanup before allowing the next tool to use the UI.
			await local?.catch(() => {});
			if (this.#snapshot.sessionId === sessionId && this.#snapshot.question?.requestId === requestId)
				this.#publish("working");
		}
	}
}

const bridges = new WeakMap<Owner, CompanionBridge>();
export function getCompanionBridge(owner: Owner): CompanionBridge {
	let bridge = bridges.get(owner);
	if (!bridge) {
		bridge = new CompanionBridge(owner);
		bridges.set(owner, bridge);
	}
	return bridge;
}
