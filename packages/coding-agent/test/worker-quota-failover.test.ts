import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { previewWorkerModel, resolveWorkerAuthority } from "../src/core/delegation/worker-authority-resolver.ts";
import { WorkerProfileResolver } from "../src/core/delegation/worker-profile-resolver.ts";
import { evaluateWorkerRetry } from "../src/core/delegation/worker-retry-policy.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";

/**
 * A routed worker whose account runs out of quota moves to the next routing candidate, the way root's
 * billing failover moves the foreground: its contract carries the routing order as an ordered-fallback
 * policy, the failover does not spend the transient-retry ceiling, and the attempt records the model it
 * then runs on. An authored model choice never moves.
 */
const foreground = { id: "grok-4.6", provider: "xai", reasoning: true } as Model<Api>;
const codex = { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true } as Model<Api>;
const ling = { id: "inclusionai/ling-3.0-flash-fin:free", provider: "openrouter", reasoning: true } as Model<Api>;
const models = [foreground, codex, ling];
const registry = {
	find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
	getAvailable: () => models,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

function admit(exhausted: readonly string[] = [], authorityModel?: { provider: string; modelId: string }) {
	const resolution = resolveWorkerAuthority({
		authority: { path: "/repo", ...(authorityModel ? { model: authorityModel } : {}) },
		foregroundModel: foreground,
		foregroundToolNames: ["read"],
		foregroundEnvelope: { id: "parent", capabilities: ["filesystem.read"] },
		accountRouting: { account: "other", routeProviders: ["openai-codex", "openrouter"] },
		modelRegistry: registry,
		isModelExhausted: (m) => exhausted.includes(`${m.provider}/${m.id}`),
	});
	if (!resolution.ok) throw new Error(resolution.reason);
	return resolution.shipment;
}

function contractResolver(exhausted: Set<string>): WorkerProfileResolver {
	return new WorkerProfileResolver({
		agentDir: "/unused",
		cwd: "/repo",
		getSettingsManager: () => ({}) as never,
		getResourceLoader: () => ({}) as never,
		getModelRegistry: () => registry,
		isModelExhausted: (m) => exhausted.has(`${m.provider}/${m.id}`),
		getTaskProfileStore: () => ({}) as never,
		onDiagnostic: () => {},
	});
}

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("worker quota failover", () => {
	it("admits a routed worker with its routing order as an ordered-fallback policy", () => {
		const shipment = admit();
		expect(shipment.modelBinding).toMatchObject({ provider: "openai-codex" });
		expect(shipment.profile.modelPolicy.mode).toBe("ordered-fallback");
		expect(shipment.profile.modelPolicy.candidates.map((candidate) => candidate.provider)).toEqual([
			"openai-codex",
			"openrouter",
		]);
	});

	it("keeps an authored model choice fixed", () => {
		const shipment = admit([], { provider: "openai-codex", modelId: "gpt-5.6-sol" });
		expect(shipment.profile.modelPolicy).toMatchObject({ mode: "fixed" });
		expect(shipment.profile.modelPolicy.candidates).toHaveLength(1);
	});

	it("resolves a routed contract to its next candidate once the first is exhausted", () => {
		const shipment = admit();
		const exhausted = new Set<string>();
		const contract = {
			modelBinding: shipment.modelBinding,
			profile: shipment.profile,
			resourcePointers: shipment.resourcePointers,
		} as never;
		const resolver = contractResolver(exhausted);
		const first = resolver.resolveContract(contract);
		expect(first.ok && first.resolved.model.provider).toBe("openai-codex");
		exhausted.add("openai-codex/gpt-5.6-sol");
		const moved = resolver.resolveContract(contract);
		expect(moved.ok && moved.resolved.model.provider).toBe("openrouter");
	});

	it("retries a quota failure only with a failover, without spending the attempt ceiling", () => {
		const quota = {
			laneStatus: "failed",
			reasonCode: "completion_error",
			reasonDetail: "Codex error: The usage limit has been reached",
			provider: "openai-codex",
			retriesUsed: 5,
			maxAttempts: 2,
		};
		expect(evaluateWorkerRetry({ ...quota, retriesUsed: 0 })).toEqual({
			retry: false,
			reason: "not_retryable_billing_or_quota",
		});
		const failover = evaluateWorkerRetry({ ...quota, failover: true });
		expect(failover).toMatchObject({ retry: true, reason: "billing_or_quota_failover" });
		// A transient failure still stops at the ceiling.
		expect(evaluateWorkerRetry({ ...quota, reasonDetail: "WebSocket error" })).toEqual({
			retry: false,
			reason: "attempts_exhausted",
		});
	});

	it("records the model a leased attempt moved to, durably, under its live lease", () => {
		const agentDir = join(tmpdir(), `pi-quota-failover-${process.pid}-${Date.now()}`);
		mkdirSync(agentDir, { recursive: true });
		dirs.push(agentDir);
		let nextId = 1;
		const store = new OrchestrationEventStore({ agentDir, sessionId: "session-1" });
		const runtime = new DurableTaskRuntime({ store, createId: () => String(nextId++) });
		const objective = runtime.createObjective({
			objectiveId: "objective-1",
			title: "Failover",
			description: "Move on quota",
			acceptanceCriteria: [{ id: "criterion", description: "Done", required: true }],
		});
		const task = runtime.createTask({
			taskId: "task-1",
			objectiveId: objective.objectiveId,
			title: "Task",
			description: "Run",
			role: "implementer",
			acceptanceCriterionIds: ["criterion"],
		});
		const queued = runtime.queueAttempt(
			task.taskId,
			{ taskId: task.taskId, profileId: "worker-default", instructions: "Run", resourcePointerIds: [] },
			"grant-1",
		);
		const lease = runtime.leaseAttempt(queued.attemptId, "owner", 60_000);
		const moved = { provider: "openrouter", modelId: ling.id, thinkingLevel: "low" } as const;
		expect(() =>
			runtime.recordAttemptRunningModel(queued.attemptId, lease.leaseId, lease.fencingToken + 1, moved),
		).toThrow(/stale|fenc/i);
		runtime.recordAttemptRunningModel(queued.attemptId, lease.leaseId, lease.fencingToken, moved);
		const reopened = new DurableTaskRuntime({
			store: new OrchestrationEventStore({ agentDir, sessionId: "session-1" }),
		});
		expect(reopened.getSnapshot().attempts[queued.attemptId]?.runningModel).toEqual(moved);
	});

	it("previews the model a fresh worker would run on: the role's pin, else routing, else the foreground", () => {
		const base = {
			foregroundModel: foreground,
			routing: { account: "other" as const, routeProviders: ["openai-codex", "openrouter"] },
			role: "implementer",
			modelRegistry: registry,
			isModelExhausted: () => false,
		};
		expect(previewWorkerModel({ ...base, pin: undefined })).toBe(codex);
		expect(
			previewWorkerModel({ ...base, pin: { provider: "openrouter", modelId: ling.id, thinkingLevel: "off" } }),
		).toBe(ling);
		expect(previewWorkerModel({ ...base, pin: undefined, isModelExhausted: () => true })).toBe(foreground);
	});
});
