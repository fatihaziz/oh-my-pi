/**
 * Mechanical carry-forward for structured compaction summaries: restores
 * critical decisions, findings, constraints, and failed approaches dropped
 * across repeated summarization cycles unless covered by both token overlap
 * and matching technical identifiers.
 */

import { stripFactLedger } from "./ledger";

export const CARRIED_HEADINGS = [
	"constraints & preferences",
	"key decisions",
	"findings",
	"approaches that failed",
	"critical context",
] as const;

export const CARRIED_MARKER = "Carried from earlier windows:";
const DEFAULT_KEPT_OVERLAP = 0.6;
const DEFAULT_MAX_CARRIED_TOKENS = 3000;

const HEADING_RE = /^\s*#{2,3}\s+([a-z][a-z &/-]*[a-z])\s*$/i;
const BULLET_RE = /^\s*(?:[-*]|\d+[.)])\s+/;
const CARRIED_MARKER_RE = /^\W*carried from earlier windows:?\W*$/i;
const NOT_ITEM_RE = /^(?:none\.?|\[.*\]|\(none\))$/i;
const FILE_OPS_BLOCK_RE = /<(?:read-files|modified-files)>[\s\S]*?<\/(?:read-files|modified-files)>\s*/gi;
const TECH_IDENT_RE = /[a-z0-9_.-]+[/.][a-z0-9_.-]+|\b[A-Z][A-Z0-9_]{2,}\b|\b\d{2,}\b/g;

interface SectionChunk {
	name: string;
	lines: string[];
}

interface ParsedItem {
	section: string;
	text: string;
	old: boolean;
}

function stripGeneratedBlocks(text: string): string {
	return stripFactLedger(text).replace(FILE_OPS_BLOCK_RE, "").trim();
}

function wordSet(text: string): Set<string> {
	const matches = text.toLowerCase().match(/[a-z0-9_./-]+/g) ?? [];
	const words = new Set<string>();
	for (const raw of matches) {
		const cleaned = raw.replace(/[./-]+$/, "");
		if (cleaned.length >= 3) words.add(cleaned);
	}
	return words;
}

function extractTechnicalIdentifiers(text: string): string[] {
	return [...new Set(text.match(TECH_IDENT_RE) ?? [])];
}

function sectionChunks(text: string): SectionChunk[] {
	const chunks: SectionChunk[] = [{ name: "", lines: [] }];
	for (const line of text.split("\n")) {
		const match = HEADING_RE.exec(line);
		const name = match?.[1]?.replace(/\s+/g, " ").toLowerCase();
		if (name && CARRIED_HEADINGS.includes(name as (typeof CARRIED_HEADINGS)[number])) {
			chunks.push({ name, lines: [line] });
			continue;
		}
		chunks[chunks.length - 1].lines.push(line);
	}
	return chunks;
}

function parseCarriedItems(text: string): ParsedItem[] {
	const items: ParsedItem[] = [];
	for (const chunk of sectionChunks(text)) {
		if (!chunk.name) continue;
		let old = false;
		let current: ParsedItem | undefined;
		for (const line of chunk.lines.slice(1)) {
			const trimmed = line.trim();
			if (CARRIED_MARKER_RE.test(trimmed)) {
				old = true;
				current = undefined;
				continue;
			}
			if (!trimmed) {
				current = undefined;
				continue;
			}
			if (BULLET_RE.test(line) || !current) {
				current = { section: chunk.name, text: trimmed.replace(BULLET_RE, ""), old };
				items.push(current);
			} else {
				current.text += ` ${trimmed}`;
			}
		}
	}
	return items.filter(item => !NOT_ITEM_RE.test(item.text) && wordSet(item.text).size > 0);
}

function isItemCovered(prior: ParsedItem, currentItems: Array<{ raw: string; words: Set<string> }>): boolean {
	const priorWords = wordSet(prior.text);
	if (priorWords.size === 0) return true;
	const priorIdents = extractTechnicalIdentifiers(prior.text);
	return currentItems.some(curr => {
		for (const ident of priorIdents) {
			if (!curr.raw.includes(ident)) return false;
		}
		let overlap = 0;
		for (const word of priorWords) {
			if (curr.words.has(word)) overlap++;
		}
		return overlap >= DEFAULT_KEPT_OVERLAP * priorWords.size;
	});
}

function displayHeading(lower: string): string {
	switch (lower) {
		case "constraints & preferences":
			return "Constraints & Preferences";
		case "key decisions":
			return "Key Decisions";
		case "findings":
			return "Findings";
		case "approaches that failed":
			return "Approaches that failed";
		case "critical context":
			return "Critical Context";
		default:
			return lower;
	}
}

export function carryDroppedSummaryItems(
	previousSummary: string,
	currentSummary: string,
	maxCarriedTokens = DEFAULT_MAX_CARRIED_TOKENS,
): string {
	const cleanPrevious = stripGeneratedBlocks(previousSummary);
	const cleanCurrent = stripGeneratedBlocks(currentSummary);
	if (!cleanPrevious || !cleanCurrent) return currentSummary;

	const currentBySection = new Map<string, Array<{ raw: string; words: Set<string> }>>();
	for (const item of parseCarriedItems(cleanCurrent)) {
		const list = currentBySection.get(item.section) ?? [];
		list.push({ raw: item.text, words: wordSet(item.text) });
		currentBySection.set(item.section, list);
	}

	const dropped = parseCarriedItems(cleanPrevious)
		.filter(item => !isItemCovered(item, currentBySection.get(item.section) ?? []))
		.sort((a, b) => Number(b.old) - Number(a.old));

	let totalTokens = dropped.reduce((sum, item) => sum + Math.ceil((item.text.length + 2) / 4), 0);
	while (totalTokens > maxCarriedTokens && dropped.length > 0) {
		const removed = dropped.shift()!;
		totalTokens -= Math.ceil((removed.text.length + 2) / 4);
	}
	if (dropped.length === 0) return currentSummary;

	const chunks = sectionChunks(cleanCurrent);
	for (const section of CARRIED_HEADINGS) {
		const bullets = dropped.filter(item => item.section === section).map(item => `- ${item.text}`);
		if (bullets.length === 0) continue;
		let chunk = chunks.findLast(candidate => candidate.name === section);
		if (!chunk) {
			chunks[chunks.length - 1].lines.push("");
			chunk = { name: section, lines: [`## ${displayHeading(section)}`] };
			chunks.push(chunk);
		}
		const lines = chunk.lines;
		let end = lines.length;
		while (end > 1 && !lines[end - 1].trim()) end--;
		const hasMarker = lines.slice(1, end).some(line => CARRIED_MARKER_RE.test(line.trim()));
		lines.splice(end, 0, ...(hasMarker ? [] : ["", CARRIED_MARKER]), ...bullets);
	}

	return chunks.flatMap(chunk => chunk.lines).join("\n");
}
