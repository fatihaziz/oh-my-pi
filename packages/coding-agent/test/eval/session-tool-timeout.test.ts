import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { $which, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../../src/config/settings";
import { disposeAllVmContexts } from "../../src/eval/js/context-manager";
import { disposeAllKernelSessions } from "../../src/eval/py/executor";
import { disposePyToolBridge } from "../../src/eval/py/tool-bridge";
import type { ToolSession } from "../../src/tools";
import { EvalTool } from "../../src/tools/eval";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let tempDir: TempDir;
let settingsState: SettingsTestState;

beforeEach(() => {
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@eval-session-tool-timeout-");
	setAgentDir(path.join(tempDir.path(), "agent"));
});

afterEach(async () => {
	await disposeAllVmContexts();
	await disposeAllKernelSessions();
	await disposePyToolBridge();
	restoreSettingsTestState(settingsState);
	tempDir.removeSync();
});

function makeSession(...tools: AgentTool[]): ToolSession {
	const sessionId = `session-tool-timeout-${crypto.randomUUID()}`;
	return {
		cwd: tempDir.path(),
		hasUI: false,
		settings: Settings.isolated({
			"async.enabled": false,
			"eval.autoProvision": false,
			"python.interpreter": Bun.env.PYTHON ?? $which("python3") ?? $which("python") ?? "",
		}),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => sessionId,
		getEvalSessionId: () => sessionId,
		getToolByName: name => tools.find(tool => tool.name === name),
	};
}

function slowTool(name: string): {
	tool: AgentTool;
	started: Promise<void>;
	aborted: () => boolean;
} {
	const started = Promise.withResolvers<void>();
	let aborted = false;
	return {
		started: started.promise,
		aborted: () => aborted,
		tool: {
			name,
			label: name,
			description: "Returns delegated work after three seconds",
			parameters: type({}),
			async execute(_id, _args, signal) {
				const result = Promise.withResolvers<AgentToolResult>();
				const timer = setTimeout(
					() => result.resolve({ content: [{ type: "text", text: "review complete" }] }),
					3_000,
				);
				const onAbort = () => {
					aborted = true;
					result.reject(signal?.reason);
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				started.resolve();
				try {
					return await result.promise;
				} finally {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				}
			},
		},
	};
}

async function warmEval(evalTool: EvalTool, language: "js" | "py"): Promise<void> {
	// Start the real worker/kernel outside the measured cell, so interpreter
	// startup cannot hide whether the delegated call reached execution.
	await evalTool.execute("warmup", { language, code: "print('ready')", timeout: 0 });
}
it.skipIf(!Bun.which("rust-script"))(
	"runs Rust cells and reports compilation errors",
	async () => {
		const tool = new EvalTool(makeSession());
		const success = await tool.execute("rust-success", {
			language: "rust",
			code: 'println!("rust cell {}", 42);',
			timeout: 120,
		});
		expect(success.details?.isError).not.toBe(true);
		expect(JSON.stringify(success.content)).toContain("rust cell 42");
		const failure = await tool.execute("rust-failure", {
			language: "rust",
			code: 'let value: u8 = "wrong";',
			timeout: 120,
		});
		expect(failure.details?.isError).toBe(true);
		expect(JSON.stringify(failure.content)).toContain("mismatched types");
		const cancelled = await tool.execute(
			"rust-cancel",
			{ language: "rust", code: "std::thread::sleep(std::time::Duration::from_secs(60));", timeout: 0 },
			AbortSignal.timeout(1000),
		);
		expect(cancelled.details?.isError).toBe(true);
	},
	180_000,
);

// Real Python kernels only under PI_PYTHON_INTEGRATION=1, like the other real-kernel suites.
const PYTHON_INTEGRATION = Bun.env.PI_PYTHON_INTEGRATION === "1";

// Real timers throughout: neither isolated runtime shares the host's fake clock.
describe("eval cell budget and delegated session tools", () => {
	for (const [language, name] of [
		["js", "task"],
		["js", "wait"],
		["py", "task"],
	] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: returns slow tool.${name} work that outlasts a one-second cell budget`,
			async () => {
				const delegated = slowTool(name);
				const evalTool = new EvalTool(makeSession(delegated.tool));
				await warmEval(evalTool, language);
				const result = await evalTool.execute("slow-delegated-work", {
					language,
					code: `print(await tool.${name}({}))`,
					timeout: 1,
				});

				expect({
					cell: result.details?.cells?.[0],
					delegatedWorkAborted: delegated.aborted(),
				}).toMatchObject({
					cell: { status: "complete", output: expect.stringContaining("review complete") },
					delegatedWorkAborted: false,
				});
			},
			15_000,
		);
	}

	for (const language of ["js", "py"] as const) {
		it.skipIf(language === "py" && !PYTHON_INTEGRATION)(
			`${language}: still aborts an awaited tool.task when the turn is cancelled`,
			async () => {
				const delegated = slowTool("task");
				const evalTool = new EvalTool(makeSession(delegated.tool));
				await warmEval(evalTool, language);
				const controller = new AbortController();
				const pending = evalTool.execute(
					"cancel-delegated-work",
					{ language, code: "print(await tool.task({}))", timeout: 1 },
					controller.signal,
				);

				await delegated.started;
				controller.abort(new Error("turn cancelled"));
				const result = await pending;
				expect(delegated.aborted()).toBe(true);
				expect(result.details?.cells?.[0]?.status).toBe("error");
				expect(result.details?.cells?.[0]?.output).not.toContain("review complete");
			},
			15_000,
		);
	}

	it("js: still charges an ordinary tool call to the cell budget", async () => {
		const ordinary = slowTool("read");
		const evalTool = new EvalTool(makeSession(ordinary.tool));
		await warmEval(evalTool, "js");
		const result = await evalTool.execute("slow-read", {
			language: "js",
			code: "print(await tool.read({}))",
			timeout: 1,
		});

		expect(ordinary.aborted()).toBe(true);
		expect(result.details?.cells?.[0]?.output).toContain("timed out");
		expect(result.details?.cells?.[0]?.output).not.toContain("review complete");
	}, 15_000);

	it("js: interrupts a CPU loop that follows a delegated tool.task", async () => {
		const delegated = slowTool("task");
		const evalTool = new EvalTool(makeSession(delegated.tool));
		await warmEval(evalTool, "js");
		const result = await evalTool.execute("compute-after-delegated-work", {
			language: "js",
			code: "print(await tool.task({}));\nwhile (true) {}",
			timeout: 1,
		});

		expect(delegated.aborted()).toBe(false);
		expect(result.details?.cells?.[0]?.output).toContain("review complete");
		expect(result.details?.cells?.[0]?.output).toContain("timed out");
	}, 15_000);
});
