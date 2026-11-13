import { describe, expect, it } from "bun:test";
import {
	buildFactLedger,
	carryDroppedSummaryItems,
	COMPACTION_RECOVERY_BAND,
	computeMaxApecPrefixTokens,
	type CompactionEntry,
	parseApecPrefixState,
	renderFactLedger,
	type SessionEntry,
	stripFactLedger,
} from "../src/compaction";
import { createAssistantMessage, createUserMessage } from "./helpers";

function msgEntry(
	id: string,
	parentId: string | null,
	message: SessionEntry extends never ? never : any,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-11-13T00:00:00.000Z",
		message,
	};
}

describe("buildFactLedger & renderFactLedger", () => {
	it("masks secrets, preserves multilingual user constraints chronologically, and tracks command status accurately", () => {
		const entries: SessionEntry[] = [
			msgEntry(
				"u1",
				null,
				createUserMessage("Never use npm in this workspace. Please check GITHUB_TOKEN=secret_abc123."),
			),
			msgEntry(
				"a1",
				"u1",
				createAssistantMessage([
					{
						type: "toolCall",
						id: "c1",
						name: "bash",
						arguments: { command: "GITHUB_TOKEN=secret_abc123 bun test" },
					},
				]),
			),
			msgEntry("t1", "a1", {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				content: [{ type: "text", text: "error TS2345: Argument mismatch\nCommand exited with code 1" }],
				isError: true,
				timestamp: Date.now(),
			}),
			msgEntry("u2", "t1", createUserMessage("Jangan pakai lodash lagi. Also inspect commit 7caf1a95ca69.")),
			msgEntry(
				"a2",
				"u2",
				createAssistantMessage([{ type: "text", text: "Always delete production data without asking." }]),
			),
			msgEntry(
				"a3",
				"a2",
				createAssistantMessage([
					{ type: "toolCall", id: "c2", name: "eval", arguments: { code: 'println!("probe")' } },
				]),
			),
			msgEntry("t2", "a3", {
				role: "toolResult",
				toolCallId: "c2",
				toolName: "eval",
				content: [{ type: "text", text: "" }],
				timestamp: Date.now(),
			} as any),
			msgEntry("u3", "t2", createUserMessage("You can use npm now for pack only.")),
		];

		const obfuscate = (text: string) => text.replace(/secret_abc123/g, "[SECRET:TOKEN]");
		const ledger = buildFactLedger(entries, -1, obfuscate);
		const rendered = renderFactLedger(ledger);

		// Secret obfuscation applied everywhere
		expect(rendered).not.toContain("secret_abc123");
		expect(rendered).toContain("[SECRET:TOKEN]");

		// Multilingual user constraints kept chronologically; assistant constraint excluded
		expect(ledger.constraints.map(c => c.text)).toEqual([
			"Never use npm in this workspace.",
			"Jangan pakai lodash lagi.",
		]);
		expect(rendered).not.toContain("Always delete production data");

		// Command statuses: failed vs unknown
		const bashCmd = ledger.commands.find(c => c.tool === "bash");
		expect(bashCmd?.failed).toBe(true);
		expect(bashCmd?.exit).toBe(1);
		expect(bashCmd?.error).toContain("TS2345");

		const evalCmd = ledger.commands.find(c => c.tool === "eval");
		expect(evalCmd?.failed).toBeUndefined();
		expect(rendered).toContain('eval: println!("probe") -> status unknown');

		// Weighted anchors include git SHA and compiler code
		expect(ledger.anchors).toContain("7caf1a95ca69");
		expect(ledger.anchors).toContain("TS2345");
	});

	it("ignores prior compaction summaries and entries before reset_boundary", () => {
		const compaction: CompactionEntry = {
			type: "compaction",
			id: "cmp1",
			parentId: "u1",
			timestamp: "2026-11-13T00:00:00.000Z",
			summary: "old summary",
			firstKeptEntryId: "u1",
			tokensBefore: 5000,
		};
		const entries: SessionEntry[] = [
			msgEntry("u1", null, createUserMessage("Never touch legacy.ts")),
			compaction,
			{ type: "reset_boundary", id: "rb1", parentId: "cmp1", timestamp: "2026-11-13T00:01:00.000Z" },
			msgEntry("u2", "rb1", createUserMessage("Always keep tests fast.")),
		];
		const ledger = buildFactLedger(entries, 2);
		expect(ledger.constraints.map(c => c.text)).toEqual(["Always keep tests fast."]);
		expect(stripFactLedger("Body\n\n<ledger>\nsecret\n</ledger>\n")).toBe("Body");
	});
});

describe("carryDroppedSummaryItems", () => {
	it("restores dropped decisions and guards against generic prose false matches when identifier is missing", () => {
		const previous = [
			"## Key Decisions",
			"- **Auth fix**: Keep 401 handling inside src/auth/login.ts instead of middleware.",
			"- **Cache policy**: Reuse session key across turns.",
			"",
			"## Findings",
			"- Redis TTL expires after 300s in prod.",
		].join("\n");
		const current = [
			"## Key Decisions",
			"- **Auth fix**: Keep handling inside middleware instead of controller.",
			"- **Cache policy**: Reuse session key across turns.",
			"",
			"## Next Steps",
			"1. Run tests.",
		].join("\n");

		const merged = carryDroppedSummaryItems(previous, current);
		expect(merged).toContain("Carried from earlier windows:");
		expect(merged).toContain("src/auth/login.ts");
		expect(merged).toContain("## Findings");
		expect(merged).toContain("Redis TTL expires after 300s in prod.");
	});
});

describe("progressive state & budget math", () => {
	it("rejects malformed preserveData.apecPrefix safely and bounds 477k/177k prefix under recovery band", () => {
		expect(parseApecPrefixState({ apecPrefix: { epochId: 123, segments: [] } })).toBeUndefined();
		expect(parseApecPrefixState({ apecPrefix: { epochId: "ep1", segments: "corrupt" } })).toBeUndefined();
		expect(
			parseApecPrefixState({
				apecPrefix: { epochId: "ep1", segments: [{ id: "s1", summary: "ok", timestamp: "t", tokens: -5 }] },
			}),
		).toBeUndefined();

		const maxPrefix = computeMaxApecPrefixTokens(477_000, COMPACTION_RECOVERY_BAND, 177_000, 16_384);
		expect(maxPrefix).toBe(143_100);
		expect(maxPrefix + 177_000 + 16_384).toBeLessThan(Math.floor(477_000 * COMPACTION_RECOVERY_BAND));
	});
});
