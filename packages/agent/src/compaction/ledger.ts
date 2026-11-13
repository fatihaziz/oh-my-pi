/**
 * Bounded code-extracted fact ledger: captures tool command outcomes, verbatim
 * user constraints (multilingual), weighted technical anchors, and goal changes
 * directly from raw user/tool entries so facts do not decay across repeated
 * summary rewrites.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { SessionEntry } from "./entries";

export interface CommandFact {
	tool: string;
	command: string;
	exit?: number;
	failed?: boolean;
	error?: string;
	index: number;
}

export interface ConstraintFact {
	text: string;
	index: number;
	sourceRole: "user";
}

export interface FactLedger {
	commands: CommandFact[];
	constraints: ConstraintFact[];
	anchors: string[];
	goalChanges: string[];
	latestUserRequest?: string;
}

const MAX_COMMANDS = 20;
const MAX_CONSTRAINTS = 16;
const MAX_ANCHORS = 12;
const MAX_GOAL_CHANGES = 5;
const CONSTRAINT_MIN_CHARS = 12;
const CONSTRAINT_MAX_CHARS = 240;

const RUN_TOOL_RE = /bash|eval|exec|run|shell|terminal/i;
const SIGNIFICANT_CMD_RE =
	/(?<![\w/.-])(?:test|vitest|jest|pytest|build|tsc|typecheck|lint|deploy|compile|check|install|migrate|cargo|bun|rust-script)(?![\w/.-])/i;
const EXIT_STATUS_RE = /exit(?:ed)?(?:\s+with)?\s+(?:code|status)[:=\s]+(-?\d+)/gi;
const FAILURE_LINE_RE =
	/\w*(?:Error|Exception)\b:|\berror(?:\[\w+\])?:|\bpanicked\b|\bTS\d{4}\b|\bFAIL\b|command not found|non-zero exit|failed with exit|\bSIG(?:SEGV|ABRT|KILL|TERM)\b/i;

const CONSTRAINT_OPEN_RE =
	/^(?:please\s+|you\s+|tolong\s+)?(?:never|always|only|avoid|stop using|make sure|do not|don't(?!\s+(?:worry|mind|bother)\b)|must|should(?:n't| not| never| always)?|jangan|harus|selalu|hanya|hindari|pastikan|dilarang|tetap|wajib|usahakan)\b/i;
const GOAL_CHANGE_RE =
	/^(?:instead\b|actually,?\s+(?:let'?s|instead|forget|scrap)\b|forget (?:that|it|about|everything)\b|scratch that\b|new plan\b|change of plan\b|ganti rencana\b|lupakan\b|batalkan\b)/i;

const ANCHOR_PATTERNS: RegExp[] = [
	/https?:\/\/[^\s)"'<>\]\\]+/g,
	/(?<![-/#\w])(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])(?!(?:[ae]|([bcdf])\1?(?![bcdf])){4,}\d+\b)[0-9a-f]{7,40}\b/g,
	/(?:\bPR\s?#?|\bissue\s?#?|(?<=^|[\s([]|[\w.-]\/[\w.-]+)#(?!\d{6}\b))\d{2,6}\b/gim,
	/\b[A-Z][A-Z0-9]*_[A-Z0-9_]{2,}\b/g,
	/\bE(?:NOENT|ACCES|PERM|PIPE|IO|BUSY|EXIST|INVAL|AGAIN|MFILE|NOSPC|ISDIR|NOTDIR|NOTEMPTY|CONNREFUSED|CONNRESET|TIMEDOUT|ADDRINUSE|HOSTUNREACH|NETUNREACH|LIFECYCLE)\b/g,
	/\b(?:TS|E|ERR)\d{3,5}\b/g,
];

const LEDGER_BLOCK_RE = /<ledger>[\s\S]*?<\/ledger>\s*/gi;

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

function clipFlat(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function clipLine(text: string, max: number): string {
	const first = (text.split("\n", 1)[0] ?? "").trim();
	return first.length <= max ? first : `${first.slice(0, max - 1)}…`;
}

function sniffExitCode(text: string): number | undefined {
	let last: number | undefined;
	EXIT_STATUS_RE.lastIndex = 0;
	for (let match = EXIT_STATUS_RE.exec(text); match !== null; match = EXIT_STATUS_RE.exec(text)) {
		const parsed = Number(match[1]);
		if (Number.isInteger(parsed)) last = parsed;
	}
	return last;
}

function findErrorLine(text: string): string {
	const lines = text.split("\n");
	const specific =
		lines.find(line => /\w*(?:Error|Exception)\b:|\berror(?:\[\w+\])?:|\bpanicked\b|\bTS\d{4}\b/.test(line)) ??
		lines.find(line => FAILURE_LINE_RE.test(line));
	return clipLine(specific ?? text, 160);
}

function splitUserSentences(text: string): string[] {
	const unwrapped = text.replace(/([^\n.!?:])\n(?![-*#\d\n])/g, "$1 ");
	return unwrapped.split(/(?<=[.!?])\s+(?=[\p{L}])|\n+/u);
}

export function stripFactLedger(text: string): string {
	return text.replace(LEDGER_BLOCK_RE, "").trim();
}

export function buildFactLedger(
	pathEntries: readonly SessionEntry[],
	resetBoundaryIndex: number,
	obfuscate?: (text: string) => string,
): FactLedger {
	const mask = obfuscate ?? ((text: string) => text);
	const start = Math.max(0, resetBoundaryIndex + 1);
	const source: Array<{ index: number; message: Record<string, unknown> & { role: string } }> = [];
	const userTexts: Array<{ index: number; text: string }> = [];

	for (let i = start; i < pathEntries.length; i++) {
		const entry = pathEntries[i];
		if (entry.type !== "message") continue;
		const message = entry.message as unknown as Record<string, unknown> & { role: string };
		const text = message.role === "user" ? extractMessageText(message.content) : "";
		if (message.role === "user") {
			const trimmed = text.trim();
			if (!trimmed || trimmed.startsWith("Ran `") || trimmed.includes("<summary>") || trimmed.includes("<ledger>")) {
				continue;
			}
			userTexts.push({ index: i, text });
		}
		source.push({ index: i, message });
	}

	// User constraints (chronological; no heuristic deletion)
	const constraintMap = new Map<string, number>();
	const goalChanges: string[] = [];
	for (const item of userTexts) {
		const trimmed = item.text.trim();
		if (GOAL_CHANGE_RE.test(trimmed)) {
			goalChanges.push(mask(clipFlat(trimmed, 200)));
		}
		for (const raw of splitUserSentences(item.text)) {
			const sentence = raw
				.replace(/^[-*]\s*/, "")
				.replace(/\s+/g, " ")
				.trim();
			if (sentence.length < CONSTRAINT_MIN_CHARS || sentence.length > CONSTRAINT_MAX_CHARS) continue;
			if (sentence.endsWith("?")) continue;
			if (!CONSTRAINT_OPEN_RE.test(sentence)) continue;
			const masked = mask(sentence);
			constraintMap.delete(masked);
			constraintMap.set(masked, item.index);
		}
	}
	const constraints: ConstraintFact[] = [...constraintMap.entries()]
		.slice(-MAX_CONSTRAINTS)
		.map(([text, index]) => ({ text, index, sourceRole: "user" }));

	// Command outcomes (paired toolCall + toolResult, newest first)
	const commandsByCallId = new Map<string, string>();
	for (const item of source) {
		if (item.message.role !== "assistant" || !Array.isArray(item.message.content)) continue;
		for (const block of item.message.content) {
			if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
			const args = isRecord(block.arguments) ? block.arguments : undefined;
			if (!args) continue;
			const rawCmd = args.command ?? args.cmd ?? args.code;
			const cmdText =
				typeof rawCmd === "string"
					? rawCmd
					: Array.isArray(rawCmd)
						? rawCmd.filter((part): part is string => typeof part === "string").join(" ")
						: undefined;
			if (cmdText) commandsByCallId.set(block.id, cmdText);
		}
	}

	const allCommands: CommandFact[] = [];
	const seenCommands = new Set<string>();
	for (let i = source.length - 1; i >= 0; i--) {
		const item = source[i];
		if (item.message.role !== "toolResult") continue;
		const toolName = typeof item.message.toolName === "string" ? item.message.toolName : "";
		if (!RUN_TOOL_RE.test(toolName)) continue;
		const callId = typeof item.message.toolCallId === "string" ? item.message.toolCallId : undefined;
		const rawCmd = callId ? commandsByCallId.get(callId) : undefined;
		if (!rawCmd) continue;
		const command = mask(clipLine(rawCmd, 160));
		if (!command || seenCommands.has(command)) continue;
		seenCommands.add(command);

		const outputText = extractMessageText(item.message.content);
		const exit = sniffExitCode(outputText);
		const isErrFlag = item.message.isError === true;
		const hasFailurePattern = FAILURE_LINE_RE.test(outputText);
		let failed: boolean | undefined;
		if (isErrFlag || (exit !== undefined && exit !== 0) || hasFailurePattern) {
			failed = true;
		} else if (exit === 0 || (item.message.isError === false && outputText.trim().length > 0)) {
			failed = false;
		}
		allCommands.push({
			tool: toolName,
			command,
			...(exit !== undefined ? { exit } : {}),
			...(failed !== undefined ? { failed } : {}),
			...(failed === true ? { error: mask(findErrorLine(outputText)) } : {}),
			index: item.index,
		});
	}
	const prioritized = new Set(
		allCommands.filter(cmd => cmd.failed === true || SIGNIFICANT_CMD_RE.test(cmd.command)).slice(0, MAX_COMMANDS),
	);
	for (const cmd of allCommands) {
		if (prioritized.size >= MAX_COMMANDS) break;
		prioritized.add(cmd);
	}
	const commands = allCommands.filter(cmd => prioritized.has(cmd));

	// Anchors weighted by message role (3x user/assistant, 1x toolResult)
	const df = new Map<string, number>();
	for (const item of source) {
		const role = item.message.role;
		const weight = role === "user" || role === "assistant" ? 3 : 1;
		const cleaned = extractMessageText(item.message.content)
			.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, " ")
			.replace(/artifact[= ][0-9a-f]{12}\b/gi, " ");
		if (!cleaned.trim()) continue;
		const seen = new Set<string>();
		for (const pattern of ANCHOR_PATTERNS) {
			pattern.lastIndex = 0;
			for (const hit of cleaned.match(pattern) ?? []) {
				const token = hit.replace(/[.,;:]+$/, "").replace(/^(?:PR|issue)\s?#?/i, "#");
				if (token.length >= 3 && (token.startsWith("#") || token.length >= 5)) {
					seen.add(mask(token));
				}
			}
		}
		for (const token of seen) {
			df.set(token, (df.get(token) ?? 0) + weight);
		}
	}
	const anchors = [...df.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_ANCHORS)
		.map(([token]) => token);

	const latest = userTexts[userTexts.length - 1]?.text;
	return {
		commands,
		constraints,
		anchors,
		goalChanges: goalChanges.slice(-MAX_GOAL_CHANGES),
		...(latest ? { latestUserRequest: mask(clipFlat(latest, 300)) } : {}),
	};
}

export function renderFactLedger(ledger: FactLedger): string {
	const sections: string[] = [];
	if (ledger.commands.length > 0) {
		const lines = ledger.commands.map(cmd => {
			if (cmd.failed === true) {
				const exitText = cmd.exit !== undefined ? ` (exit ${cmd.exit})` : "";
				return `- ${cmd.tool}: ${cmd.command} -> FAILED${exitText}${cmd.error ? `: ${cmd.error}` : ""}`;
			}
			if (cmd.failed === false) {
				return `- ${cmd.tool}: ${cmd.command} -> ${cmd.exit !== undefined ? `exit ${cmd.exit}` : "ok"}`;
			}
			return `- ${cmd.tool}: ${cmd.command} -> status unknown`;
		});
		sections.push(`<commands newest-first>\n${lines.join("\n")}\n</commands>`);
	}
	if (ledger.constraints.length > 0) {
		const lines = ledger.constraints.map(c => `- [turn #${c.index}] ${c.text}`);
		sections.push(`<user-constraints>\n${lines.join("\n")}\n</user-constraints>`);
	}
	if (ledger.goalChanges.length > 0) {
		sections.push(`<goal-changes>\n${ledger.goalChanges.map(g => `- ${g}`).join("\n")}\n</goal-changes>`);
	}
	if (ledger.anchors.length > 0) {
		sections.push(`<anchors>\n${ledger.anchors.join("\n")}\n</anchors>`);
	}
	if (ledger.latestUserRequest) {
		sections.push(`<latest-user-request>${ledger.latestUserRequest}</latest-user-request>`);
	}
	if (sections.length === 0) return "";
	return [
		"<ledger>",
		"Extracted by code from raw user/tool entries (bounded; chronological).",
		...sections,
		"</ledger>",
	].join("\n");
}
