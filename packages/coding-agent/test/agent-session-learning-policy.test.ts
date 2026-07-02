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

	it("policy enabled without evidence: low-confidence cue becomes a no-op, nothing is applied", async () => {
		const session = await newSession({ enabled: true });
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Speculative fact" }]);

		await runPass(session);

		expect(readFileSync(join(agentDir, "MEMORY.md"), "utf-8")).not.toContain("Speculative fact");
		const decisions = session.getLearningDecisionSnapshots();
		expect(decisions).toHaveLength(1);
		expect(decisions[0]?.kind).toBe("no-op");
		expect(session.getLearningAuditRecords()).toHaveLength(0);

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

	it("audit ids track STORED snapshots only: a no-op pass must not advance the sequence", async () => {
		const session = await newSession({ enabled: true });
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Speculative fact" }]);
		await runPass(session, "turn-1");
		expect(session.getLearningAuditRecords()).toHaveLength(0);

		session.settingsManager.setLearningPolicySettings({ enabled: false });
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Fact A" }]);
		await runPass(session, "turn-2");
		scriptReflection(session, [{ kind: "memory_add", section: "MEMORY", text: "Fact B" }]);
		await runPass(session, "turn-3");

		const ids = session.getLearningAuditRecords().map((record) => record.id);
		expect(ids).toEqual(["audit-1", "audit-2"]);
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

	it("returns audit_not_found for unknown ids and refuses to roll back proposals", async () => {
		const session = await newSession({ enabled: true, allowedAutoApplyLayers: [] });
		expect(await session.rollbackLearningWrite("nope")).toEqual({ ok: false, reason: "audit_not_found" });
		session.dispose();
	});
});
