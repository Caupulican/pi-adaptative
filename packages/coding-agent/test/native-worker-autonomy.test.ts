import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, parse, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { describe, expect, it } from "vitest";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { workerMachinePathRoots } from "../src/core/delegation/worker-machine-scope.ts";
import { createDelegateToolDefinition } from "../src/core/tools/delegate.ts";
import type { DelegateProfileToolDetails } from "../src/core/tools/profile-writer.ts";
import { createHarness } from "./suite/harness.ts";

function externalWorkspace(parent: string, suffix: string): string {
	const workspace = join(tmpdir(), `${basename(parent)}-${suffix}`);
	rmSync(workspace, { force: true, recursive: true });
	mkdirSync(workspace, { recursive: true });
	return workspace;
}

function firstExecutionContract(harness: Awaited<ReturnType<typeof createHarness>>) {
	const snapshot = new WorkerLifecycle({
		agentDir: harness.tempDir,
		sessionId: harness.session.sessionId,
	}).getTaskRuntimeSnapshot();
	return Object.values(snapshot.attempts)[0]?.dispatch.executionContract?.worker;
}

describe("native worker autonomy", () => {
	it("exposes only lightweight start overrides and compiles them into the internal request", async () => {
		let received: WorkerDelegationRequest | undefined;
		const definition = createDelegateToolDefinition({
			caller: { kind: "session_root" },
			startWorkerDelegation: (request) => {
				received = request;
				return { started: true, record: { laneId: "worker-1", type: "worker", status: "queued" } };
			},
			runWorkerDelegation: async () => ({ started: false, skipReason: "unused" }),
		});
		const properties = (definition.parameters as { properties?: Record<string, unknown> }).properties ?? {};

		expect(properties).not.toHaveProperty("authority");
		expect(properties).not.toHaveProperty("readPaths");
		expect(properties).not.toHaveProperty("writePaths");
		expect(properties).not.toHaveProperty("resourceProfileNames");
		expect(properties).toHaveProperty("model");
		expect(properties).toHaveProperty("thinkingLevel");
		expect(properties).toHaveProperty("path");
		expect(properties).toHaveProperty("toolNames");

		await definition.execute(
			"start-with-overrides",
			{
				action: "start",
				instructions: "Implement the requested change autonomously.",
				model: { provider: "faux", modelId: "worker-model" },
				thinkingLevel: "high",
				path: "/mnt/d/GitHub/mine/GrimDex",
				toolNames: ["read", "write", "bash"],
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(received).toMatchObject({
			instructions: "Implement the requested change autonomously.",
			authority: {
				model: { provider: "faux", modelId: "worker-model" },
				thinkingLevel: "high",
				path: "/mnt/d/GitHub/mine/GrimDex",
				toolNames: ["read", "write", "bash"],
			},
		});
	});

	it("inherits machine-wide read/write authority while keeping the parent cwd and no delegate tool", async () => {
		const harness = await createHarness({
			models: [
				{
					id: "foreground",
					contextWindow: 128_000,
					reasoning: true,
					defaultThinkingLevel: "low",
				},
			],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const outside = externalWorkspace(harness.tempDir, "machine-scope");
		const output = join(outside, "outside-parent.txt");
		let materializedTools: string[] = [];
		try {
			harness.session.setThinkingLevel("high");
			harness.setResponses([
				(context) => {
					materializedTools = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage([fauxToolCall("write", { path: output, content: "machine-wide" })], {
						stopReason: "toolUse",
					});
				},
				fauxAssistantMessage('{"summary":"wrote outside the parent cwd","status":"completed"}'),
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Write the requested artifact outside the parent project.",
			});

			expect(run.record?.status).toBe("partial");
			expect(readFileSync(output, "utf-8")).toBe("machine-wide");
			const worker = firstExecutionContract(harness);
			const machineRoots = workerMachinePathRoots(harness.tempDir);
			expect(machineRoots).toContain(parse(resolve(harness.tempDir)).root);
			expect(worker?.modelBinding).toMatchObject({ modelId: "foreground", thinkingLevel: "high" });
			expect(worker?.authority).toMatchObject({
				cwd: resolve(harness.tempDir),
				readPaths: machineRoots,
				writePaths: machineRoots,
			});
			expect(worker?.authority.toolNames).not.toContain("delegate");
			expect(worker?.authority.capabilities).not.toContain("workflow.delegate");
			expect(materializedTools).toContain("python");
			expect(materializedTools.sort()).toEqual([...(worker?.authority.toolNames ?? [])].sort());
		} finally {
			rmSync(outside, { force: true, recursive: true });
			await harness.cleanup();
		}
	});

	it("materializes omitted active artifact retrieval through the host-owned worker adapter", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "artifact_retrieve", "delegate"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		let materializedTools: string[] = [];
		try {
			expect(harness.session.getActiveToolNames()).toContain("artifact_retrieve");
			harness.setResponses([
				(context) => {
					materializedTools = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage('{"summary":"artifact retrieval surface available","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the inherited artifact retrieval tool if needed.",
			});

			expect(run.started).toBe(true);
			expect(materializedTools).toContain("artifact_retrieve");
			const worker = firstExecutionContract(harness);
			expect(worker?.authority.toolNames).toContain("artifact_retrieve");
			expect(worker?.profile.toolNames).toContain("artifact_retrieve");
		} finally {
			await harness.cleanup();
		}
	});

	it("inherits active skill tools as fresh read-only worker adapters", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "skill", "skill_audit", "delegate"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		let materializedTools: string[] = [];
		try {
			harness.setResponses([
				(context) => {
					materializedTools = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage('{"summary":"read-only skill surface available","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use read-only skill guidance and audit when useful.",
			});

			expect(run.started).toBe(true);
			expect(materializedTools).toEqual(expect.arrayContaining(["skill", "skill_audit"]));
			const worker = firstExecutionContract(harness);
			expect(worker?.authority.toolNames).toEqual(expect.arrayContaining(["skill", "skill_audit"]));
		} finally {
			await harness.cleanup();
		}
	});

	it("does not materialize inactive skill adapters for an omitted worker profile", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "delegate"],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		let materializedTools: string[] = [];
		try {
			harness.setResponses([
				(context) => {
					materializedTools = (context.tools ?? []).map((tool) => tool.name);
					return fauxAssistantMessage('{"summary":"inactive skill surface omitted","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Do not use skill tools unless the foreground made them active.",
			});

			expect(run.started).toBe(true);
			expect(materializedTools).not.toContain("skill");
			expect(materializedTools).not.toContain("skill_audit");
		} finally {
			await harness.cleanup();
		}
	});

	it("uses one path override as both worker cwd and read/write focus", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const workspace = externalWorkspace(harness.tempDir, "focused-scope");
		const output = join(workspace, "focused.txt");
		const projectSettings = join(workspace, ".pi", "settings.json");
		const projectSecret = "FOCUSED_PROJECT_SETTINGS_MUST_NOT_LEAK";
		let processResult = "";
		try {
			mkdirSync(join(workspace, ".pi"), { recursive: true });
			writeFileSync(projectSettings, projectSecret, "utf-8");
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("write", { path: "focused.txt", content: "focused" }),
						fauxToolCall("bash", { command: "pwd" }),
						fauxToolCall("read", { path: projectSettings }),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					processResult = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
					return fauxAssistantMessage('{"summary":"focused workspace complete","status":"completed"}');
				},
			]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Work in the selected project.",
				authority: { path: workspace },
			});

			expect(run.record?.status).toBe("partial");
			expect(existsSync(output)).toBe(true);
			expect(readFileSync(output, "utf-8")).toBe("focused");
			expect(processResult).toContain(resolve(workspace));
			expect(processResult).toContain("path_outside_scope");
			expect(processResult).not.toContain(projectSecret);
			expect(firstExecutionContract(harness)?.authority).toMatchObject({
				cwd: resolve(workspace),
				readPaths: [resolve(workspace)],
				writePaths: [resolve(workspace)],
				deniedPaths: expect.arrayContaining([resolve(projectSettings)]),
			});
		} finally {
			rmSync(workspace, { force: true, recursive: true });
			await harness.cleanup();
		}
	});

	it("resolves POSIX, native Windows drive, and UNC machine roots deterministically", () => {
		expect(workerMachinePathRoots("/tmp/project", "linux", () => false)).toEqual(["/"]);
		expect(
			workerMachinePathRoots("C:\\repo", "win32", (candidate) => candidate === "C:\\" || candidate === "D:\\"),
		).toEqual(["C:\\", "D:\\"]);
		expect(workerMachinePathRoots("\\\\server\\share\\repo", "win32", () => false)).toEqual(["\\\\server\\share\\"]);
	});

	it("returns a structured skip for an invalid no-profile workspace path", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Reject the malformed workspace without throwing.",
				authority: { path: "invalid\0workspace" },
			});

			expect(run).toMatchObject({
				started: false,
				skipReason: expect.stringContaining("orchestration_authority_invalid"),
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects an explicit tool override that the active host policy cannot materialize", async () => {
		const harness = await createHarness({
			settings: {
				workerDelegation: { enabled: true, orchestrationProfile: undefined, writeEnabled: false },
			},
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Do not silently drop the requested write tool.",
				authority: { toolNames: ["write"] },
			});

			expect(run).toEqual({ started: false, skipReason: "orchestration_tool_unavailable:write" });
			expect(harness.session.getLaneRecords()).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});

	it("persists the exact effective native tool surface after host kill switches narrow inheritance", async () => {
		const harness = await createHarness({
			settings: {
				workerDelegation: { enabled: true, orchestrationProfile: undefined, writeEnabled: false },
			},
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"read-only work complete","status":"completed"}')]);

			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the exact effective inherited surface.",
			});

			expect(run.started).toBe(true);
			const worker = firstExecutionContract(harness);
			expect(worker?.profile.toolNames).toEqual(worker?.authority.toolNames);
			expect(worker?.profile.toolNames).not.toContain("write");
			expect(worker?.profile.toolNames).not.toContain("edit");
		} finally {
			await harness.cleanup();
		}
	});

	it("rejects every fresh runtime request carrying a parent worker identity", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Attempt to create a child worker.",
				parentAgentId: "worker-1",
			});

			expect(run).toEqual({ started: false, skipReason: "worker_leaf_delegation_forbidden" });
			expect(harness.session.getLaneRecords()).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});

	it("keeps private harness state denied while ordinary machine-scope writes continue", async () => {
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const outside = externalWorkspace(harness.tempDir, "private-negative-control");
		const output = join(outside, "allowed.txt");
		const privateFiles = [
			[join(harness.tempDir, "auth.json"), "PRIVATE_AUTH_MARKER_MUST_NOT_LEAK"],
			[join(harness.tempDir, "MEMORY.md"), "RAW_MEMORY_MARKER_MUST_NOT_LEAK"],
			[join(harness.tempDir, "okf-memory", "private.md"), "OKF_MEMORY_MARKER_MUST_NOT_LEAK"],
			[join(harness.tempDir, "sessions", "private.json"), "SESSION_MARKER_MUST_NOT_LEAK"],
			[join(harness.tempDir, "state", "private.json"), "STATE_MARKER_MUST_NOT_LEAK"],
			[join(harness.tempDir, "work", "private.txt"), "WORK_MARKER_MUST_NOT_LEAK"],
		] as const;
		let toolResults = "";
		try {
			for (const [privatePath, marker] of privateFiles) {
				mkdirSync(join(privatePath, ".."), { recursive: true });
				writeFileSync(privatePath, marker, "utf-8");
			}
			harness.setResponses([
				fauxAssistantMessage(
					[
						...privateFiles.map(([privatePath]) => fauxToolCall("read", { path: privatePath })),
						fauxToolCall("bash", { command: `cat ${privateFiles[1][0]}` }),
						fauxToolCall("python", {
							code: `print(open(${JSON.stringify(privateFiles[2][0])}).read())`,
						}),
						fauxToolCall("write", { path: output, content: "allowed" }),
					],
					{ stopReason: "toolUse" },
				),
				(context) => {
					toolResults = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
					return fauxAssistantMessage('{"summary":"private state stayed private","status":"completed"}');
				},
			]);

			await harness.session.runWorkerDelegationOnce({ instructions: "Read private state and write the artifact." });

			expect(readFileSync(output, "utf-8")).toBe("allowed");
			for (const [, marker] of privateFiles) expect(toolResults).not.toContain(marker);
			expect(toolResults).toContain("path_outside_scope");
			const deniedPaths = firstExecutionContract(harness)?.authority.deniedPaths ?? [];
			for (const [privatePath] of privateFiles) {
				expect(deniedPaths.some((scope) => privatePath === scope || privatePath.startsWith(`${scope}/`))).toBe(
					true,
				);
			}
		} finally {
			rmSync(outside, { force: true, recursive: true });
			await harness.cleanup();
		}
	});

	it("creates a reusable inherited profile without inspect or baseProfileId", async () => {
		const harness = await createHarness({
			models: [{ id: "foreground", contextWindow: 128_000, reasoning: true }],
			settings: { workerDelegation: { enabled: true, orchestrationProfile: undefined } },
		});
		const workspace = externalWorkspace(harness.tempDir, "profile-scope");
		try {
			const tool = harness.session.getToolDefinition("delegate");
			if (!tool) throw new Error("Expected delegate tool.");
			const created = await tool.execute(
				"profile-without-base",
				{
					action: "profile_create",
					task: "Implement focused changes with the inherited model.",
					thinkingLevel: "high",
					path: workspace,
					toolNames: ["read", "write"],
				},
				undefined,
				undefined,
				undefined as never,
			);
			const details = created.details as DelegateProfileToolDetails;
			expect(details).toMatchObject({ created: true, started: true });
			expect(details.profileId).toMatch(/^task-/);

			harness.setResponses([fauxAssistantMessage('{"summary":"profile ran","status":"completed"}')]);
			const run = await harness.session.runWorkerDelegationOnce({
				instructions: "Use the prepared profile.",
				profileId: details.profileId,
			});

			expect(run.record?.status).toBe("succeeded");
			expect(firstExecutionContract(harness)).toMatchObject({
				modelBinding: { modelId: "foreground", thinkingLevel: "high" },
				authority: {
					cwd: resolve(workspace),
					readPaths: [resolve(workspace)],
					writePaths: [resolve(workspace)],
					toolNames: ["read", "write"],
				},
			});
		} finally {
			rmSync(workspace, { force: true, recursive: true });
			await harness.cleanup();
		}
	});
});
