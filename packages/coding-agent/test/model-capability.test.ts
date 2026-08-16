import { describe, expect, it } from "vitest";
import {
	deriveModelCapabilityProfile,
	evaluateLaneWorkerRefusal,
	filterToolNamesForCapability,
	formatLaneWorkerRefusal,
	LANE_WORKER_REFUSAL_PREFIX,
	MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS,
	MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS,
} from "../src/core/model-capability.ts";

const DEFAULT_ACTIVE = [
	"read",
	"skill",
	"bash",
	"python",
	"edit",
	"write",
	"context_audit",
	"goal",
	"create_goal",
	"get_goal",
	"update_goal",
	"pipeline",
	"task_steps",
	"ask_question",
	"delegate",
	"run_toolkit_script",
	"worktree_sync",
	"improvement_loop",
	"extensionify",
	"skillify",
	"model_fitness",
	"context_scout",
	"tmux_agent_manager",
];

describe("deriveModelCapabilityProfile", () => {
	it("classifies by context window with metadata-first derivation", () => {
		expect(deriveModelCapabilityProfile({ contextWindow: 200_000 }).class).toBe("full");
		expect(deriveModelCapabilityProfile({ contextWindow: 32_768 }).class).toBe("full");
		expect(deriveModelCapabilityProfile({ contextWindow: 24_000 }).class).toBe("lean");
		expect(deriveModelCapabilityProfile({ contextWindow: 16_384 }).class).toBe("lean");
		expect(deriveModelCapabilityProfile({ contextWindow: 12_000 }).class).toBe("minimal");
		expect(deriveModelCapabilityProfile({ contextWindow: 8_192 }).class).toBe("minimal");
		expect(deriveModelCapabilityProfile({ contextWindow: 4_096 }).class).toBe("chat");
		expect(deriveModelCapabilityProfile({ contextWindow: 2_048 }).class).toBe("chat");
	});

	it("owns the aggregate system-prompt envelope in the same derived profile", () => {
		expect(deriveModelCapabilityProfile({ contextWindow: 200_000 }).systemPromptMaxChars).toBeUndefined();
		expect(deriveModelCapabilityProfile({ contextWindow: 16_384 }).systemPromptMaxChars).toBe(8_192);
		expect(deriveModelCapabilityProfile({ contextWindow: 8_192 }).systemPromptMaxChars).toBe(4_096);
		expect(deriveModelCapabilityProfile({ contextWindow: 4_096 }).systemPromptMaxChars).toBe(2_048);
	});

	it("falls back to full defaults when the window is unknown (defaults are for missing info)", () => {
		const missing = deriveModelCapabilityProfile({});
		expect(missing.class).toBe("full");
		expect(missing.reasonCode).toBe("unknown_context_window_defaults");
		expect(missing.allowedToolNames).toBeUndefined();
		expect(missing.blockedToolNames).toBeUndefined();
		expect(missing.backgroundLanesEnabled).toBe(true);

		expect(deriveModelCapabilityProfile({ contextWindow: 0 }).reasonCode).toBe("unknown_context_window_defaults");
		expect(deriveModelCapabilityProfile({ contextWindow: -5 }).reasonCode).toBe("unknown_context_window_defaults");
	});

	it("disables background lanes below the lean threshold and scales lane output tokens", () => {
		expect(deriveModelCapabilityProfile({ contextWindow: 200_000 }).backgroundLanesEnabled).toBe(true);
		expect(deriveModelCapabilityProfile({ contextWindow: 16_384 }).backgroundLanesEnabled).toBe(true);
		expect(deriveModelCapabilityProfile({ contextWindow: 8_192 }).backgroundLanesEnabled).toBe(false);
		expect(deriveModelCapabilityProfile({ contextWindow: 4_096 }).backgroundLanesEnabled).toBe(false);

		expect(deriveModelCapabilityProfile({ contextWindow: 200_000 }).laneMaxOutputTokens).toBe(2048);
		expect(deriveModelCapabilityProfile({ contextWindow: 8_192 }).laneMaxOutputTokens).toBe(1024);
		expect(deriveModelCapabilityProfile({ contextWindow: 2_048 }).laneMaxOutputTokens).toBe(256);
	});

	it("guards NaN context windows in every mode (no NaN lane budgets)", () => {
		for (const mode of [undefined, "off", "minimal"] as const) {
			const profile = deriveModelCapabilityProfile({ contextWindow: Number.NaN, mode });
			expect(Number.isNaN(profile.laneMaxOutputTokens)).toBe(false);
			expect(profile.laneMaxOutputTokens).toBeGreaterThan(0);
		}
	});

	it("honors mode off and forced classes regardless of the window", () => {
		const off = deriveModelCapabilityProfile({ contextWindow: 2_048, mode: "off" });
		expect(off.class).toBe("full");
		expect(off.reasonCode).toBe("detection_disabled");

		const forcedChat = deriveModelCapabilityProfile({ contextWindow: 200_000, mode: "chat" });
		expect(forcedChat.class).toBe("chat");
		expect(forcedChat.reasonCode).toBe("forced_by_setting");

		const forcedFull = deriveModelCapabilityProfile({ contextWindow: 2_048, mode: "full" });
		expect(forcedFull.class).toBe("full");
	});
});

describe("filterToolNamesForCapability", () => {
	it("keeps everything for full", () => {
		const profile = deriveModelCapabilityProfile({ contextWindow: 200_000 });
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, profile)).toEqual(DEFAULT_ACTIVE);
	});

	it("blocks background-autonomy and orchestration-surface tools for lean", () => {
		const profile = deriveModelCapabilityProfile({ contextWindow: 16_384 });
		const filtered = filterToolNamesForCapability(DEFAULT_ACTIVE, profile);
		for (const blocked of MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS) {
			expect(filtered).not.toContain(blocked);
		}
		expect(filtered).toContain("read");
		expect(filtered).toContain("edit");
	});

	it("monotonicity guard: run_toolkit_script and task_steps are NOT blocked for lean", () => {
		const profile = deriveModelCapabilityProfile({ contextWindow: 16_384 });
		const filtered = filterToolNamesForCapability(DEFAULT_ACTIVE, profile);
		expect(filtered).toContain("run_toolkit_script");
		expect(filtered).toContain("task_steps");
	});

	it("keeps compact goal lifecycle controls in every model class", () => {
		for (const contextWindow of [200_000, 16_384, 8_192, 4_096]) {
			const filtered = filterToolNamesForCapability(DEFAULT_ACTIVE, deriveModelCapabilityProfile({ contextWindow }));
			expect(filtered).toEqual(expect.arrayContaining(["create_goal", "get_goal", "update_goal"]));
		}
	});

	it("reduces minimal to the core coding set and chat to compact goal lifecycle controls", () => {
		const minimal = deriveModelCapabilityProfile({ contextWindow: 8_192 });
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, minimal)).toEqual([
			"read",
			"skill",
			"bash",
			"python",
			"edit",
			"write",
			"create_goal",
			"get_goal",
			"update_goal",
			"ask_question",
			"run_toolkit_script",
		]);

		const chat = deriveModelCapabilityProfile({ contextWindow: 4_096 });
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, chat)).toEqual([...MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS]);
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, chat)).toEqual(["create_goal", "get_goal", "update_goal"]);
	});

	it("keeps owner clarification available to lean and minimal models", () => {
		for (const contextWindow of [16_384, 8_192]) {
			const profile = deriveModelCapabilityProfile({ contextWindow });
			expect(filterToolNamesForCapability(DEFAULT_ACTIVE, profile)).toContain("ask_question");
		}
	});

	it("preserves requested order and never invents tools", () => {
		const minimal = deriveModelCapabilityProfile({ contextWindow: 8_192 });
		expect(filterToolNamesForCapability(["write", "goal", "update_goal", "read"], minimal)).toEqual([
			"write",
			"update_goal",
			"read",
		]);
		expect(filterToolNamesForCapability([], minimal)).toEqual([]);
	});
});

describe("evaluateLaneWorkerRefusal", () => {
	const eligible = {
		capabilityClass: "full" as const,
		contextWindow: 200_000,
		toolCallingAdvertised: true,
		toolCallingDemoted: false,
	};

	it("is eligible (undefined) for full class, a known window, advertised tool calling, not demoted", () => {
		expect(evaluateLaneWorkerRefusal(eligible)).toBeUndefined();
	});

	it("refuses capability_class_below_full for lean, minimal, and chat", () => {
		for (const capabilityClass of ["lean", "minimal", "chat"] as const) {
			expect(evaluateLaneWorkerRefusal({ ...eligible, capabilityClass })).toEqual({
				reason: "capability_class_below_full",
				capabilityClass,
				contextWindow: 200_000,
			});
		}
	});

	it("refuses context_window_unknown for a full class with no declared window", () => {
		expect(evaluateLaneWorkerRefusal({ ...eligible, contextWindow: undefined })).toEqual({
			reason: "context_window_unknown",
			capabilityClass: "full",
			contextWindow: undefined,
		});
	});

	it("refuses tool_calling_unadvertised when native tool calling is not advertised (textToolCallProtocol: true)", () => {
		expect(evaluateLaneWorkerRefusal({ ...eligible, toolCallingAdvertised: false })).toEqual({
			reason: "tool_calling_unadvertised",
			capabilityClass: "full",
			contextWindow: 200_000,
		});
	});

	it("refuses tool_calling_demoted for a graded /toolprobe demotion to text-protocol or none", () => {
		expect(evaluateLaneWorkerRefusal({ ...eligible, toolCallingDemoted: true })).toEqual({
			reason: "tool_calling_demoted",
			capabilityClass: "full",
			contextWindow: 200_000,
		});
	});

	it("is eligible for an UNPROBED model: unprobed is not treated as demoted", () => {
		// toolCallingDemoted is derived by the caller from the verdict; an unprobed model (verdict
		// undefined) yields toolCallingDemoted: false, same as this eligible fixture.
		expect(evaluateLaneWorkerRefusal({ ...eligible, toolCallingDemoted: false })).toBeUndefined();
	});

	it("first failure wins: capability class below full takes precedence over every other failure", () => {
		const refusal = evaluateLaneWorkerRefusal({
			capabilityClass: "lean",
			contextWindow: undefined,
			toolCallingAdvertised: false,
			toolCallingDemoted: true,
		});
		expect(refusal?.reason).toBe("capability_class_below_full");
	});
});

describe("formatLaneWorkerRefusal", () => {
	it("names the class, window, and reason in one deterministic, greppable line", () => {
		const line = formatLaneWorkerRefusal(
			{ reason: "tool_calling_demoted", capabilityClass: "full", contextWindow: 16_384 },
			"lane-a",
		);
		expect(line.startsWith(LANE_WORKER_REFUSAL_PREFIX)).toBe(true);
		expect(line).toContain("full");
		expect(line).toContain("16384");
		expect(line).toContain("tool_calling_demoted");
		expect(line).toContain("lane-a");
	});

	it("renders an unknown window as 'unknown' and omits the lane when no laneKey is given", () => {
		const line = formatLaneWorkerRefusal({
			reason: "context_window_unknown",
			capabilityClass: "full",
			contextWindow: undefined,
		});
		expect(line).toContain("unknown");
		expect(line).not.toContain("lane=");
	});
});
