/** Private, session-selected inputs for an explicitly launched hosted skill comparison. */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { join } from "node:path";
import { getAgentDir, getPackageDir } from "../../config.ts";
import { stateFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import { getDirectoryResourceProfileInfo } from "../settings/settings-rules.ts";
import type { SkillInspectResult } from "../skill-repair.ts";
import type { AutoLearnHandoffStore } from "./auto-learn-handoff-store.ts";
import type { AutoLearnReportEntry } from "./auto-learn-proposals.ts";
import { lookupSkillComparison, skillBodyDigest } from "./skill-comparison.ts";

export function exportAutoLearnComparison(input: {
	agentDir: string;
	cwd: string;
	runId: string;
	sessionId: string;
	entry: AutoLearnReportEntry;
	baseline: SkillInspectResult;
}): { directory: string; baseline: string; candidate: string; model: string; skill: string } {
	const { entry, baseline } = input;
	const evidence = entry.skillEvidence;
	if (
		entry.kind !== "skill_update" ||
		entry.outcome !== "proposed" ||
		!entry.suggestion ||
		!evidence ||
		!entry.subject
	)
		throw new Error("Select a held skill update with comparison evidence");
	if (evidence.projectHash !== getDirectoryResourceProfileInfo(input.cwd, input.agentDir).hash)
		throw new Error("Skill comparison belongs to another project");
	if (!baseline.ok) throw new Error(baseline.message);
	if (!evidence.thinkingLevel) throw new Error("The held comparison has no thinking level; collect a fresh proposal");
	if (
		baseline.name !== entry.subject ||
		baseline.version !== evidence.baselineVersion ||
		skillBodyDigest(baseline.body) !== evidence.baselineDigest ||
		skillBodyDigest(entry.suggestion.body) !== evidence.candidateDigest
	)
		throw new Error("The skill comparison baseline or candidate changed; collect a fresh proposal");
	const parent = stateFile(input.agentDir, "learning", "skill-comparison-inputs");
	if (!isPathWithinScope(safeRealpathSync(parent), safeRealpathSync(input.agentDir)))
		throw new Error("Comparison inputs must remain in private Pi state");
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (!isPathWithinScope(safeRealpathSync(parent), safeRealpathSync(input.agentDir)))
		throw new Error("Comparison input directory escaped private Pi state");
	const directory = join(parent, randomUUID());
	mkdirSync(directory, { mode: 0o700 });
	const baselinePath = join(directory, "baseline.md");
	const candidatePath = join(directory, "candidate.md");
	writeFileSync(baselinePath, baseline.body, { flag: "wx", mode: 0o600 });
	writeFileSync(candidatePath, entry.suggestion.body, { flag: "wx", mode: 0o600 });
	writeFileSync(
		join(directory, "selection.json"),
		JSON.stringify(
			{
				runId: input.runId,
				sessionId: input.sessionId,
				index: entry.index,
				skill: entry.subject,
				evidence,
				rationale: entry.rationale,
				predictedEffect: entry.predictedEffect,
			},
			null,
			2,
		),
		{ flag: "wx", mode: 0o600 },
	);
	return { directory, baseline: baselinePath, candidate: candidatePath, model: evidence.model, skill: entry.subject };
}

export interface AutoLearnComparisonContext {
	handoffs: AutoLearnHandoffStore;
	tenantsDirectory: string;
	cwdHash: string;
	session: AgentSession;
	cwd: string;
	sourceCheckout?: string;
	isActive(): boolean;
}

function comparisonDirectory(context: AutoLearnComparisonContext, runId: string): string {
	return context.handoffs.findForSession(context.tenantsDirectory, context.cwdHash, runId, context.session.sessionId);
}

export function exportHeldSkillComparison(context: AutoLearnComparisonContext, runId: string, index: number): string {
	if (!context.isActive()) throw new Error("The session is no longer active");
	const session = context.session;
	const record = context.handoffs.readForSession(comparisonDirectory(context, runId), runId, session.sessionId);
	const entry = record.entries.find((entry) => entry.index === index);
	if (!entry?.subject) throw new Error("Held skill update not found");
	const exported = exportAutoLearnComparison({
		agentDir: getAgentDir(),
		cwd: context.cwd,
		runId,
		sessionId: session.sessionId,
		entry,
		baseline: session.skillVault.inspect(entry.subject),
	});
	const checkout = context.sourceCheckout ?? path.resolve(getPackageDir(), "../..");
	const hasCheckout = existsSync(path.join(checkout, "scripts", "coding-eval", "cli.mjs"));
	const outputParent = path.dirname(getAgentDir());
	const canonicalOutput = safeRealpathSync(outputParent);
	let projectRoot = safeRealpathSync(context.cwd);
	while (path.dirname(projectRoot) !== projectRoot && !existsSync(path.join(projectRoot, ".git"))) {
		projectRoot = path.dirname(projectRoot);
	}
	if (
		isPathWithinScope(canonicalOutput, safeRealpathSync(getAgentDir())) ||
		isPathWithinScope(canonicalOutput, safeRealpathSync(context.cwd)) ||
		(hasCheckout && isPathWithinScope(canonicalOutput, safeRealpathSync(checkout))) ||
		(existsSync(path.join(projectRoot, ".git")) && isPathWithinScope(canonicalOutput, projectRoot))
	)
		throw new Error("Comparison results must be outside Pi state and Git worktrees");
	const resultsDirectory = mkdtempSync(path.join(canonicalOutput, "skill-comparison-"));
	const output = path.join(resultsDirectory, "study");
	const args = [
		"npm",
		...(hasCheckout ? ["--prefix", checkout] : []),
		"run",
		"eval:coding",
		"--",
		"--skill-name",
		exported.skill,
		"--baseline-skill",
		exported.baseline,
		"--candidate-skill",
		exported.candidate,
		"--project",
		context.cwd,
		"--model",
		exported.model,
		"--thinking",
		entry.skillEvidence!.thinkingLevel!,
		"--out",
		output,
		"--run",
		"--hosted-only",
	];
	const quote =
		process.platform === "win32"
			? (value: string) => `'${value.replaceAll("'", "''")}'`
			: (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	const command = `${process.platform === "win32" ? "& " : ""}${args.map(quote).join(" ")}`;
	return `Private comparison inputs exported to ${exported.directory}\n${hasCheckout ? "Run" : "Change directory to your Pi source checkout, then run"} with hosted-model execution authorized (${process.platform === "win32" ? "PowerShell" : "POSIX shell"}):\n${command}\nReview the recorded model, thinking level, graded cases and verdict with /auto-learn comparison ${runId} ${index}.\nThe comparison view prints the exact study-bound command to accept that tested task coverage for this skill.`;
}

export function describeHeldSkillComparison(context: AutoLearnComparisonContext, runId: string, index: number): string {
	if (!context.isActive()) throw new Error("The session is no longer active");
	const record = context.handoffs.readForSession(
		comparisonDirectory(context, runId),
		runId,
		context.session.sessionId,
	);
	const entry = record.entries.find((item) => item.index === index);
	if (entry?.kind !== "skill_update" || !entry.subject || !entry.skillEvidence?.thinkingLevel)
		throw new Error("Select a held skill comparison with model and thinking evidence");
	const evidence = entry.skillEvidence;
	const receipt = lookupSkillComparison(getAgentDir(), context.cwd, {
		skill: entry.subject,
		model: evidence.model,
		baselineDigest: evidence.baselineDigest,
		candidateDigest: evidence.candidateDigest,
		thinkingLevel: entry.skillEvidence.thinkingLevel,
	});
	if (!receipt)
		return `No recorded comparison for ${entry.subject} on ${evidence.model} at ${evidence.thinkingLevel}.`;
	return `Skill ${entry.subject}\nStudy ${receipt.studyId}\nModel ${receipt.model}\nThinking ${receipt.thinkingLevel}\nGraded cases ${receipt.caseIds.join(", ")}\nVerdict ${receipt.verdict}\nReoffer requests application and accepts these tested cases as coverage for this particular skill. Other task behavior remains unmeasured.\n/auto-learn reoffer-comparison ${runId} ${index} ${receipt.studyId}`;
}

export async function reofferHeldSkillComparison(
	context: AutoLearnComparisonContext,
	runId: string,
	index: number,
	studyId?: string,
): Promise<string> {
	if (!context.isActive()) throw new Error("The session is no longer active");
	const session = context.session;
	if (studyId === undefined) {
		const record = context.handoffs.readForSession(comparisonDirectory(context, runId), runId, session.sessionId);
		const entry = record.entries.find((item) => item.index === index);
		if (entry?.outcome === "applied" || entry?.reasonCode === "skill_candidate_already_present")
			return `${entry.subject}: ${entry.outcome} (${entry.reasonCode})`;
		return describeHeldSkillComparison(context, runId, index);
	}
	if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(studyId)) throw new Error("Invalid comparison study ID");
	const result = await context.handoffs.reofferEntry(
		comparisonDirectory(context, runId),
		runId,
		session.sessionId,
		index,
		async (entry) => {
			if (!context.isActive()) throw new Error("The session is no longer active");
			if (
				entry?.kind !== "skill_update" ||
				entry.outcome !== "proposed" ||
				!entry.suggestion ||
				!entry.subject ||
				!entry.skillEvidence
			)
				throw new Error("Select a held skill update with comparison evidence");
			if (!entry.skillEvidence.thinkingLevel) throw new Error("Collect a fresh proposal with a thinking level");
			const receipt = lookupSkillComparison(getAgentDir(), context.cwd, {
				skill: entry.subject,
				...entry.skillEvidence,
				thinkingLevel: entry.skillEvidence.thinkingLevel,
				studyId,
			});
			if (!receipt || receipt.studyId !== studyId)
				throw new Error("The selected comparison is unavailable or a conflicting regression holds it");
			const baseline = session.skillVault.inspect(entry.subject);
			if (baseline.ok && skillBodyDigest(baseline.body) === entry.skillEvidence.candidateDigest) {
				return {
					...entry,
					outcome: "ineligible",
					reasonCode: "skill_candidate_already_present",
					detail:
						"The candidate body is already present. Its author and application history are unverified; no skill write was made.",
				};
			}
			const proposal = {
				...entry.suggestion,
				index,
				name: entry.subject,
				rationale: entry.rationale,
				predictedEffect: entry.predictedEffect,
				skillEvidence: { ...entry.skillEvidence, studyId },
			};
			const entries = await session.applyAutoLearnProposals(
				{
					verdict: "PASS",
					rationale: entry.rationale ?? "Reoffer measured skill update",
					skillUpdates: [proposal],
					writes: [],
					settings: [],
					forwarded: [],
					malformed: [],
				},
				runId,
				{ reviewedSkillComparison: true },
			);
			const applied = entries.find((result) => result.index === index);
			if (!applied) throw new Error("Auto Learn reoffer returned no selected outcome");
			return applied;
		},
	);
	return `${result.subject}: ${result.outcome} (${result.reasonCode})`;
}
