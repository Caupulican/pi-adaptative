import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deriveCompositeChildEnvelope,
	wrapToolWithCapabilityEnvelopeGate,
} from "../src/core/autonomy/composite-tool-gate.ts";
import type { CapabilityEnvelope, GateOutcome, GateOutcomeKind } from "../src/core/autonomy/contracts.ts";
import {
	combineGateOutcomes,
	evaluateToolGate,
	extractCandidatePaths,
	fallbackGateOutcome,
} from "../src/core/autonomy/gates.ts";
import { resolveProfileToolCapabilities } from "../src/core/tool-capability-policy.ts";

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
			capabilities: ["filesystem.read", "filesystem.write", "process.exec", "network.http"],
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

		it("returns block for bash that reads outside allowed root", () => {
			const outsideFile = path.join(outsideRoot, "data.txt");
			fs.writeFileSync(outsideFile, "outside data", "utf-8");
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedPaths: [allowedRoot] };

			const outcome = evaluateToolGate({
				toolName: "bash",
				args: { command: `cat ${outsideFile}` },
				cwd: allowedRoot,
				envelope,
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("path_outside_allowed_roots");

			const inside = evaluateToolGate({
				toolName: "bash",
				args: { command: `cat ${path.join(allowedRoot, "notes.txt")}` },
				cwd: allowedRoot,
				envelope,
			});
			expect(inside.outcome).toBe("allow");

			const relativeOutside = evaluateToolGate({
				toolName: "bash",
				args: { command: "cat ../outside/data.txt" },
				cwd: allowedRoot,
				envelope,
			});
			expect(relativeOutside.outcome).toBe("block");
			expect(relativeOutside.reasonCode).toBe("path_outside_allowed_roots");

			const attachedFlagOutside = evaluateToolGate({
				toolName: "bash",
				args: { command: `gcc -I${outsideRoot} main.c` },
				cwd: allowedRoot,
				envelope,
			});
			expect(attachedFlagOutside.outcome).toBe("block");
			expect(attachedFlagOutside.reasonCode).toBe("path_outside_allowed_roots");
			expect(
				evaluateToolGate({
					toolName: "bash",
					args: { command: `gcc -I${allowedRoot} main.c` },
					cwd: allowedRoot,
					envelope,
				}).outcome,
			).toBe("allow");

			const separatorTokensInScope = evaluateToolGate({
				toolName: "bash",
				args: { command: "git merge origin/main && sed s/a/b/ notes.txt" },
				cwd: tempDir,
				envelope: { ...emptyEnvelope, allowedPaths: [tempDir] },
			});
			expect(separatorTokensInScope.outcome).toBe("allow");
		});

		it("returns block for an execute-class call whose working directory is outside allowed roots", () => {
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedPaths: [allowedRoot] };

			// A bare relative operand projects nothing, so the working directory is the only bound on
			// what the launched process can reach.
			for (const command of ["cat package.json", "cat Makefile", "npm test"]) {
				const outcome = evaluateToolGate({ toolName: "bash", args: { command }, cwd: outsideRoot, envelope });
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("cwd_outside_allowed_roots");
			}
			for (const toolName of ["python", "run_process"]) {
				const outcome = evaluateToolGate({
					toolName,
					args: { executable: "cat", args: ["package.json"], code: "open('data.csv').read()" },
					cwd: outsideRoot,
					envelope,
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("cwd_outside_allowed_roots");
			}
			// An in-scope operand cannot buy back an unscoped working directory.
			const inScopeOperand = evaluateToolGate({
				toolName: "bash",
				args: { command: `cat ${path.join(allowedRoot, "notes.txt")}` },
				cwd: outsideRoot,
				envelope,
			});
			expect(inScopeOperand.outcome).toBe("block");
			expect(inScopeOperand.reasonCode).toBe("cwd_outside_allowed_roots");

			// Inside the allowed root the same bare operands are in scope by construction.
			for (const command of ["cat package.json", "cat Makefile", "npm test"]) {
				expect(evaluateToolGate({ toolName: "bash", args: { command }, cwd: allowedRoot, envelope }).outcome).toBe(
					"allow",
				);
			}
			expect(
				evaluateToolGate({
					toolName: "run_process",
					args: { executable: "cat", args: ["package.json"] },
					cwd: allowedRoot,
					envelope,
				}).outcome,
			).toBe("allow");

			// A working directory inside a denied subtree reports the deny, not a plain scope escape.
			const deniedCwd = path.join(allowedRoot, "vault");
			fs.mkdirSync(deniedCwd, { recursive: true });
			const deniedOutcome = evaluateToolGate({
				toolName: "bash",
				args: { command: "cat package.json" },
				cwd: deniedCwd,
				envelope: { ...envelope, deniedPaths: [deniedCwd] },
			});
			expect(deniedOutcome.outcome).toBe("block");
			expect(deniedOutcome.reasonCode).toBe("path_denied");

			// Path-scoped read tools keep their own lane: no working-directory requirement.
			expect(
				evaluateToolGate({
					toolName: "read",
					args: { path: path.join(allowedRoot, "notes.txt") },
					cwd: outsideRoot,
					envelope,
				}).outcome,
			).toBe("allow");
		});

		it("returns block for interpreter code, scriptPath, and argv paths outside allowed root", () => {
			const outsideFile = path.join(outsideRoot, "data.txt");
			fs.writeFileSync(outsideFile, "outside data", "utf-8");
			const insideFile = path.join(allowedRoot, "notes.txt");
			fs.writeFileSync(insideFile, "inside data", "utf-8");
			const envelope: CapabilityEnvelope = { ...emptyEnvelope, allowedPaths: [allowedRoot] };

			const codeOutside = evaluateToolGate({
				toolName: "python",
				args: { code: `print(open("${outsideFile}").read())` },
				cwd: allowedRoot,
				envelope,
			});
			expect(codeOutside.outcome).toBe("block");
			expect(codeOutside.reasonCode).toBe("path_outside_allowed_roots");
			expect(
				evaluateToolGate({
					toolName: "python",
					args: { code: `print(open("${insideFile}").read())` },
					cwd: allowedRoot,
					envelope,
				}).outcome,
			).toBe("allow");

			// Hex-encoded separators become a path only once the literal's escapes are decoded.
			const encodeSeparators = (value: string) => value.replaceAll("\\", "\\x5c").replaceAll("/", "\\x2f");
			const encodedOutside = evaluateToolGate({
				toolName: "python",
				args: { code: `print(open('${encodeSeparators(outsideFile)}').read())` },
				cwd: allowedRoot,
				envelope,
			});
			expect(encodedOutside.outcome).toBe("block");
			expect(encodedOutside.reasonCode).toBe("path_outside_allowed_roots");
			expect(
				evaluateToolGate({
					toolName: "python",
					args: { code: `print(open('${encodeSeparators(insideFile)}').read())` },
					cwd: allowedRoot,
					envelope,
				}).outcome,
			).toBe("allow");

			const scriptOutside = evaluateToolGate({
				toolName: "python",
				args: { scriptPath: outsideFile },
				cwd: allowedRoot,
				envelope,
			});
			expect(scriptOutside.outcome).toBe("block");
			expect(scriptOutside.reasonCode).toBe("path_outside_allowed_roots");
			expect(
				evaluateToolGate({ toolName: "python", args: { scriptPath: insideFile }, cwd: allowedRoot, envelope })
					.outcome,
			).toBe("allow");

			const argvOutside = evaluateToolGate({
				toolName: "run_process",
				args: { executable: "node", args: ["--check", outsideFile] },
				cwd: allowedRoot,
				envelope,
			});
			expect(argvOutside.outcome).toBe("block");
			expect(argvOutside.reasonCode).toBe("path_outside_allowed_roots");
			expect(
				evaluateToolGate({
					toolName: "run_process",
					args: { executable: "node", args: ["--check", insideFile] },
					cwd: allowedRoot,
					envelope,
				}).outcome,
			).toBe("allow");
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

		it("envelope missing filesystem.read blocks read/grep/find/ls", () => {
			for (const toolName of ["read", "grep", "find", "ls"]) {
				const outcome = evaluateToolGate({ toolName, cwd: "/tmp", envelope: baseEnvelope });
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("missing_capability");
			}
		});

		it("distinguishes read-only memory queries from memory mutations", () => {
			const readEnvelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["memory.query"] };
			const writeEnvelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["memory.mutate"] };

			expect(
				evaluateToolGate({
					toolName: "memory",
					args: { query: "relevant fact" },
					cwd: "/tmp",
					envelope: readEnvelope,
				}).outcome,
			).toBe("allow");
			expect(
				evaluateToolGate({ toolName: "memory", args: { action: "add" }, cwd: "/tmp", envelope: readEnvelope })
					.reasonCode,
			).toBe("missing_capability");
			expect(
				evaluateToolGate({
					toolName: "memory",
					args: { query: "relevant fact" },
					cwd: "/tmp",
					envelope: writeEnvelope,
				}).reasonCode,
			).toBe("missing_capability");
			expect(
				evaluateToolGate({
					toolName: "memory",
					args: { query: "disguise", action: "add", target: "memory", content: "unsafe" },
					cwd: "/tmp",
					envelope: readEnvelope,
				}).reasonCode,
			).toBe("missing_capability");
		});

		it("classifies goal reads separately from goal mutations", () => {
			const readEnvelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["memory.query"] };
			const writeEnvelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["memory.mutate"] };

			expect(evaluateToolGate({ toolName: "get_goal", args: {}, cwd: "/tmp", envelope: readEnvelope }).outcome).toBe(
				"allow",
			);
			expect(
				evaluateToolGate({ toolName: "goal", args: { action: "get" }, cwd: "/tmp", envelope: readEnvelope })
					.outcome,
			).toBe("allow");
			expect(
				evaluateToolGate({ toolName: "create_goal", args: {}, cwd: "/tmp", envelope: readEnvelope }).reasonCode,
			).toBe("missing_capability");
			expect(
				evaluateToolGate({ toolName: "goal", args: { action: "get" }, cwd: "/tmp", envelope: writeEnvelope })
					.reasonCode,
			).toBe("missing_capability");
		});

		it("envelope with filesystem.read allows read path inside scope", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read"],
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

		it("accepts an equivalent worktree.read grant through the shared tool policy", () => {
			const outcome = evaluateToolGate({
				toolName: "read",
				args: { path: "/tmp/foo/file.txt" },
				cwd: "/tmp",
				envelope: { ...baseEnvelope, capabilities: ["worktree.read"], allowedPaths: ["/tmp/foo"] },
			});
			expect(outcome.outcome).toBe("allow");
		});

		it("envelope missing filesystem.write blocks write/edit even if path is inside allowed root", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read"],
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

		it("envelope with filesystem.write allows scoped write/edit path inside scope", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.write"],
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

		it("envelope missing process.exec blocks bash, including read-only bash commands", () => {
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
				capabilities: ["filesystem.read", "filesystem.write", "process.exec"],
			};
			const outcome = evaluateToolGate({ toolName: "custom_tool", cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("unknown_tool_capability");
		});

		it("envelope with process.exec allows read-only bash command", () => {
			const envelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["process.exec"] };
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "ls" }, cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("allow");
		});

		it("accepts an equivalent tests.execute grant through the shared tool policy", () => {
			const envelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["tests.execute"] };
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "ls" }, cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("allow");
		});

		it("envelope with process.exec still asks before a destructive bash command", () => {
			const envelope: CapabilityEnvelope = { ...baseEnvelope, capabilities: ["process.exec"] };
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "rm -rf /" }, cwd: "/tmp", envelope });
			expect(["ask-user", "block"]).toContain(outcome.outcome);
			expect(outcome.gate).toBe("risk_assessment");
		});

		it("denied tool overrides present capability", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["process.exec"],
				deniedTools: ["bash"],
			};
			const outcome = evaluateToolGate({ toolName: "bash", args: { command: "ls" }, cwd: "/tmp", envelope });
			expect(outcome.outcome).toBe("block");
			expect(outcome.reasonCode).toBe("tool_denied");
		});

		it("denied path overrides present capability", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read"],
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

		it("enforces deniedPaths even when allowedPaths is omitted", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read"],
				deniedPaths: ["/tmp/secret"],
			};
			const blocked = evaluateToolGate({
				toolName: "read",
				args: { path: "/tmp/secret/creds.json" },
				cwd: "/tmp",
				envelope,
			});
			expect(blocked.outcome).toBe("block");
			expect(blocked.reasonCode).toBe("path_denied");

			const allowed = evaluateToolGate({
				toolName: "read",
				args: { path: "/tmp/public/readme.md" },
				cwd: "/tmp",
				envelope,
			});
			expect(allowed.outcome).toBe("allow");
		});

		it("allows core harness tools with valid capabilities", () => {
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: [
					"workflow.plan",
					"memory.mutate",
					"process.exec",
					"workflow.delegate",
					"filesystem.read",
					"filesystem.write",
					"worktree.mutate",
				],
			};
			for (const toolName of [
				"task_steps",
				"pipeline",
				"tool_task",
				"ask_question",
				"artifact_retrieve",
				"worktree_sync",
				"context_scout",
				"improvement_loop",
			]) {
				const outcome = evaluateToolGate({ toolName, cwd: "/tmp", envelope });
				expect(outcome.outcome).toBe("allow");
			}
		});

		it("rejects mutating tools under read-only capability envelopes", () => {
			const readOnlyEnvelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read", "worktree.read", "memory.query"],
			};
			const pipelineOutcome = evaluateToolGate({ toolName: "pipeline", cwd: "/tmp", envelope: readOnlyEnvelope });
			expect(pipelineOutcome.outcome).toBe("block");
			expect(pipelineOutcome.reasonCode).toBe("missing_capability");

			const worktreeOutcome = evaluateToolGate({
				toolName: "worktree_sync",
				cwd: "/tmp",
				envelope: readOnlyEnvelope,
			});
			expect(worktreeOutcome.outcome).toBe("block");
			expect(worktreeOutcome.reasonCode).toBe("missing_capability");

			const loopOutcome = evaluateToolGate({
				toolName: "improvement_loop",
				cwd: "/tmp",
				envelope: readOnlyEnvelope,
			});
			expect(loopOutcome.outcome).toBe("block");
			expect(loopOutcome.reasonCode).toBe("missing_capability");
		});

		it("resolves relative allowedPaths and deniedPaths against input.cwd rather than process cwd", () => {
			const customCwd = "/tmp/sandbox-repo";
			const envelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read"],
				allowedPaths: ["src", "docs"],
				deniedPaths: ["src/secret"],
			};

			const allowed = evaluateToolGate({
				toolName: "read",
				args: { path: "src/main.ts" },
				cwd: customCwd,
				envelope,
			});
			expect(allowed.outcome).toBe("allow");

			const outside = evaluateToolGate({
				toolName: "read",
				args: { path: "package.json" },
				cwd: customCwd,
				envelope,
			});
			expect(outside.outcome).toBe("block");
			expect(outside.reasonCode).toBe("path_outside_allowed_roots");

			const denied = evaluateToolGate({
				toolName: "read",
				args: { path: "src/secret/key.pem" },
				cwd: customCwd,
				envelope,
			});
			expect(denied.outcome).toBe("block");
			expect(denied.reasonCode).toBe("path_denied");
		});

		it("requires a mutating pipeline action to remain inside its workspace path scope", () => {
			const outcome = evaluateToolGate({
				toolName: "pipeline",
				args: { action: "start", name: "research" },
				cwd: "/tmp/sandbox-repo",
				envelope: {
					...baseEnvelope,
					capabilities: ["workflow.plan", "filesystem.write"],
					allowedPaths: ["src"],
				},
			});
			expect(outcome).toMatchObject({ outcome: "block", reasonCode: "path_outside_allowed_roots" });
		});

		it("enforces conjunctive capability requirements for mutating pipeline actions", () => {
			const planOnlyEnvelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["workflow.plan"],
			};
			// Read actions allowed with workflow.plan alone
			expect(
				evaluateToolGate({
					toolName: "pipeline",
					args: { action: "list" },
					cwd: "/tmp",
					envelope: planOnlyEnvelope,
				}).outcome,
			).toBe("allow");
			expect(
				evaluateToolGate({
					toolName: "pipeline",
					args: { action: "status" },
					cwd: "/tmp",
					envelope: { ...planOnlyEnvelope, allowedPaths: ["isolated-subtree"] },
				}).outcome,
			).toBe("allow");

			// Mutating actions require both workflow.plan AND (filesystem.write | worktree.mutate)
			for (const action of ["start", "increment", "abandon"]) {
				const outcome = evaluateToolGate({
					toolName: "pipeline",
					args: { action },
					cwd: "/tmp",
					envelope: planOnlyEnvelope,
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("missing_capability");
				expect(outcome.message).toContain("workflow.plan and (filesystem.write or worktree.mutate)");
			}

			// Full grant allows all actions
			const fullEnvelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["workflow.plan", "filesystem.write"],
			};
			for (const action of ["start", "increment", "abandon", "list", "status"]) {
				expect(
					evaluateToolGate({
						toolName: "pipeline",
						args: { action },
						cwd: "/tmp",
						envelope: fullEnvelope,
					}).outcome,
				).toBe("allow");
			}
		});

		it("materializes every conjunctive capability clause into profile tool manifests", () => {
			expect(resolveProfileToolCapabilities({ capabilityCeiling: ["workflow.plan"] }, "pipeline")).toBeUndefined();
			expect(
				resolveProfileToolCapabilities({ capabilityCeiling: ["workflow.plan", "worktree.mutate"] }, "pipeline"),
			).toEqual(["workflow.plan", "worktree.mutate"]);
			expect(resolveProfileToolCapabilities({ capabilityCeiling: ["memory.query"] }, "memory")).toEqual([
				"memory.query",
			]);
		});

		it("gates omitted directory-search paths without treating context_scout as cwd access", () => {
			const customCwd = "/tmp/sandbox-repo";
			const scopedEnvelope: CapabilityEnvelope = {
				...baseEnvelope,
				capabilities: ["filesystem.read", "memory.query"],
				allowedPaths: ["src"],
			};

			// Directory search tools default to root "." and are blocked if whole root is not in allowedPaths
			for (const toolName of ["find", "grep", "ls"]) {
				const outcome = evaluateToolGate({
					toolName,
					args: {},
					cwd: customCwd,
					envelope: scopedEnvelope,
				});
				expect(outcome.outcome).toBe("block");
				expect(outcome.reasonCode).toBe("path_outside_allowed_roots");
			}
			expect(extractCandidatePaths("grep", undefined)).toEqual(["."]);

			const scout = evaluateToolGate({
				toolName: "context_scout",
				args: { query: "inspect src" },
				cwd: customCwd,
				envelope: scopedEnvelope,
			});
			expect(scout.outcome).toBe("allow");
			expect(extractCandidatePaths("context_scout", { query: "inspect src" })).toEqual([]);

			// Explicitly pointing to allowed subpath succeeds
			const allowedGrep = evaluateToolGate({
				toolName: "grep",
				args: { path: "src" },
				cwd: customCwd,
				envelope: scopedEnvelope,
			});
			expect(allowedGrep.outcome).toBe("allow");
		});

		it("lets an authorized context_scout use internal read tools only inside the captured envelope", async () => {
			const parameters = Type.Object({ path: Type.String() });
			const execute = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "ok" }],
				details: undefined,
			}));
			const readTool: AgentTool<typeof parameters, undefined> = {
				name: "read",
				label: "Read",
				description: "Read one file.",
				parameters,
				execute,
			};
			const allowedPaths = [allowedRoot];
			const callerEnvelope: CapabilityEnvelope = {
				id: "scout-envelope",
				capabilities: ["filesystem.read"],
				allowedTools: ["context_scout"],
				allowedPaths,
				deniedPaths: [path.join(allowedRoot, "private")],
			};
			const childEnvelope = deriveCompositeChildEnvelope("context_scout", ["read", "grep", "find"], callerEnvelope);
			expect(childEnvelope?.allowedTools).toEqual(["context_scout", "read", "grep", "find"]);
			allowedPaths[0] = outsideRoot;

			const guarded = wrapToolWithCapabilityEnvelopeGate(readTool, tempDir, childEnvelope);
			await expect(
				guarded.execute("call-allowed", { path: path.join(allowedRoot, "file.txt") }),
			).resolves.toMatchObject({ content: [{ text: "ok" }] });
			await expect(guarded.execute("call-outside", { path: path.join(outsideRoot, "file.txt") })).rejects.toThrow(
				"path_outside_allowed_roots",
			);
			await expect(
				guarded.execute("call-denied", { path: path.join(allowedRoot, "private", "secret.txt") }),
			).rejects.toThrow("path_denied");
			expect(execute).toHaveBeenCalledOnce();
		});

		it("does not grant child tools when the composite parent is outside the allowlist", () => {
			const childEnvelope = deriveCompositeChildEnvelope("context_scout", ["read", "grep", "find"], {
				id: "wrong-parent-envelope",
				capabilities: ["filesystem.read"],
				allowedTools: ["read"],
			});
			expect(childEnvelope?.allowedTools).toEqual([]);
		});
	});
});
