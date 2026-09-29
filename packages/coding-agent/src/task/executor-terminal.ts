import type { Terminal, TerminalAppearance, TerminalAppearanceRequestToken } from "@oh-my-pi/pi-tui/terminal";
import { StdinBuffer } from "@oh-my-pi/pi-tui/stdin-buffer";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import type { AgentSession } from "../session/agent-session";
import { InteractiveMode } from "../modes/interactive-mode";
import type { InteractiveModeContext } from "../modes/types";

/** ANSI transport for the worker's own InteractiveMode; never opens a second session. */
export class ExecutorTerminal implements Terminal {
	columns: number;
	rows: number;
	readonly kittyProtocolActive = false;
	readonly kittyEnableSequence = null;
	readonly appearance: TerminalAppearance = "dark";
	mode?: InteractiveMode;
	#input?: (data: string) => void;
	#resize?: () => void;
	#buffer = new StdinBuffer();
	#appearanceListeners: ((appearance: TerminalAppearance) => void)[] = [];

	constructor(
		columns: number,
		rows: number,
		private output: (data: string) => void,
	) {
		this.columns = columns;
		this.rows = rows;
		this.#buffer.on("data", data => this.#input?.(data));
		this.#buffer.on("paste", (text, enter) => {
			this.#input?.(`\x1b[200~${text}\x1b[201~`);
			if (enter) this.#input?.(enter);
		});
	}

	async attach(session: AgentSession, hostedInput: NonNullable<InteractiveModeContext["hostedInput"]>): Promise<void> {
		await initTheme();
		const composer = new Composer({ terminal: this, preferences: { quiet: true } });
		const mode = new InteractiveMode(
			session,
			VERSION,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			composer,
		);
		this.mode = mode;
		mode.hostedInput = hostedInput;
		try {
			await mode.init({ suppressWelcomeIntro: true });
			await mode.renderInitialMessages({ clearTerminalHistory: true });
			mode.statusLine.setSession(session, hostedInput.agentId);
			mode.ui.requestRender(true);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	input(data: string): void {
		this.#buffer.process(data);
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.#resize?.();
	}
	setVisible(visible: boolean): void {
		if (!this.mode) throw new Error("Worker terminal is not attached");
		if (visible) {
			this.mode.ui.start();
			this.mode.ui.requestRender(true);
		} else this.mode.ui.stop();
	}
	dispose(): void {
		this.mode?.unsubscribe?.();
		this.mode?.stop();
		this.mode = undefined;
		this.#buffer.destroy();
		this.#appearanceListeners = [];
	}
	start(input: (data: string) => void, resize: () => void): void {
		this.#input = input;
		this.#resize = resize;
		this.write("\x1b[?2004h");
	}
	stop(): void {
		this.#input = undefined;
		this.#resize = undefined;
		this.#buffer.clear();
		this.write("\x1b[?2004l\x1b[?25h");
	}
	async drainInput(): Promise<void> {
		this.#buffer.clear();
	}
	write(data: string): void {
		this.output(data);
	}
	moveBy(lines: number): void {
		if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? "B" : "A"}`);
	}
	hideCursor(): void {
		this.write("\x1b[?25l");
	}
	showCursor(): void {
		this.write("\x1b[?25h");
	}
	clearLine(): void {
		this.write("\x1b[K");
	}
	clearFromCursor(): void {
		this.write("\x1b[J");
	}
	clearScreen(): void {
		this.write("\x1b[H\x1b[2J");
	}
	setTitle(title: string): void {
		this.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, "")}\x07`);
	}
	setProgress(active: boolean): void {
		this.write(`\x1b]9;4;${active ? "3" : "0"};\x07`);
	}
	onAppearanceChange(callback: (appearance: TerminalAppearance) => void): void {
		this.#appearanceListeners.push(callback);
		callback(this.appearance);
	}
	refreshAppearance(_token?: TerminalAppearanceRequestToken): void {
		for (const callback of this.#appearanceListeners) callback(this.appearance);
	}
}
