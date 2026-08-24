#!/usr/bin/env bun
/**
 * Verifies that the configured external editor ($VISUAL / $EDITOR) actually
 * launches, instead of reporting success while doing nothing.
 *
 * The failure this catches: a CLI wrapper (for example a half-updated VS Code
 * install) returns exit code 0 without ever opening the file. `openInEditor`
 * then treats the launch as successful, removes its temp file, and Ctrl+G
 * looks completely inert with no error anywhere.
 *
 * Usage:
 *   bun scripts/check-external-editor.ts                 # checks $VISUAL / $EDITOR
 *   bun scripts/check-external-editor.ts "code --wait"   # checks one command
 */
import * as os from "node:os";
import * as path from "node:path";

/** A launcher that returns faster than this never opened an interactive editor. */
const INSTANT_RETURN_MS = 1500;
/** How long to wait before concluding the editor is holding the file open. */
const WAIT_CAP_MS = 4000;

function resolveEditor(): string | undefined {
	const fromArgs = process.argv[2]?.trim();
	if (fromArgs) return fromArgs;
	return Bun.env.VISUAL?.trim() || Bun.env.EDITOR?.trim() || undefined;
}

/** Process-name hint for the editor, e.g. `"E:\...\code.cmd" --wait` -> `code`. */
function processHint(editorCmd: string): string {
	const firstToken = editorCmd.trim().match(/^"([^"]+)"|^(\S+)/);
	const executable = firstToken?.[1] ?? firstToken?.[2] ?? editorCmd;
	return path
		.basename(executable)
		.replace(/\.(cmd|bat|exe|sh)$/i, "")
		.toLowerCase();
}

async function countProcesses(hint: string): Promise<number> {
	const command =
		process.platform === "win32"
			? [
					"powershell",
					"-NoProfile",
					"-Command",
					`(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "*${hint}*" }).Count`,
				]
			: ["sh", "-c", `ps -eo comm= | grep -ci ${hint} || true`];
	const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "ignore" });
	return Number.parseInt(result.stdout.toString().trim(), 10) || 0;
}

function buildCommand(editorCmd: string, file: string): { cmd: string[]; verbatim: boolean } {
	if (process.platform === "win32") {
		return { cmd: ["cmd.exe", "/d", "/s", "/c", `"${editorCmd} "${file}""`], verbatim: true };
	}
	return { cmd: ["/bin/sh", "-c", `${editorCmd} "$1"`, "sh", file], verbatim: false };
}

const editorCmd = resolveEditor();
if (!editorCmd) {
	console.log("FAIL  no editor configured: set $VISUAL or $EDITOR");
	process.exit(1);
}

const hint = processHint(editorCmd);
const file = path.join(os.tmpdir(), `omp-editor-check-${Date.now()}.md`);
await Bun.write(file, "external editor check\n");

const { cmd, verbatim } = buildCommand(editorCmd, file);
const before = await countProcesses(hint);
const started = Bun.nanoseconds();

const child = Bun.spawn(cmd, {
	stdin: "inherit",
	stdout: "pipe",
	stderr: "pipe",
	windowsVerbatimArguments: verbatim,
	windowsHide: process.platform === "win32",
});

const outcome = await Promise.race([child.exited, Bun.sleep(WAIT_CAP_MS).then(() => "waiting" as const)]);
const elapsedMs = Math.round((Bun.nanoseconds() - started) / 1e6);
const after = await countProcesses(hint);
const spawned = after - before;

console.log(`editor    ${editorCmd}`);
console.log(`command   ${cmd.join(" ")}`);
console.log(`elapsed   ${elapsedMs}ms`);
console.log(`processes ${hint}: ${before} -> ${after}`);

let exitCode = 0;
if (outcome === "waiting") {
	console.log("PASS      editor is holding the file open, exactly what --wait should do");
	child.kill();
} else if (outcome !== 0) {
	const stderr = (await new Response(child.stderr).text()).trim();
	console.log(`FAIL      launcher exited ${outcome}${stderr ? `: ${stderr}` : ""}`);
	exitCode = 1;
} else if (spawned > 0) {
	console.log("PASS      launcher returned but an editor process appeared (non-blocking editor)");
} else if (elapsedMs < INSTANT_RETURN_MS) {
	console.log("SUSPECT   launcher claimed success instantly and no editor process appeared.");
	console.log("          Ctrl+G will look completely inert. Check which binary the command resolves to");
	console.log(`          (Windows: where.exe ${hint}) and point $VISUAL at an install that really starts.`);
	exitCode = 2;
} else {
	console.log("PASS      launcher exited 0 after a plausible editing session");
}

await Bun.file(file)
	.unlink()
	.catch(() => {});
process.exit(exitCode);
