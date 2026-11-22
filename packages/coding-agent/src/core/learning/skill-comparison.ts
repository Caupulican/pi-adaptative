/** Private project evidence for comparing two skill bodies on matched hosted-model tasks. */
import { isDeepStrictEqual } from "node:util";
import { stateFile } from "../agent-paths.ts";
import { isPathWithinScope, realPathIdentity } from "../autonomy/path-scope.ts";
import { ORCHESTRATION_THINKING_LEVELS } from "../orchestration/contracts.ts";
import { getDirectoryResourceProfileInfo } from "../settings/settings-rules.ts";
import { computeSkillDigest } from "../skill-repair.ts";
import { validateSkillName } from "../skills.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../util/value-guards.ts";

export interface SkillComparisonKey {
	skill: string;
	model: string;
	thinkingLevel: string;
	baselineDigest: string;
	candidateDigest: string;
}

interface StudyIdentity extends SkillComparisonKey {
	studyId: string;
	corpusDigest: string;
	sourceDigest: string;
	completedAt: string;
}

interface GradedArm {
	passed: boolean;
	corrections: number;
	tokens: number;
}

export interface SkillComparisonInput extends StudyIdentity {
	pairs: Array<{ caseId: string; repetition: number; baseline: GradedArm; candidate: GradedArm }>;
}

export interface SkillComparisonReceipt extends StudyIdentity {
	projectHash: string;
	pairDigest: string;
	caseIds: string[];
	pairs: number;
	safetyPairs: number;
	candidateFailures: number;
	newFailures: number;
	extraCorrections: number;
	baselineTokens: number;
	candidateTokens: number;
	verdict: "improved" | "regressed" | "inconclusive";
}

const DIGEST = /^[a-f0-9]{64}$/;
const STUDY_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const MAX_STUDIES = 128;
const MAX_PAIRS = 512;
const MAX_CASES = 64;
const CASE_ID = /^[\w.-]{1,128}$/;
export const SKILL_COMPARISON_SAFETY_CASE = "skill-scope-and-disclosure";

export function skillBodyDigest(body: string): string {
	return computeSkillDigest(body.trim());
}

function validIdentity(row: Record<string, unknown>): boolean {
	return (
		typeof row.skill === "string" &&
		validateSkillName(row.skill).length === 0 &&
		ORCHESTRATION_THINKING_LEVELS.some((level) => level === row.thinkingLevel) &&
		typeof row.model === "string" &&
		row.model.length <= 256 &&
		/^[\w.-]+\/[\w.:/@+-]+$/.test(row.model) &&
		typeof row.studyId === "string" &&
		STUDY_ID.test(row.studyId) &&
		[row.baselineDigest, row.candidateDigest, row.corpusDigest, row.sourceDigest].every(
			(d) => typeof d === "string" && DIGEST.test(d),
		) &&
		row.baselineDigest !== row.candidateDigest &&
		typeof row.completedAt === "string" &&
		Number.isFinite(Date.parse(row.completedAt)) &&
		new Date(row.completedAt).toISOString() === row.completedAt
	);
}

function validArm(value: unknown): value is GradedArm {
	return (
		isPlainRecord(value) &&
		typeof value.passed === "boolean" &&
		isNonNegativeSafeInteger(value.corrections) &&
		isNonNegativeSafeInteger(value.tokens) &&
		value.tokens > 0
	);
}

type Measures = Pick<
	SkillComparisonReceipt,
	| "pairs"
	| "safetyPairs"
	| "candidateFailures"
	| "newFailures"
	| "extraCorrections"
	| "baselineTokens"
	| "candidateTokens"
>;

function verdict(m: Measures): SkillComparisonReceipt["verdict"] {
	if (m.newFailures || m.extraCorrections) return "regressed";
	if (!m.safetyPairs || m.safetyPairs === m.pairs || m.candidateFailures || m.candidateTokens >= m.baselineTokens)
		return "inconclusive";
	return "improved";
}

// Extra fields have no place in a study receipt; private raw observations stay with the evaluator.
const RECEIPT_FIELDS: ReadonlySet<keyof SkillComparisonReceipt> = new Set([
	"skill",
	"model",
	"thinkingLevel",
	"baselineDigest",
	"candidateDigest",
	"studyId",
	"corpusDigest",
	"sourceDigest",
	"completedAt",
	"projectHash",
	"pairDigest",
	"caseIds",
	"pairs",
	"safetyPairs",
	"candidateFailures",
	"newFailures",
	"extraCorrections",
	"baselineTokens",
	"candidateTokens",
	"verdict",
]);

function validReceipt(row: unknown, projectHash: string): row is SkillComparisonReceipt {
	if (
		!isPlainRecord(row) ||
		Object.keys(row).some((key) => !RECEIPT_FIELDS.has(key as keyof SkillComparisonReceipt)) ||
		!validIdentity(row) ||
		row.projectHash !== projectHash ||
		typeof row.pairDigest !== "string" ||
		!DIGEST.test(row.pairDigest) ||
		!Array.isArray(row.caseIds) ||
		!row.caseIds.length ||
		row.caseIds.length > MAX_CASES ||
		!row.caseIds.every((id) => typeof id === "string" && CASE_ID.test(id)) ||
		new Set(row.caseIds).size !== row.caseIds.length
	)
		return false;
	const { pairs, safetyPairs, candidateFailures, newFailures, extraCorrections, baselineTokens, candidateTokens } =
		row;
	if (
		!isNonNegativeSafeInteger(pairs) ||
		!pairs ||
		pairs > MAX_PAIRS ||
		!isNonNegativeSafeInteger(safetyPairs) ||
		safetyPairs > pairs ||
		row.caseIds.length > pairs ||
		row.caseIds.includes(SKILL_COMPARISON_SAFETY_CASE) !== safetyPairs > 0 ||
		!isNonNegativeSafeInteger(candidateFailures) ||
		candidateFailures > pairs ||
		!isNonNegativeSafeInteger(newFailures) ||
		newFailures > candidateFailures ||
		!isNonNegativeSafeInteger(extraCorrections) ||
		!isNonNegativeSafeInteger(baselineTokens) ||
		!isNonNegativeSafeInteger(candidateTokens) ||
		baselineTokens < pairs ||
		candidateTokens < pairs
	)
		return false;
	return (
		row.verdict ===
		verdict({ pairs, safetyPairs, candidateFailures, newFailures, extraCorrections, baselineTokens, candidateTokens })
	);
}

function storage(agentDir: string, cwd: string) {
	const projectHash = getDirectoryResourceProfileInfo(cwd, agentDir).hash;
	const path = stateFile(agentDir, "learning", "skill-comparisons", `${projectHash}.json`);
	if (!isPathWithinScope(realPathIdentity(path), realPathIdentity(agentDir))) {
		throw new Error("Skill comparison evidence escaped the private agent directory");
	}
	return { path, projectHash };
}

function readStudies(store: ReturnType<typeof storage>): SkillComparisonReceipt[] {
	let raw: string;
	try {
		raw = readBoundedTextFileSync(store.path, 2 * 1024 * 1024, "Skill comparison history");
	} catch (error) {
		if (isMissingFileError(error)) return [];
		throw error;
	}
	const data: unknown = JSON.parse(raw);
	if (
		!isPlainRecord(data) ||
		data.version !== 1 ||
		!Array.isArray(data.studies) ||
		data.studies.length > MAX_STUDIES ||
		!data.studies.every((row) => validReceipt(row, store.projectHash)) ||
		new Set(data.studies.map((row) => row.studyId)).size !== data.studies.length
	) {
		throw new Error("Invalid skill comparison history");
	}
	return data.studies;
}

export function recordSkillComparison(
	agentDir: string,
	cwd: string,
	input: SkillComparisonInput,
): SkillComparisonReceipt {
	const store = storage(agentDir, cwd);
	const {
		skill,
		model,
		thinkingLevel,
		baselineDigest,
		candidateDigest,
		studyId,
		corpusDigest,
		sourceDigest,
		completedAt,
		pairs,
	} = input;
	const identity = {
		skill,
		model,
		thinkingLevel,
		baselineDigest,
		candidateDigest,
		studyId,
		corpusDigest,
		sourceDigest,
		completedAt,
	};
	if (!validIdentity(identity) || !Array.isArray(pairs) || !pairs.length || pairs.length > MAX_PAIRS) {
		throw new Error("Invalid skill comparison identity or pair count");
	}
	const measures: Measures = {
		pairs: pairs.length,
		safetyPairs: 0,
		candidateFailures: 0,
		newFailures: 0,
		extraCorrections: 0,
		baselineTokens: 0,
		candidateTokens: 0,
	};
	const keys = new Set<string>();
	const workloads = new Set<string>();
	const evidence: string[] = [];
	for (const pair of pairs) {
		const { caseId, repetition, baseline, candidate } = pair;
		if (
			typeof caseId !== "string" ||
			!CASE_ID.test(caseId) ||
			!isNonNegativeSafeInteger(repetition) ||
			!repetition ||
			!validArm(baseline) ||
			!validArm(candidate)
		) {
			throw new Error("Invalid matched skill observation");
		}
		const key = JSON.stringify([caseId, repetition]);
		if (keys.has(key)) throw new Error("Duplicate matched skill observation");
		keys.add(key);
		workloads.add(caseId);
		if (caseId === SKILL_COMPARISON_SAFETY_CASE) {
			if (baseline.corrections || candidate.corrections)
				throw new Error("Safety task must be graded on the first submission");
			measures.safetyPairs++;
		}
		evidence.push(
			JSON.stringify([
				key,
				baseline.passed,
				baseline.corrections,
				baseline.tokens,
				candidate.passed,
				candidate.corrections,
				candidate.tokens,
			]),
		);
		if (!candidate.passed) measures.candidateFailures++;
		if (baseline.passed && !candidate.passed) measures.newFailures++;
		measures.extraCorrections += Math.max(0, candidate.corrections - baseline.corrections);
		measures.baselineTokens += baseline.tokens;
		measures.candidateTokens += candidate.tokens;
	}
	const receipt = {
		...identity,
		...measures,
		projectHash: store.projectHash,
		caseIds: [...workloads].sort(),
		pairDigest: computeSkillDigest(evidence.sort().join("\n")),
		verdict: verdict(measures),
	};
	if (!validReceipt(receipt, store.projectHash)) throw new Error("Invalid skill comparison totals");
	return withFileLockSync(store.path, () => {
		const studies = readStudies(store);
		const previous = studies.find((row) => row.studyId === studyId);
		if (previous) {
			if (!isDeepStrictEqual(previous, receipt)) throw new Error("Conflicting skill comparison replay");
			return previous;
		}
		const retained = [...studies, receipt]
			.sort((a, b) => a.completedAt.localeCompare(b.completedAt) || a.studyId.localeCompare(b.studyId))
			.slice(-MAX_STUDIES);
		writeFileAtomicSync(store.path, JSON.stringify({ version: 1, studies: retained }), { mode: 0o600 });
		return receipt;
	});
}

export function recentSkillComparisons(agentDir: string, cwd: string, limit = 8): SkillComparisonReceipt[] {
	if (!Number.isSafeInteger(limit) || limit <= 0) return [];
	return readStudies(storage(agentDir, cwd)).reverse().slice(0, Math.min(limit, MAX_STUDIES));
}

export function lookupSkillComparison(
	agentDir: string,
	cwd: string,
	key: SkillComparisonKey & { studyId?: string },
): SkillComparisonReceipt | undefined {
	const matches = recentSkillComparisons(agentDir, cwd, MAX_STUDIES).filter(
		(row) =>
			row.skill === key.skill &&
			row.model === key.model &&
			row.thinkingLevel === key.thinkingLevel &&
			row.baselineDigest === key.baselineDigest &&
			row.candidateDigest === key.candidateDigest,
	);
	// A passing subset of the workload cannot erase a known regression on the same revisions.
	return (
		matches.find((row) => row.verdict === "regressed") ??
		(key.studyId ? matches.find((row) => row.studyId === key.studyId) : matches[0])
	);
}
