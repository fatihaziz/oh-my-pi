/**
 * Utilities for launching an external text editor ($VISUAL / $EDITOR).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, $which, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Shortest run that can still be a real editing session. A launcher that
 * returns faster than this AND leaves the file byte-identical never opened an
 * editor: it is either non-blocking (missing `--wait`) or a broken wrapper that
 * reports success while starting nothing. Both cases used to look like a dead
 * keybinding, because exit 0 made the caller keep the unchanged draft in
 * silence and the temp file was removed on the way out.
 */
const INSTANT_EXIT_MS = 1500;

/**
 * Returns the user's preferred editor command, or a platform default.
 *
 * Resolution order:
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. `notepad` on Windows (always present in `%SystemRoot%\System32`)
 *
 * POSIX returns `undefined` when neither variable is set so the caller can
 * surface a warning that nudges the user to configure one.
 */
export function getEditorCommand(): string | undefined {
	const configured = $env.VISUAL?.trim() || $env.EDITOR?.trim();
	if (configured) return configured;
	if (process.platform === "win32") return "notepad";
	return undefined;
}

export interface OpenInEditorOptions {
	/** File extension for the temp file (default: ".md"). */
	extension?: string;
	/** Keep the file's trailing newline instead of trimming it from the returned text. */
	trimTrailingNewline?: boolean;
}

/** Subprocess argv and Windows quoting mode used to launch an external editor. */
export interface EditorSpawnCommand {
	cmd: string[];
	windowsVerbatimArguments: boolean;
}

/** Resolves shell argv without letting the host runtime re-quote the editor command. */
export function resolveEditorSpawnCommand(
	editorCmd: string,
	tmpFile: string,
	platform: NodeJS.Platform = process.platform,
): EditorSpawnCommand {
	const windows = platform === "win32";
	// cmd.exe strips the outer /s /c quote pair; Bun must pass the embedded
	// editor/path quotes verbatim instead of applying argv escaping to them.
	const cmd = windows
		? ["cmd.exe", "/d", "/s", "/c", `"${editorCmd} "${tmpFile}""`]
		: [$which("sh") ?? "sh", "-c", `${editorCmd} "$1"`, "sh", tmpFile];
	return { cmd, windowsVerbatimArguments: windows };
}

/**
 * Opens `content` in the user's external editor and returns the edited text.
 * Returns `null` if the editor exits with a non-zero code, and throws when the
 * launcher reports success without ever opening the file (see INSTANT_EXIT_MS)
 * so the caller can surface the misconfiguration instead of doing nothing.
 *
 * The caller is responsible for stopping/starting the TUI around this call.
 */
export async function openInEditor(
	editorCmd: string,
	content: string,
	options?: OpenInEditorOptions,
): Promise<string | null> {
	const ext = options?.extension ?? ".md";
	const tmpFile = path.join(os.tmpdir(), `omp-editor-${Snowflake.next()}${ext}`);

	try {
		await Bun.write(tmpFile, content);

		const spawnCommand = resolveEditorSpawnCommand(editorCmd, tmpFile);
		// Inherit the real pane pty so terminal editors (including emacsclient,
		// which resolves the device via ttyname) render into the visible pane.
		const startedAt = Bun.nanoseconds();
		const child = Bun.spawn(spawnCommand.cmd, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
			windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
			windowsHide: process.platform === "win32",
		});
		const exitCode = await child.exited;
		const elapsedMs = (Bun.nanoseconds() - startedAt) / 1e6;
		if (exitCode === 0) {
			const text = await Bun.file(tmpFile).text();
			if (text === content && elapsedMs < INSTANT_EXIT_MS) {
				throw new Error(
					`\`${editorCmd}\` returned after ${Math.round(elapsedMs)}ms without opening the file. Configure a blocking editor (for example \`code --wait\`) and check that it resolves to a working install.`,
				);
			}
			if (options?.trimTrailingNewline === false) {
				return text;
			}
			return text.replace(/\n$/, "");
		}
		return null;
	} finally {
		try {
			await fs.rm(tmpFile, { force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}
