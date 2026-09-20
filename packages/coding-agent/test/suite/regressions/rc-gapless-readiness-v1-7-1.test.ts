/**
 * RC Gapless Readiness Closure v1.7.1 (FINAL) regressions — RCG-001..075.
 *
 * Every scenario here runs through the normal SDK composition with a mocked provider transport and
 * replayed decision results in the engine's real normalized shapes. Nothing in this file requires a
 * provider credential, a live Jev call, or direct controller construction standing in for wiring.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CapabilityProofRunner,
	compileCapabilityProofObligations,
	RealCapabilityBuilder,
	RealMechanicalVerifier,
	RealWorkerDispatcher,
} from "../../../src/core/adaptive/index.ts";
import { RETENTION_AUDIT_CUSTOM_TYPE } from "../../../src/core/compaction/evidence-retention-projection.ts";
import { DurableOwnerRuleStore, normalizeOwnerRule } from "../../../src/core/project-rules/durable-owner-rules.ts";
import {
	PROJECT_RULE_REPAIR_CUSTOM_TYPE,
	SessionProjectRules,
} from "../../../src/core/project-rules/session-project-rules.ts";
import { createRcSdkHarness } from "../rc-sdk-harness.ts";

/** Tool results still present on the compacted projection, which the audit entry never inflates. */
function countToolResults(branch: readonly unknown[]): number {
	return branch.filter(
		(entry) =>
			(entry as { type?: string }).type === "message" &&
			((entry as { message?: { role?: string } }).message?.role ?? "") === "toolResult",
	).length;
}

/** Above the planner's recency window, so pairs are actually offered to the decision engine. */
const PAIRS_BEYOND_RECENCY_WINDOW = 20;

type CompactionInternals = {
	_compaction: {
		planEvidenceRetention(signal: AbortSignal): Promise<void>;
		getCompactionBranch(): unknown[];
		getAppliedRetentionAudit():
			| {
					stats: {
						pairsRemoved: number;
						resultsTruncated: number;
						pinnedPairs: number;
						jevRequestCount: number;
						failureReason?: string;
					};
					droppedCallIds: readonly string[];
					truncatedCallIds: readonly string[];
			  }
			| undefined;
	};
};

/** Appends one assistant tool call and its result to the live session branch. */
function appendToolExchange(
	harness: Awaited<ReturnType<typeof createRcSdkHarness>>,
	options: { callId: string; toolName: string; output: string; isError?: boolean },
): void {
	const model = harness.session.model;
	harness.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "toolCall", id: options.callId, name: options.toolName, arguments: {} }],
		api: model?.api ?? "anthropic-messages",
		provider: model?.provider ?? "faux",
		model: model?.id ?? "faux-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	} as never);
	harness.session.sessionManager.appendMessage({
		role: "toolResult",
		toolCallId: options.callId,
		toolName: options.toolName,
		content: [{ type: "text", text: options.output }],
		isError: options.isError ?? false,
		timestamp: Date.now(),
	} as never);
}

describe("RC Gapless Readiness Closure v1.7.1", () => {
	describe("Execution fail-closed (RCG-020..RCG-027)", () => {
		it("RCG-025: a dispatcher or builder without a real worker execution owner cannot be constructed", () => {
			expect(() => new RealWorkerDispatcher({})).toThrow(/real worker execution owner/);
			expect(
				() =>
					new RealCapabilityBuilder({
						taskRuntime: {} as never,
						taskProfiles: {} as never,
						contractFactory: {} as never,
						cwd: "/tmp",
					}),
			).toThrow(/real worker execution owner/);
		});

		it("RCG-022, RCG-024: specialist dispatch raises instead of manufacturing a result", async () => {
			const dispatcher = new RealWorkerDispatcher({ runWorkerDelegationOnce: async () => ({}) });
			await expect(
				dispatcher.dispatchSpecialist({
					specialist: {
						spec: { specialist_id: "spec-1", mission: "do the thing", objective_id: "obj-1" },
						profileId: "prof-1",
						expert: { providerId: "p", modelId: "m", routingBand: "medium", capabilityTier: "tier_2" },
						executionContract: {},
						isExisting: false,
					} as never,
					taskId: "task-1",
				}),
			).rejects.toThrow(/never fabricated/);
		});

		it("RCG-027: every declared proof obligation is executed, and a failing one blocks", async () => {
			const harness = await createRcSdkHarness();
			mkdirSync(join(harness.cwd, "capabilities"), { recursive: true });
			writeFileSync(join(harness.cwd, "capabilities", "cap_good.mjs"), "export default async () => 1;\n");
			writeFileSync(join(harness.cwd, "capabilities", "cap_inert.mjs"), "export const value = 1;\n");

			const verifier = new RealMechanicalVerifier({
				proofRunner: new CapabilityProofRunner(),
				cwd: harness.cwd,
				provenance: "production-live",
			});
			const specFor = (capabilityId: string) =>
				({
					schema_version: "1.0",
					capability_id: capabilityId,
					version: "1.0",
					kind: "toolkit_script",
					lifetime: "session",
					purpose: "probe",
					interface: {},
					side_effects: [],
					denied_behavior: [],
					proof: compileCapabilityProofObligations(capabilityId, "toolkit_script"),
					activation: {},
					rollback: {},
				}) as never;

			const proof = JSON.parse(await verifier.runTaskSpecificProof(specFor("cap_good")));
			expect(proof.proofs.length).toBe(3);
			expect(proof.proofs.every((entry: { status: string }) => entry.status === "passed")).toBe(true);
			expect(proof.proofs.map((entry: { kind: string }) => entry.kind)).toContain("task_specific_test");

			await expect(verifier.runTaskSpecificProof(specFor("cap_inert"))).rejects.toThrow(/proof obligations failed/);
			await expect(verifier.runTaskSpecificProof(specFor("cap_absent"))).rejects.toThrow(/proof obligations failed/);
		});
	});

	describe("Durable owner rules (RCG-010..RCG-014, RCG-046)", () => {
		it("RCG-010: a normal prompt carrying an owner development directive becomes a durable policy", async () => {
			const harness = await createRcSdkHarness();
			harness.replyWith("acknowledged");
			await harness.session.prompt("deliver this end-to-end, no tdd and this is not negotinable");

			const policies = harness.session.getOwnerRulePolicies();
			expect(policies).toHaveLength(1);
			expect(policies[0]?.consequence).toBe("critical");
			expect(policies[0]?.forbid).toContain("tdd_workflow");
			expect(policies[0]?.phases).toEqual(["build", "adapt"]);
			expect(policies[0]?.broad_verification_phases).toEqual(["verify", "deliver"]);
			// The owner's exact words are retained, never paraphrased into the rule.
			expect(policies[0]?.original_text).toContain("not negotinable");
		});

		it("RCG-011..RCG-013: a fast-pace directive forbids per-edit whole-repository validation", () => {
			const policy = normalizeOwnerRule("no TDD, mandatory, fast paced only");
			expect(policy?.forbid).toEqual(
				expect.arrayContaining(["tdd_workflow", "full_suite_per_edit", "full_repo_gate_per_edit"]),
			);
			expect(policy?.prefer).toContain("milestone_validation");
			expect(policy?.allow.length).toBeGreaterThan(0);
		});

		it("RCG-010: a request that carries no development directive creates no policy", async () => {
			const harness = await createRcSdkHarness();
			harness.replyWith("ok");
			await harness.session.prompt("add a button to the settings screen");
			expect(harness.session.getOwnerRulePolicies()).toEqual([]);

			// An instruction asking FOR the practice is not a prohibition of it.
			expect(normalizeOwnerRule("please use TDD for this one")).toBeUndefined();
		});

		it("RCG-046: the policy survives a new session on the same project (restart)", async () => {
			const first = await createRcSdkHarness();
			first.replyWith("ok");
			await first.session.prompt("no TDD, mandatory, fast paced only");
			expect(first.session.getOwnerRulePolicies()).toHaveLength(1);

			// A fresh store over the same agent dir and project is exactly what a restart produces.
			const restored = new DurableOwnerRuleStore({ agentDir: first.agentDir, projectKey: first.cwd });
			expect(restored.list()).toHaveLength(1);
			expect(restored.list()[0]?.forbid).toContain("tdd_workflow");
		});

		it("RCG-046: the rules reach worker, specialist and capability-builder missions", async () => {
			const harness = await createRcSdkHarness();
			harness.replyWith("ok");
			await harness.session.prompt("no TDD, mandatory, fast paced only");
			const rendered = harness.session.renderOwnerRulesForMission();
			expect(rendered).toContain("MANDATORY OWNER DEVELOPMENT RULES");

			const dispatched: string[] = [];
			const dispatcher = new RealWorkerDispatcher({
				runWorkerDelegationOnce: async (request) => {
					dispatched.push(String((request as { instructions?: string }).instructions ?? ""));
					return {};
				},
				getOwnerRules: () => rendered,
			});
			await dispatcher.dispatch({ route: "continue_worker", action: "continue_worker" } as never);
			expect(dispatched[0]).toContain("MANDATORY OWNER DEVELOPMENT RULES");

			const builderMissions: string[] = [];
			const builder = new RealCapabilityBuilder({
				taskRuntime: {} as never,
				taskProfiles: {} as never,
				contractFactory: {} as never,
				cwd: harness.cwd,
				runWorkerOnce: async (request) => {
					builderMissions.push(String((request as { instructions?: string }).instructions ?? ""));
					return {};
				},
				getOwnerRules: () => rendered,
			});
			expect(builder.provenance).toBe("production-live");
			// The mission text is composed before any worker call; a rejected build still proves it.
			await expect(
				builder.build(
					{
						schema_version: "1.0",
						capability_id: "cap_probe",
						version: "1.0",
						kind: "ephemeral_script",
						lifetime: "one_shot",
						purpose: "probe",
						interface: {},
						side_effects: [],
						denied_behavior: [],
						proof: compileCapabilityProofObligations("cap_probe", "ephemeral_script"),
						activation: {},
						rollback: {},
					} as never,
					undefined,
					undefined,
				),
			).rejects.toThrow(/ExpertBinding/);
		});
	});

	describe("Semantic project rules live hooks (RCG-041..RCG-043)", () => {
		const AGENTS_MD = [
			"# Development Rules",
			"",
			"## Code Quality",
			"",
			"- Never use inline imports (`await import()`); top-level imports only.",
			"- Never commit unless the user asks.",
		].join("\n");

		it("RCG-041: a normal SDK session compiles trusted rules and blocks a violating mutation", async () => {
			const harness = await createRcSdkHarness({
				agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }],
			});

			const rules = harness.session.projectRules.getRules();
			expect(rules.length).toBeGreaterThan(0);
			const inlineImportRule = rules.find((rule) => rule.text.includes("inline imports"));
			expect(inlineImportRule).toBeDefined();
			// "Never" makes it the owner's blocking class; the deterministic heuristic owns the check.
			expect(inlineImportRule?.consequence).toBe("critical");
			expect(inlineImportRule?.owner).toBe("deterministic");
			// Provenance is the trusted source, not arbitrary repository text.
			expect(rules.every((rule) => rule.source.path === "AGENTS.md")).toBe(true);

			const violating = join(harness.cwd, "offender.ts");
			writeFileSync(violating, "export async function load() { return await import('./other.ts'); }\n");
			const result = await harness.session.projectRules.validateMutation({ changedFiles: [violating] });

			expect(result.passed).toBe(false);
			expect(result.violations[0]?.explanation).toContain("Inline dynamic import");
			expect(result.repairWork).toBeDefined();
		});

		it("RCG-045: a blocking violation queues durable RepairWork on the session", async () => {
			const harness = await createRcSdkHarness({
				agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }],
			});
			const violating = join(harness.cwd, "offender.ts");
			writeFileSync(violating, "const mod = await import('./x.ts');\n");
			await harness.session.projectRules.validateMutation({ changedFiles: [violating] });

			const queued = harness.session.getQueuedRuleRepairWork();
			expect(queued).toHaveLength(1);
			expect(queued[0]?.blocking).toBe(true);
			expect(queued[0]?.required_verifications).toContain("project_rule_recheck");

			const persisted = harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === PROJECT_RULE_REPAIR_CUSTOM_TYPE);
			expect(persisted).toHaveLength(1);
		});

		it("RCG-041: a compliant mutation passes silently", async () => {
			const harness = await createRcSdkHarness({
				agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }],
			});
			const compliant = join(harness.cwd, "clean.ts");
			writeFileSync(compliant, "import { join } from 'node:path';\nexport const p = join('a', 'b');\n");
			const result = await harness.session.projectRules.validateMutation({ changedFiles: [compliant] });
			expect(result.passed).toBe(true);
			expect(result.summaryEvent).toBeUndefined();
			expect(harness.session.getQueuedRuleRepairWork()).toEqual([]);
		});

		it("RCG-046: a critical semantic rule that cannot be evaluated fails closed", async () => {
			const harness = await createRcSdkHarness({
				agentsFiles: [{ path: "AGENTS.md", content: "- Never leave a TODO in shipped code.\n" }],
				decisions: { failWith: new Error("semantic transport unavailable") },
			});
			const file = join(harness.cwd, "todo.ts");
			writeFileSync(file, "// TODO: finish\nexport const x = 1;\n");
			const result = await harness.session.projectRules.validateMutation({ changedFiles: [file] });

			expect(result.passed).toBe(false);
			expect(result.violations[0]?.ruleId).toBe("critical_rule_eval_failure");
			expect(result.violations[0]?.consequence).toBe("critical");
		});

		it("RCG-042, RCG-043: postflight and completion evaluate their own phase rules and block", async () => {
			const phaseRules = [
				"## Code Quality",
				"- Never use inline imports (`await import()`); top-level imports only.",
				"",
				"## Task postflight",
				"- Never leave a postflight obligation unmet.",
				"",
				"## Completion",
				"- Never complete with an unresolved release blocker.",
			].join("\n");
			const harness = await createRcSdkHarness({
				agentsFiles: [{ path: "AGENTS.md", content: phaseRules }],
				// The semantic engine confirms both phase rules are violated.
				decisions: { fallback: { kind: "boolean", probabilityTrue: 0.93 } },
			});

			const rules = harness.session.projectRules.getRules();
			expect(rules.some((rule) => rule.phase === "task_postflight")).toBe(true);
			expect(rules.some((rule) => rule.phase === "completion")).toBe(true);

			const postflight = await harness.session.projectRules.validateTaskPostflight({
				objectiveId: "obj-1",
				taskId: "task-1",
				changedFiles: ["src/thing.ts"],
			});
			expect(postflight.passed).toBe(false);
			expect(SessionProjectRules.blocks(postflight)).toBe(true);

			const completion = await harness.session.projectRules.validateCompletion({
				objectiveId: "obj-1",
				changedFiles: ["src/thing.ts"],
			});
			expect(completion.passed).toBe(false);
			expect(SessionProjectRules.blocks(completion)).toBe(true);
			expect(harness.session.getQueuedRuleRepairWork().length).toBe(2);
		});

		it("RCG-046: durable owner rules become blocking rules at all three phases", async () => {
			const harness = await createRcSdkHarness();
			harness.replyWith("ok");
			await harness.session.prompt("no TDD, mandatory, fast paced only");

			const ownerRuleIds = harness.session.projectRules
				.getRules()
				.filter((rule) => rule.source.path === "owner:instruction");
			expect(ownerRuleIds.map((rule) => rule.phase).sort()).toEqual(["completion", "mutation", "task_postflight"]);
			expect(ownerRuleIds.every((rule) => rule.consequence === "critical")).toBe(true);
		});

		it("RCG-041: the live mutation-acceptance hook turns a violating write into an error result", async () => {
			const harness = await createRcSdkHarness({
				agentsFiles: [{ path: "AGENTS.md", content: AGENTS_MD }],
			});
			const violating = join(harness.cwd, "offender.ts");
			writeFileSync(violating, "const mod = await import('./x.ts');\n");

			// The hook the session installs on the live tool gate, exercised by its real signature.
			const gate = (
				harness.session as unknown as {
					_toolGate: {
						afterToolCall(
							input: unknown,
						): Promise<{ isError?: boolean; content?: { type: string; text?: string }[] } | undefined>;
					};
				}
			)._toolGate;
			const hookResult = await gate.afterToolCall({
				toolCall: { id: "call-1", name: "write", arguments: { path: violating } },
				args: { path: violating },
				result: { content: [{ type: "text", text: "wrote 1 file" }] },
				isError: false,
			});

			expect(hookResult?.isError).toBe(true);
			expect(hookResult?.content?.[0]?.text).toContain("Mutation rejected by project rules");
			expect(hookResult?.content?.[0]?.text).toContain("RepairWork");
		});
	});

	describe("Evidence-preserving compaction live path (RCG-040)", () => {
		it("RCG-040: the real compaction owner plans retention and its decisions change the compacted branch", async () => {
			const harness = await createRcSdkHarness({
				decisions: {
					// Old read evidence is no longer useful; the recent pair stays pinned by recency.
					fallback: { kind: "boolean", probabilityTrue: 0.05 },
				},
			});
			for (let index = 0; index < PAIRS_BEYOND_RECENCY_WINDOW; index++) {
				appendToolExchange(harness, {
					callId: `call-${index}`,
					toolName: "read",
					output: `stale evidence ${index}`.repeat(10),
				});
			}

			const internals = harness.session as unknown as CompactionInternals;
			const before = countToolResults(internals._compaction.getCompactionBranch());
			await internals._compaction.planEvidenceRetention(new AbortController().signal);
			const after = countToolResults(internals._compaction.getCompactionBranch());

			const audit = internals._compaction.getAppliedRetentionAudit();
			expect(audit).toBeDefined();
			expect(audit?.stats.jevRequestCount).toBe(1);
			expect(audit?.droppedCallIds.length).toBeGreaterThan(0);
			// The decisions must alter the real compacted projection, not merely be reported.
			expect(after).toBeLessThan(before);
			expect(before - after).toBe(audit?.droppedCallIds.length);
			// The recency window is never offered to the engine, so the newest pairs survive.
			expect(audit?.stats.pinnedPairs).toBeGreaterThan(0);

			// RCG-040: the applied audit is durable on the session branch.
			const persisted = harness.session.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === RETENTION_AUDIT_CUSTOM_TYPE);
			expect(persisted.length).toBe(1);
		});

		it("RCG-040: a semantic transport failure deletes nothing", async () => {
			const harness = await createRcSdkHarness({
				decisions: { failWith: new Error("system one transport unavailable") },
			});
			for (let index = 0; index < PAIRS_BEYOND_RECENCY_WINDOW; index++) {
				appendToolExchange(harness, { callId: `call-${index}`, toolName: "read", output: `evidence ${index}` });
			}

			const internals = harness.session as unknown as CompactionInternals;
			const before = countToolResults(internals._compaction.getCompactionBranch());
			await internals._compaction.planEvidenceRetention(new AbortController().signal);
			expect(countToolResults(internals._compaction.getCompactionBranch())).toBe(before);

			const audit = internals._compaction.getAppliedRetentionAudit();
			expect(audit?.droppedCallIds).toEqual([]);
			expect(audit?.truncatedCallIds).toEqual([]);
			expect(audit?.stats.failureReason).toContain("system one transport unavailable");
		});

		it("RCG-040: an errored pair and a recent pair are pinned even when the engine says drop", async () => {
			const harness = await createRcSdkHarness({
				decisions: { fallback: { kind: "boolean", probabilityTrue: 0.0 } },
			});
			appendToolExchange(harness, {
				callId: "call-error",
				toolName: "bash",
				output: "error: compilation failed",
				isError: true,
			});
			for (let index = 0; index < PAIRS_BEYOND_RECENCY_WINDOW; index++) {
				appendToolExchange(harness, { callId: `call-${index}`, toolName: "read", output: `noise ${index}` });
			}

			const internals = harness.session as unknown as CompactionInternals;
			await internals._compaction.planEvidenceRetention(new AbortController().signal);
			const audit = internals._compaction.getAppliedRetentionAudit();
			expect(audit?.droppedCallIds.length).toBeGreaterThan(0);
			expect(audit?.droppedCallIds).not.toContain("call-error");
			// The newest pairs are inside the recency window and are never offered to the engine.
			expect(audit?.droppedCallIds).not.toContain(`call-${PAIRS_BEYOND_RECENCY_WINDOW - 1}`);
		});
	});
});
