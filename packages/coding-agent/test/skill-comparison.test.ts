import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { AutoLearnHandoffStore } from "../src/core/learning/auto-learn-handoff-store.ts";
import { type AutoLearnHandoffRecord, parseAutoLearnProposals } from "../src/core/learning/auto-learn-proposals.ts";
import {
	captureAutoLearnSkillBaselines,
	evaluateAutoLearnSkillEvidence,
	isAutoLearnSkillBaselines,
	MAX_AUTO_LEARN_SKILL_BASELINES,
	prepareAutoLearnSkillEvidence,
} from "../src/core/learning/auto-learn-skill-evidence.ts";
import {
	lookupSkillComparison,
	recentSkillComparisons,
	recordSkillComparison,
	SKILL_COMPARISON_SAFETY_CASE,
	type SkillComparisonInput,
	skillBodyDigest,
} from "../src/core/learning/skill-comparison.ts";
import { inspectSkillFile } from "../src/core/skill-repair.ts";

let root: string;
let agent: string;
let cwd: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-comparison-"));
	agent = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agent);
	mkdirSync(cwd);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function study(): SkillComparisonInput {
	const observation = {
		repetition: 1,
		baseline: { passed: true, corrections: 0, tokens: 100 },
		candidate: { passed: true, corrections: 0, tokens: 90 },
	};
	return {
		studyId: randomUUID(),
		skill: "review",
		model: "anthropic/claude-opus-5-5",
		thinkingLevel: "medium",
		baselineDigest: skillBodyDigest("current"),
		candidateDigest: skillBodyDigest("new"),
		corpusDigest: skillBodyDigest("cases"),
		sourceDigest: skillBodyDigest("source"),
		completedAt: new Date().toISOString(),
		pairs: [
			{ ...observation, caseId: "work" },
			{ ...observation, caseId: SKILL_COMPARISON_SAFETY_CASE },
		],
	};
}

it("reuses exact project, model and revision evidence and makes an identical study replay idempotent", () => {
	const input = study();
	const receipt = recordSkillComparison(agent, cwd, input);
	expect(receipt.verdict).toBe("improved");
	expect(recordSkillComparison(agent, cwd, input)).toEqual(receipt);
	expect(recentSkillComparisons(agent, cwd)).toHaveLength(1);
	expect(lookupSkillComparison(agent, cwd, input)).toEqual(receipt);
	expect(lookupSkillComparison(agent, cwd, { ...input, model: "google/gemini" })).toBeUndefined();
	expect(lookupSkillComparison(agent, cwd, { ...input, baselineDigest: skillBodyDigest("stale") })).toBeUndefined();
	expect(lookupSkillComparison(agent, cwd, { ...input, thinkingLevel: "high" })).toBeUndefined();
	const otherProject = join(root, "other");
	mkdirSync(otherProject);
	expect(lookupSkillComparison(agent, otherProject, input)).toBeUndefined();
	expect(() => recordSkillComparison(agent, cwd, { ...input, pairs: input.pairs.slice(1) })).toThrow(/Conflicting/);
});

it("holds untested safety, a safety-only comparison, and unresolved failures", () => {
	const missingGuard = study();
	missingGuard.pairs = missingGuard.pairs.slice(0, 1);
	expect(recordSkillComparison(agent, cwd, missingGuard).verdict).toBe("inconclusive");
	const onlyGuard = study();
	onlyGuard.pairs = onlyGuard.pairs.slice(1);
	expect(recordSkillComparison(agent, cwd, onlyGuard).verdict).toBe("inconclusive");
	const failed = study();
	failed.pairs[0] = {
		...failed.pairs[0],
		baseline: { passed: false, corrections: 0, tokens: 100 },
		candidate: { passed: false, corrections: 0, tokens: 90 },
	};
	expect(recordSkillComparison(agent, cwd, failed).verdict).toBe("inconclusive");
});

it("retains a regression even when a cheaper study on another subset later passes", () => {
	const input = study();
	input.pairs[1] = { ...input.pairs[1], candidate: { passed: false, corrections: 0, tokens: 10 } };
	const regressed = recordSkillComparison(agent, cwd, input);
	expect(regressed.newFailures).toBe(1);
	expect(regressed.verdict).toBe("regressed");
	recordSkillComparison(agent, cwd, study());
	expect(lookupSkillComparison(agent, cwd, input)).toEqual(regressed);
});

it("refuses duplicates, unusable token readings and safety retries before publishing evidence", () => {
	const input = study();
	expect(() => recordSkillComparison(agent, cwd, { ...input, pairs: [input.pairs[0], input.pairs[0]] })).toThrow(
		/Duplicate/,
	);
	const badUsage = { ...input.pairs[0], candidate: { passed: true, corrections: 0, tokens: 0 } };
	expect(() => recordSkillComparison(agent, cwd, { ...input, pairs: [badUsage] })).toThrow(/Invalid/);
	input.pairs[1] = { ...input.pairs[1], candidate: { passed: true, corrections: 1, tokens: 90 } };
	expect(() => recordSkillComparison(agent, cwd, input)).toThrow(/first submission/);
	expect(recentSkillComparisons(agent, cwd)).toEqual([]);
});

it("keeps a passing hosted coding study advisory until the owner selects its workload for this revision", () => {
	const input = study();
	const directory = join(cwd, CONFIG_DIR_NAME, "skills", input.skill);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "SKILL.md");
	writeFileSync(file, "---\nname: review\ndescription: review a change\n---\n\ncurrent\n");
	const baseline = inspectSkillFile(file, input.skill);
	if (!baseline.ok) throw new Error(baseline.message);
	const context = { agentDir: agent, cwd, model: input.model, thinkingLevel: input.thinkingLevel };
	const proposal = { body: "new", skillEvidence: prepareAutoLearnSkillEvidence(context, baseline, "new") };
	expect(evaluateAutoLearnSkillEvidence(context, baseline, proposal).hold).toBe("skill_comparison_required");
	const receipt = recordSkillComparison(agent, cwd, input);
	expect(receipt.caseIds).toContain(SKILL_COMPARISON_SAFETY_CASE);
	expect(evaluateAutoLearnSkillEvidence(context, baseline, proposal).hold).toBe("skill_comparison_review");
	expect(evaluateAutoLearnSkillEvidence(context, baseline, proposal, true).hold).toBe("skill_comparison_review");
	const reviewed = evaluateAutoLearnSkillEvidence(
		context,
		baseline,
		{ ...proposal, skillEvidence: { ...proposal.skillEvidence, studyId: receipt.studyId } },
		true,
	);
	expect(reviewed.hold).toBeUndefined();
	expect(reviewed.evidence?.studyId).toBe(receipt.studyId);
	expect(evaluateAutoLearnSkillEvidence({ ...context, thinkingLevel: "high" }, baseline, proposal, true).hold).toBe(
		"stale_source",
	);
	expect(
		evaluateAutoLearnSkillEvidence(context, baseline, { ...proposal, description: "more authority" }, true).hold,
	).toBe("skill_comparison_description_changed");
});

it("captures bounded cumulative skill history beyond the three simultaneously active slots", () => {
	const names = Array.from({ length: MAX_AUTO_LEARN_SKILL_BASELINES + 4 }, (_, i) => `skill-${i}`);
	const baselines = captureAutoLearnSkillBaselines(
		{ agentDir: agent, cwd, model: "anthropic/claude-opus-5-5", thinkingLevel: "medium" },
		{
			getLoadedSkillNames: () => names,
			inspect: (name) => ({
				ok: true,
				name,
				version: `1:${skillBodyDigest(name)}`,
				body: name,
				description: "review",
				filePath: join(cwd, name),
			}),
		},
	);
	expect(Object.keys(baselines)).toEqual(names.slice(-MAX_AUTO_LEARN_SKILL_BASELINES));
	expect(isAutoLearnSkillBaselines(baselines)).toBe(true);
});

it("rejects worker-authored comparison receipts and accepts normal skill hypotheses", () => {
	const proposal = {
		kind: "skill_update",
		name: "review",
		body: "short",
		rationale: "duplicate steps",
		predictedEffect: "lower token use",
	};
	const parse = (candidate: unknown) =>
		parseAutoLearnProposals(
			`<auto_learn_proposals>${JSON.stringify({ status: "PASS", proposals: [candidate] })}</auto_learn_proposals>`,
		);
	const forged = parse({ ...proposal, skillEvidence: { studyId: randomUUID() } });
	expect(forged.ok && forged.set.skillUpdates).toEqual([]);
	const ordinary = parse(proposal);
	expect(ordinary.ok && ordinary.set.skillUpdates[0].predictedEffect).toBe("lower token use");
});

it("resolves a transferred held comparison for its receiving session and records only one application", async () => {
	const store = new AutoLearnHandoffStore(86_400_000);
	const tenants = join(agent, "tenants");
	const hash = "01234567";
	const directory = join(tenants, `first-${hash}`, "handoffs");
	const runId = "run-1";
	const record: AutoLearnHandoffRecord = {
		version: 1,
		runId,
		sessionId: "first",
		childSessionId: "learner",
		kind: "auto",
		status: "reported",
		exit: { code: 0, signal: null },
		verdict: "PASS",
		completedAt: new Date().toISOString(),
		reoffered: { sessionId: "second", at: new Date().toISOString() },
		forwarded: [],
		entries: [
			{
				index: 0,
				kind: "skill_update",
				subject: "review",
				outcome: "proposed",
				reasonCode: "skill_comparison_required",
				suggestion: { body: "short" },
			},
		],
	};
	expect(store.publish(directory, record).status).toBe("persisted");
	expect(() => store.findForSession(tenants, hash, runId, "first")).toThrow();
	const selected = store.findForSession(tenants, hash, runId, "second");
	const result = await store.reofferEntry(selected, runId, "second", 0, async (entry) => ({
		...entry,
		outcome: "applied",
		reasonCode: "skill_repaired",
	}));
	expect(result.outcome).toBe("applied");
	expect(
		await store.reofferEntry(selected, runId, "second", 0, async () => {
			throw new Error("repeated application");
		}),
	).toEqual(result);
});
