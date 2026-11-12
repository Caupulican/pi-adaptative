import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { appendWorkerKnowledgeContext } from "../src/core/delegation/worker-knowledge-context.ts";
import { WorkerProviderTurnProtocol } from "../src/core/delegation/worker-provider-turn-protocol.ts";
import {
	boundedByRunBudget,
	WorkerTreeBudgetCoordinator,
} from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import { EMPTY_ATTEMPT_USAGE } from "../src/core/orchestration/attempt-usage.ts";
import { CapabilityGateway, type SharedCapabilityBudget } from "../src/core/orchestration/capability-gateway.ts";
import type { ExecutionGrant } from "../src/core/orchestration/contracts.ts";

const model: Model<Api> = {
	id: "worker-budget-fixture",
	name: "Worker budget fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://unused.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function grant(attemptId: string, maximum = 10_000): ExecutionGrant {
	return {
		schemaVersion: 1,
		grantId: `grant-${attemptId}`,
		objectiveId: "objective",
		taskId: "task",
		attemptId,
		subjectId: "worker",
		role: "implementer",
		capabilities: [],
		allowedTools: [],
		resources: [],
		readPaths: [],
		writePaths: [],
		deniedPaths: [],
		budget: { maxTokens: maximum },
		policyVersion: "fixture",
		decisionTrace: [],
		issuedAt: "2026-01-01T00:00:00.000Z",
	};
}
function gateway(attemptId: string, sharedBudget?: SharedCapabilityBudget): CapabilityGateway {
	return new CapabilityGateway({
		grant: grant(attemptId),
		cwd: "/workspace",
		...(sharedBudget ? { sharedBudget } : {}),
	});
}
function port(coordinator: WorkerTreeBudgetCoordinator, attemptId: string): SharedCapabilityBudget {
	return coordinator.createPort({
		treeKey: "tree",
		attemptId,
		budget: { maxTokens: 10_000 },
		seeds: [],
		initialUsage: EMPTY_ATTEMPT_USAGE,
	});
}

describe("worker knowledge context budget currency", () => {
	it("keeps its own preflight reservation current while sibling reservations still invalidate it", async () => {
		const tree = new WorkerTreeBudgetCoordinator();
		const a = port(tree, "attempt-a");
		const b = port(tree, "attempt-b");
		const gatewayA = gateway("attempt-a", a);
		const gatewayB = gateway("attempt-b", b);
		const signal = new AbortController().signal;
		const providerTurn = new WorkerProviderTurnProtocol({
			signal,
			onFailure: (error) => {
				throw error;
			},
			acquireReservation: (request) => gatewayA.reserveProviderBudget(400, "worker request", signal, request),
		});
		const result = await appendWorkerKnowledgeContext({
			plan: { messages: [] },
			model,
			measureRequest: async () => 100,
			projectKnowledge: () => ({
				revision: 1,
				text: "Knowledge.",
				includedCount: 1,
				omittedCount: 0,
				references: [],
				isCurrent: () => true,
			}),
			compactionReserveTokens: 0,
			maxOutputTokens: 64,
			remainingTokenAllowance: () => gatewayA.remainingContextTokenBudget(),
			signal,
		});
		if (result.kind !== "ready") throw new Error("Worker knowledge fixture did not fit.");
		expect(result.plan.isCurrent?.()).toBe(true);
		expect(result.plan.isDispatchCurrent?.()).toBe(true);
		await providerTurn.requestPreflight();
		expect(gatewayA.remainingTokenBudget()).toBe(9600);
		expect(gatewayA.remainingContextTokenBudget()).toBe(10_000);
		expect(result.plan.isCurrent?.()).toBe(true);
		expect(result.plan.isDispatchCurrent?.()).toBe(true);
		const sibling = await gatewayB.reserveProviderBudget(200, "sibling request", signal);
		expect(gatewayA.remainingContextTokenBudget()).toBe(9800);
		expect(gatewayB.remainingContextTokenBudget()).toBe(9600);
		expect(result.plan.isCurrent?.()).toBe(false);
		expect(result.plan.isDispatchCurrent?.()).toBe(false);
		sibling.release();
		expect(result.plan.isCurrent?.()).toBe(true);
		providerTurn.close();
	});

	it("keeps ordinary pooled headroom and actual admission bound across attempts", async () => {
		const tree = new WorkerTreeBudgetCoordinator();
		const a = port(tree, "attempt-a");
		const b = port(tree, "attempt-b");
		const own = await a.reserveProviderBudget(7000, "own");
		expect(a.remainingTokens()).toBe(3000);
		expect(a.remainingContextTokens()).toBe(10_000);
		const sibling = await b.reserveProviderBudget(5000, "sibling");
		expect(sibling.maxTokens).toBe(3000);
		expect(a.remainingContextTokens()).toBe(7000);
		expect(b.remainingContextTokens()).toBe(3000);
		sibling.release();
		own.release();
	});

	it("preserves the tree's context projection under run-budget composition and without a tree", async () => {
		const coordinator = new WorkerTreeBudgetCoordinator();
		const tree = port(coordinator, "attempt-a");
		const run = coordinator.createPort({
			treeKey: "run",
			attemptId: "attempt-a",
			budget: {},
			seeds: [],
			initialUsage: EMPTY_ATTEMPT_USAGE,
		});
		const composed = boundedByRunBudget(tree, run);
		const reservation = await composed.reserveProviderBudget(400, "request");
		expect(composed.remainingTokens()).toBe(9600);
		expect(composed.remainingContextTokens()).toBe(10_000);
		reservation.release();
		const standalone = gateway("standalone");
		const local = await standalone.reserveProviderBudget(400);
		expect(standalone.remainingContextTokenBudget()).toBe(standalone.remainingTokenBudget());
		local.release();
	});
});
