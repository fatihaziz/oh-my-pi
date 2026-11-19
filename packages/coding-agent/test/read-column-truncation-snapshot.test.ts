/**
 * Regression: column truncation in `read` is display-only. The snapshot
 * recorded for the hashline TAG returned to the model MUST contain the
 * on-disk content, not the ellipsis-truncated display content.
 *
 * Before the fix, `collectedLines` was mutated in place with `…`-terminated
 * lines and that mutated array was passed straight to the snapshot store.
 * Every subsequent edit on a file with any line wider than
 * `tools.outputMaxColumns` failed with a permanent hash-mismatch loop
 * (`Section is bound to #XYZ, but the current file hashes to #ABC`).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { getEditStore } from "@oh-my-pi/pi-coding-agent/edit/store";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { GrepTool } from "@oh-my-pi/pi-coding-agent/tools/grep";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

import { cfgReadSummarizeEnabled, cfgToolsOutputMaxColumns } from "@oh-my-pi/pi-coding-agent/tools/settings";

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/m;
const COLUMN_CAP = 64;
const LONG_LINE_LEN = COLUMN_CAP * 3;

function textOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(c => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

function createSession(cwd: string): ToolSession {
	const settings = Settings.isolated();
	cfgToolsOutputMaxColumns.set(settings, COLUMN_CAP);
	cfgReadSummarizeEnabled.set(settings, false);
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async () => ({ id: "artifact-1", path: path.join(cwd, "artifact-1.log") }),
		settings,
		enableLsp: false,
	};
}

function extractHeader(text: string): { header: string; tag: string; relPath: string } {
	const match = HASHLINE_HEADER_LINE.exec(text);
	if (!match) throw new Error(`no hashline header in:\n${text}`);
	const [header, relPath, tag] = match;
	return { header: header!, tag: tag!, relPath: relPath! };
}

async function applyEditWithTag(args: { session: ToolSession; header: string; patchBody: string }): Promise<void> {
	const patchInput = `${args.header}\n${args.patchBody}`;
	await new EditTool(args.session, "hashline").execute("call-edit", { input: patchInput });
}

describe("read tool column truncation vs hashline snapshot", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-column-trunc-test-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("snapshot keeps untruncated content for a full-file read with long lines", async () => {
		const filePath = path.join(tmpDir, "wide.txt");
		const longLine = "x".repeat(LONG_LINE_LEN);
		const fullText = `first short line\n${longLine}\nthird short line\n`;
		await fs.writeFile(filePath, fullText);

		const session = createSession(tmpDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call-1", { path: filePath });
		const text = textOutput(result);

		// Sanity: display IS column-truncated.
		expect(text).toContain("…");
		expect(text).not.toContain(longLine);

		const { tag } = extractHeader(text);
		const snapshot = getEditStore(session).byHashText(filePath, tag);
		expect(snapshot).not.toBeNull();

		// The snapshot MUST hold the on-disk text, not the display-truncated version.
		expect(snapshot).toBe(fullText);
		expect(snapshot?.split("\n")[1]).toBe(longLine);
	});

	it("range read snapshot keeps untruncated content for long lines", async () => {
		const filePath = path.join(tmpDir, "wide-range.txt");
		const longLine = "y".repeat(LONG_LINE_LEN);
		const fullText = `head\n${longLine}\ntail\n`;
		await fs.writeFile(filePath, fullText);

		const session = createSession(tmpDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call-range", { path: `${filePath}:1-3` });
		const text = textOutput(result);
		expect(text).toContain("…");

		const { tag } = extractHeader(text);
		const snapshot = getEditStore(session).byHashText(filePath, tag);
		expect(snapshot?.split("\n")[1]).toBe(longLine);
	});

	it("multi-range read snapshot keeps untruncated content for long lines", async () => {
		const filePath = path.join(tmpDir, "wide-multi.txt");
		const longLine = "z".repeat(LONG_LINE_LEN);
		const fullText = ["a", longLine, "c", "d", "e", longLine, "g"].join("\n");
		await fs.writeFile(filePath, fullText);

		const session = createSession(tmpDir);
		const tool = new ReadTool(session);
		const result = await tool.execute("call-multi", { path: `${filePath}:1-2,6-7` });
		const text = textOutput(result);
		expect(text).toContain("…");

		const { tag } = extractHeader(text);
		const snapshot = getEditStore(session).byHashText(filePath, tag);
		expect(snapshot?.split("\n")[1]).toBe(longLine);
		expect(snapshot?.split("\n")[5]).toBe(longLine);
	});

	it("edit can apply against a file with long lines without re-reading", async () => {
		// The bug: after reading a file with column-truncated lines, ANY follow-up
		// hashline edit failed with "current file hashes to #XYZ" because the
		// recorded snapshot held `…`-suffixed lines instead of the on-disk content.
		const filePath = path.join(tmpDir, "editable-wide.txt");
		const longLine = "w".repeat(LONG_LINE_LEN);
		const original = `intro\n${longLine}\noutro\n`;
		await fs.writeFile(filePath, original);

		const session = createSession(tmpDir);
		const readTool = new ReadTool(session);
		const readResult = await readTool.execute("call-read", { path: filePath });
		const readText = textOutput(readResult);
		const { header } = extractHeader(readText);

		// Replace line 3 ("outro") using the TAG returned by the truncating read.
		await applyEditWithTag({
			session,
			header,
			patchBody: "PUT 3-3:\n+epilogue\n",
		});

		const after = await fs.readFile(filePath, "utf8");
		expect(after).toBe(`intro\n${longLine}\nepilogue\n`);
	});

	it("rejects a PUT or CUT of a column-cut line until a raw read shows its tail", async () => {
		const filePath = path.join(tmpDir, "tail.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `first\n${longLine}\nlast\n`;
		await fs.writeFile(filePath, original);

		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 768);
		const readTool = new ReadTool(session);
		const readText = textOutput(await readTool.execute("read-cut", { path: filePath }));
		const { header } = extractHeader(readText);
		const shownLine = readText
			.split("\n")
			.find(line => line.startsWith("2:"))!
			.slice(2);
		expect(shownLine.endsWith("…")).toBe(true);

		const editTool = new EditTool(session, "hashline");
		for (const body of [
			`PUT 2.=2:\n+${shownLine.slice(0, -1).replace("note:", "NOTE:")}\n`,
			`PUT 2.=2:\n+${shownLine.replace("note:", "NOTE:")}\n`,
			"CUT 2.=2\n",
		]) {
			const result = await editTool.execute("edit-cut", { input: `${header}\n${body}` });
			expect(textOutput(result)).toContain("tail.txt:2:raw");
			expect(await fs.readFile(filePath, "utf8")).toBe(original);
		}

		const raw = textOutput(await readTool.execute("read-raw", { path: `${filePath}:2-2:raw` }));
		expect(raw).toContain(longLine);
		await editTool.execute("edit-full", {
			input: `${header}\nPUT 2.=2:\n+${longLine.replace("note:", "NOTE:")}\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe(original.replace("note:", "NOTE:"));
	});

	it("rejects a cut line in a multi-range read but allows edits to the other displayed range", async () => {
		const filePath = path.join(tmpDir, "multi-cut.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `first\n${longLine}\nthird\nfourth\n`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 768);
		const readText = textOutput(
			await new ReadTool(session).execute("read-multi-cut", { path: `${filePath}:2-2,4-4` }),
		);
		const { header } = extractHeader(readText);
		const editTool = new EditTool(session, "hashline");
		const cut = await editTool.execute("edit-multi-cut", {
			input: `${header}\nCUT 2.=2\n`,
		});
		expect(textOutput(cut)).toContain("multi-cut.txt:2:raw");
		expect(await fs.readFile(filePath, "utf8")).toBe(original);
		await editTool.execute("edit-multi-full", {
			input: `${header}\nPUT 4.=4:\n+FOURTH\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe(original.replace("fourth", "FOURTH"));
	});

	it("rejects a block PUT or CUT whose interior holds a column-cut line", async () => {
		const filePath = path.join(tmpDir, "block.ts");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `function f() {\n\tconst x = "${longLine}";\n\treturn x;\n}\n`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 768);
		const readText = textOutput(await new ReadTool(session).execute("read-block", { path: filePath }));
		const { header } = extractHeader(readText);
		const shownLine = readText
			.split("\n")
			.find(line => line.startsWith("2:"))!
			.slice(2, -1);
		const editTool = new EditTool(session, "hashline");
		for (const body of [`PUT 1*:\n+function f() {\n+${shownLine}\n+\treturn x.trim();\n+}\n`, "CUT 1*\n"]) {
			const result = await editTool.execute("edit-block", { input: `${header}\n${body}` });
			expect(textOutput(result)).toContain("block.ts:2:raw");
			expect(await fs.readFile(filePath, "utf8")).toBe(original);
		}
	});

	it("marks a line seen when column capping is disabled", async () => {
		const filePath = path.join(tmpDir, "uncapped.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		await fs.writeFile(filePath, `${longLine}\n`);
		const session = createSession(tmpDir);
		cfgToolsOutputMaxColumns.set(session.settings, 0);
		const readText = textOutput(await new ReadTool(session).execute("read-full", { path: filePath }));
		const { header } = extractHeader(readText);
		await new EditTool(session, "hashline").execute("edit-full", {
			input: `${header}\nPUT 1.=1:\n+${longLine.replace("note:", "NOTE:")}\n`,
		});
		expect(await fs.readFile(filePath, "utf8")).toBe(`${longLine.replace("note:", "NOTE:")}\n`);
	});

	it("does not treat a clipped grep match as an editable full line", async () => {
		const filePath = path.join(tmpDir, "grep-wide.txt");
		const longLine = `note: ${"abcdefghij".repeat(80)} END-OF-LINE-TAIL`;
		const original = `${longLine}\n`;
		await fs.writeFile(filePath, original);
		const session = createSession(tmpDir);
		const grepText = textOutput(
			await new GrepTool(session).execute("grep-cut", {
				pattern: "note:",
				path: filePath,
			}),
		);
		expect(grepText).not.toContain("END-OF-LINE-TAIL");
		const tag = getEditStore(session).headHash(filePath);
		expect(tag).not.toBeNull();
		const result = await new EditTool(session, "hashline").execute("edit-grep-cut", {
			input: `[${filePath}#${tag}]\nPUT 1.=1:\n+NOTE: cut\n`,
		});
		expect(textOutput(result)).toContain("grep-wide.txt:1:raw");
		expect(await fs.readFile(filePath, "utf8")).toBe(original);
	});

	it("keeps a genuine blank line editable without exposing the EOF sentinel", async () => {
		const filePath = path.join(tmpDir, "eof-blank.txt");
		await fs.writeFile(filePath, "first\n\nlast\n");

		const session = createSession(tmpDir);
		const readText = textOutput(await new ReadTool(session).execute("call-eof-blank", { path: filePath }));
		expect(readText).toContain("1:first\n2:\n3:last");
		expect(readText).not.toContain("\n4:");

		const { header } = extractHeader(readText);
		await applyEditWithTag({
			session,
			header,
			patchBody: "CUT 2\n",
		});

		expect(await fs.readFile(filePath, "utf8")).toBe("first\nlast\n");
	});

	describe("local:// span replacements over wide clipped rows", () => {
		const WIDE = new Map([
			[132, 818],
			[153, 1266],
			[191, 776],
		]);

		function wideRows(): string[] {
			return Array.from({ length: 300 }, (_, i) => {
				const n = i + 1;
				const id = `old-${String(n).padStart(3, "0")}`;
				const width = WIDE.get(n);
				if (!width) return id;
				const tail = ` TAIL-${n}-END`;
				return `${id} ${"q".repeat(width - id.length - 1 - tail.length)}${tail}`;
			});
		}

		function localSession(): { session: ToolSession; root: string } {
			const session: ToolSession = {
				...createSession(tmpDir),
				getSessionId: () => "wide-session",
				getPlanModeState: () => ({ enabled: true, planFilePath: "local://wide-plan.md" }),
			};
			cfgToolsOutputMaxColumns.set(session.settings, 768);
			const root = resolveLocalRoot({ getArtifactsDir: session.getArtifactsDir, getSessionId: session.getSessionId });
			return { session, root };
		}

		async function seed(root: string, name: string, rows = wideRows()): Promise<{ file: string; text: string }> {
			await fs.mkdir(root, { recursive: true });
			const file = path.join(root, name);
			const text = `${rows.join("\n")}\n`;
			await fs.writeFile(file, text);
			return { file, text };
		}

		async function readTag(session: ToolSession, selector: string): Promise<{ tag: string; text: string }> {
			const text = textOutput(await new ReadTool(session).execute("read-local", { path: selector }));
			return { tag: extractHeader(text).tag, text };
		}

		async function run(
			session: ToolSession,
			input: string,
		): Promise<AgentToolResult<{ diff?: string; errorKind?: string }>> {
			return (await new EditTool(session, "hashline").execute("edit-local", { input })) as AgentToolResult<{
				diff?: string;
				errorKind?: string;
			}>;
		}

		it("applies a local plan patch with three wide unseen anchors in one call", async () => {
			const { session, root } = localSession();
			const { file } = await seed(root, "wide-plan.md");
			const { tag, text: readText } = await readTag(session, "local://wide-plan.md:1-220");
			// A file-backed local:// read heads its output with the backing path.
			const { relPath } = extractHeader(readText);
			expect(relPath.replaceAll("\\", "/").endsWith("local/wide-plan.md")).toBe(true);
			expect(tag).toMatch(/^[0-9A-F]{4}$/);
			for (const n of WIDE.keys()) {
				const shown = readText.split("\n").find(line => line.startsWith(`${n}:`))!;
				expect(shown.endsWith("…")).toBe(true);
				expect(shown).not.toContain(`TAIL-${n}-END`);
			}
			const added = Array.from({ length: 300 }, (_, i) => `added-${String(i + 1).padStart(3, "0")}`);
			const input = [
				`[local://wide-plan.md#${tag}]`,
				"PUT 4.=4:",
				"+new-004",
				"PUT 132.=132:",
				"+new-132",
				"PUT 153.=154:",
				"+new-153",
				"+new-154",
				"PUT 191.=191:",
				"+new-191",
				"PUT >212:",
				...added.map(row => `+${row}`),
				"",
			].join("\n");
			const result = await run(session, input);
			expect(result.isError).not.toBe(true);
			const output = textOutput(result);

			const expected = wideRows().flatMap((row, i) => {
				const n = i + 1;
				if (n === 4) return ["new-004"];
				if (n === 132) return ["new-132"];
				if (n === 153) return ["new-153"];
				if (n === 154) return ["new-154"];
				if (n === 191) return ["new-191"];
				if (n === 212) return [row, ...added];
				return [row];
			});
			expect(await fs.readFile(file, "utf8")).toBe(`${expected.join("\n")}\n`);
			expect(output).toMatch(new RegExp(`\\[local://wide-plan\\.md#(?!${tag}\\])[0-9A-F]{4}\\]`));
			expect(output.match(/Warnings:/g)?.length).toBe(1);
			expect(output.match(/Applied as written:/g)?.length).toBe(1);
			expect(output).toContain(
				"Applied as written: local://wide-plan.md replaced original lines 132, 153, 191, which were not displayed in full. The replacement may have removed unseen text.",
			);
			expect(output).toContain("Do not resend the patch.");
			expect(output).not.toContain("154, 191");
			const diff = result.details?.diff ?? "";
			for (const n of WIDE.keys()) expect(diff).toContain(`TAIL-${n}-END`);
		});

		it("keeps every staged file unchanged when a later section fails", async () => {
			const { session, root } = localSession();
			const first = await seed(root, "wide-plan.md");
			const second = await seed(
				root,
				"other.md",
				wideRows().map(row => row.replace("old-", "other-")),
			);
			const { tag: firstTag } = await readTag(session, "local://wide-plan.md:1-220");
			const { tag: secondTag } = await readTag(session, "local://other.md:1-220");
			const result = await run(
				session,
				`[local://wide-plan.md#${firstTag}]\nPUT 132.=132:\n+new-132\n[local://other.md#${secondTag}]\nPUT 999.=999:\n+nope\n`,
			);
			expect(result.isError).toBe(true);
			expect(textOutput(result)).not.toContain("Applied as written");
			expect(await fs.readFile(first.file, "utf8")).toBe(first.text);
			expect(await fs.readFile(second.file, "utf8")).toBe(second.text);
		});

		it("rejects a bodyless cut, an empty PUT, and a span with a short unseen row", async () => {
			const { session, root } = localSession();
			const { file, text } = await seed(root, "wide-plan.md");
			const { tag } = await readTag(session, "local://wide-plan.md:1-220");
			for (const body of ["CUT 132.=132\n", "PUT 132.=132:\n"]) {
				const result = await run(session, `[local://wide-plan.md#${tag}]\n${body}`);
				expect(result.isError).toBe(true);
				expect(result.details?.errorKind).toBe("unseen_lines");
				expect(textOutput(result)).not.toContain("Applied as written");
				expect(await fs.readFile(file, "utf8")).toBe(text);
			}
			// A fresh session: the first one's 1-220 read would fuse row 133 into the seen set.
			const { session: mixedSession } = localSession();
			const { tag: mixedTag } = await readTag(mixedSession, "local://wide-plan.md:131-132,134-134");
			const result = await run(mixedSession, `[local://wide-plan.md#${mixedTag}]\nPUT 132.=134:\n+new-132\n`);
			expect(result.isError).toBe(true);
			expect(result.details?.errorKind).toBe("unseen_lines");
			expect(textOutput(result)).not.toContain("Applied as written");
			expect(await fs.readFile(file, "utf8")).toBe(text);
		});

		it("rejects a stale tag whose target row changed", async () => {
			const { session, root } = localSession();
			const { file } = await seed(root, "wide-plan.md");
			const { tag } = await readTag(session, "local://wide-plan.md:1-220");
			const rows = wideRows();
			rows[131] = `changed-132 ${"z".repeat(900)} CHANGED-TAIL`;
			const newer = `${rows.join("\n")}\n`;
			await fs.writeFile(file, newer);
			const result = await run(session, `[local://wide-plan.md#${tag}]\nPUT 132.=132:\n+new-132\n`);
			expect(result.isError).toBe(true);
			expect(result.details?.errorKind).toBe("stale_tag");
			expect(textOutput(result)).not.toContain("Applied as written");
			expect(await fs.readFile(file, "utf8")).toBe(newer);
		});
	});
});
