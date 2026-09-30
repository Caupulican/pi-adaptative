// @isolated: uses native session runtime and local Git publication fixtures
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createLaneToolSurface } from "../../src/core/autonomy/lane-tool-surface.ts";
import type { ExtensionContext } from "../../src/core/extensions/types.ts";
import { createGoalState } from "../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../../src/core/goals/session-goal-state.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { committedRepo } from "../git-fixture.ts";
import { tempDir } from "../temp-dir.ts";
import { createHarness } from "./harness.ts";

function controller() {
	return new SystemOneController({
		store: new ExecutionStore({
			run_id: "rank2-review",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "base" },
		}),
		adapter: {
			evaluate: async () => ({
				model: "jev-fixture",
				latency_ms: 1,
				answers: {
					route_choice: { type: "choice", choice: "stronger", confidence: 0.99 },
					verification_operation_safe: { noul: 0.99 },
					verification_resolution_valid: { noul: 0.99 },
				},
			}),
		},
	});
}

describe("rank 2 composed binding probe", () => {
	it("keeps unrelated repository delivery available while the original scope is pending", async () => {
		const repo = committedRepo("verification-scope-");
		const other = committedRepo("verification-other-scope-");
		const remote = tempDir("verification-other-remote-");
		execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", remote], { cwd: other, stdio: "ignore" });
		const semantic = controller();
		const h = await createHarness({
			cwd: repo,
			systemOneController: semantic,
			settings: { modelRouter: { enabled: false } },
		});
		semantic.noteControlDirective({
			source: "postflight",
			objectiveRoute: "deterministic_test",
			reasonCodes: ["same_lane_verification_required", "Verify current repository README"],
		});
		h.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: `git -C '${other}' push origin HEAD:refs/heads/unrelated` })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Unrelated repository delivered; current finding remains."),
		]);
		await h.session.prompt("Publish the independently authorized unrelated repository.");
		expect(
			execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
				stdio: ["ignore", "pipe", "pipe"],
			}).toString(),
		).toContain("refs/heads/unrelated");
		expect(semantic.verification.status().obligations).toHaveLength(1);
	});
	it.each(["rejected", "repaired"] as const)(
		"native evidence resolves %s findings and permits autonomous delivery",
		async (disposition) => {
			const repo = committedRepo("verification-recovery-");
			const remote = tempDir("verification-recovery-remote-");
			execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
			execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
			const semantic = controller();
			const h = await createHarness({
				cwd: repo,
				models: [
					{ id: "lead", reasoning: true },
					{ id: "peer", reasoning: true },
				],
				systemOneController: semantic,
				settings: { modelRouter: { enabled: false } },
			});
			h.session.setThinkingLevel("medium");
			h.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("peer", {
							action: "review",
							review: {
								peer: `${h.getModel().provider}/peer`,
								thinkingLevel: "high",
								stage: "delivery",
								objective: "Verify README content",
								artifact: "README.md contains one",
								evidence: "README.md contains one",
							},
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					JSON.stringify({
						verdict: "findings",
						summary: "Verify required content",
						findings: [
							{
								summary: "Potential content mismatch",
								evidence: "README.md contains one",
								requiredCheck: `Verify README contains ${disposition === "repaired" ? "two" : "one"}.`,
							},
						],
						limitations: [],
					}),
				),
				fauxAssistantMessage("I will reproduce the candidate."),
			]);
			await h.session.prompt("Review required README content with the peer.");
			const obligation = semantic.verification.status().obligations[0];
			expect(obligation).toBeDefined();
			h.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Reproduced against current source."),
			]);
			await h.session.prompt("Reproduce the finding in this lane.");
			if (disposition === "repaired") {
				h.setResponses([
					fauxAssistantMessage([fauxToolCall("edit", { path: "README.md", oldText: "one", newText: "two" })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage([fauxToolCall("bash", { command: 'test "$(cat README.md)" = two' })], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("Repaired and checked README."),
				]);
				await h.session.prompt("Repair confirmed content mismatch and recheck.");
			}
			const receipts = semantic.verification.status().receipts;
			const evidence = [{ receiptId: receipts.find((item) => item.tool === "read")!.id, role: "reproduction" }];
			if (disposition === "repaired")
				evidence.push(
					{ receiptId: receipts.find((item) => item.tool === "edit")!.id, role: "repair" },
					{ receiptId: receipts.find((item) => item.tool === "bash")!.id, role: "recheck" },
				);
			h.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("peer", { action: "resolve", resolution: { id: obligation.id, disposition, evidence } })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					[
						fauxToolCall("bash", {
							command: `${disposition === "repaired" ? "git add README.md && git -c commit.gpgsign=false commit -m 'Repair README' && " : ""}git push origin HEAD:refs/heads/reviewed`,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Resolved and delivered."),
			]);
			await h.session.prompt("Resolve the finding from these host receipts, then deliver.");
			expect(
				h.session.messages.filter((item) => item.role === "toolResult" && item.toolName === "peer").at(-1),
			).toMatchObject({ isError: false, details: { status: "resolved" } });
			expect(semantic.peekControlDirective()).toBeUndefined();
			expect(
				execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
					stdio: ["ignore", "pipe", "pipe"],
				}).toString(),
			).toContain("refs/heads/reviewed");
			expect(
				execFileSync("git", ["--git-dir", remote, "show", "refs/heads/reviewed:README.md"], {
					stdio: ["ignore", "pipe", "pipe"],
				}).toString(),
			).toBe(disposition === "repaired" ? "two\n" : "one\n");
		},
	);

	it("a worker executing through its own tools cannot bypass the parent's finding in YOLO", async () => {
		const repo = committedRepo("verification-worker-");
		const semantic = controller();
		await createHarness({ cwd: repo, systemOneController: semantic, settings: { modelRouter: { enabled: false } } });
		semantic.noteControlDirective({
			source: "postflight",
			objectiveRoute: "deterministic_test",
			reasonCodes: ["same_lane_verification_required", "Verify README before publication"],
		});
		const lane = createLaneToolSurface({
			cwd: repo,
			yolo: true,
			shellSessionKey: "verification-worker",
			sharedToolOptions: { getVerification: () => semantic.verification },
		});
		try {
			await expect(
				lane.tools
					.find((tool) => tool.name === "bash")!
					.execute("worker-push", { command: "git push origin HEAD" }),
			).rejects.toThrow("same_lane_verification_required");
			expect(semantic.verification.status().obligations).toHaveLength(1);
		} finally {
			await lane.dispose();
		}
	});

	it("stale passing evidence cannot reject a finding after the worktree changes", async () => {
		const repo = committedRepo("verification-stale-");
		const semantic = controller();
		const h = await createHarness({
			cwd: repo,
			systemOneController: semantic,
			models: [
				{ id: "lead", reasoning: true },
				{ id: "peer", reasoning: true },
			],
			settings: { modelRouter: { enabled: false } },
		});
		semantic.noteControlDirective({
			source: "postflight",
			objectiveRoute: "deterministic_test",
			reasonCodes: ["same_lane_verification_required", "Verify README content"],
		});
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Checked README."),
		]);
		await h.session.prompt("Reproduce the finding.");
		const state = semantic.verification.status();
		writeFileSync(join(repo, "README.md"), "changed after check\n");
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("peer", {
						action: "resolve",
						resolution: {
							id: state.obligations[0].id,
							disposition: "rejected",
							evidence: [{ receiptId: state.receipts[0].id, role: "reproduction" }],
						},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Must check current source."),
		]);
		await h.session.prompt("Attempt resolution using the previous check.");
		expect(
			h.session.messages.filter((item) => item.role === "toolResult" && item.toolName === "peer").at(-1),
		).toMatchObject({ isError: true });
		expect(semantic.verification.status().obligations).toHaveLength(1);
	});
	it("native completion verify_more blocks publication of that goal", async () => {
		const repo = committedRepo("rank2-completion-publish-");
		const remote = tempDir("rank2-completion-remote-");
		execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
		const store = new ExecutionStore({
			run_id: "rank2-completion",
			objective: {
				request: "Publish README",
				normalized_goal: "Publish README",
				acceptance_criteria: [{ id: "AC", text: "README verified", required: true }],
			},
			repo: { root: repo, baseline_revision: "base" },
		});
		store.recordVerification({ kind: "unit_test", status: "passed", covers_acceptance_ids: ["AC"] });
		const semantic = new SystemOneController({
			store,
			adapter: {
				evaluate: async () => ({
					model: "jev-fixture",
					latency_ms: 1,
					answers: {
						outcomes_achieved: true,
						required_behavior_unverified: false,
						material_claim_unsupported: false,
						out_of_scope_change_present: false,
						duplicate_responsibility_introduced: false,
						completion_verdict: { choice: "complete", confidence: 0.99, probabilities: { complete: 0.99 } },
						missing_requirement: false,
						hidden_assumption: true,
						plausible_regression_not_tested: false,
						conclusion_overstates_evidence: false,
					},
				}),
			},
		});
		const h = await createHarness({
			cwd: repo,
			systemOneController: semantic,
			settings: { modelRouter: { enabled: false }, edge: { allow: ["publish"] } },
		});
		appendGoalStateSnapshot(
			h.sessionManager,
			createGoalState({ goalId: "reviewed-goal", userGoal: "Publish README", now: new Date().toISOString() }),
		);
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("goal", { action: "complete" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "git push origin HEAD:refs/heads/reviewed", timeout: 10 })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Published despite unresolved completion review."),
		]);
		await h.session.prompt("Complete and publish README only after resolving required verification.");
		const completion = h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "goal");
		expect(completion).toMatchObject({ isError: true });
		expect(JSON.stringify(completion)).toContain("JEV-CHALLENGE-hidden_assumption");
		expect(semantic.peekControlDirective()?.reasonCodes).toContain("same_lane_verification_required");
		expect(h.session.getGoalStateSnapshot()?.status).not.toBe("completed");
		const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
			stdio: ["ignore", "pipe", "pipe"],
		}).toString();
		expect(refs).not.toContain("refs/heads/reviewed");
	});
	it.each(["guarded", "yolo"] as const)(
		"unresolved native peer findings block affected local publication in %s",
		async (mode) => {
			const repo = committedRepo("rank2-peer-publish-");
			const remote = tempDir("rank2-local-remote-");
			execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
			execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
			const semantic = controller();
			const h = await createHarness({
				cwd: repo,
				models: [
					{ id: "lead", reasoning: true },
					{ id: "peer", reasoning: true },
				],
				systemOneController: semantic,
				settings: { modelRouter: { enabled: false }, edge: { mode, allow: ["publish"] } },
			});
			h.session.setThinkingLevel("medium");
			const peerRequest = {
				action: "review",
				review: {
					peer: `${h.getModel().provider}/peer`,
					thinkingLevel: "high",
					stage: "delivery",
					objective: "Publish README after verifying peer findings",
					artifact: "README.md contains one",
					evidence: "README.md contains one",
				},
			};
			h.setResponses([
				fauxAssistantMessage([fauxToolCall("peer", peerRequest)], { stopReason: "toolUse" }),
				fauxAssistantMessage(
					JSON.stringify({
						verdict: "findings",
						summary: "Check the reviewed README before delivery.",
						findings: [
							{
								summary: "Candidate mismatch",
								evidence: "README.md contains one",
								requiredCheck: "Read README and verify the required content before publication.",
							},
						],
						limitations: [],
					}),
				),
			]);
			h.appendResponses([
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "git push origin HEAD:refs/heads/reviewed", timeout: 10 })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Published without reproducing the candidate."),
			]);
			await h.session.prompt("Review README with the peer; resolve its findings before publishing README.");
			expect(h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "peer")).toMatchObject({
				details: { status: "reviewed" },
			});
			expect(semantic.peekControlDirective()?.reasonCodes).toContain("same_lane_verification_required");
			const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
				stdio: ["ignore", "pipe", "pipe"],
			}).toString();
			expect(refs).not.toContain("refs/heads/reviewed");
		},
	);

	it("negative control: no-findings permits owner-authorized local publication", async () => {
		const repo = committedRepo("rank2-clean-publish-");
		const remote = tempDir("rank2-clean-remote-");
		execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
		execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, stdio: "ignore" });
		const semantic = controller();
		const h = await createHarness({
			cwd: repo,
			models: [
				{ id: "lead", reasoning: true },
				{ id: "peer", reasoning: true },
			],
			systemOneController: semantic,
			settings: { modelRouter: { enabled: false }, edge: { allow: ["publish"] } },
		});
		h.session.setThinkingLevel("medium");
		h.setResponses([
			fauxAssistantMessage(
				JSON.stringify({
					verdict: "no_findings",
					summary: "No candidate in supplied snapshot.",
					findings: [],
					limitations: [],
				}),
			),
		]);
		await h.session.getToolDefinition("peer")!.execute(
			"peer-clean",
			{
				action: "review",
				review: {
					peer: `${h.getModel().provider}/peer`,
					thinkingLevel: "high",
					stage: "delivery",
					objective: "Publish README",
					artifact: "README.md contains one",
					evidence: "README.md contains one",
				},
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(semantic.peekControlDirective()).toBeUndefined();
		h.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("bash", { command: "git push origin HEAD:refs/heads/reviewed", timeout: 10 })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Published."),
		]);
		await h.session.prompt("Publish the reviewed README.");
		expect(
			execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname)"], {
				stdio: ["ignore", "pipe", "pipe"],
			}).toString(),
		).toContain("refs/heads/reviewed");
	});

	it("unresolved finding survives native session reopen", async () => {
		const agentDir = tempDir("rank2-reopen-");
		const semantic = controller();
		const h = await createHarness({
			agentDir,
			persistSession: true,
			models: [
				{ id: "lead", reasoning: true },
				{ id: "peer", reasoning: true },
			],
			systemOneController: semantic,
			settings: { modelRouter: { enabled: false } },
			extensionFactories: [
				(pi) =>
					pi.registerTool({
						name: "verify",
						label: "Verify",
						description: "Failed deterministic control",
						parameters: Type.Object({}),
						async execute() {
							return {
								content: [{ type: "text", text: "failed" }],
								isError: true,
								details: { piVerification: { version: 1, id: "durable-control", status: "failed" } },
							};
						},
					}),
			],
		});
		h.session.setThinkingLevel("medium");
		h.setResponses([fauxAssistantMessage("Session initialized.")]);
		await h.session.prompt("Inspect README.");
		h.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("peer", {
						action: "review",
						review: {
							peer: `${h.getModel().provider}/peer`,
							thinkingLevel: "high",
							stage: "delivery",
							objective: "Publish README",
							artifact: "README.md contains one",
							evidence: "README.md contains one",
						},
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				JSON.stringify({
					verdict: "findings",
					summary: "Verify before delivery.",
					findings: [
						{
							summary: "Candidate mismatch",
							evidence: "README.md contains one",
							requiredCheck: "Verify README content.",
						},
					],
					limitations: [],
				}),
			),
			fauxAssistantMessage([fauxToolCall("verify", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("Finding and failed check remain unresolved."),
		]);
		await h.session.prompt("Review the README with the peer before delivery.");
		expect(h.session.messages.find((m) => m.role === "toolResult" && m.toolName === "peer")).toMatchObject({
			details: { status: "reviewed" },
		});
		expect(semantic.peekControlDirective()).toBeDefined();
		const restoredController = controller();
		const restored = await createHarness({
			agentDir,
			sessionFile: h.sessionManager.getSessionFile()!,
			sharedFauxProvider: h.faux,
			systemOneController: restoredController,
			settings: { modelRouter: { enabled: false } },
		});
		expect(restored.session.messages.find((m) => m.role === "toolResult" && m.toolName === "peer")).toBeDefined();
		expect(restored.session.getVerificationObligations().map((v) => v.id)).toContain("durable-control");
		expect(restoredController.peekControlDirective()).toBeDefined();
	});
});
