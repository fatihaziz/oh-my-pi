/**
 * APEC append-only progressive summary segments: accumulates immutable segment
 * summaries within an epoch so provider KV prefix caches stay warm across
 * compaction boundaries until prefix headroom triggers an epoch consolidation.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import { stripFactLedger } from "./ledger";

export interface ApecSegment {
	id: string;
	summary: string;
	timestamp: string;
	tokens: number;
}

export interface ApecPrefixState {
	epochId: string;
	segments: ApecSegment[];
}

export const APEC_PREFIX_PRESERVE_KEY = "apecPrefix";
export const APEC_PREFIX_MAX_SHARE = 0.3;
const APEC_FOOTER_SAFETY_MARGIN = 16_000;

const FILE_OPS_BLOCK_RE = /<(?:read-files|modified-files)>[\s\S]*?<\/(?:read-files|modified-files)>\s*/gi;
const LEDGER_EXTRACT_RE = /<ledger>[\s\S]*?<\/ledger>/i;
const READ_FILES_EXTRACT_RE = /<read-files>[\s\S]*?<\/read-files>/i;
const MODIFIED_FILES_EXTRACT_RE = /<modified-files>[\s\S]*?<\/modified-files>/i;

export function parseApecPrefixState(preserveData: Record<string, unknown> | undefined): ApecPrefixState | undefined {
	if (!isRecord(preserveData)) return undefined;
	const raw = preserveData[APEC_PREFIX_PRESERVE_KEY];
	if (!isRecord(raw)) return undefined;
	if (typeof raw.epochId !== "string" || raw.epochId.length === 0) return undefined;
	if (!Array.isArray(raw.segments) || raw.segments.length === 0) return undefined;
	const segments: ApecSegment[] = [];
	for (const entry of raw.segments) {
		if (!isRecord(entry)) return undefined;
		if (
			typeof entry.id !== "string" ||
			entry.id.length === 0 ||
			typeof entry.summary !== "string" ||
			typeof entry.timestamp !== "string" ||
			entry.timestamp.length === 0 ||
			typeof entry.tokens !== "number" ||
			!Number.isFinite(entry.tokens) ||
			entry.tokens < 0
		) {
			return undefined;
		}
		segments.push({
			id: entry.id,
			summary: entry.summary,
			timestamp: entry.timestamp,
			tokens: entry.tokens,
		});
	}
	return { epochId: raw.epochId, segments };
}

export function withApecPrefixPreserveData(
	preserveData: Record<string, unknown> | undefined,
	state: ApecPrefixState | undefined,
): Record<string, unknown> | undefined {
	const next = preserveData ? { ...preserveData } : {};
	if (state && state.segments.length > 0) {
		next[APEC_PREFIX_PRESERVE_KEY] = {
			epochId: state.epochId,
			segments: state.segments.map(seg => ({ ...seg })),
		};
	} else {
		delete next[APEC_PREFIX_PRESERVE_KEY];
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

export function computeMaxApecPrefixTokens(
	thresholdTokens: number,
	recoveryBandRatio: number,
	keepRecentTokens: number,
	reserveTokens: number,
	nonMessageTokens = 0,
): number {
	if (thresholdTokens <= 0) return 0;
	const recoveryBand = Math.floor(thresholdTokens * recoveryBandRatio);
	const headroomBudget =
		recoveryBand - keepRecentTokens - nonMessageTokens - reserveTokens - APEC_FOOTER_SAFETY_MARGIN;
	return Math.max(0, Math.min(Math.floor(thresholdTokens * APEC_PREFIX_MAX_SHARE), headroomBudget));
}

export function canExtendApecEpoch(state: ApecPrefixState | undefined, maxPrefixTokens: number): boolean {
	if (!state || state.segments.length === 0 || maxPrefixTokens <= 0) return false;
	const used = state.segments.reduce((sum, seg) => sum + seg.tokens, 0);
	return used < maxPrefixTokens;
}

export function stripSegmentSuffixes(summary: string): string {
	return stripFactLedger(summary).replace(FILE_OPS_BLOCK_RE, "").trim();
}

export function extractCompactionFooter(summary: string): string {
	const blocks: string[] = [];
	const readMatch = READ_FILES_EXTRACT_RE.exec(summary);
	if (readMatch) blocks.push(readMatch[0].trim());
	const modMatch = MODIFIED_FILES_EXTRACT_RE.exec(summary);
	if (modMatch) blocks.push(modMatch[0].trim());
	const ledgerMatch = LEDGER_EXTRACT_RE.exec(summary);
	if (ledgerMatch) blocks.push(ledgerMatch[0].trim());
	return blocks.join("\n\n");
}

export function formatApecCombinedSummary(segments: readonly ApecSegment[]): string {
	if (segments.length <= 1) return segments[0]?.summary ?? "";
	return segments.map((seg, index) => `### Segment ${index + 1}\n${seg.summary}`).join("\n\n");
}
