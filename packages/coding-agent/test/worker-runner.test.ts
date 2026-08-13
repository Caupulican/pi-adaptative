import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import type { WorkerRequest } from "../src/core/autonomy/contracts.ts";
import {
	appendWorkerClaimSnapshot,
	getWorkerClaimSnapshots,
	getWorkerRequestSnapshots,
} from "../src/core/delegation/session-worker-claim.ts";
import {
	buildWorkerSystemPrompt,
	buildWorkerUserPrompt,
	parseWorkerOutput,
	runWorker,
	WORKER_LANE_SYSTEM_PROMPT,
	type WorkerCompletion,
	type WorkerRunnerOptions,
} from "../src/core/delegation/worker-runner.ts";
import { WorkerTreeBudgetExceededError } from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import { CapabilityGatewayDeniedError } from "../src/core/orchestration/capability-gateway.ts";

function workerRequest(overrides: Partial<WorkerRequest> = {}): WorkerRequest {
	return {
		id: "worker-1",
		instructions: "Scout the delegation module and summarize its validation rules",
		route: {
			tier: "cheap",
			risk: "read-only",
			confidence: 1,
			reasonCode: "profile_worker",
			reasons: ["Read-only worker delegation"],
		},
		envelope: {
			id: "worker-env-1",
			capabilities: ["filesystem.read"],
			maxEstimatedUsd: 0.5,
			createdAt: "2026-07-01T00:00:00.000Z",
		},
		maxEstimatedUsd: 0.5,
		createdAt: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function completionOf(text: string, costUsd = 0.01, stopReason = "stop"): WorkerCompletion {
	return { text, costUsd, stopReason };
}

function runnerOptions(overrides: Partial<WorkerRunnerOptions> = {}): WorkerRunnerOptions {
	return {
		request: workerRequest(),
		maxUsd: 0.5,
		maxWallClockMs: 0,
		usageReportId: "worker:session-1:worker-1",
		now: () => "2026-07-01T00:00:01.000Z",
		complete: async () =>
			completionOf('{"summary":"Validation blocks out-of-scope file changes.","status":"completed"}'),
		...overrides,
	};
}

describe("parseWorkerOutput", () => {
	it("parses exact statuses, blocked, and findings-bearing outputs", () => {
		expect(parseWorkerOutput('{"summary":"All good","status":"completed"}')).toEqual({
			summary: "All good",
			status: "completed",
			blockers: [],
			findings: [],
			actions: [],
			reasonCodes: [],
		});

		const blocked = parseWorkerOutput('{"summary":"Cannot proceed","status":"blocked","blockers":["Missing spec"]}');
		expect(blocked?.status).toBe("blocked");
		expect(blocked?.blockers).toEqual(["Missing spec"]);

		const withFindings = parseWorkerOutput(
			'```json\n{"summary":"Done","status":"completed","findings":[{"summary":"Rule A","confidence":0.7},{"summary":"Rule B"}]}\n```',
		);
		expect(withFindings?.findings).toHaveLength(2);
		expect(withFindings?.findings[0]).toEqual({ summary: "Rule A", confidence: 0.7 });
	});

	it("returns undefined for prose or missing summary", () => {
		expect(parseWorkerOutput("no JSON here")).toBeUndefined();
		expect(parseWorkerOutput('{"status":"completed"}')).toBeUndefined();
		expect(parseWorkerOutput('{"summary":""}')).toBeUndefined();
	});

	it("rejects missing, unknown, and non-string claim statuses", () => {
		expect(parseWorkerOutput('{"summary":"missing status"}')).toBeUndefined();
		expect(parseWorkerOutput('{"summary":"failed status","status":"failed"}')).toBeUndefined();
		expect(parseWorkerOutput('{"summary":"object status","status":{"value":"completed"}}')).toBeUndefined();
	});

	it("parses the typed independent-verifier verdict", () => {
		expect(
			parseWorkerOutput(
				'{"summary":"checks passed","status":"completed","verdict":"accepted","reasonCodes":["focused_checks_passed"]}',
			),
		).toMatchObject({ verdict: "accepted", reasonCodes: ["focused_checks_passed"] });
	});

	it("bounds every untrusted structured claim field before it reaches durable state", () => {
		const parsed = parseWorkerOutput(
			JSON.stringify({
				summary: "s".repeat(20_000),
				status: "completed",
				blockers: Array.from({ length: 100 }, () => "b".repeat(1_200)),
				findings: Array.from({ length: 100 }, () => ({ summary: "f".repeat(2_200), confidence: 2 })),
				reasonCodes: Array.from({ length: 100 }, () => "r".repeat(300)),
			}),
		);

		expect(parsed?.summary).toHaveLength(8_000);
		expect(parsed?.blockers).toHaveLength(32);
		expect(parsed?.blockers[0]).toHaveLength(1_000);
		expect(parsed?.findings).toHaveLength(64);
		expect(parsed?.findings[0]?.summary).toHaveLength(2_000);
		expect(parsed?.reasonCodes).toHaveLength(32);
		expect(parsed?.reasonCodes[0]).toHaveLength(128);
	});

	it("preserves a rejected structured action contract for the runner to fail closed", () => {
		const parsed = parseWorkerOutput(
			JSON.stringify({
				summary: "attempted write",
				status: "completed",
				actions: [{ op: "write", path: "x".repeat(2_049), content: "x" }],
			}),
		);

		expect(parsed?.actionRejection).toMatchObject({ kind: "rejected", reasonCode: "worker_actions_path_too_long" });
	});
});

describe("buildWorkerUserPrompt", () => {
	it("fences the task without decorative XML and keeps the worker claim envelope authoritative", () => {
		const prompt = buildWorkerUserPrompt(workerRequest());
		expect(prompt).toContain("TASK\nScout the delegation module");
		expect(prompt).toContain("END TASK");
		expect(prompt).not.toContain("<task>");
		expect(prompt).toContain("Do not replace the worker claim envelope");
		expect(prompt).toContain('inside "summary" and "findings"');
	});
});

describe("buildWorkerSystemPrompt", () => {
	it("keeps inherited parent orchestration outside the worker task owner", () => {
		const prompt = buildWorkerSystemPrompt({ write: false, process: false, delegate: true });
		expect(prompt).toContain("CAVEMAN MODE - MANDATORY");
		expect(prompt).toContain("Inherited parent history is context only");
		expect(prompt).toContain("Execute only the latest TASK envelope");
		expect(prompt).toContain("Parent-owned orchestration stays parent-owned");
		expect(prompt).toContain("delegate only when that TASK explicitly assigns delegation");
	});

	it("describes combined write and process grants without denying either capability", () => {
		const prompt = buildWorkerSystemPrompt({ write: true, process: true });
		expect(prompt).toContain("Write/edit tools");
		expect(prompt).toContain("run_process");
		expect(prompt).not.toContain("workspace tools are read-only");
		expect(prompt.length).toBeLessThan(1_000);
	});
});

describe("runWorker", () => {
	it("completes a delegated worker and passes parent validation", async () => {
		const outcome = await runWorker(runnerOptions());

		expect(outcome.claim.requestId).toBe("worker-1");
		expect(outcome.claim.status).toBe("completed");
		expect(outcome.claim.summary).toBe("Validation blocks out-of-scope file changes.");
		expect(outcome.claim.changedFiles).toEqual([]);
		expect(outcome.claim.usageReportId).toBe("worker:session-1:worker-1");
		expect(outcome.claim.createdAt).toBe("2026-07-01T00:00:01.000Z");
		expect(outcome.acceptance.outcome).toBe("allow");
		expect(outcome.accepted).toBe(true);
		expect(outcome.laneStatus).toBe("succeeded");
		expect(outcome.reasonCode).toBe("worker_completed");
		expect(outcome.costUsd).toBe(0.01);
	});

	it("maps findings into an untrusted evidence bundle", async () => {
		const outcome = await runWorker(
			runnerOptions({
				complete: async () =>
					completionOf(
						'{"summary":"Done","status":"completed","findings":[{"summary":"validateWorkerClaim blocks scope escapes"}]}',
					),
			}),
		);
		expect(outcome.claim.evidence?.findings).toHaveLength(1);
		expect(outcome.claim.evidence?.sources.some((source) => source.kind === "tool" && !source.trusted)).toBe(true);
	});

	it("returns a blocked result that requires parent review", async () => {
		const outcome = await runWorker(
			runnerOptions({
				complete: async () =>
					completionOf('{"summary":"Stuck","status":"blocked","blockers":["Needs credentials"]}'),
			}),
		);
		expect(outcome.claim.status).toBe("blocked");
		expect(outcome.accepted).toBe(false);
		expect(outcome.acceptance.outcome).toBe("block");
		expect(outcome.laneStatus).toBe("blocked");
		expect(outcome.reasonCode).toBe("worker_blocked");
	});

	it("fails closed instead of salvaging malformed structured claim statuses", async () => {
		for (const text of [
			'{"summary":"missing status"}',
			'{"summary":"failed status","status":"failed"}',
			'{"summary":"object status","status":{"value":"completed"}}',
		]) {
			const outcome = await runWorker(runnerOptions({ complete: async () => completionOf(text) }));
			expect(outcome).toMatchObject({
				claim: { status: "failed" },
				accepted: false,
				laneStatus: "failed",
				reasonCode: "unparseable_output",
			});
		}
	});

	it("fails closed when a verifier's typed verdict fields contain malformed values", async () => {
		const outcome = await runWorker(
			runnerOptions({
				verificationSubjectTaskId: "worker-subject",
				complete: async () =>
					completionOf(
						'{"summary":"mixed reason codes","status":"completed","verdict":"accepted","reasonCodes":["focused_checks_passed",7]}',
					),
			}),
		);

		expect(outcome).toMatchObject({
			claim: { status: "failed" },
			accepted: false,
			laneStatus: "failed",
			reasonCode: "unparseable_output",
		});
	});

	it("salvages read-only plain text as bounded untrusted output while preserving spend", async () => {
		const outcome = await runWorker(runnerOptions({ complete: async () => completionOf("plain prose", 0.03) }));
		expect(outcome.claim.status).toBe("completed");
		expect(outcome.claim.outputFormat).toBe("plain_text");
		expect(outcome.claim.summary).toBe("plain prose");
		expect(outcome.laneStatus).toBe("succeeded");
		expect(outcome.reasonCode).toBe("worker_completed_plain_text");
		expect(outcome.costUsd).toBe(0.03);
	});

	it("salvages a read-only custom JSON shape as plain text", async () => {
		const text = '{"filesRead":["src/a.ts"],"conclusion":"done"}';
		const outcome = await runWorker(runnerOptions({ complete: async () => completionOf(text) }));

		expect(outcome.claim.status).toBe("completed");
		expect(outcome.claim.outputFormat).toBe("plain_text");
		expect(outcome.claim.summary).toBe(text);
		expect(outcome.reasonCode).toBe("worker_completed_plain_text");
	});

	it("preserves nonempty read-only output when the model stops at its length bound", async () => {
		const outcome = await runWorker(
			runnerOptions({ complete: async () => completionOf("bounded findings", 0.02, "length") }),
		);

		expect(outcome.claim.status).toBe("completed");
		expect(outcome.claim.summary).toContain("bounded findings");
		expect(outcome.claim.summary).toContain("stop reason 'length'");
		expect(outcome.laneStatus).toBe("succeeded");
		expect(outcome.reasonCode).toBe("worker_completed_plain_text_incomplete");
	});

	it("keeps child tool blockers authoritative when salvaging plain text", async () => {
		const outcome = await runWorker(
			runnerOptions({
				complete: async () => ({
					...completionOf("partial result"),
					blockers: ["read failed during isolated execution"],
				}),
			}),
		);

		expect(outcome.claim.status).toBe("blocked");
		expect(outcome.claim.blockers).toEqual(["read failed during isolated execution"]);
		expect(outcome.accepted).toBe(false);
		expect(outcome.laneStatus).toBe("blocked");
		expect(outcome.reasonCode).toBe("worker_blocked");
	});

	it("surfaces host-observed claim overflow instead of silently preserving an incomplete file review", async () => {
		const outcome = await runWorker(
			runnerOptions({
				getChangedFiles: () => Array.from({ length: 300 }, (_entry, index) => `src/${index}-${"p".repeat(3_000)}`),
				complete: async () => ({
					...completionOf('{"summary":"partial result","status":"completed"}'),
					blockers: Array.from({ length: 100 }, (_entry, index) => `${index}:${"blocked ".repeat(300)}`),
				}),
			}),
		);

		expect(outcome.claim.changedFiles).toEqual([]);
		expect(outcome.claim.blockers?.length).toBeLessThanOrEqual(32);
		expect(outcome.claim.blockers?.every((blocker) => blocker.length <= 1_000)).toBe(true);
		expect(outcome.claim.status).toBe("blocked");
		expect(outcome.claim.blockers).toContain(
			"worker changed-file report exceeded the durable claim bound; parent review is required",
		);
	});

	it("fails on a model error stop reason", async () => {
		const outcome = await runWorker(
			runnerOptions({ complete: async () => completionOf("irrelevant", 0.002, "error") }),
		);
		expect(outcome.claim.status).toBe("failed");
		expect(outcome.laneStatus).toBe("failed");
		expect(outcome.reasonCode).toBe("model_error");
	});

	it("marks the lane budget_exhausted when spend exceeds maxUsd but keeps the result", async () => {
		const outcome = await runWorker(
			runnerOptions({ complete: async () => completionOf('{"summary":"pricey","status":"completed"}', 1.5) }),
		);
		expect(outcome.claim.status).toBe("partial");
		expect(outcome.laneStatus).toBe("budget_exhausted");
		expect(outcome.reasonCode).toBe("cost_budget_exceeded");
	});

	it("treats an explicit zero-dollar budget as a hard ceiling", async () => {
		const outcome = await runWorker(
			runnerOptions({
				maxUsd: 0,
				complete: async () => completionOf('{"summary":"not free","status":"completed"}', 0.01),
			}),
		);
		expect(outcome.laneStatus).toBe("budget_exhausted");
		expect(outcome.reasonCode).toBe("cost_budget_exceeded");
	});

	it.each([
		[
			"attempt token",
			new CapabilityGatewayDeniedError("token_budget_exhausted", "Token budget exhausted."),
			"token_budget_exhausted",
			"Token budget exhausted.",
		],
		[
			"worker-tree token",
			new WorkerTreeBudgetExceededError("maxTokens", "provider completion"),
			"worker_tree_token_budget_exhausted",
			"Worker orchestration tree budget 'maxTokens' is exhausted before provider completion.",
		],
	] as const)(
		"preserves an explicit %s denial as bounded exhaustion instead of a completion error",
		async (_label, error, reasonCode, detail) => {
			const outcome = await runWorker(
				runnerOptions({
					complete: async () => {
						throw error;
					},
				}),
			);

			expect(outcome).toMatchObject({
				claim: {
					status: "partial",
					summary: `Worker paused at budget limit (${reasonCode}): ${detail}`,
				},
				accepted: false,
				laneStatus: "budget_exhausted",
				reasonCode,
				reasonDetail: detail,
			});
		},
	);

	it("cancels on external abort and times out on wall clock breach", async () => {
		const controller = new AbortController();
		const pendingCancel = runWorker(
			runnerOptions({
				signal: controller.signal,
				complete: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			}),
		);
		controller.abort();
		const canceled = await pendingCancel;
		expect(canceled.claim.status).toBe("cancelled");
		expect(canceled.laneStatus).toBe("canceled");

		const timedOut = await runWorker(
			runnerOptions({
				maxWallClockMs: 10,
				getChangedFiles: () => ["src/already-written.ts"],
				complete: ({ signal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			}),
		);
		expect(timedOut.claim.status).toBe("cancelled");
		expect(timedOut.laneStatus).toBe("timeout");
		expect(timedOut.reasonCode).toBe("wall_clock_exceeded");
		expect(timedOut.claim.changedFiles).toEqual(["src/already-written.ts"]);
	});

	it("keeps the worker system prompt static for provider prompt caching", async () => {
		const complete = vi.fn(async ({ systemPrompt }: { systemPrompt: string }) => {
			expect(systemPrompt).toBe(WORKER_LANE_SYSTEM_PROMPT);
			return completionOf('{"summary":"ok","status":"completed"}');
		});
		await runWorker(runnerOptions({ complete }));
		expect(complete).toHaveBeenCalledOnce();
	});

	it("requires and returns a typed verifier decision without plain-text salvage", async () => {
		const accepted = await runWorker(
			runnerOptions({
				verificationSubjectTaskId: "worker-subject",
				complete: async () =>
					completionOf(
						'{"summary":"focused checks passed","status":"completed","verdict":"accepted","reasonCodes":["focused_checks_passed"]}',
					),
			}),
		);
		expect(accepted).toMatchObject({
			accepted: true,
			reasonCode: "verification_accepted",
			claim: {
				verification: {
					subjectTaskId: "worker-subject",
					verdict: "accepted",
					reasonCodes: ["focused_checks_passed"],
				},
			},
		});

		const invalid = await runWorker(
			runnerOptions({
				verificationSubjectTaskId: "worker-subject",
				complete: async () => completionOf("looks good"),
			}),
		);
		expect(invalid).toMatchObject({ reasonCode: "unparseable_output", claim: { status: "failed" } });
	});
});

describe("worker claim persistence (G2)", () => {
	it("round-trips the originating request alongside the claim", () => {
		const sessionManager = SessionManager.inMemory();
		const request = {
			id: "wr-1",
			instructions: "scout the retry helpers",
			route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "test", reasons: [] },
			envelope: { id: "env-1", capabilities: ["filesystem.read"], allowedPaths: ["src"] },
			maxEstimatedUsd: 1,
		};
		const claim = {
			requestId: "wr-1",
			status: "completed",
			reasonCode: "ok",
			summary: "done",
			findings: [],
			changedFiles: [],
			costUsd: 0,
		};
		appendWorkerClaimSnapshot(sessionManager, claim as never, request as never);
		const entries = sessionManager.getEntries();
		expect(getWorkerRequestSnapshots(entries).map((r) => r.id)).toEqual(["wr-1"]);
		expect(getWorkerRequestSnapshots(entries)[0]).toMatchObject({ envelope: { allowedPaths: ["src"] } });
		expect(getWorkerClaimSnapshots(entries)).toHaveLength(1);
	});
});

describe("worker write lane (G2)", () => {
	it("applies actions through the envelope when filesystem.write is granted; refusals become blockers", async () => {
		const { runWorker } = await import("../src/core/delegation/worker-runner.ts");
		const applied: string[] = [];
		const request = {
			id: "wr-write",
			instructions: "add a helper",
			route: { tier: "cheap", risk: "scoped-write", confidence: 1, reasonCode: "t", reasons: [] },
			envelope: {
				id: "env-w",
				capabilities: ["filesystem.read", "filesystem.write"],
				allowedPaths: ["src"],
			},
			maxEstimatedUsd: 1,
		};
		const outcome = await runWorker({
			request: request as never,
			maxUsd: 1,
			maxWallClockMs: 0,
			usageReportId: "u-1",
			complete: async () => ({
				text: JSON.stringify({
					summary: "wrote it",
					status: "completed",
					blockers: [],
					findings: [],
					actions: [
						{ op: "write", path: "src/helper.ts", content: "export const x = 1;" },
						{ op: "write", path: "docs/leak.md", content: "nope" },
					],
				}),
				costUsd: 0,
				stopReason: "stop",
			}),
			applyActions: (actions) => {
				for (const action of actions) applied.push(action.path);
				return {
					changedFiles: ["src/helper.ts"],
					refused: [{ path: "docs/leak.md", reason: "outside scope" }],
					failed: [],
					inspectionRequired: [],
				};
			},
		});
		expect(applied).toEqual(["src/helper.ts", "docs/leak.md"]);
		expect(outcome.claim.changedFiles).toEqual(["src/helper.ts"]);
		// A refusal downgrades the result to blocked — a partial change can never look like clean success.
		expect(outcome.claim.status).toBe("blocked");
		expect(outcome.claim.blockers?.some((b) => b.includes("docs/leak.md"))).toBe(true);
	});

	it("without a filesystem.write grant, emitted actions are ignored and flagged", async () => {
		const { runWorker } = await import("../src/core/delegation/worker-runner.ts");
		const request = {
			id: "wr-ro",
			instructions: "scout",
			route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "t", reasons: [] },
			envelope: { id: "env-ro", capabilities: ["filesystem.read"] },
			maxEstimatedUsd: 1,
		};
		const outcome = await runWorker({
			request: request as never,
			maxUsd: 1,
			maxWallClockMs: 0,
			usageReportId: "u-2",
			complete: async () => ({
				text: JSON.stringify({
					summary: "tried to write",
					status: "completed",
					blockers: [],
					findings: [],
					actions: [{ op: "write", path: "src/x.ts", content: "y" }],
				}),
				costUsd: 0,
				stopReason: "stop",
			}),
		});
		expect(outcome.claim.changedFiles).toEqual([]);
		expect(outcome.claim.status).toBe("blocked");
		expect(outcome.claim.blockers?.some((b) => b.includes("without a filesystem.write"))).toBe(true);
	});

	it("fails closed when a write-capable worker emits malformed structured actions", async () => {
		const request = workerRequest({
			envelope: {
				id: "env-malformed-actions",
				capabilities: ["filesystem.read", "filesystem.write"],
				allowedPaths: ["src"],
			},
		});
		const applyActions = vi.fn();

		const outcome = await runWorker(
			runnerOptions({
				request,
				complete: async () =>
					completionOf(
						JSON.stringify({
							summary: "attempted mutation",
							status: "completed",
							actions: [{ op: "write", path: "x".repeat(2_049), content: "x" }],
						}),
					),
				applyActions,
			}),
		);

		expect(applyActions).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({
			claim: { status: "failed" },
			laneStatus: "failed",
			reasonCode: "unparseable_output",
		});
		expect(outcome.claim.blockers).toContain("worker_actions_path_too_long");
	});

	it("blocks a structured write claim when its durable action journal requires inspection", async () => {
		const request = workerRequest({
			envelope: {
				id: "env-journal",
				capabilities: ["filesystem.read", "filesystem.write"],
				allowedPaths: ["src"],
			},
		});
		const outcome = await runWorker(
			runnerOptions({
				request,
				complete: async () =>
					completionOf(
						'{"summary":"wrote it","status":"completed","actions":[{"op":"write","path":"src/a.ts","content":"x"}]}',
					),
				applyActions: () => ({
					changedFiles: ["src/a.ts"],
					refused: [],
					failed: [],
					inspectionRequired: [
						{
							path: "src/a.ts",
							actionId: "wa-0-test",
							state: "unknown",
							reasonCode: "worker_action_outcome_unknown",
						},
					],
				}),
			}),
		);

		expect(outcome.claim.status).toBe("blocked");
		expect(outcome.claim.changedFiles).toEqual(["src/a.ts"]);
		expect(outcome.claim.blockers).toContain(
			"action requires workspace/evidence inspection (src/a.ts, unknown): worker_action_outcome_unknown",
		);
	});
});
