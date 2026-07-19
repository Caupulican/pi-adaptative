import { describe, expect, it } from "vitest";
import {
	deriveModelCapabilityProfile,
	evaluateLaneWorkerRefusal,
	filterToolNamesForCapability,
	formatLaneWorkerRefusal,
	LANE_WORKER_REFUSAL_PREFIX,
	MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS,
	MODEL_CAPABILITY_LEAN_BLOCKED_TOOLS,
	MODEL_CAPABILITY_LEAN_MAX_CONTINUE_TURNS,
	MODEL_CAPABILITY_LEAN_MAX_CONTINUE_WALL_CLOCK_MINUTES,
	scaleContinuationBudgetsForCapability,
} from "../src/core/model-capability.ts";

const DEFAULT_ACTIVE = [
	"read",
	"bash",
	"python",
	"edit",
	"write",
	"context_audit",
	"goal",
	"task_steps",
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

describe("scaleContinuationBudgetsForCapability", () => {
	const configured = { maxTurns: 20, maxWallClockMinutes: 30 };

	it("passes the configured budget through unchanged for the full class", () => {
		const full = deriveModelCapabilityProfile({ contextWindow: 200_000 });
		expect(full.class).toBe("full");
		expect(scaleContinuationBudgetsForCapability(full, configured)).toEqual(configured);
	});

	it("caps both dimensions for the lean class", () => {
		const lean = deriveModelCapabilityProfile({ contextWindow: 24_000 });
		expect(lean.class).toBe("lean");
		expect(scaleContinuationBudgetsForCapability(lean, configured)).toEqual({
			maxTurns: MODEL_CAPABILITY_LEAN_MAX_CONTINUE_TURNS,
			maxWallClockMinutes: MODEL_CAPABILITY_LEAN_MAX_CONTINUE_WALL_CLOCK_MINUTES,
		});
	});

	it("only tightens: a lean budget already below the caps is left alone", () => {
		const lean = deriveModelCapabilityProfile({ contextWindow: 24_000 });
		expect(scaleContinuationBudgetsForCapability(lean, { maxTurns: 1, maxWallClockMinutes: 3 })).toEqual({
			maxTurns: 1,
			maxWallClockMinutes: 3,
		});
	});

	it("keeps a disabled wall-clock budget (0) disabled under the lean cap", () => {
		const lean = deriveModelCapabilityProfile({ contextWindow: 24_000 });
		expect(scaleContinuationBudgetsForCapability(lean, { maxTurns: 20, maxWallClockMinutes: 0 })).toEqual({
			maxTurns: MODEL_CAPABILITY_LEAN_MAX_CONTINUE_TURNS,
			maxWallClockMinutes: 0,
		});
	});

	it("applies the lean caps at the 16k boundary and full passthrough at the 32k boundary", () => {
		const leanBoundary = deriveModelCapabilityProfile({ contextWindow: 16_384 });
		expect(leanBoundary.class).toBe("lean");
		expect(scaleContinuationBudgetsForCapability(leanBoundary, configured)).toEqual({
			maxTurns: MODEL_CAPABILITY_LEAN_MAX_CONTINUE_TURNS,
			maxWallClockMinutes: MODEL_CAPABILITY_LEAN_MAX_CONTINUE_WALL_CLOCK_MINUTES,
		});

		const fullBoundary = deriveModelCapabilityProfile({ contextWindow: 32_768 });
		expect(fullBoundary.class).toBe("full");
		expect(scaleContinuationBudgetsForCapability(fullBoundary, configured)).toEqual(configured);
	});

	it("passes through for minimal and chat (they never reach the loop, but the scaler is class-pure)", () => {
		const minimal = deriveModelCapabilityProfile({ contextWindow: 8_192 });
		const chat = deriveModelCapabilityProfile({ contextWindow: 4_096 });
		expect(minimal.class).toBe("minimal");
		expect(chat.class).toBe("chat");
		expect(scaleContinuationBudgetsForCapability(minimal, configured)).toEqual(configured);
		expect(scaleContinuationBudgetsForCapability(chat, configured)).toEqual(configured);
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

	it("reduces minimal to the core coding set and chat to nothing", () => {
		const minimal = deriveModelCapabilityProfile({ contextWindow: 8_192 });
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, minimal)).toEqual([
			"read",
			"bash",
			"python",
			"edit",
			"write",
			"run_toolkit_script",
		]);

		const chat = deriveModelCapabilityProfile({ contextWindow: 4_096 });
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, chat)).toEqual([...MODEL_CAPABILITY_CHAT_ALLOWED_TOOLS]);
		expect(filterToolNamesForCapability(DEFAULT_ACTIVE, chat)).toEqual([]);
	});

	it("preserves requested order and never invents tools", () => {
		const minimal = deriveModelCapabilityProfile({ contextWindow: 8_192 });
		expect(filterToolNamesForCapability(["write", "goal", "read"], minimal)).toEqual(["write", "read"]);
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
