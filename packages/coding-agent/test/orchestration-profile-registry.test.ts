import { describe, expect, it } from "vitest";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
	type TaskContract,
	type ToolCapabilityManifest,
} from "../src/core/orchestration/contracts.ts";
import { ExecutionPolicyCompiler } from "../src/core/orchestration/policy-compiler.ts";
import {
	OrchestrationProfileError,
	OrchestrationProfileRegistry,
	parseOrchestrationDispatchRequest,
	planProfileDispatch,
	resolveProfileModel,
	validateOrchestrationProfile,
} from "../src/core/orchestration/profile-registry.ts";

const now = "2026-07-23T12:00:00.000Z";

function profile(overrides: Partial<OrchestrationProfile> = {}): OrchestrationProfile {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId: "fast-worker",
		description: "Pinned execution-only worker",
		role: "operator",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "minimal" }],
		},
		capabilityCeiling: ["filesystem.read", "process.exec", "tests.execute"],
		toolNames: ["read", "run_process"],
		resourceProfileNames: ["operator-minimal"],
		dispatchProfileIds: [],
		executionPolicy: {
			allowedExecutables: ["npm", "node"],
			allowedEnvironmentVariables: ["CI"],
			maxOutputBytes: 64 * 1024,
		},
		budget: { maxCostUsd: 0.25, maxToolCalls: 20, maxWallClockMs: 120_000 },
		maxConcurrent: 4,
		leaseTtlMs: 180_000,
		requireIndependentVerification: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

const manifests: ToolCapabilityManifest[] = [
	{
		toolName: "read",
		moduleSpecifier: "./tools/read.ts",
		capabilities: ["filesystem.read"],
		roles: ["operator"],
		enforcements: ["path-scope"],
	},
	{
		toolName: "run_process",
		moduleSpecifier: "./tools/run-process.ts",
		capabilities: ["process.exec"],
		roles: ["operator"],
		enforcements: ["process-launcher"],
	},
];

const task: TaskContract = {
	schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
	taskId: "task-1",
	objectiveId: "objective-1",
	title: "Run tests",
	description: "Execute focused tests",
	role: "operator",
	status: "ready",
	dependsOn: [],
	requiredCapabilities: ["filesystem.read", "process.exec"],
	acceptanceCriterionIds: [],
	riskBudget: { maxAttempts: 2 },
	createdAt: now,
	updatedAt: now,
};

describe("OrchestrationProfileRegistry", () => {
	it("makes model and thinking overrides structurally invalid", () => {
		expect(() =>
			parseOrchestrationDispatchRequest({
				taskId: "task-1",
				profileId: "fast-worker",
				instructions: "run tests",
				resourcePointerIds: [],
				model: "expensive-model",
				thinkingLevel: "high",
			}),
		).toThrow(OrchestrationProfileError);
	});

	it("rejects runtime-owned requirement correlation from model dispatch input", () => {
		expect(() =>
			parseOrchestrationDispatchRequest({
				taskId: "task-1",
				profileId: "fast-worker",
				instructions: "run tests",
				resourcePointerIds: [],
				requirementIds: ["req-1"],
			}),
		).toThrow(OrchestrationProfileError);
	});

	it("rejects oversized model-facing dispatch fields before they become a durable attempt", () => {
		expect(() =>
			parseOrchestrationDispatchRequest({
				taskId: "task-1",
				profileId: "fast-worker",
				instructions: "x".repeat(16 * 1024 + 1),
				resourcePointerIds: [],
			}),
		).toThrow("Dispatch request is invalid");
		expect(() =>
			parseOrchestrationDispatchRequest({
				taskId: "task-1",
				profileId: "fast-worker",
				instructions: "bounded",
				resourcePointerIds: Array.from({ length: 65 }, (_, index) => `resource-${index}`),
			}),
		).toThrow("Dispatch request is invalid");
		expect(() =>
			parseOrchestrationDispatchRequest({
				taskId: "task-1",
				profileId: "fast-worker",
				instructions: "bounded",
				resourcePointerIds: ["resource-1", "resource-1"],
			}),
		).toThrow("Dispatch request is invalid");
	});

	it("rejects unrestricted process tools even when process authority exists", () => {
		expect(() => validateOrchestrationProfile(profile({ toolNames: ["read", "bash"] }))).toThrow(
			"cannot expose unrestricted process tools",
		);
	});

	it("caps profile process output at the shared execution-plane ceiling", () => {
		expect(() =>
			validateOrchestrationProfile({
				...profile(),
				executionPolicy: {
					...profile().executionPolicy!,
					maxOutputBytes: 512 * 1024 + 1,
				},
			}),
		).toThrow("executionPolicy is invalid");
	});

	it("rejects unknown, duplicated, and capability-unbound profile tools", () => {
		expect(() => validateOrchestrationProfile(profile({ toolNames: ["read", "opaque_extension"] }))).toThrow(
			"unclassified orchestration tools",
		);
		expect(() => validateOrchestrationProfile(profile({ toolNames: ["read", "read"] }))).toThrow(
			"duplicate toolNames",
		);
		const { executionPolicy: _executionPolicy, ...withoutProcessPolicy } = profile();
		expect(() =>
			validateOrchestrationProfile({
				...withoutProcessPolicy,
				toolNames: ["memory"],
				capabilityCeiling: ["filesystem.read"],
			}),
		).toThrow("lacks memory authority");
	});

	it("pins a fixed model and exact reasoning level", () => {
		const selected = resolveProfileModel(profile(), { isHealthy: () => true });
		expect(selected).toEqual({ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "minimal" });
	});

	it("allows fallback only through the owner's declared ordered list", () => {
		const configured = profile({
			modelPolicy: {
				mode: "ordered-fallback",
				candidates: [
					{ provider: "local", modelId: "small-fast", thinkingLevel: "off" },
					{ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "minimal" },
				],
			},
		});
		const selected = resolveProfileModel(configured, { isHealthy: (binding) => binding.modelId !== "small-fast" });
		expect(selected?.modelId).toBe("gpt-5-mini");
		expect(selected?.thinkingLevel).toBe("minimal");
	});

	it("lets an architect dispatch only owner-listed non-orchestrator profiles", () => {
		const worker = profile();
		const { executionPolicy: _executionPolicy, ...base } = profile();
		const architect: OrchestrationProfile = {
			...base,
			profileId: "architect",
			role: "orchestrator",
			capabilityCeiling: ["workflow.delegate"],
			toolNames: ["delegate", "delegate_status"],
			resourceProfileNames: [],
			dispatchProfileIds: [worker.profileId],
		};
		const registry = new OrchestrationProfileRegistry([architect, worker]);
		expect(registry.get("architect")?.dispatchProfileIds).toEqual(["fast-worker"]);
		expect(
			() => new OrchestrationProfileRegistry([{ ...architect, dispatchProfileIds: ["missing"] }, worker]),
		).toThrow("dispatches missing profile");
	});

	it("requires an owner-pinned verifier and requires architects to authorize the complete chain", () => {
		const worker = profile({
			profileId: "checked-worker",
			requireIndependentVerification: true,
			verificationProfileId: "verifier-fast",
		});
		const verifier = profile({ profileId: "verifier-fast", role: "verifier" });
		expect(() => new OrchestrationProfileRegistry([worker])).toThrow("requires missing verifier profile");
		expect(new OrchestrationProfileRegistry([worker, verifier]).get(worker.profileId)).toMatchObject({
			verificationProfileId: verifier.profileId,
		});

		const { executionPolicy: _executionPolicy, ...base } = profile();
		const architect: OrchestrationProfile = {
			...base,
			profileId: "architect-verification",
			role: "orchestrator",
			capabilityCeiling: ["workflow.delegate"],
			toolNames: ["delegate", "delegate_status"],
			resourceProfileNames: [],
			dispatchProfileIds: [worker.profileId],
		};
		expect(() => new OrchestrationProfileRegistry([architect, worker, verifier])).toThrow("but not its verifier");
		expect(
			new OrchestrationProfileRegistry([
				{ ...architect, dispatchProfileIds: [worker.profileId, verifier.profileId] },
				worker,
				verifier,
			]).get(architect.profileId)?.dispatchProfileIds,
		).toEqual([worker.profileId, verifier.profileId]);
	});

	it("builds dispatch solely from the selected profile", () => {
		const registry = new OrchestrationProfileRegistry([profile()]);
		const request = parseOrchestrationDispatchRequest({
			taskId: task.taskId,
			profileId: "fast-worker",
			instructions: "run focused tests",
			resourcePointerIds: [],
		});
		const result = planProfileDispatch({
			request,
			task,
			attemptId: "attempt-1",
			subjectId: "agent-1",
			registry,
			health: { isHealthy: () => true },
			policyCompiler: new ExecutionPolicyCompiler({ now: () => now, createId: () => "1" }),
			toolManifests: manifests,
			resources: [],
			readPaths: ["."],
			policyVersion: "policy-1",
		});

		expect(result.outcome).toBe("allow");
		if (result.outcome !== "allow") return;
		expect(result.plan.model).toEqual({ provider: "openai", modelId: "gpt-5-mini", thinkingLevel: "minimal" });
		expect(result.plan.grant.budget).toMatchObject({ maxCostUsd: 0.25, maxToolCalls: 20 });
		expect(result.plan.profile.resourceProfileNames).toEqual(["operator-minimal"]);
	});

	it("rejects duplicate profile identities and invalid fixed candidate sets", () => {
		const registry = new OrchestrationProfileRegistry([profile()]);
		expect(() => registry.register(profile())).toThrow("Duplicate orchestration profile");
		expect(
			() =>
				new OrchestrationProfileRegistry([
					profile({
						modelPolicy: {
							mode: "fixed",
							candidates: [
								{ provider: "a", modelId: "one", thinkingLevel: "off" },
								{ provider: "b", modelId: "two", thinkingLevel: "off" },
							],
						},
					}),
				]),
		).toThrow("must declare exactly one model candidate");
	});
});
