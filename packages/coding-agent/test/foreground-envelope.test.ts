import { describe, expect, it } from "vitest";
import type { CapabilityName } from "../src/core/autonomy/contracts.ts";
import {
	buildForegroundEnvelope,
	formatForegroundEnvelopeObservation,
} from "../src/core/autonomy/foreground-envelope.ts";

describe("buildForegroundEnvelope", () => {
	it("maps every known tool to its capability", () => {
		const cases: Array<[string, CapabilityName]> = [
			["read", "read_files"],
			["grep", "read_files"],
			["find", "read_files"],
			["ls", "read_files"],
			["edit", "write_files"],
			["write", "write_files"],
			["bash", "run_shell"],
			["run_toolkit_script", "run_shell"],
			["delegate", "delegate"],
			["goal", "memory_write"],
			["memory", "memory_write"],
		];
		for (const [toolName, capability] of cases) {
			const envelope = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: [toolName], cwd: "/w" });
			expect(envelope.capabilities).toEqual([capability]);
		}
	});

	it("deduplicates capabilities in first-seen order when several tools share one", () => {
		const envelope = buildForegroundEnvelope({
			turnIndex: 3,
			activeToolNames: ["read", "grep", "edit", "write", "bash", "run_toolkit_script"],
			cwd: "/w",
		});
		expect(envelope.capabilities).toEqual(["read_files", "write_files", "run_shell"]);
	});

	it("omits unknown tools rather than guessing a capability", () => {
		const envelope = buildForegroundEnvelope({
			turnIndex: 1,
			activeToolNames: ["read", "context_audit", "artifact_retrieve", "mystery_tool"],
			cwd: "/w",
		});
		// only `read` maps; the three unknown tools contribute nothing
		expect(envelope.capabilities).toEqual(["read_files"]);
		// but they are still surfaced as allowed tools for visibility
		expect(envelope.allowedTools).toEqual(["read", "context_audit", "artifact_retrieve", "mystery_tool"]);
	});

	it("produces no capabilities when no active tool maps", () => {
		const envelope = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: ["context_audit"], cwd: "/w" });
		expect(envelope.capabilities).toEqual([]);
	});

	it("mirrors active tools into allowedTools and scopes allowedPaths to cwd", () => {
		const envelope = buildForegroundEnvelope({
			turnIndex: 7,
			activeToolNames: ["read", "edit"],
			cwd: "/home/project",
		});
		expect(envelope.id).toBe("foreground-turn-7");
		expect(envelope.allowedTools).toEqual(["read", "edit"]);
		expect(envelope.allowedPaths).toEqual(["/home/project"]);
	});

	it("sets maxEstimatedUsd only when a positive per-turn ceiling is supplied", () => {
		const withBudget = buildForegroundEnvelope({
			turnIndex: 0,
			activeToolNames: ["read"],
			cwd: "/w",
			maxTurnUsd: 0.5,
		});
		expect(withBudget.maxEstimatedUsd).toBe(0.5);

		const zero = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: ["read"], cwd: "/w", maxTurnUsd: 0 });
		expect(zero.maxEstimatedUsd).toBeUndefined();

		const negative = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: ["read"], cwd: "/w", maxTurnUsd: -3 });
		expect(negative.maxEstimatedUsd).toBeUndefined();

		const omitted = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: ["read"], cwd: "/w" });
		expect(omitted.maxEstimatedUsd).toBeUndefined();
	});

	it("matches tool names case-insensitively", () => {
		const envelope = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: ["READ", "Edit"], cwd: "/w" });
		expect(envelope.capabilities).toEqual(["read_files", "write_files"]);
	});
});

describe("formatForegroundEnvelopeObservation", () => {
	it("renders one bounded line with capability names, tool count, and path scope", () => {
		const envelope = buildForegroundEnvelope({
			turnIndex: 2,
			activeToolNames: ["read", "edit", "bash"],
			cwd: "/home/project",
		});
		expect(formatForegroundEnvelopeObservation(envelope)).toBe(
			"foreground envelope: 3 capability(ies) [read_files, write_files, run_shell], 3 tool(s), path scope /home/project",
		);
	});

	it("renders 'none' when no capability was derived", () => {
		const envelope = buildForegroundEnvelope({ turnIndex: 0, activeToolNames: ["context_audit"], cwd: "/w" });
		expect(formatForegroundEnvelopeObservation(envelope)).toBe(
			"foreground envelope: 0 capability(ies) [none], 1 tool(s), path scope /w",
		);
	});
});
