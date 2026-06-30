import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CapabilityEnvelope, GateOutcome, GateOutcomeKind } from "../src/core/autonomy/contracts.ts";
import {
	combineGateOutcomes,
	evaluateToolGate,
	extractCandidatePaths,
	fallbackGateOutcome,
} from "../src/core/autonomy/gates.ts";

describe("Autonomy Gates", () => {
	let tempDir: string;
	let allowedRoot: string;
	let outsideRoot: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-gates-test-"));
		allowedRoot = path.join(tempDir, "allowed");
		outsideRoot = path.join(tempDir, "outside");

		fs.mkdirSync(allowedRoot, { recursive: true });
		fs.mkdirSync(outsideRoot, { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe("combineGateOutcomes", () => {
		it("uses most restrictive outcome", () => {
			const outcomes: readonly GateOutcome[] = [
				{ outcome: "allow", gate: "g1", reasonCode: "r1" },
				{ outcome: "downgrade", gate: "g2", reasonCode: "r2" },
				{ outcome: "escalate", gate: "g3", reasonCode: "r3" },
				{ outcome: "ask-user", gate: "g4", reasonCode: "r4" },
				{ outcome: "block", gate: "g5", reasonCode: "r5" },
			];
			const combined = combineGateOutcomes(outcomes);
			expect(combined.outcome).toBe("block");
			expect(combined.gate).toBe("g5");
			expect(combined.reasonCode).toBe("r5");
		});

		it("defaults empty input to ask-user with reasonCode no_gate_outcomes", () => {
			const combined = combineGateOutcomes([]);
			expect(combined.outcome).toBe("ask-user");
			expect(combined.gate).toBe("gate-combiner");
			expect(combined.reasonCode).toBe("no_gate_outcomes");
		});

		it("keeps deterministic first most-restrictive outcome on ties", () => {
			const outcomes: readonly GateOutcome[] = [
				{ outcome: "ask-user", gate: "g1", reasonCode: "r1" },
				{ outcome: "block", gate: "first-block", reasonCode: "r2" },
				{ outcome: "block", gate: "second-block", reasonCode: "r3" },
			];
			const combined = combineGateOutcomes(outcomes);
			expect(combined.outcome).toBe("block");
			expect(combined.gate).toBe("first-block");
			expect(combined.reasonCode).toBe("r2");
		});

		it("does not allow malformed outcome values", () => {
			const outcomes: readonly GateOutcome[] = [
				{ outcome: "allow", gate: "g1", reasonCode: "r1" },
				{ outcome: "malformed" as unknown as GateOutcomeKind, gate: "g2", reasonCode: "r2" },
			];
			const combined = combineGateOutcomes(outcomes);
			expect(combined.outcome).toBe("block");
			expect(combined.gate).toBe("g2");
			expect(combined.reasonCode).toBe("r2");
		});
	});

	describe("fallbackGateOutcome", () => {
		it("blocks irreversible operations", () => {
			const outcome = fallbackGateOutcome({
				gate: "test-gate",
				reversible: false,
				reasonCode: "test-reason",
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.gate).toBe("test-gate");
			expect(outcome.reasonCode).toBe("test-reason");
		});

		it("asks for reversible operations", () => {
			const outcome = fallbackGateOutcome({
				gate: "test-gate",
				reversible: true,
				reasonCode: "test-reason",
			});
			expect(outcome.outcome).toBe("ask-user");
			expect(outcome.gate).toBe("test-gate");
			expect(outcome.reasonCode).toBe("test-reason");
		});

		it("coerces empty gate and reasonCode to defaults", () => {
			const outcome = fallbackGateOutcome({
				gate: "",
				reversible: true,
				reasonCode: "",
			});
			expect(outcome.gate).toBe("unknown_gate");
			expect(outcome.reasonCode).toBe("unknown_reason");
		});
	});

	describe("extractCandidatePaths", () => {
		it("extracts path from supported file tools", () => {
			expect(extractCandidatePaths("read", { path: "/test/file" })).toEqual(["/test/file"]);
			expect(extractCandidatePaths("edit", { path: "/test/file" })).toEqual(["/test/file"]);
		});

		it("ignores missing or invalid paths", () => {
			expect(extractCandidatePaths("read", {})).toEqual([]);
			expect(extractCandidatePaths("read", { path: 123 })).toEqual([]);
			expect(extractCandidatePaths("unsupported_tool", { path: "/test/file" })).toEqual([]);
		});
	});

	describe("evaluateToolGate", () => {
		const emptyEnvelope: CapabilityEnvelope = {
			id: "env-1",
			capabilities: ["read_files", "write_files", "run_shell", "network"],
		};

		it("returns allow when no envelope is provided", () => {
			const outcome = evaluateToolGate({ toolName: "bash", cwd: tempDir });
			expect(outcome.outcome).toBe("allow");
			expect(outcome.reasonCode).toBe("no_envelope");
		});

		it("returns block for denied tool", () => {
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, deniedTools: ["bash"] };
			const outcome = evaluateToolGate({ toolName: "bash", cwd: tempDir, envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("tool_denied");
		});

		it("returns block when tool is not in allowedTools", () => {
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedTools: ["read"] };
			const outcome = evaluateToolGate({ toolName: "bash", cwd: tempDir, envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("tool_not_allowed");
		});

		it("returns allow for read path inside allowed root", () => {
			const targetFile = path.join(allowedRoot, "file.txt");
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedPaths: [allowedRoot] };
			const outcome = evaluateToolGate({ toolName: "read", args: { path: targetFile }, cwd: tempDir, envelope });
			expect(outcome.outcome).toBe("allow");
		});

		it("resolves relative tool paths against the session cwd", () => {
			const workspace = path.join(tempDir, "workspace");
			const srcRoot = path.join(workspace, "src");
			fs.mkdirSync(srcRoot, { recursive: true });
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedPaths: [srcRoot] };
			const outcome = evaluateToolGate({
				toolName: "read",
				args: { path: "src/file.ts" },
				cwd: workspace,
				envelope,
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("returns block for edit path outside allowed root", () => {
			const targetFile = path.join(outsideRoot, "file.txt");
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedPaths: [allowedRoot] };
			const outcome = evaluateToolGate({ toolName: "edit", args: { path: targetFile }, cwd: tempDir, envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("path_outside_allowed_roots");
		});

		it("returns block for denied path inside allowed root", () => {
			const deniedPath = path.join(allowedRoot, "denied");
			fs.mkdirSync(deniedPath);
			const targetFile = path.join(deniedPath, "file.txt");

			const envelope: CapabilityEnvelope = {
				...emptyEnvelope,
				allowedPaths: [allowedRoot],
				deniedPaths: [deniedPath],
			};
			const outcome = evaluateToolGate({ toolName: "read", args: { path: targetFile }, cwd: tempDir, envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("path_denied");
		});

		it("returns allow for bash read-only command", () => {
			const outcome = evaluateToolGate({
				toolName: "bash",
				args: { command: "ls -la" },
				cwd: tempDir,
				envelope: emptyEnvelope,
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("returns ask-user or block for bash mutating/destructive command", () => {
			const outcome = evaluateToolGate({
				toolName: "bash",
				args: { command: "rm -rf /tmp/foo" },
				cwd: tempDir,
				envelope: emptyEnvelope,
			});
			expect(["ask-user", "block"]).toContain(outcome.outcome);
		});

		it("returns ask-user or block for mutating settings/prompts/tools operation", () => {
			const outcome = evaluateToolGate({
				toolName: "bash",
				args: { command: "Update agent skills" },
				cwd: tempDir,
				envelope: emptyEnvelope,
			});
			expect(["ask-user", "block"]).toContain(outcome.outcome);
		});
	});

	describe("Capability checks (Phase 3C)", () => {
		const baseEnvelope: CapabilityEnvelope = { id: "env-1", capabilities: [] };

		it("envelope missing read_files blocks read/grep/find/ls", () => {
			for (const toolName of ["read", "grep", "find", "ls"]) {
				const outcome = evaluateToolGate({ toolName, cwd: "/tmp", envelope: baseEnvelope });
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("missing_capability");
			}
		});

		it("envelope with read_files allows read path inside scope", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["read_files"],
				allowedPaths: ["/tmp/foo"],
			};
			const outcome = evaluateToolGate({
				toolName: "read",
				args: { path: "/tmp/foo/file.txt" },
				cwd: "/tmp",
				envelope,
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("envelope missing write_files blocks write/edit even if path is inside allowed root", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["read_files"],
				allowedPaths: ["/tmp/foo"],
			};
			const outcome = evaluateToolGate({
				toolName: "write",
				args: { path: "/tmp/foo/file.txt" },
				cwd: "/tmp",
				envelope,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_capability");
		});

		it("envelope with write_files allows scoped write/edit path inside scope", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["write_files"],
				allowedPaths: ["/tmp/foo"],
			};
			const outcome = evaluateToolGate({
				toolName: "write",
				args: { path: "/tmp/foo/file.txt" },
				cwd: "/tmp",
				envelope,
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("envelope missing run_shell blocks bash, including read-only bash commands", () => {
			const outcome = evaluateToolGate({
				toolName: "bash",
				args: { command: "ls" },
				cwd: "/tmp",
				envelope: baseEnvelope,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("missing_capability");
		});

		it("active envelope blocks tools without a capability policy", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["read_files", "write_files", "run_shell"],
			};
			const outcome = evaluateToolGate({ toolName: "custom_tool", cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("unknown_tool_capability");
		});

		it("envelope with run_shell allows read-only bash command", () => {
			const envelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["run_shell"] };
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "ls" }, cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("allow");
		});

		it("envelope with run_shell still ask-user/blocks destructive bash command", () => {
			const envelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["run_shell"] };
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "rm -rf /" }, cwd: "/tmp", envelope });
			expect(["ask-user", "block"]).toContain(outcome.outcome);
			expect(outcome.gate).toBe("risk_assessment");
		});

		it("denied tool overrides present capability", () => {
			const envelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["run_shell"], deniedTools: ["bash"] };
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "ls" }, cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("tool_denied");
		});

		it("denied path overrides present capability", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["read_files"],
				allowedPaths: ["/tmp/foo"],
				deniedPaths: ["/tmp/foo/secret"],
			};
			const outcome = evaluateToolGate({
				toolName: "read",
				args: { path: "/tmp/foo/secret/file.txt" },
				cwd: "/tmp",
				envelope,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("path_denied");
		});
	});
});
