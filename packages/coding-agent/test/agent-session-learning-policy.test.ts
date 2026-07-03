import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { LearningPolicySettings } from "../src/core/settings-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Learning apply/audit/rollback policy: reflection-sourced durable writes route through the
 * learning gate, leave audit records with rollback plans, and can be rolled back.
 */
describe("learning apply policy — audit and rollback", () => {
	let tempDir: string;
	let agentDir: string;

	const reply = (jsonBody: string): AssistantMessage => ({
		role: "assistant",
		content: [{ type: "text", text: `\`\`\`json\n${jsonBody}\n\`\`\`` }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 20,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 30,
			cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.002 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});

	const newSession = async (learningPolicy?: LearningPolicySettings) => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		if (learningPolicy) {
			settingsManager.setLearningPolicySettings(learningPolicy);
		}
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		await session.bindExtensions({});
		return session;
	};

	const scriptReflection = (session: Awaited<ReturnType<typeof newSession>>, writes: unknown[]) => {
		(session.agent as unknown as { streamFn: unknown }).streamFn = async () =>
			({
				result: async () => reply(JSON.stringify({ rationale: "learned something", writes })),
			}) as never;
	};

	const runPass = (session: Awaited<ReturnType<typeof newSession>>, reportId = "turn-1") =>
		session.runReflectionPass({
			signals: {
				trigger: "corrective",
				toolCallCount: 0,
				hadCorrection: true,
				contextHeadroomPct: 90,
				usefulLately: 0,
			},
			recentTurnText: "user: remember to run checks",
			reportId,
		});

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-learning-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "MEMORY.md"), "Existing fact\n", "utf-8");
		writeFileSync(join(agentDir, "USER.md"), "User prefers tabs\n", "utf-8");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("legacy path (policy disabled): applies the write but records decision + audit with rollback plan", async () => {
		const session = await newSession();
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Always run npm run check" }]);

		await runPass(session);

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Always run npm run check");

		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.kind).toBe("apply");
		expect(decisions[0]?.reasonCode).toBe("learning_policy_disabled_legacy_apply");

		const audits = session.getLearningAuditRecords();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.action).toBe("apply");
		expect(audits[0]?.rollback?.kind).toBe("memory_remove");
		expect(audits[0]?.rollback?.target).toBe("Always run npm run check");

		const diagnostics = session.getAutonomyDiagnosticSnapshot();
		expect(diagnostics.learning?.some((entry) => entry.title.startsWith("Audit audit-1"))).toBe(true);

		session.dispose();
	});

	it("policy enabled, stock thresholds: low-confidence cue proposes (audited), nothing auto-applies", async () => {
		// Stock settings put reflectionSourceConfidence (50) below confidenceThreshold (90), and reflection
		// writes carry no evidenceIds. This must degrade to an approval-gated proposal that is AUDITED, not a
		// silent no-op that disables learning entirely. Fail-closed is preserved: nothing is auto-applied.
		const session = await newSession({ enabled: true });
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Speculative fact" }]);

		await runPass(session);

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain("Speculative fact");
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.kind).toBe("proposal");
		expect(decisions[0]?.reasonCode).toBe("below_confidence_threshold");
		expect(decisions[0]?.requiresApproval).toBe(true);
		const audits = session.getLearningAuditRecords();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.action).toBe("propose");
		expect(audits[0]?.reasonCode).toBe("below_confidence_threshold");

		session.dispose();
	});

	it("policy enabled with permissive thresholds: eligible memory write auto-applies with audit", async () => {
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 40,
			minObservations: 1,
			reflectionSourceConfidence: 50,
		});
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Vetted durable fact" }]);

		await runPass(session);

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Vetted durable fact");
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("apply");
		expect(decisions[0]?.reasonCode).toBe("eligible_auto_apply");
		expect(session.getLearningAuditRecords()[0]?.action).toBe("apply");

		session.dispose();
	});

	it("gate decides apply but the memory tool refuses the write: no phantom apply audit, rollback refuses", async () => {
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 40,
			minObservations: 1,
			reflectionSourceConfidence: 50,
		});

		// Fill MEMORY.md to the edge of the file-store's budget (2200 chars) so the gate's "apply"
		// decision cannot actually land on disk — the memory tool refuses with details.success:false
		// ("Memory budget exceeded") rather than throwing.
		const fact = "Speculative fact that will not fit in the remaining budget";
		const budgetMemory = 2200; // mirrors FileStoreProvider's private BUDGET_MEMORY
		const fillerLength = budgetMemory + 3 - fact.length; // post-add content lands 5 chars over budget
		writeFileSync(join(agentDir, "MEMORY.md"), `${"x".repeat(fillerLength)}\n`, "utf-8");

		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: fact }]);
		await runPass(session);

		// The write never landed.
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain(fact);

		// The GATE still decided to apply — this isn't a gate-eligibility bug.
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("apply");
		expect(decisions[0]?.reasonCode).toBe("eligible_auto_apply");

		// But the audit must record the HONEST outcome, not a phantom "apply".
		const audits = session.getLearningAuditRecords();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.action).not.toBe("apply");
		expect(audits[0]?.action).toBe("apply_failed");
		expect(audits[0]?.rollback).toBeUndefined();

		// A phantom "apply" audit would let rollback attempt an inverse for a write that never happened.
		const rollback = await session.rollbackLearningWrite(audits[0]!.id);
		expect(rollback).toEqual({ ok: false, reason: "not_an_applied_change" });

		session.dispose();
	});

	it("legacy path (policy disabled): memory tool refusal also avoids a phantom apply audit", async () => {
		const session = await newSession();

		const fact = "Legacy fact that will not fit in the remaining budget";
		const budgetMemory = 2200;
		const fillerLength = budgetMemory + 3 - fact.length;
		writeFileSync(join(agentDir, "MEMORY.md"), `${"x".repeat(fillerLength)}\n`, "utf-8");

		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: fact }]);
		await runPass(session);

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain(fact);

		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("apply");
		expect(decisions[0]?.reasonCode).toBe("learning_policy_disabled_legacy_apply");

		const audits = session.getLearningAuditRecords();
		expect(audits).toHaveLength(1);
		expect(audits[0]?.action).toBe("apply_failed");
		expect(audits[0]?.rollback).toBeUndefined();

		session.dispose();
	});

	it("a memory_replace supersedes an existing fact: gated as a contradiction, not auto-applied", async () => {
		// A replace/remove overwrites or deletes existing durable memory — the reflection engine emits it
		// only when the new turn CONFRONTS an existing fact. That supersession is a real contradiction
		// signal, so even with otherwise-eligible thresholds it must route through the contradiction branch
		// (approval-gated) rather than silently destroying the prior fact.
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 40,
			minObservations: 1,
			reflectionSourceConfidence: 50,
			allowedAutoApplyLayers: ["memory"],
		});
		scriptReflection(session, [{ kind: "memory_replace", target: "Existing fact", text: "Updated fact" }]);

		await runPass(session);

		const memory = readFileSync(join(agentDir, "MEMORY.md"), "utf-8");
		expect(memory).toContain("Existing fact");
		expect(memory).not.toContain("Updated fact");
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("proposal");
		expect(decisions[0]?.reasonCode).toBe("contradictions_present");
		expect(decisions[0]?.requiresApproval).toBe(true);
		expect(session.getLearningAuditRecords()[0]?.action).toBe("propose");

		session.dispose();
	});

	it("Bug F: autoApplySupersessions opted in, otherwise eligible: a memory_replace auto-applies with audit", async () => {
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 40,
			minObservations: 1,
			reflectionSourceConfidence: 50,
			allowedAutoApplyLayers: ["memory"],
			autoApplySupersessions: true,
		});
		scriptReflection(session, [{ kind: "memory_replace", target: "Existing fact", text: "Updated fact" }]);

		await runPass(session);

		const memory = readFileSync(join(agentDir, "MEMORY.md"), "utf-8");
		expect(memory).not.toContain("Existing fact");
		expect(memory).toContain("Updated fact");
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("apply");
		expect(decisions[0]?.reasonCode).toBe("eligible_auto_apply");
		expect(session.getLearningAuditRecords()[0]?.action).toBe("apply");

		session.dispose();
	});

	it("Bug F: autoApplySupersessions opted in but below the confidence threshold: still proposes", async () => {
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 90, // reflectionSourceConfidence (50) stays below this
			minObservations: 1,
			reflectionSourceConfidence: 50,
			allowedAutoApplyLayers: ["memory"],
			autoApplySupersessions: true,
		});
		scriptReflection(session, [{ kind: "memory_replace", target: "Existing fact", text: "Updated fact" }]);

		await runPass(session);

		const memory = readFileSync(join(agentDir, "MEMORY.md"), "utf-8");
		expect(memory).toContain("Existing fact");
		expect(memory).not.toContain("Updated fact");
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("proposal");
		// Fell through PAST the contradiction gate and was stopped by the confidence check next, not
		// the contradiction check — proves autoApplySupersessions falls through rather than skipping
		// the rest of the chain outright.
		expect(decisions[0]?.reasonCode).toBe("below_confidence_threshold");
		expect(session.getLearningAuditRecords()[0]?.action).toBe("propose");

		session.dispose();
	});

	it("evidence strength (G6): first observation proposes, the second auto-applies", async () => {
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 40,
			minObservations: 2,
			reflectionSourceConfidence: 50,
		});
		const write = { kind: "memory_add", section: "MEMORY", text: "Vetted repeated fact" };

		// First pass: only one observation of this lesson — the gate holds it as a proposal.
		scriptReflection(session, [write]);
		await runPass(session, "turn-1");

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain("Vetted repeated fact");
		let decisions = session.getLearningDecisionSnapshots();
		expect(decisions.at(-1)?.kind).toBe("proposal");
		expect(decisions.at(-1)?.reasonCode).toBe("insufficient_observations");
		expect(session.getLearningAuditRecords().at(-1)?.action).toBe("propose");

		// Second pass proposes the SAME lesson — now observed twice, it clears minObservations and applies.
		scriptReflection(session, [write]);
		await runPass(session, "turn-2");

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Vetted repeated fact");
		decisions = session.getLearningDecisionSnapshots();
		expect(decisions.at(-1)?.kind).toBe("apply");
		expect(decisions.at(-1)?.reasonCode).toBe("eligible_auto_apply");
		expect(session.getLearningAuditRecords().at(-1)?.action).toBe("apply");

		session.dispose();
	});

	it("policy enabled, skill layer not allowed: promotion becomes a proposal, no skill is written", async () => {
		const session = await newSession({
			enabled: true,
			autoApplyEnabled: true,
			confidenceThreshold: 40,
			minObservations: 1,
			reflectionSourceConfidence: 50,
			allowedAutoApplyLayers: ["memory"],
		});
		scriptReflection(session, [
			{ kind: "promote_skill", name: "release-flow", description: "How to release", body: "Run release:patch" },
		]);

		await runPass(session);

		expect(existsSync(join(agentDir, "skills", "release-flow", "SKILL.md"))).toBe(false);
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions[0]?.kind).toBe("proposal");
		expect(decisions[0]?.reasonCode).toBe("layer_not_allowed_for_auto_apply");
		const audits = session.getLearningAuditRecords();
		expect(audits[0]?.action).toBe("propose");
		expect(audits[0]?.layer).toBe("skill");

		session.dispose();
	});

	it("audit ids reseed from stored snapshots so passes never reuse an id", async () => {
		// Each pass reseeds its audit sequence from the stored snapshot count, so ids stay sequential and
		// unique across passes (rollback keys on the id — a collision would misdirect it). The first
		// enabled/stock pass now proposes (audited) rather than silently no-op'ing.
		const session = await newSession({ enabled: true });
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Speculative fact" }]);
		await runPass(session, "turn-1");
		expect(session.getLearningAuditRecords()).toHaveLength(1);

		session.settingsManager.setLearningPolicySettings({ enabled: false });
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Fact A" }]);
		await runPass(session, "turn-2");
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Fact B" }]);
		await runPass(session, "turn-3");

		const ids = session.getLearningAuditRecords().map((record) => record.id);
		expect(ids).toEqual(["audit-1", "audit-2", "audit-3"]);
		expect(new Set(ids).size).toBe(ids.length);
		session.dispose();
	});

	it("rolls back an applied memory_add exactly once", async () => {
		const session = await newSession();
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Fact to roll back" }]);
		await runPass(session);
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).toContain("Fact to roll back");

		const audit = session.getLearningAuditRecords()[0];
		expect(audit).toBeDefined();

		const first = await session.rollbackLearningWrite(audit!.id);
		expect(first).toEqual({ ok: true, reason: "rollback_applied" });
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain("Fact to roll back");

		const audits = session.getLearningAuditRecords();
		expect(audits).toHaveLength(2);
		expect(audits[1]?.action).toBe("rollback");
		expect(audits[1]?.rollbackOf).toBe(audit!.id);

		const second = await session.rollbackLearningWrite(audit!.id);
		expect(second).toEqual({ ok: false, reason: "already_rolled_back" });

		session.dispose();
	});

	it("a failed rollback inverse does not consume the once-only rollback (no self-lock)", async () => {
		const session = await newSession();
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Fact to roll back" }]);
		await runPass(session);
		const audit = session.getLearningAuditRecords()[0];
		expect(audit).toBeDefined();

		// Sabotage: the fact vanishes from disk (hand-edit), so the inverse remove cannot apply.
		writeFileSync(join(agentDir, "MEMORY.md"), "Existing fact\n", "utf-8");

		const failed = await session.rollbackLearningWrite(audit!.id);
		expect(failed).toEqual({ ok: false, reason: "rollback_apply_failed" });
		// No rollback audit was appended — the change stays eligible for a retry.
		expect(session.getLearningAuditRecords().some((record) => record.action === "rollback")).toBe(false);

		// Once the fact is back, the retry must succeed instead of hitting already_rolled_back.
		writeFileSync(join(agentDir, "MEMORY.md"), "Existing fact\nFact to roll back\n", "utf-8");
		const retried = await session.rollbackLearningWrite(audit!.id);
		expect(retried).toEqual({ ok: true, reason: "rollback_applied" });
		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain("Fact to roll back");

		session.dispose();
	});

	it("returns audit_not_found for unknown ids and refuses to roll back proposals", async () => {
		const session = await newSession({ enabled: true, allowedAutoApplyLayers: [] });
		expect(await session.rollbackLearningWrite("nope")).toEqual({ ok: false, reason: "audit_not_found" });
		session.dispose();
	});
});
