/** Preparation and exact private evidence requirements for automatic skill body revisions. */
import { accessSync, constants, realpathSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { boundedRedactedDiagnosticText } from "../security/secret-text.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { getDirectoryResourceProfileInfo } from "../settings/settings-rules.ts";
import type { SkillInspectResult, SkillInspectSuccess } from "../skill-repair.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type { AutoLearnHandoffStore } from "./auto-learn-handoff-store.ts";
import type { AutoLearnHandoffRecord, AutoLearnProposalSet } from "./auto-learn-proposals.ts";
import { lookupSkillComparison, recentSkillComparisons, skillBodyDigest } from "./skill-comparison.ts";

export interface AutoLearnSkillContext {
	agentDir: string;
	cwd: string;
	model: string;
	thinkingLevel: string;
}

export function activeAutoLearnSkillContext(
	agentDir: string,
	cwd: string,
	model: { provider: string; id: string } | undefined,
	thinkingLevel: string,
): AutoLearnSkillContext | undefined {
	return model ? { agentDir, cwd, model: `${model.provider}/${model.id}`, thinkingLevel } : undefined;
}

export function autoLearnPriorSkillAttempts(
	context: AutoLearnSkillContext | undefined,
	handoffs: AutoLearnHandoffStore,
	directory: string,
	sessionId: string,
): string {
	if (!context) return "";
	try {
		return autoLearnSkillAttemptEvidence(handoffs.recentSkillOutcomes(directory, sessionId), context);
	} catch {
		return "\n\nPrior native skill edit history could not be read; no measured benefit is established.";
	}
}

export interface AutoLearnSkillEvidence {
	projectHash: string;
	model: string;
	/** Missing on legacy handoffs, which cannot authorize measured pruning. */
	thinkingLevel?: string;
	baselineDigest: string;
	candidateDigest: string;
	baselineVersion: string;
	preparedAt?: "learner_launch" | "application_review";
	studyId?: string;
}

export function isAutoLearnSkillEvidence(value: unknown): value is AutoLearnSkillEvidence {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.projectHash === "string" &&
		/^[a-f0-9]{16}$/.test(value.projectHash) &&
		typeof value.model === "string" &&
		value.model.length > 0 &&
		value.model.length <= 256 &&
		(value.thinkingLevel === undefined ||
			(typeof value.thinkingLevel === "string" &&
				/^(?:off|minimal|low|medium|high|xhigh|max|ultra)$/.test(value.thinkingLevel))) &&
		typeof value.baselineVersion === "string" &&
		value.baselineVersion.length > 0 &&
		value.baselineVersion.length <= 256 &&
		(value.preparedAt === undefined ||
			value.preparedAt === "learner_launch" ||
			value.preparedAt === "application_review") &&
		[value.baselineDigest, value.candidateDigest].every(
			(digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
		) &&
		(value.studyId === undefined || (typeof value.studyId === "string" && /^[a-f0-9-]{36}$/.test(value.studyId)))
	);
}

export function prepareAutoLearnSkillEvidence(
	context: AutoLearnSkillContext,
	baseline: SkillInspectSuccess,
	candidate: string,
): AutoLearnSkillEvidence {
	return {
		projectHash: getDirectoryResourceProfileInfo(context.cwd, context.agentDir).hash,
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		baselineDigest: skillBodyDigest(baseline.body),
		candidateDigest: skillBodyDigest(candidate),
		baselineVersion: baseline.version,
		preparedAt: "application_review",
	};
}

/** A body comparison cannot authorize changes to triggers or a skill shared with other projects. */
export function evaluateAutoLearnSkillEvidence(
	context: AutoLearnSkillContext | undefined,
	baseline: SkillInspectSuccess,
	candidate: { body: string; description?: string; skillEvidence?: AutoLearnSkillEvidence },
	reviewedSkillComparison = false,
): { evidence?: AutoLearnSkillEvidence; hold?: string; canonicalFile?: string } {
	if (!context)
		return candidate.skillEvidence ||
			Buffer.byteLength(candidate.body.trim()) < Buffer.byteLength(baseline.body.trim())
			? { hold: "skill_comparison_scope_unavailable" }
			: {};
	const current = prepareAutoLearnSkillEvidence(context, baseline, candidate.body);
	const prepared = candidate.skillEvidence;
	if (
		prepared &&
		(prepared.projectHash !== current.projectHash ||
			prepared.model !== current.model ||
			prepared.thinkingLevel !== current.thinkingLevel ||
			prepared.baselineDigest !== current.baselineDigest ||
			prepared.candidateDigest !== current.candidateDigest ||
			prepared.baselineVersion !== current.baselineVersion)
	)
		return { evidence: prepared, hold: "stale_source" };
	current.preparedAt = prepared?.preparedAt ?? "application_review";
	if (Buffer.byteLength(candidate.body.trim()) >= Buffer.byteLength(baseline.body.trim()))
		return { evidence: current };
	if (candidate.description !== undefined && candidate.description.trim() !== baseline.description.trim())
		return { evidence: current, hold: "skill_comparison_description_changed" };
	let canonicalFile: string;
	try {
		// The loader's project default is relative to cwd, including a nested working directory.
		const project = realpathSync(context.cwd);
		const lexicalRoot = join(context.cwd, CONFIG_DIR_NAME, "skills");
		const root = realpathSync(lexicalRoot);
		const file = realpathSync(baseline.filePath);
		canonicalFile = file;
		if (
			!isPathWithinScope(root, project) ||
			!isPathWithinScope(file, root) ||
			!isPathWithinScope(baseline.filePath, lexicalRoot)
		)
			return { evidence: current, hold: "skill_comparison_project_scope" };
		accessSync(file, constants.W_OK);
	} catch {
		return { evidence: current, hold: "skill_comparison_project_scope" };
	}
	let receipt: ReturnType<typeof lookupSkillComparison>;
	try {
		receipt = lookupSkillComparison(context.agentDir, context.cwd, {
			skill: baseline.name,
			model: context.model,
			thinkingLevel: context.thinkingLevel,
			baselineDigest: current.baselineDigest,
			candidateDigest: current.candidateDigest,
			studyId: reviewedSkillComparison ? prepared?.studyId : undefined,
		});
	} catch {
		return { evidence: current, hold: "skill_comparison_unavailable" };
	}
	if (!receipt) return { evidence: current, hold: "skill_comparison_required" };
	const evidence = { ...current, studyId: receipt.studyId };
	if (receipt.verdict !== "improved") return { evidence, hold: `skill_comparison_${receipt.verdict}` };
	return reviewedSkillComparison && prepared?.studyId === receipt.studyId
		? { evidence, canonicalFile }
		: { evidence, hold: "skill_comparison_review" };
}

/** Only scoped identifiers and measured counts enter a later learner's context. */
export function autoLearnSkillOutcomeEvidence(context: AutoLearnSkillContext): string {
	try {
		const rows = recentSkillComparisons(context.agentDir, context.cwd)
			.filter((row) => row.model === context.model && row.thinkingLevel === context.thinkingLevel)
			.map((row) => ({
				studyId: row.studyId,
				skill: row.skill,
				verdict: row.verdict,
				baselineDigest: row.baselineDigest,
				candidateDigest: row.candidateDigest,
				pairs: row.pairs,
				cases: row.caseIds.slice(0, 8),
				otherCases: Math.max(0, row.caseIds.length - 8),
				newFailures: row.newFailures,
				extraCorrections: row.extraCorrections,
				baselineTokens: row.baselineTokens,
				candidateTokens: row.candidateTokens,
			}));
		return rows.length
			? `\n\nPrior paired skill comparisons for the active project/model/thinking level. Results cover only the named cases; the owner must review applicability.\n${wrapUntrustedText(JSON.stringify(rows), "auto-learn-skill-comparisons")}`
			: "";
	} catch {
		return "\n\nPrior skill comparisons could not be read; no measured benefit is established.";
	}
}

export type AutoLearnSkillBaselines = Record<string, Omit<AutoLearnSkillEvidence, "candidateDigest">>;
export const MAX_AUTO_LEARN_SKILL_BASELINES = 24;

export function isAutoLearnSkillBaselines(value: unknown): value is AutoLearnSkillBaselines {
	return (
		isPlainRecord(value) &&
		Object.keys(value).length <= MAX_AUTO_LEARN_SKILL_BASELINES &&
		Object.values(value).every(
			(baseline) =>
				isPlainRecord(baseline) &&
				isAutoLearnSkillEvidence({ ...baseline, candidateDigest: baseline.baselineDigest }),
		)
	);
}

export function captureAutoLearnSkillBaselines(
	context: AutoLearnSkillContext | undefined,
	vault: { getLoadedSkillNames(): readonly string[]; inspect(name: string): SkillInspectResult },
): AutoLearnSkillBaselines {
	const baselines: AutoLearnSkillBaselines = Object.create(null);
	if (!context) return baselines;
	for (const name of vault.getLoadedSkillNames().slice(-MAX_AUTO_LEARN_SKILL_BASELINES)) {
		const inspected = vault.inspect(name);
		if (!inspected.ok) continue;
		const { candidateDigest: _candidate, ...baseline } = prepareAutoLearnSkillEvidence(
			context,
			inspected,
			inspected.body,
		);
		baselines[name] = { ...baseline, preparedAt: "learner_launch" };
	}
	return baselines;
}

/** Host-captured launch baselines take precedence over learner-authored freshness claims. */
export function bindAutoLearnSkillBaselines(set: AutoLearnProposalSet, baselines: AutoLearnSkillBaselines): void {
	for (const update of set.skillUpdates) {
		const baseline = Object.hasOwn(baselines, update.name) ? baselines[update.name] : undefined;
		if (!baseline) continue;
		update.skillEvidence = { ...baseline, candidateDigest: skillBodyDigest(update.body) };
	}
}

export function autoLearnSkillAttemptEvidence(
	records: readonly AutoLearnHandoffRecord[],
	context: AutoLearnSkillContext,
): string {
	const projectHash = getDirectoryResourceProfileInfo(context.cwd, context.agentDir).hash;
	const entries = records
		.flatMap((record) =>
			record.entries
				.filter((entry) => entry.kind === "skill_update" && entry.skillEvidence?.projectHash === projectHash)
				.map((entry) => ({
					runId: record.runId,
					skill: entry.subject,
					disposition: entry.outcome,
					reason: entry.reasonCode,
					model: entry.skillEvidence!.model,
					thinkingLevel: entry.skillEvidence!.thinkingLevel,
					activeConfiguration:
						entry.skillEvidence!.model === context.model &&
						entry.skillEvidence!.thinkingLevel === context.thinkingLevel,
					rationale: boundedRedactedDiagnosticText(entry.rationale ?? "")?.slice(0, 512),
					predictedEffect: boundedRedactedDiagnosticText(entry.predictedEffect ?? "")?.slice(0, 512),
					studyId: entry.skillEvidence!.studyId,
				})),
		)
		.slice(0, 12);
	return entries.length
		? `\n\nPrior native skill edit outcomes from this session. These dispositions do not establish quality or savings; other configurations are unmeasured for the active model and thinking level.\n${wrapUntrustedText(JSON.stringify(entries), "auto-learn-skill-history")}`
		: "";
}
