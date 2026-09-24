import { afterEach, expect, test, vi } from "bun:test";
import * as path from "node:path";
import factory from "../../../.omp/tools/tui";

const schema = { describe: () => schema, optional: () => schema };
const tool = factory({
	cwd: path.resolve(import.meta.dir, "../../.."),
	zod: {
		object: () => schema,
		string: () => schema,
		boolean: () => schema,
		number: () => schema,
		array: () => schema,
	},
});

afterEach(() => {
	tool.onSession({ reason: "shutdown" });
	vi.restoreAllMocks();
});

for (const teardown of ["stop", "shutdown"] as const) {
	test(`late PTY output after ${teardown} cannot touch the freed screen or a replacement session`, async () => {
		const spawn = vi.spyOn(Bun, "spawn");
		const start = () =>
			tool.execute("start", {
				op: "start",
				name: "lifecycle",
				file: "packages/coding-agent/test/fixtures/tui-output-child.ts",
				timeout: 0,
			});
		await start();
		const calls = spawn.mock.calls as unknown as [string[], { terminal: Bun.TerminalOptions }][];
		const data = calls[0][1].terminal.data;
		const child = spawn.mock.results[0].value as Bun.Subprocess;
		if (!data || !child.terminal) throw new Error("Missing PTY callback");
		data(child.terminal, Buffer.from("before-close"));
		const before = await tool.execute("screen", { op: "screen", name: "lifecycle" });
		expect(before.content).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("before-close") })]),
		);

		if (teardown === "stop") await tool.execute("stop", { op: "stop", name: "lifecycle" });
		else tool.onSession({ reason: "shutdown" });
		// Replay a callback already queued by the native PTY when close returned.
		data(child.terminal, Buffer.from("late-old-output\x1b[6n"));
		await child.exited;
		expect((await tool.execute("list", { op: "list" })).content).toEqual([{ type: "text", text: "no sessions" }]);

		await start();
		data(child.terminal, Buffer.from("stale-session-output"));
		const replacement = spawn.mock.results[1].value as Bun.Subprocess;
		const freshData = calls[1][1].terminal.data;
		if (!freshData || !replacement.terminal) throw new Error("Missing replacement PTY");
		freshData(replacement.terminal, Buffer.from("replacement-alive"));
		const screen = await tool.execute("screen", { op: "screen", name: "lifecycle" });
		const text = screen.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		expect(text).toContain("replacement-alive");
		expect(text).not.toContain("late-old-output");
		expect(text).not.toContain("stale-session-output");
		await tool.execute("stop", { op: "stop", name: "lifecycle" });
	}, 15_000);
}
