import { resolve } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	bindCompiledVerifierIdentity,
	resolveWorkerAuthority,
	stepDownThinkingLevel,
} from "../src/core/delegation/worker-authority-resolver.ts";
import { parseWorkerDelegationAuthorityRequest } from "../src/core/delegation/worker-delegation-request.ts";
import {
	buildWorkerExecutionPlan,
	compileWorkerExecutionGrant,
} from "../src/core/delegation/worker-execution-policy.ts";
import type { ResolvedWorkerProfile } from "../src/core/delegation/worker-profile-resolver.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { createTestWorkerOrchestrationProfile } from "./orchestration-profile-fixture.ts";

const model = { id: "m1", provider: "faux", reasoning: true } as Model<Api>;
const modelRegistry = {
	find: () => model,
	getAvailable: () => [],
	hasConfiguredAuth: () => true,
} as unknown as ModelRegistry;

describe("resolveWorkerAuthority", () => {
	it.each([undefined, "child"])(
		"anchors preset paths to configuration and explicit paths to task cwd (%s)",
		(path) => {
			const base: ResolvedWorkerProfile = {
				model,
				modelBinding: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
				profile: {
					...createTestWorkerOrchestrationProfile({
						profileId: "directory-preset",
						model,
						toolNames: ["read"],
						capabilityCeiling: ["filesystem.read"],
					}),
					workspacePath: "preset",
				},
				resourcePointers: [],
			};
			const resolution = resolveWorkerAuthority({
				base,
				authority: path ? { path } : undefined,
				cwd: resolve("/launch"),
				executionCwd: resolve("/selected"),
				modelRegistry,
				isModelExhausted: () => false,
			});
			expect(resolution.ok).toBe(true);
			if (!resolution.ok) throw new Error(resolution.reason);
			expect(resolution.shipment.profile.workspacePath).toBe(resolve(path ? "/selected/child" : "/launch/preset"));
		},
	);

	it.each([true, false, undefined])("compiles readOnly=%s into the effective execution plan", (readOnly) => {
		const resolution = resolveWorkerAuthority({
			authority: { readOnly, path: "/repo" },
			foregroundModel: model,
			foregroundToolNames: ["read", "write", "bash"],
			foregroundEnvelope: {
				id: "parent",
				capabilities: ["filesystem.read", "filesystem.write", "process.exec"],
			},
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(resolution.ok).toBe(true);
		if (!resolution.ok) throw new Error(resolution.reason);
		const plan = buildWorkerExecutionPlan({
			profile: resolution.shipment.profile,
			cwd: "/repo",
			deniedPaths: [],
			memoryEnabled: false,
			settings: { enabled: true, writeEnabled: true, maxUsd: 1, maxWallClockMs: 120_000, maxConcurrent: 4 },
		});
		expect(plan.writeEnabled).toBe(readOnly !== true);
		expect(plan.processEnabled).toBe(readOnly !== true);
		const compiled = compileWorkerExecutionGrant({
			target: { objectiveId: "objective", taskId: "task", attemptId: "attempt" },
			profile: resolution.shipment.profile,
			plan,
			resources: [],
		});
		expect(compiled.ok).toBe(true);
		if (!compiled.ok) throw new Error(compiled.reasonCodes.join(","));
		if (readOnly) {
			// Read is read: the parent's bash lends the catalog read tools and read-only git natively.
			expect(resolution.shipment.profile.capabilityCeiling).toEqual(["filesystem.read", "repo.read"]);
			expect(plan.requiredCapabilities).toEqual(["filesystem.read", "repo.read"]);
			expect(plan.toolManifests.map((entry) => entry.toolName)).toEqual(["read", "grep", "find", "ls", "repo_read"]);
			expect(plan.readPaths).not.toEqual([]);
			expect(plan.writePaths).toEqual([]);
			expect(compiled.grant.capabilities).toEqual(["filesystem.read", "repo.read"]);
			expect(compiled.grant.allowedTools).toEqual(["read", "grep", "find", "ls", "repo_read"]);
			expect(compiled.grant.writePaths).toEqual([]);
		}
	});
	it("retains the read-only choice through request parsing and rejects malformed choices", () => {
		expect(parseWorkerDelegationAuthorityRequest({ readOnly: true })).toEqual({ readOnly: true });
		expect(parseWorkerDelegationAuthorityRequest({ readOnly: false })).toEqual({ readOnly: false });
		for (const readOnly of ["true", "false", 1, null, []]) {
			expect(() => parseWorkerDelegationAuthorityRequest({ readOnly })).toThrow("readOnly");
		}
	});
	it.each(["write", "bash", "python"])("refuses an explicit %s override of read-only authority", (toolName) => {
		expect(
			resolveWorkerAuthority({
				authority: { readOnly: true, toolNames: [toolName] },
				foregroundModel: model,
				foregroundToolNames: [toolName],
				modelRegistry,
				isModelExhausted: () => false,
			}),
		).toEqual({ ok: false, reason: `orchestration_tool_capability_missing:${toolName}` });
	});
	it("makes every adaptive worker a leaf even when an ordinary tool list is narrowed", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["read", "bash"] },
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "bash"]);
		expect(resolution.shipment.profile.capabilityCeiling).not.toContain("workflow.delegate");
		expect(resolution.shipment.profile.delegationLimits).toEqual({
			maxDepth: 0,
			maxChildrenPerAgent: 0,
			maxNestedAgentsPerSession: 0,
		});
	});

	it("keeps an explicit capability restriction authoritative for leaf workers", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				capabilities: ["filesystem.read", "process.exec"],
				toolNames: ["read", "bash"],
			},
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "bash"]);
		expect(resolution.shipment.profile.capabilityCeiling).not.toContain("workflow.delegate");
	});

	it("rejects the root-only memory tool for a worker authority request", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				capabilities: ["memory.query"],
				toolNames: ["memory"],
			},
			base: undefined,
			foregroundModel: model,
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({ ok: false, reason: "orchestration_tool_unavailable:memory" });
	});

	it("admits the bounded memory_read adapter from an active root memory surface", () => {
		const resolution = resolveWorkerAuthority({
			authority: {
				capabilities: ["memory.query"],
				toolNames: ["memory_read"],
			},
			foregroundModel: model,
			foregroundToolNames: ["memory"],
			foregroundEnvelope: { id: "memory-root", capabilities: ["memory.query"], allowedTools: ["memory"] },
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["memory_read"]);
		expect(resolution.shipment.profile.capabilityCeiling).toEqual(["memory.query"]);
	});

	it("inherits every compatible active foreground tool and strips root-only tools", () => {
		const resolution = resolveWorkerAuthority({
			foregroundModel: model,
			foregroundToolNames: ["read", "python", "memory", "delegate", "goal", "reflection"],
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "python"]);
	});

	it("inherits run_toolkit_script only when it is active in the foreground, and keeps explicit requests deterministic", () => {
		const inherited = resolveWorkerAuthority({
			foregroundModel: model,
			foregroundToolNames: ["read", "run_toolkit_script"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(inherited.ok).toBe(true);
		if (inherited.ok) expect(inherited.shipment.profile.toolNames).toEqual(["read", "run_toolkit_script"]);

		const explicit = resolveWorkerAuthority({
			authority: { toolNames: ["run_toolkit_script"] },
			foregroundModel: model,
			foregroundToolNames: ["run_toolkit_script"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(explicit.ok).toBe(true);
		if (explicit.ok) expect(explicit.shipment.profile.toolNames).toEqual(["run_toolkit_script"]);

		const unavailable = resolveWorkerAuthority({
			authority: { toolNames: ["run_toolkit_script"] },
			foregroundModel: model,
			foregroundToolNames: ["read"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(unavailable).toEqual({
			ok: false,
			reason: "orchestration_tool_unavailable:run_toolkit_script",
		});
	});

	it("rejects an explicit classified tool when its capability is unavailable", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["python"] },
			foregroundModel: model,
			foregroundEnvelope: { id: "read-only", capabilities: ["filesystem.read"] },
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({
			ok: false,
			reason: "orchestration_tool_capability_missing:python",
		});
	});

	it("rejects a sibling tool that was not active in the inherited foreground surface", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["write"] },
			foregroundModel: model,
			foregroundToolNames: ["edit"],
			foregroundEnvelope: { id: "write-capable", capabilities: ["filesystem.write"] },
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({
			ok: false,
			reason: "orchestration_tool_unavailable:write",
		});
	});

	it("lends catalog grep/find/ls and repo_read natively when the parent surface has bash and not those tools", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["read", "grep", "find", "ls", "repo_read"] },
			foregroundModel: model,
			foregroundToolNames: ["read", "bash", "edit", "write"],
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "grep", "find", "ls", "repo_read"]);
	});

	it("keeps a readOnly worker on native reads and read-only git, never bash", () => {
		const resolution = resolveWorkerAuthority({
			authority: { readOnly: true, toolNames: ["read", "grep", "repo_read"] },
			foregroundModel: model,
			foregroundToolNames: ["read", "bash", "edit", "write"],
			foregroundEnvelope: {
				id: "parent",
				capabilities: ["filesystem.read", "filesystem.write", "process.exec"],
			},
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) throw new Error(resolution.reason);
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "grep", "repo_read"]);
		expect(resolution.shipment.profile.capabilityCeiling).toEqual(["filesystem.read", "repo.read"]);
	});

	it("does not invent repo.read for an explicit capability list or a base profile", () => {
		const explicit = resolveWorkerAuthority({
			authority: { capabilities: ["filesystem.read", "process.exec"], toolNames: ["read", "repo_read"] },
			foregroundModel: model,
			foregroundToolNames: ["read", "bash"],
			modelRegistry,
			isModelExhausted: () => false,
		});
		expect(explicit).toEqual({ ok: false, reason: "orchestration_tool_capability_missing:repo_read" });
	});

	it("keeps first-class grep/find/ls when those tools are already on the parent surface", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["read", "grep", "find", "ls"] },
			foregroundModel: model,
			foregroundToolNames: ["read", "grep", "find", "ls"],
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution.ok).toBe(true);
		if (!resolution.ok) return;
		expect(resolution.shipment.profile.toolNames).toEqual(["read", "grep", "find", "ls"]);
	});

	it("still refuses grep/find/ls/repo_read when the parent has neither those tools nor bash", () => {
		const resolution = resolveWorkerAuthority({
			authority: { toolNames: ["read", "grep", "find", "ls", "repo_read"] },
			foregroundModel: model,
			foregroundToolNames: ["read"],
			modelRegistry,
			isModelExhausted: () => false,
		});

		expect(resolution).toEqual({
			ok: false,
			reason: "orchestration_tool_unavailable:grep,find,ls,repo_read",
		});
	});

	it("preserves a base identity only when compiled content is unchanged", () => {
		const alternateModel = { id: "m2", provider: "faux", reasoning: true } as Model<Api>;
		const identityRegistry = {
			find: (_provider: string, modelId: string) => (modelId === alternateModel.id ? alternateModel : model),
			getAvailable: () => [],
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const profile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "exact-leaf-base",
				model,
				capabilityCeiling: ["filesystem.read", "process.exec"],
				toolNames: ["read", "python"],
			}),
			{ delegationLimits: { maxDepth: 0, maxChildrenPerAgent: 0, maxNestedAgentsPerSession: 0 } },
		);
		const base: ResolvedWorkerProfile = {
			model,
			modelBinding: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
			profile,
			resourcePointers: [],
		};
		const exact = resolveWorkerAuthority({
			base,
			modelRegistry: identityRegistry,
			isModelExhausted: () => false,
		});
		expect(exact.ok).toBe(true);
		if (!exact.ok) return;
		expect(exact.shipment.profile).toEqual(profile);

		const overrides = [
			{ model: { provider: alternateModel.provider, modelId: alternateModel.id } },
			{ thinkingLevel: "low" as const },
			{ path: "/tmp/another-project" },
			{ toolNames: ["read"] },
		];
		const derivedIds = overrides.map((authority) => {
			const resolution = resolveWorkerAuthority({
				authority,
				base,
				cwd: "/repo",
				modelRegistry: identityRegistry,
				isModelExhausted: () => false,
			});
			expect(resolution.ok).toBe(true);
			if (!resolution.ok) return "";
			return resolution.shipment.profile.profileId;
		});
		expect(derivedIds).not.toContain(profile.profileId);
		expect(new Set(derivedIds).size).toBe(derivedIds.length);
	});

	it("steps an inherited foreground thinking level down one notch unless something pins it", () => {
		// xhigh is only supported when the model maps it (see getSupportedThinkingLevels).
		const reasoningModel = {
			id: "m1",
			provider: "faux",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
		} as Model<Api>;
		const reasoningRegistry = {
			find: () => reasoningModel,
			getAvailable: () => [],
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const resolveBinding = (input: {
			foregroundThinkingLevel?: "xhigh" | "minimal" | "off";
			foregroundThinkingPolicy?: "inherit" | "step_down";
			authority?: { thinkingLevel?: "low" };
		}) => {
			const resolution = resolveWorkerAuthority({
				authority: { path: "/repo", ...(input.authority ?? {}) },
				foregroundModel: reasoningModel,
				foregroundThinkingLevel: input.foregroundThinkingLevel,
				...(input.foregroundThinkingPolicy ? { foregroundThinkingPolicy: input.foregroundThinkingPolicy } : {}),
				foregroundToolNames: ["read"],
				foregroundEnvelope: { id: "parent", capabilities: ["filesystem.read"] },
				modelRegistry: reasoningRegistry,
				isModelExhausted: () => false,
			});
			if (!resolution.ok) throw new Error(resolution.reason);
			return resolution.shipment.modelBinding.thinkingLevel;
		};

		// Default policy: the worker runs one notch below the owner's xhigh.
		expect(resolveBinding({ foregroundThinkingLevel: "xhigh" })).toBe("high");
		// Explicit inherit copies the foreground level exactly.
		expect(resolveBinding({ foregroundThinkingLevel: "xhigh", foregroundThinkingPolicy: "inherit" })).toBe("xhigh");
		// An authority pin is an authored choice and is never stepped.
		expect(resolveBinding({ foregroundThinkingLevel: "xhigh", authority: { thinkingLevel: "low" } })).toBe("low");
		// The floor never turns reasoning off, and off stays off.
		expect(resolveBinding({ foregroundThinkingLevel: "minimal" })).toBe("minimal");
		expect(resolveBinding({ foregroundThinkingLevel: "off" })).toBe("off");
	});

	it("routes a fresh unpinned worker to another authenticated account and steps its thinking down", () => {
		const foreground = {
			id: "grok-4.6",
			provider: "xai",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
		} as Model<Api>;
		const codex = { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true } as Model<Api>;
		const ling = { id: "inclusionai/ling-3.0-flash-fin:free", provider: "openrouter", reasoning: true } as Model<Api>;
		const models = [foreground, codex, ling];
		const authed = new Set(["xai", "openai-codex", "openrouter"]);
		const local = { id: "local", provider: "llama-cpp", reasoning: false } as Model<Api>;
		models.push(local);
		const registry = {
			find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
			// llama-cpp needs no auth and so is "available", but it is not an account.
			getAvailable: () => models.filter((m) => authed.has(m.provider) || m.provider === "llama-cpp"),
			hasConfiguredAuth: (m: Model<Api>) => authed.has(m.provider) || m.provider === "llama-cpp",
			authStorage: { hasAuth: (provider: string) => authed.has(provider) },
		} as unknown as ModelRegistry;
		const resolve = (routing: { account: "other" | "same"; routeProviders: string[] }, exhausted: string[] = []) => {
			const resolution = resolveWorkerAuthority({
				authority: { path: "/repo" },
				foregroundModel: foreground,
				foregroundThinkingLevel: "xhigh",
				foregroundToolNames: ["read"],
				foregroundEnvelope: { id: "parent", capabilities: ["filesystem.read"] },
				accountRouting: routing,
				modelRegistry: registry,
				isModelExhausted: (m) => exhausted.includes(`${m.provider}/${m.id}`),
			});
			if (!resolution.ok) throw new Error(resolution.reason);
			return resolution.shipment.modelBinding;
		};
		// Default: the first other authenticated provider in catalog order, at the provider's default model.
		expect(resolve({ account: "other", routeProviders: [] })).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
		});
		// An explicit order wins, and a `provider/modelId` entry names the exact model (ids may contain slashes).
		expect(
			resolve({
				account: "other",
				routeProviders: ["openrouter/inclusionai/ling-3.0-flash-fin:free", "openai-codex"],
			}),
		).toMatchObject({
			provider: "openrouter",
			modelId: "inclusionai/ling-3.0-flash-fin:free",
		});
		// An exhausted candidate is skipped; the foreground's own provider is never a candidate.
		expect(
			resolve({ account: "other", routeProviders: ["openrouter", "xai", "openai-codex"] }, [
				"openrouter/inclusionai/ling-3.0-flash-fin:free",
			]),
		).toMatchObject({
			provider: "openai-codex",
		});
		// A live machine-wide limit on a candidate's account skips it for this dispatch.
		expect(
			(() => {
				const resolution = resolveWorkerAuthority({
					authority: { path: "/repo" },
					foregroundModel: foreground,
					foregroundToolNames: ["read"],
					foregroundEnvelope: { id: "parent", capabilities: ["filesystem.read"] },
					accountRouting: { account: "other", routeProviders: ["openrouter", "openai-codex"] },
					modelRegistry: registry,
					isModelExhausted: () => false,
					isModelLimited: (m) => m.provider === "openrouter",
				});
				if (!resolution.ok) throw new Error(resolution.reason);
				return resolution.shipment.modelBinding.provider;
			})(),
		).toBe("openai-codex");
		// A per-role list replaces the general order for that role only.
		const byRole = (role: "explorer" | "verifier") => {
			const resolution = resolveWorkerAuthority({
				authority: { path: "/repo", role },
				foregroundModel: foreground,
				foregroundToolNames: ["read"],
				foregroundEnvelope: { id: "parent", capabilities: ["filesystem.read"] },
				accountRouting: {
					account: "other",
					routeProviders: ["openrouter"],
					routeProvidersByRole: { verifier: ["openai-codex"] },
				},
				modelRegistry: registry,
				isModelExhausted: () => false,
			});
			if (!resolution.ok) throw new Error(resolution.reason);
			return resolution.shipment.modelBinding.provider;
		};
		expect(byRole("verifier")).toBe("openai-codex");
		expect(byRole("explorer")).toBe("openrouter");
		// `same` keeps the foreground account.
		expect(resolve({ account: "same", routeProviders: ["openai-codex"] })).toMatchObject({
			provider: "xai",
			modelId: "grok-4.6",
			thinkingLevel: "high",
		});
		// With no other ACCOUNT the worker inherits the foreground: the credential-free local
		// server is available but is not a budget of its own.
		authed.delete("openai-codex");
		authed.delete("openrouter");
		expect(resolve({ account: "other", routeProviders: [] })).toMatchObject({ provider: "xai", modelId: "grok-4.6" });
		// Named explicitly, a credential-free provider is the owner's choice and is honoured.
		expect(resolve({ account: "other", routeProviders: ["llama-cpp/local"] })).toMatchObject({
			provider: "llama-cpp",
			modelId: "local",
		});
	});

	it("never moves an authority model, a pin or a profile binding to another account", () => {
		const foreground = { id: "grok-4.6", provider: "xai", reasoning: true } as Model<Api>;
		const codex = { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true } as Model<Api>;
		const models = [foreground, codex, model];
		const registry = {
			find: (provider: string, modelId: string) => models.find((m) => m.provider === provider && m.id === modelId),
			getAvailable: () => models,
			hasConfiguredAuth: () => true,
			authStorage: { hasAuth: () => true },
		} as unknown as ModelRegistry;
		const routing = { account: "other" as const, routeProviders: ["openai-codex"] };
		const withAuthorityModel = resolveWorkerAuthority({
			authority: { path: "/repo", model: { provider: "xai", modelId: "grok-4.6" } },
			foregroundModel: foreground,
			foregroundToolNames: ["read"],
			foregroundEnvelope: { id: "parent", capabilities: ["filesystem.read"] },
			accountRouting: routing,
			modelRegistry: registry,
			isModelExhausted: () => false,
		});
		if (!withAuthorityModel.ok) throw new Error(withAuthorityModel.reason);
		expect(withAuthorityModel.shipment.modelBinding).toMatchObject({ provider: "xai", modelId: "grok-4.6" });
		const base: ResolvedWorkerProfile = {
			model,
			modelBinding: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
			profile: createTestWorkerOrchestrationProfile({
				profileId: "authored-binding",
				model,
				toolNames: ["read"],
				capabilityCeiling: ["filesystem.read"],
			}),
			resourcePointers: [],
		};
		const withBase = resolveWorkerAuthority({
			base,
			cwd: "/repo",
			foregroundModel: foreground,
			accountRouting: routing,
			modelRegistry: registry,
			isModelExhausted: () => false,
		});
		if (!withBase.ok) throw new Error(withBase.reason);
		expect(withBase.shipment.modelBinding).toMatchObject({ provider: "faux", modelId: "m1", thinkingLevel: "off" });
	});

	it("keeps a profile-bound thinking level exactly as authored under the step-down policy", () => {
		const xhighModel = {
			id: "m1",
			provider: "faux",
			reasoning: true,
			thinkingLevelMap: { xhigh: "xhigh" },
		} as Model<Api>;
		const xhighRegistry = {
			find: () => xhighModel,
			getAvailable: () => [],
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const base: ResolvedWorkerProfile = {
			model: xhighModel,
			modelBinding: { provider: xhighModel.provider, modelId: xhighModel.id, thinkingLevel: "xhigh" },
			profile: createTestWorkerOrchestrationProfile({
				profileId: "authored-thinking",
				model: xhighModel,
				toolNames: ["read"],
				capabilityCeiling: ["filesystem.read"],
			}),
			resourcePointers: [],
		};
		const resolution = resolveWorkerAuthority({
			base,
			cwd: "/repo",
			foregroundModel: xhighModel,
			foregroundThinkingLevel: "xhigh",
			foregroundThinkingPolicy: "step_down",
			modelRegistry: xhighRegistry,
			isModelExhausted: () => false,
		});
		if (!resolution.ok) throw new Error(resolution.reason);
		expect(resolution.shipment.modelBinding.thinkingLevel).toBe("xhigh");
	});

	it("steps every level down one notch with minimal as the floor", () => {
		expect(
			["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((level) =>
				stepDownThinkingLevel(level as never),
			),
		).toEqual(["off", "minimal", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	it("derives a new implementation identity when a verifier compiles to a new identity", () => {
		const profile = Object.assign(
			createTestWorkerOrchestrationProfile({
				profileId: "implementation-source",
				model,
				capabilityCeiling: ["filesystem.read"],
				toolNames: ["read"],
			}),
			{
				requireIndependentVerification: true,
				verificationProfileId: "verifier-source",
				delegationLimits: { maxDepth: 0, maxChildrenPerAgent: 0, maxNestedAgentsPerSession: 0 },
			},
		);
		const shipment: ResolvedWorkerProfile = {
			model,
			modelBinding: { provider: model.provider, modelId: model.id, thinkingLevel: "off" },
			profile,
			resourcePointers: [],
		};

		const rebound = bindCompiledVerifierIdentity(shipment, "adaptive-verifier");

		expect(rebound.profile.verificationProfileId).toBe("adaptive-verifier");
		expect(rebound.profile.profileId).toMatch(/^adaptive-/);
		expect(rebound.profile.profileId).not.toBe(profile.profileId);
		expect(bindCompiledVerifierIdentity(rebound, "adaptive-verifier")).toBe(rebound);
	});
});
