import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";
import type { SemanticDecisionEngine } from "../src/core/decision/engine.ts";
import {
	certainBooleanResult,
	createDecisionEvaluation,
	type DecisionEvaluation,
} from "../src/core/decision/evaluation.ts";
import { createWorkerSkillAccess } from "../src/core/delegation/worker-skill-access.ts";
import {
	ACTIVE_SKILL_RECORD_KIND_PREFIX,
	DISCOVERED_SKILL_RECORD_KIND_PREFIX,
	ProviderRequestContextController,
} from "../src/core/provider-request-context-controller.ts";
import { SkillVaultController } from "../src/core/skill-vault.ts";
import { loadSkills, loadSkillsFromDir, SkillFrontmatterCache } from "../src/core/skills.ts";
import { adaptHostTransients, reconcileTransientRecords } from "../src/kernel/transient-records.ts";

function writeSkill(root: string, name: string, description: string, extra = ""): void {
	const dir = join(root, name);
	mkdirSync(dir);
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nPRIVATE BODY ${name}\n`,
	);
}

function fakeEngine(evaluate: SemanticDecisionEngine["evaluate"]): SemanticDecisionEngine {
	return {
		id: "fixture",
		model: "fixture",
		evaluate,
		capabilities: () => ({
			boolean: true,
			choice: true,
			score: false,
			set: false,
			fullDistributions: true,
			parallelIndependentDecisions: true,
			confidenceProvenance: "native_calibrated",
		}),
	};
}

it("searches the current catalog semantically before reading roots for a paraphrase", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-paraphrase-"));
	try {
		writeSkill(root, "chart-review", "Guidance for reviewing charts.");
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const refreshSkills = vi.fn();
		const evaluate = vi.fn<SemanticDecisionEngine["evaluate"]>(async (program, state) =>
			createDecisionEvaluation({
				programId: program.id,
				programVersion: program.version,
				engineId: "fixture",
				model: "fixture",
				confidenceProvenance: "native_calibrated",
				results: {
					has_match: certainBooleanResult(
						(state as { query: string }).query !== "inspect choreography" || refreshSkills.mock.calls.length > 0,
						"required_true",
						{
							value: 1,
							provenance: "native_calibrated",
							isCalibrated: true,
						},
					),
				},
			}),
		);
		const engine = fakeEngine(evaluate);
		const vault = new SkillVaultController({
			getSkills: () => skills,
			refreshSkills,
			getSemanticEngine: () => engine,
		});
		expect(await vault.search("assess the plot")).toMatchObject({
			ranking: "semantic",
			candidates: [{ name: "chart-review" }],
		});
		expect(await vault.search("assess the plot")).toMatchObject({ semantic: "reused" });
		expect(evaluate).toHaveBeenCalledOnce();
		expect(refreshSkills).not.toHaveBeenCalled();

		skills[0]!.description = "Updated guidance for reviewing charts and graphs.";
		expect(await vault.search("assess the plot")).toMatchObject({
			candidates: [{ description: skills[0]!.description }],
		});
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(refreshSkills).not.toHaveBeenCalled();

		writeSkill(root, "animation-review", "Guidance for assessing animated transitions.");
		refreshSkills.mockImplementationOnce(() => {
			const added = loadSkillsFromDir({ dir: root, source: "user" }).skills.find(
				(skill) => skill.name === "animation-review",
			);
			skills.splice(0, skills.length, added!);
		});
		expect(await vault.search("inspect choreography")).toMatchObject({
			ranking: "semantic",
			candidates: [{ name: "animation-review" }],
		});
		expect(refreshSkills).toHaveBeenCalledOnce();
		expect(evaluate).toHaveBeenCalledTimes(4);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("reuses frontmatter by file version and still rediscovers changes under current admission", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-frontmatter-"));
	try {
		writeSkill(root, "original-skill", "Original guidance.");
		const path = join(root, "original-skill", "SKILL.md");
		const cache = new SkillFrontmatterCache();
		let allowOriginal = true;
		const load = () =>
			loadSkills({
				cwd: root,
				agentDir: root,
				skillPaths: [root],
				includeDefaults: false,
				frontmatterCache: cache,
				isPathAllowed: (file) => allowOriginal || file !== path,
			});
		const original = cache.read(path);
		expect(load().skills).toMatchObject([{ name: "original-skill" }]);
		expect(cache.read(path)).toBe(original);

		writeFileSync(path, "---\nname: original-skill\ndescription: Revised guidance after editing the file.\n---\n");
		writeSkill(root, "new-skill", "New guidance.");
		expect(load().skills).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "original-skill",
					description: "Revised guidance after editing the file.",
				}),
				expect.objectContaining({ name: "new-skill" }),
			]),
		);
		expect(cache.read(path)).not.toBe(original);
		allowOriginal = false;
		expect(load().skills).toMatchObject([{ name: "new-skill" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("reuses the request projection and its records while checking the file at dispatch", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-projection-"));
	try {
		writeSkill(root, "chart-review", "Guidance for reviewing charts.");
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const onSkillUsed = vi.fn();
		const vault = new SkillVaultController({ getSkills: () => skills, onSkillUsed });
		await vault.search("chart-review");
		expect(vault.load("chart-review", "model")).toMatchObject({ ok: true });
		const projection = vault.captureRequestContext();
		const planner = new ProviderRequestContextController({
			skillVault: vault,
			applyContextGc: (messages) => applyContextGc(messages, { enabled: false }),
			applyPathAliases: (messages) => ({ messages }),
		});
		const first = await planner.plan([], 0);
		const second = await planner.plan([], 0);
		const bodyOf = (messages: NonNullable<typeof first.transientMessages>) =>
			messages.find((row) => row.role === "custom" && row.customType.startsWith(ACTIVE_SKILL_RECORD_KIND_PREFIX));
		const body = bodyOf(first.transientMessages ?? []);
		expect(body).toBeDefined();
		expect(bodyOf(second.transientMessages ?? [])).toBe(body);
		expect(onSkillUsed).not.toHaveBeenCalled();
		expect(first.prepareCommit?.()).toBe(true);
		first.commit?.();
		expect(vault.captureRequestContext()).toBe(projection);
		expect(onSkillUsed).toHaveBeenCalledOnce();

		writeFileSync(skills[0]!.filePath, "---\nname: chart-review\ndescription: updated\n---\nDifferent body.\n");
		expect(second.isDispatchCurrent?.()).toBe(false);
		expect(vault.captureRequestContext().sections).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it.each(["disabled", "failed", "unresponsive", "cancelled"] as const)(
	"keeps local discovery usable when semantic ranking is %s",
	async (mode) => {
		const root = mkdtempSync(join(tmpdir(), "pi-offline-skill-"));
		vi.useFakeTimers();
		try {
			writeSkill(root, "chart-review", "Guidance for reviewing charts.");
			writeSkill(root, "release-notes", "Guidance for preparing releases.");
			const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
			const pending = Promise.withResolvers<DecisionEvaluation>();
			const evaluate = vi.fn<SemanticDecisionEngine["evaluate"]>(() =>
				mode === "failed" ? Promise.reject(new Error("Semantic engine unavailable")) : pending.promise,
			);
			const engine = mode === "disabled" ? undefined : fakeEngine(evaluate);
			const vault = new SkillVaultController({
				getSkills: () => skills,
				getSemanticEngine: () => engine,
				now: Date.now,
			});
			const caller = new AbortController();
			const search = vault.search("reviewing charts", { signal: caller.signal });

			if (mode === "cancelled") {
				const reason = new Error("Caller cancelled");
				caller.abort(reason);
				await expect(search).rejects.toBe(reason);
				expect(vault.previewSkillHeaders()).toEqual([]);
				return;
			}
			if (mode === "unresponsive") await vi.advanceTimersByTimeAsync(3_000);
			expect(await search).toMatchObject({ candidates: [{ name: "chart-review" }], ranking: "lexical" });
			expect(await vault.search("preparing releases")).toMatchObject({
				candidates: [{ name: "release-notes" }],
				ranking: "lexical",
			});
			expect(evaluate).toHaveBeenCalledTimes(mode === "disabled" ? 0 : 1);
			const headers = vault.previewSkillHeaders();
			expect(headers).toMatchObject([
				{ name: "chart-review", recordId: "1" },
				{ name: "release-notes", recordId: "2" },
			]);
			await vault.search("chart-review");
			expect(vault.previewSkillHeaders()).toEqual(headers);
			expect(vault.previewSkillSections()).toEqual([]);
			expect(vault.load("chart-review", "model")).toMatchObject({ ok: true });
		} finally {
			vi.useRealTimers();
			rmSync(root, { recursive: true, force: true });
		}
	},
);

it("asks for an eligible header, makes it sticky, and loads its body only on demand", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-discovered-skill-"));
	try {
		writeSkill(root, "catalog-a", "Guidance for exporting spreadsheets.");
		writeSkill(root, "catalog-b", "Guidance for comparing two charts.");
		writeSkill(root, "owner-only", "Owner-only chart comparison.", "disable-model-invocation: true\n");
		let inventory = loadSkillsFromDir({ dir: root, source: "user" }).skills;
		const confidence = { value: 1, provenance: "native_calibrated", isCalibrated: true } as const;
		const evaluate = vi.fn<SemanticDecisionEngine["evaluate"]>(async (program, state) => {
			expect(state).toEqual({
				query: "compare charts",
				candidates: {
					s0: { name: "catalog-b", description: "Guidance for comparing two charts." },
					s1: { name: "catalog-a", description: "Guidance for exporting spreadsheets." },
				},
			});
			return createDecisionEvaluation({
				programId: program.id,
				programVersion: program.version,
				engineId: "fixture",
				model: "fixture",
				confidenceProvenance: "native_calibrated",
				results: {
					has_match: certainBooleanResult(true, "required_true", confidence),
					best_match: { kind: "choice", selected: "s0", distribution: { s0: 1, s1: 0 }, margin: 1, confidence },
				},
			});
		});
		const engine = fakeEngine(evaluate);
		let provider = "typesafe";
		const vault = new SkillVaultController({
			getSkills: () => inventory,
			getSemanticEngine: () => engine,
			getSemanticProvider: () => provider,
		});

		expect(vault.previewSkillHeaders()).toEqual([]);
		expect(await vault.search("compare charts")).toEqual({
			candidates: [{ name: "catalog-b", description: "Guidance for comparing two charts." }],
			ranking: "semantic",
		});
		expect(evaluate).toHaveBeenCalledOnce();
		const headers = vault.previewSkillHeaders();
		expect(headers).toMatchObject([{ name: "catalog-b", recordId: "1" }]);
		expect(headers[0]?.section).not.toContain("PRIVATE BODY");
		expect(vault.previewSkillSections()).toEqual([]);
		await vault.search("catalog-b");
		expect(await vault.search("compare charts")).toMatchObject({ ranking: "semantic", semantic: "reused" });
		expect(vault.previewSkillHeaders()).toEqual(headers);
		expect(evaluate).toHaveBeenCalledOnce();
		provider = "openrouter";
		expect(await vault.search("compare charts")).toMatchObject({ ranking: "semantic" });
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(vault.previewSkillHeaders()).toEqual(headers);
		expect(vault.load("catalog-b", "model")).toMatchObject({ ok: true });
		expect(vault.previewSkillSections()[0]?.section).toContain("PRIVATE BODY catalog-b");

		inventory = inventory.filter((skill) => skill.name !== "catalog-b");
		expect(vault.previewSkillHeaders()).toEqual([]);
		expect(vault.previewSkillSections()).toEqual([]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("abstains from partial-word and tied keyword matches", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-keywords-"));
	try {
		writeSkill(root, "article-writing", "Guidance for drafting long-form stories.");
		writeSkill(root, "chart-review", "Guidance for reviewing visuals.");
		writeSkill(root, "chart-authoring", "Guidance for creating visuals.");
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const vault = new SkillVaultController({ getSkills: () => skills });
		expect((await vault.search("art")).candidates).toEqual([]);
		expect(await vault.search("chart")).toMatchObject({ candidates: [], ambiguous: true });
		expect(vault.previewSkillHeaders()).toEqual([]);
		expect(await vault.search("authoring charts")).toMatchObject({ candidates: [{ name: "chart-authoring" }] });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("shares an identical in-flight judgment without letting one caller cancel the other", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-shared-skill-search-"));
	try {
		writeSkill(root, "chart-review", "Guidance for reviewing charts.");
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const pending = Promise.withResolvers<DecisionEvaluation>();
		const evaluate = vi.fn<SemanticDecisionEngine["evaluate"]>(() => pending.promise);
		const engine = fakeEngine(evaluate);
		const vault = new SkillVaultController({ getSkills: () => skills, getSemanticEngine: () => engine });
		const abort = new AbortController();
		const first = vault.search("reviewing charts", { signal: abort.signal });
		const second = vault.search("reviewing charts");
		const reason = new Error("Stop this wait");
		abort.abort(reason);
		await expect(first).rejects.toBe(reason);
		expect(evaluate).toHaveBeenCalledOnce();
		const [program, , options] = evaluate.mock.calls[0]!;
		expect(options?.signal?.aborted).toBe(false);
		pending.resolve(
			createDecisionEvaluation({
				programId: program.id,
				programVersion: program.version,
				engineId: engine.id,
				model: engine.model,
				confidenceProvenance: "native_calibrated",
				results: {
					has_match: certainBooleanResult(true, "required_true", {
						value: 1,
						provenance: "native_calibrated",
						isCalibrated: true,
					}),
				},
			}),
		);
		expect(await second).toMatchObject({ ranking: "semantic", candidates: [{ name: "chart-review" }] });
		expect(vault.previewSkillHeaders()).toMatchObject([{ name: "chart-review" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("uses bounded record identities for headers and keeps worker selections separate", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-skill-header-slots-"));
	try {
		for (let i = 0; i < 9; i++) writeSkill(root, `skill-${i}`, "Specialist guidance.");
		writeSkill(root, "effectful", "External workflow guidance.", "effects: [network]\n");
		const { skills } = loadSkillsFromDir({ dir: root, source: "user" });
		const vault = new SkillVaultController({ getSkills: () => skills });
		const worker = createWorkerSkillAccess(vault).getSkillReadBroker();
		expect((await worker.search("effectful")).candidates).toEqual([]);
		expect(worker.read("effectful")).toMatchObject({ ok: false, reason: "not_found" });
		await worker.search("skill-0");
		expect(worker.headers?.previewSkillHeaders()).toMatchObject([{ name: "skill-0" }]);
		expect(vault.previewSkillHeaders()).toEqual([]);

		for (let i = 0; i < 9; i++) await vault.search(`skill-${i}`);
		const headers = vault.previewSkillHeaders();
		expect(headers).toHaveLength(8);
		expect(headers.find((header) => header.recordId === "1")?.name).toBe("skill-8");
		expect(worker.headers?.previewSkillHeaders()).toMatchObject([{ name: "skill-0" }]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("retains the accepted header across worker attempts without appending a duplicate", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-worker-skill-retry-"));
	try {
		writeSkill(root, "worker-guide", "Guidance for worker tasks.");
		let inventory = loadSkillsFromDir({ dir: root, source: "user" }).skills;
		const vault = new SkillVaultController({ getSkills: () => inventory });
		const access = createWorkerSkillAccess(vault);
		const newAttempt = () => {
			const worker = access.getSkillReadBroker("worker-1");
			const planner = new ProviderRequestContextController({
				skillDiscovery: worker.headers,
				applyContextGc: (messages) => applyContextGc(messages, { enabled: false }),
				applyPathAliases: (messages) => ({ messages }),
			});
			return { worker, planner };
		};

		const first = newAttempt();
		const cold = await first.planner.plan([], 0);
		await first.worker.search("worker-guide");
		expect(cold.isDispatchCurrent?.()).toBe(false);
		const plan = await first.planner.plan([], 0);
		const { slots } = adaptHostTransients(plan.transientMessages ?? []);
		const { records } = reconcileTransientRecords([], slots, []);
		expect(records).toMatchObject([{ customType: `${DISCOVERED_SKILL_RECORD_KIND_PREFIX}1` }]);

		const next = newAttempt();
		const nextPlan = await next.planner.plan(records, records.length);
		expect(next.worker.headers?.previewSkillHeaders()).toEqual(first.worker.headers?.previewSkillHeaders());
		const repeated = adaptHostTransients(nextPlan.transientMessages ?? []).slots;
		expect(reconcileTransientRecords(records, repeated, records).records).toEqual([]);

		inventory = inventory.map((skill) => ({ ...skill, filePath: join(root, "replacement", "SKILL.md") }));
		const stale = newAttempt();
		const stalePlan = await stale.planner.plan(records, records.length);
		expect(stale.worker.headers?.previewSkillHeaders()).toEqual([]);
		const clears = adaptHostTransients(stalePlan.transientMessages ?? []).slots;
		expect(clears).toMatchObject([{ kind: `${DISCOVERED_SKILL_RECORD_KIND_PREFIX}1`, content: undefined }]);

		await next.worker.search("worker-guide");
		const replacement = await next.planner.plan(records, records.length);
		const replacementSlots = adaptHostTransients(replacement.transientMessages ?? []).slots;
		const replacementRecords = reconcileTransientRecords(records, replacementSlots, records).records;
		expect(replacementRecords).toHaveLength(1);
		const active = newAttempt();
		const history = [...records, ...replacementRecords];
		await active.planner.plan(history, history.length);
		expect(active.worker.headers?.previewSkillHeaders()).toEqual(next.worker.headers?.previewSkillHeaders());
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
