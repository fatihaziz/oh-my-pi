import { DEFAULT_MAX_BYTES, OutputSink } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { spawn } from "@oh-my-pi/pi-utils/ptree";
import type { ExecutorBackend, ExecutorBackendExecOptions, ExecutorBackendResult } from "./backend";
import {
	resolveOutputMaxColumns,
	resolveOutputSinkArtifactMaxBytes,
	resolveOutputSinkHeadBytes,
} from "../tools/output-meta";

/** Rust cells are independent expressions; unlike JS and Python they retain no process state. */
export default {
	id: "rust",
	label: "Rust",
	highlightLang: "rust",
	async isAvailable() {
		return Bun.which("rust-script") !== null;
	},
	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const executable = Bun.which("rust-script");
		if (!executable) throw new Error("Rust eval requires rust-script on PATH.");
		const sink = new OutputSink({
			spillThreshold: DEFAULT_MAX_BYTES,
			headBytes: resolveOutputSinkHeadBytes(opts.session.settings),
			artifactMaxBytes: resolveOutputSinkArtifactMaxBytes(opts.session.settings),
			maxColumns: resolveOutputMaxColumns(opts.session.settings),
			onChunk: opts.onChunk,
		});
		try {
			using child = spawn([executable, "--expr", `{\n${code}\n}`], {
				cwd: opts.cwd,
				signal: opts.signal,
				stderr: "full",
				detached: process.platform !== "win32",
				subreaper: true,
			});
			const drain = async (stream: ReadableStream<Uint8Array> | undefined) => {
				if (!stream) return;
				const decoder = new TextDecoder();
				for await (const chunk of stream) sink.push(decoder.decode(chunk, { stream: true }));
				const rest = decoder.decode();
				if (rest) sink.push(rest);
			};
			await Promise.all([drain(child.stdout), drain(child.stderr)]);
			const result = await child.wait({ allowAbort: true, allowNonZero: true });
			const summary = await sink.dump();
			return {
				...summary,
				artifactId: summary.artifactId,
				exitCode: result.exitCode ?? undefined,
				cancelled: Boolean(result.exitError?.aborted),
				displayOutputs: [],
			};
		} finally {
			await sink.dispose();
		}
	},
} satisfies ExecutorBackend;
