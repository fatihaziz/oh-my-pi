import { type Component, CURSOR_MARKER, type Focusable, Input, truncateToWidth, visibleWidth } from "../index";
import { sanitizeStatusText } from "../chrome/shared";
import { theme } from "../theme/theme";
import { OverlayPanel, PanelRows } from "../chrome/overlay-box";
import { editorKey } from "../chrome/keybinding-hints";
import { col, keyed, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { getKeybindings } from "../keybindings";
import { wrapTextWithAnsi } from "../utils";

/** A confirmed destination, resolved only after the write succeeded. */
export interface PlanSaveOverlayResult {
	path: string;
}

type PlanSaveState =
	| { kind: "editing"; error?: string }
	| { kind: "saving"; path: string }
	| { kind: "closed" };

/**
 * Collects a destination path, writes it, and closes only when the write
 * succeeded. A failed write keeps the entry editable and shows the reason
 * inline, so the operator can correct the name without losing the dialog.
 */
export class PlanSaveOverlay implements Component, Focusable {
	#input = new Input();
	#suggestedPath: string;
	#save: (path: string) => Promise<string>;
	#done: (result: PlanSaveOverlayResult | undefined) => void;
	#requestRender: () => void;
	#state: PlanSaveState = { kind: "editing" };
	#focused = false;
	readonly #panel: OverlayPanel;
	readonly #body: PanelRows;
	#nativeSig = "";
	#nativeRoot: NativeNode | undefined;

	constructor(
		suggestedPath: string,
		save: (path: string) => Promise<string>,
		done: (result: PlanSaveOverlayResult | undefined) => void,
		requestRender: () => void,
	) {
		this.#suggestedPath = suggestedPath;
		this.#save = save;
		this.#done = done;
		this.#requestRender = requestRender;
		this.#input.prompt = theme.fg("dim", "Path: ");
		this.#input.placeholder = suggestedPath;
		this.#input.onSubmit = () => this.#submit();
		this.#input.onEscape = () => this.#cancel();
		this.#panel = new OverlayPanel("Save plan");
		this.#body = new PanelRows();
		this.#body.setHeight(2);
		this.#panel.addChild(this.#body);
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	/** Replaces the suggestion; only the hint changes, never text already entered or accepted. */
	setSuggestedPath(path: string): void {
		this.#suggestedPath = path;
		this.#input.placeholder = path;
		this.#nativeRoot = undefined;
		this.#requestRender();
	}

	handleInput(data: string): void {
		if (this.#state.kind !== "editing") return;
		// Tab fills the suggested name only while the field is empty or a proper
		// prefix of it, and never submits; a custom entry stays untouched.
		if (getKeybindings().matches(data, "tui.input.tab")) {
			if (this.#canAcceptSuggestion()) this.#acceptSuggestion();
			return;
		}
		this.#input.handleInput(data);
	}

	/** Routes enhanced clipboard pastes into the path input. */
	pasteText(text: string): void {
		if (this.#state.kind !== "editing") return;
		this.#input.pasteText(text);
	}

	invalidate(): void {
		this.#input.invalidate();
		this.#panel.invalidate();
		this.#nativeRoot = undefined;
	}

	/** Teardown from the host: late write completion must not touch the UI. */
	dispose(): void {
		this.#state = { kind: "closed" };
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(0, width - 4);
		const state = this.#state;
		let lines: string[];
		if (state.kind === "saving") {
			lines = [theme.fg("dim", "Path: ") + state.path, theme.fg("accent", "Saving…")];
		} else if (state.kind === "closed") {
			lines = [];
		} else {
			this.#input.focused = this.#focused;
			lines = [this.#renderInput(innerWidth), ...this.#renderHint(), ...this.#renderError(innerWidth, state.error)];
		}
		this.#body.setHeight(lines.length);
		this.#body.setLines(lines);
		return this.#panel.render(width);
	}

	/** A small glass sheet titled "Save plan". */
	readonly nativeOverlay = { role: "omp.overlay.planSave", size: "sm", head: "Save plan" } as const;

	describe(): NativeNode {
		const state = this.#state;
		const bindings = getKeybindings();
		const submitKey = bindings.getKeys("tui.input.submit")[0];
		const cancelKey = bindings.getKeys("tui.select.cancel")[0];
		const value = this.#input.getValue();
		const accept = this.#canAcceptSuggestion();
		const error = state.kind === "editing" ? state.error : undefined;
		const saving = state.kind === "saving" ? state.path : "";
		const sig = `${state.kind}|${error ?? ""}|${saving}|${value}|${this.#suggestedPath}|${accept}|${submitKey}|${cancelKey}`;
		if (this.#nativeRoot && sig === this.#nativeSig) return this.#nativeRoot;
		const children: NativeChild[] = [];
		if (state.kind === "saving") {
			children.push(keyed(text([span(state.path, "path")], { truncate: "middle" }), "path"));
			children.push(
				keyed(
					node(
						"row",
						{ role: "omp.planSave.saving", gap: "sm", align: "center" },
						[node("spinner", { style: "dots", tone: "accent" }), text("Saving…")],
					),
					"saving",
				),
			);
		} else if (state.kind === "editing") {
			this.#input.focused = this.#focused;
			children.push(this.#input);
			if (accept) {
				const label = value.length > 0 ? `use suggested name: ${this.#suggestedPath}` : "use suggested name";
				children.push(keyed(text([span(`${editorKey("tui.input.tab")} `, "dim"), span(label, "dim")]), "suggest"));
			}
			if (error) {
				children.push(
					keyed(
						node(
							"row",
							{ role: "omp.planSave.error", tone: "error", gap: "sm", align: "center" },
							[node("icon", { name: "x-circle", tone: "error" }), text(sanitizeStatusText(error), { wrap: "word" })],
						),
						"error",
					),
				);
			}
			children.push(
				actionBar([
					null,
					actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {}),
					actionButton("Save", "save", { tone: "accent", ...(submitKey ? { keys: submitKey } : {}) }),
				]),
			);
		}
		this.#nativeSig = sig;
		this.#nativeRoot = col(children, { gap: "md" });
		return this.#nativeRoot;
	}

	/** Save and Cancel run what the submit and cancel keys run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action" || this.#state.kind !== "editing") return;
		if (event.act === "save") this.#submit();
		else if (event.act === "cancel") this.#cancel();
	}

	#canAcceptSuggestion(): boolean {
		if (this.#state.kind !== "editing") return false;
		const value = this.#input.getValue();
		return value.length < this.#suggestedPath.length && this.#suggestedPath.startsWith(value);
	}

	#acceptSuggestion(): void {
		this.#input.setValue(this.#suggestedPath);
		this.#input.invalidate();
		this.#nativeRoot = undefined;
		this.#requestRender();
	}

	#submit(): void {
		if (this.#state.kind !== "editing") return;
		const path = this.#input.getValue().trim() || this.#suggestedPath;
		const saving: PlanSaveState = { kind: "saving", path };
		this.#state = saving;
		this.#nativeRoot = undefined;
		this.#requestRender();
		void Promise.try(() => this.#save(path)).then(
			destination => {
				if (this.#state !== saving) return;
				this.#state = { kind: "closed" };
				this.#done({ path: destination });
			},
			error => {
				if (this.#state !== saving) return;
				this.#state = { kind: "editing", error: error instanceof Error ? error.message : String(error) };
				this.#nativeRoot = undefined;
				this.#requestRender();
			},
		);
	}

	#cancel(): void {
		if (this.#state.kind !== "editing") return;
		this.#state = { kind: "closed" };
		this.#done(undefined);
	}

	#renderHint(): string[] {
		const hints = [`${editorKey("tui.input.submit")} save`, `${editorKey("tui.select.cancel")} cancel`];
		if (this.#canAcceptSuggestion()) {
			const value = this.#input.getValue();
			hints.unshift(
				value.length > 0
					? `${editorKey("tui.input.tab")} use suggested name: ${this.#suggestedPath}`
					: `${editorKey("tui.input.tab")} use suggested name`,
			);
		}
		return [theme.fg("dim", hints.join(" · "))];
	}

	#renderError(width: number, error: string | undefined): string[] {
		if (!error || width <= 0) return [];
		return wrapTextWithAnsi(theme.fg("error", sanitizeStatusText(error)), width);
	}

	#renderInput(width: number): string {
		if (this.#input.getValue().length > 0) return this.#input.render(width)[0] ?? "";
		const prompt = this.#input.prompt;
		const available = width - visibleWidth(prompt);
		if (available <= 0) return prompt;
		const marker = this.#focused ? CURSOR_MARKER : "";
		const suggested = truncateToWidth(this.#suggestedPath, Math.max(0, available - 1));
		return `${prompt}${marker}\x1b[7m \x1b[27m${theme.fg("dim", suggested)}`;
	}
}
