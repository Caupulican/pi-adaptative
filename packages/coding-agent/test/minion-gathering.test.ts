import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	formatGatheredEvidence,
	GATHERED_EVIDENCE_CUSTOM_TYPE,
	gatheringQuestions,
} from "../src/core/minion-gathering.ts";
import type { ObjectiveRoute } from "../src/core/objective-execution/objective-route.ts";
import { createHostResponseScript } from "./profiling/host-response-script.ts";
import { createHarness } from "./suite/harness.ts";
import { completedWorkerOutput } from "./worker-output-fixture.ts";

describe("minion gathering plan", () => {
	it("asks one question per targeted requirement, or the objective itself", () => {
		expect(gatheringQuestions("ship the cache ledger", ["R1", "R2"])).toHaveLength(2);
		expect(gatheringQuestions("ship the cache ledger", [])).toEqual([
			"Gather what the repository shows that this objective needs: ship the cache ledger",
		]);
	});

	it("delivers only accepted reports, bounded, and says what was cut", () => {
		const record = formatGatheredEvidence(
			[
				{ question: "q1", accepted: true, summary: "found it in a.ts:3" },
				{ question: "q2", accepted: false, reason: "claim_contradicted" },
				{ question: "q3", accepted: true, summary: "x".repeat(500) },
			],
			300,
		);
		expect(record).toContain("2 of 3 read-only workers returned accepted reports");
		expect(record).toContain("found it in a.ts:3");
		expect(record).toContain("(no accepted report: claim_contradicted)");
		expect(record).toContain("1 report omitted");
		expect(record.length).toBeLessThanOrEqual(400);
	});
});

describe("the retrieve route's executor", () => {
	const route = (targets: string[]): ObjectiveRoute => ({
		schema_version: "1.0",
		cycle_id: "cycle-1",
		objective_id: "obj-1",
		route: "retrieve",
		reason_codes: [],
		target_requirement_ids: targets,
	});

	const priced = async () => {
		const harness = await createHarness({
			models: [
				{ id: "priced", cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, contextWindow: 400_000 },
			],
			settings: { autoLearn: { enabled: false }, workerDelegation: { enabled: true, maxConcurrent: 2 } },
		});
		// The talker's prefix is large: reading on it costs more than minions on a brief.
		vi.spyOn(harness.session, "getContextUsage").mockReturnValue({
			tokens: 150_000,
			contextWindow: 400_000,
			percent: 37.5,
		} as ReturnType<typeof harness.session.getContextUsage>);
		return harness;
	};

	const learnRootRetrieval = (harness: Awaited<ReturnType<typeof createHarness>>) => {
		const ledger = harness.session.getDecisionLedger();
		if (!ledger) throw new Error("ledger unavailable");
		const decide = (cycleId: string, at: number) => {
			ledger.recordRoute({
				sessionId: "history",
				cwd: "/repo",
				objectiveId: "o",
				cycleId,
				route: "retrieve",
				reasonCodes: [],
				decidedAt: at,
				evidenceMarker: 0,
			});
			ledger.noteRouteExecutor("history", cycleId, "root");
		};
		decide("h1", 1_000);
		for (let index = 0; index < 20; index++) {
			ledger.recordCacheObservation({
				sessionId: "history",
				cwd: "/repo",
				lane: "lane",
				observedAt: 1_001 + index,
				promptTokens: 1,
				cacheReadTokens: 0,
				prefixIntact: "true",
			});
		}
		decide("h2", 2_000);
	};

	const retrieve = (harness: Awaited<ReturnType<typeof createHarness>>, targets: string[]) =>
		(
			harness.session as unknown as {
				_retrieveForObjective(route: ObjectiveRoute): Promise<"root" | "worker">;
			}
		)._retrieveForObjective(route(targets));

	it("sends minions when the talker's reads would cost more, and queues one evidence record", async () => {
		const harness = await priced();
		try {
			learnRootRetrieval(harness);
			const script = createHostResponseScript(harness.faux);
			// The foreground speaks first, so the script tells its requests from the minions'.
			script.setResponses([fauxAssistantMessage("Ready.")]);
			await harness.session.prompt("Get ready.", { autoContinueGoal: false });
			script.setResponses(
				[
					fauxAssistantMessage(completedWorkerOutput("R1 is in src/a.ts:10.")),
					fauxAssistantMessage(completedWorkerOutput("R2 is in src/b.ts:20.")),
				],
				true,
			);
			expect(await retrieve(harness, ["R1", "R2"])).toBe("worker");
			const pending = (
				harness.session as unknown as {
					_pendingNextTurnMessages: Array<{ customType?: string; content?: unknown }>;
				}
			)._pendingNextTurnMessages;
			const evidence = pending.filter((message) => message.customType === GATHERED_EVIDENCE_CUSTOM_TYPE);
			expect(evidence).toHaveLength(1);
			const content = String(evidence[0]?.content);
			expect(content).toContain("2 of 2 read-only workers returned accepted reports");
			expect(content).toContain("src/a.ts:10");
			expect(content).toContain("src/b.ts:20");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the reading on the talker when nothing is learned", async () => {
		const harness = await priced();
		try {
			harness.setResponses([fauxAssistantMessage("read on the root")]);
			expect(await retrieve(harness, ["R1"])).toBe("root");
		} finally {
			harness.cleanup();
		}
	});
});
