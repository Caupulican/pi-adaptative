/**
 * The code-built evidence a plan's judgments on a settled step read (S5): the step's result packet (its outcome's facts,
 * the validated outcome digest and the host's claim report), the open-items line a dependent step is told, and the
 * finding pairs that cite the same place. Pure except for the bounded digest read. Worker words stay plain and bounded
 * here: a judgment fences them when it builds its question state, and a step's input carries them as plain words, as the
 * handoff already does.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { WorkerSubmittedReport } from "../autonomy/contracts.ts";
import {
	OUTCOME_LIMITS,
	type Outcome,
	type OutcomeAssurance,
	type OutcomeDigest,
	type OutcomeStatus,
} from "../delegation/worker-outcome-contract.ts";
import { currentTaskOf } from "../orchestration/task-successor.ts";
import { UNTRUSTED_BOUNDARY_TAG } from "../provider-prompt-contracts.ts";
import { boundedLine } from "../util/bounded-line.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { PlanRuntimeState } from "./plan-graph.ts";
import { type PlanProjection, planNodeOutcome } from "./plan-view.ts";

/** Each predecessor's result enters a step's task as at most this many bytes. */
export const PLAN_INPUT_DIGEST_BYTES = 2 * 1024;
/** The result excerpt a packet carries, in bytes. */
export const PLAN_EXCERPT_BYTES = 1200;

const PACKET_FILES = 16;
const PACKET_ITEMS = 8;
const PACKET_FINDINGS = 12;
const PACKET_RECEIPTS = 8;
const PACKET_LINE_CHARS = OUTCOME_LIMITS.maxStringChars;
/** The most finding pairs one reduce step is asked about. */
const MAX_FINDING_PAIRS = 12;
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;
/** A path-shaped token of a finding's words: folders and a name, or a file name with an extension, each with an optional line. */
const PLACE_TOKEN =
	/(?:[\w@+-][\w@.+-]*[\\/])+[\w@+-][\w@.+-]*(?::\d+(?:-\d+)?)?|[\w@+-][\w@.+-]*\.[A-Za-z]\w*:\d+(?:-\d+)?/g;
const FENCED_WORDS = new RegExp(`^<${UNTRUSTED_BOUNDARY_TAG} [^>]*>\\n([\\s\\S]*)\\n</${UNTRUSTED_BOUNDARY_TAG}>$`);

/** Clips text to at most `maxBytes` UTF-8 bytes, marking the cut with an ellipsis that counts toward the bound. */
export function clipBytes(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let end = Math.min(text.length, maxBytes);
	while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 3) end -= 1;
	return `${text.slice(0, end)}...`;
}

/** The host's claim report of one step's attempt (`workerClaim(taskId, attemptId)?.report`). */
export type PacketReport = (taskId: string, attemptId: string | undefined) => WorkerSubmittedReport | undefined;

/** One settled step's result as a judgment reads it. Every text field is plain worker words, bounded. */
export interface ResultPacket {
	/** The plan step the result belongs to. */
	readonly nodeId: string;
	readonly status: OutcomeStatus;
	readonly changedFiles: readonly string[];
	/** Requirement ids the step's outcome leaves uncovered. */
	readonly uncovered: readonly string[];
	/** The report's own open items. */
	readonly remaining: readonly string[];
	/** Each finding with the places its own words name (`findingPlaces`). */
	readonly findings: readonly { readonly summary: string; readonly cites: readonly string[] }[];
	readonly receipts: readonly { readonly command: string; readonly exitCode?: number }[];
	readonly assurance: OutcomeAssurance;
	/** The digest's summary, unfenced, at most {@link PLAN_EXCERPT_BYTES} bytes. */
	readonly excerpt: string;
}

/** Two findings from two different steps that cite the same place. `key` names the pair in every reading. */
export interface FindingPair {
	readonly a: string;
	readonly b: string;
	readonly cite: string;
	readonly summaryA: string;
	readonly summaryB: string;
	readonly key: string;
}

function isOutcomeDigest(value: unknown, outcomeId: string): value is OutcomeDigest {
	return (
		isPlainRecord(value) &&
		value.v === 1 &&
		value.outcomeId === outcomeId &&
		typeof value.summary === "string" &&
		Array.isArray(value.findings) &&
		value.findings.every(
			(finding: unknown) =>
				isPlainRecord(finding) &&
				typeof finding.summary === "string" &&
				Array.isArray(finding.cites) &&
				finding.cites.every((cite: unknown) => typeof cite === "string"),
		) &&
		(value.receipts === undefined ||
			(Array.isArray(value.receipts) &&
				value.receipts.every((receipt: unknown) => isPlainRecord(receipt) && typeof receipt.command === "string")))
	);
}

/** The digest's words without their untrusted fence; a value that carries no fence is its own words. */
function unfenced(text: string): string {
	return FENCED_WORDS.exec(text)?.[1] ?? text;
}

/**
 * Each outcome's digest, read once: an outcome is an immutable projection record, so its digest file cannot change under it.
 */
const digestByOutcome = new WeakMap<Outcome, OutcomeDigest | undefined>();

/**
 * The outcome's digest, read only when its path is absolute and the file is within the digest bound, and accepted only
 * when it is a v1 digest of this outcome with well-formed findings. Anything else is undefined: a code fact that leaves the
 * step with no findings, and the sufficiency reading then decides.
 */
export function readOutcomeDigest(outcome: Outcome): OutcomeDigest | undefined {
	if (!digestByOutcome.has(outcome)) digestByOutcome.set(outcome, readDigestFile(outcome));
	return digestByOutcome.get(outcome);
}

function readDigestFile(outcome: Outcome): OutcomeDigest | undefined {
	const path = outcome.digestRef;
	if (path === undefined || !isAbsolute(path)) return undefined;
	let value: unknown;
	try {
		if (statSync(path).size > OUTCOME_LIMITS.digestMaxBytes) {
			harnessLog.warn("plan", "an outcome digest is over its bound; its findings do not count", {
				outcomeId: outcome.outcomeId,
			});
			return undefined;
		}
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		harnessLog.warn("plan", "an outcome digest could not be read; its findings do not count", {
			outcomeId: outcome.outcomeId,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	if (isOutcomeDigest(value, outcome.outcomeId)) return value;
	harnessLog.warn("plan", "an outcome digest is malformed; its findings do not count", {
		outcomeId: outcome.outcomeId,
	});
	return undefined;
}

/**
 * The places a finding names in its own words, in the order it names them: a file path with an optional line or line range. A
 * token counts when it names a line, when its last part carries an extension, or when it is at least three parts deep, so
 * prose such as "read/write" names no place. The digest's own `cites` are evidence source ids (the same one for every
 * finding of a worker), never places, so a finding's places are read here.
 */
export function findingPlaces(summary: string): string[] {
	const places = new Set<string>();
	for (const [token] of summary.matchAll(PLACE_TOKEN)) {
		const place = token.replace(/\\/g, "/").replace(/\.+$/, "");
		const path = placeOf(place);
		const parts = path.split("/");
		if (path !== place || parts.length >= 3 || (parts.at(-1) ?? "").includes(".")) places.add(place);
		if (places.size >= PACKET_ITEMS) break;
	}
	return [...places];
}

/**
 * The result packet of plan step `nodeId` from its settled outcome and its claim report (the report's open items, when one was
 * submitted). The packet names the step, never the outcome's own node: a worker's outcome names its lane, which no reader of
 * the plan knows.
 */
export function resultPacket(
	nodeId: string,
	outcome: Outcome,
	report: WorkerSubmittedReport | undefined,
): ResultPacket {
	const digest = readOutcomeDigest(outcome);
	return {
		nodeId,
		status: outcome.status,
		changedFiles: outcome.changedFiles.slice(0, PACKET_FILES),
		uncovered: outcome.coverage.uncovered.slice(0, PACKET_ITEMS).map((entry) => entry.id),
		remaining: (report?.remaining ?? []).slice(0, PACKET_ITEMS).map((item) => boundedLine(item, PACKET_LINE_CHARS)),
		findings: (digest?.findings ?? []).slice(0, PACKET_FINDINGS).map((finding) => {
			const summary = boundedLine(unfenced(finding.summary), PACKET_LINE_CHARS);
			return { summary, cites: findingPlaces(summary) };
		}),
		receipts: (digest?.receipts ?? []).slice(0, PACKET_RECEIPTS).map((receipt) => ({
			command: boundedLine(receipt.command, PACKET_LINE_CHARS),
			...(receipt.exitCode !== undefined ? { exitCode: receipt.exitCode } : {}),
		})),
		assurance: outcome.assurance,
		excerpt: digest ? clipBytes(unfenced(digest.summary).trim(), PLAN_EXCERPT_BYTES) : "",
	};
}

/** The packet of a settled step of an open plan; undefined while the step has no outcome (held or unsettled). */
export function planNodePacket(
	projection: PlanProjection,
	plan: PlanRuntimeState,
	nodeId: string,
	reportOf: PacketReport,
): ResultPacket | undefined {
	const outcome = planNodeOutcome(projection, plan, nodeId);
	if (!outcome) return undefined;
	const release = plan.nodes[nodeId]?.release;
	const taskId = release ? currentTaskOf(projection, release.taskId) : undefined;
	const report = taskId !== undefined ? reportOf(taskId, outcome.attempts.at(-1)?.attemptId) : undefined;
	return resultPacket(nodeId, outcome, report);
}

/**
 * The line a dependent step is told about what its predecessor left open: its uncovered requirements and its report's
 * open items. Undefined when the predecessor left nothing open.
 */
export function openItemsLine(packet: ResultPacket): string | undefined {
	const parts = [
		...(packet.uncovered.length > 0 ? [`requirements not met: ${packet.uncovered.join(", ")}`] : []),
		...packet.remaining,
	];
	if (parts.length === 0) return undefined;
	return clipBytes(`Open items from step ${packet.nodeId}: ${parts.join("; ")}.`, PLAN_INPUT_DIGEST_BYTES);
}

/** A cite's place: its path, without a line suffix. */
function placeOf(cite: string): string {
	return cite.replace(LINE_SUFFIX, "");
}

/** The places two cite lists share: the same cite, or the same file with another line. */
function sharedPlaces(left: readonly string[], right: readonly string[]): string[] {
	const places = new Set<string>();
	for (const a of left)
		for (const b of right) {
			if (a === b) places.add(a);
			else if (placeOf(a) === placeOf(b)) places.add(placeOf(a));
		}
	return [...places];
}

/** The pairs of findings of two packets that cite a shared place, appended to `into` up to the bound. */
function pairsBetween(left: ResultPacket, right: ResultPacket, into: FindingPair[]): void {
	for (const [ia, a] of left.findings.entries())
		for (const [ib, b] of right.findings.entries())
			for (const cite of sharedPlaces(a.cites, b.cites)) {
				if (into.length >= MAX_FINDING_PAIRS) return;
				into.push({
					a: left.nodeId,
					b: right.nodeId,
					cite,
					summaryA: a.summary,
					summaryB: b.summary,
					key: `${left.nodeId}#${ia}|${right.nodeId}#${ib}|${cite}`,
				});
			}
}

/** Finding pairs across the packets (given in record order), at most {@link MAX_FINDING_PAIRS}. */
export function findingPairs(packets: readonly ResultPacket[]): readonly FindingPair[] {
	const pairs: FindingPair[] = [];
	for (const [index, left] of packets.entries())
		for (const right of packets.slice(index + 1))
			if (pairs.length < MAX_FINDING_PAIRS) pairsBetween(left, right, pairs);
	return pairs;
}
