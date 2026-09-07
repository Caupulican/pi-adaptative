import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { createPipelineToolDefinition, type PipelineToolDetails } from "../src/core/tools/pipeline.ts";
import type * as worktreeEngine from "../src/core/worktree-sync/git-engine.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

const status = vi.hoisted(() => vi.fn<typeof worktreeEngine.buildSyncStatus>());
vi.mock("../src/core/worktree-sync/git-engine.ts", async (importOriginal) => ({
	...(await importOriginal<typeof worktreeEngine>()),
	buildSyncStatus: status,
}));

async function call(harness: Harness, name: string, params: Record<string, unknown>) {
	const id = `fixture-${harness.session.messages.length}`;
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall(name, params, { id })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Fixture complete"),
	]);
	await harness.session.prompt("Execute the synthetic workflow operation.", { autoContinueGoal: false });
	const result = harness.session.messages.find(
		(message) => message.role === "toolResult" && message.toolCallId === id,
	);
	if (result?.role !== "toolResult") throw new Error("Missing fixture tool result");
	return result;
}

async function projectHarness() {
	const harness = await createHarness({
		initialActiveToolNames: [
			"task_directory",
			"task_steps",
			"pipeline",
			"worktree_sync",
			"goal",
			"get_goal",
			"update_goal",
		],
		settings: { modelCapability: { mode: "off" }, worktreeSync: { enabled: true } },
	});
	const project = join(harness.tempDir, "workflow project 日本語");
	mkdirSync(project);
	for (const params of [
		{ action: "register", workspaceId: "project", path: project },
		{ action: "select", workspaceId: "project" },
	])
		expect((await call(harness, "task_directory", params)).isError).toBe(false);
	return { harness, project };
}

function definition(cwd: string, marker: string) {
	const root = join(cwd, ".pi", "pipelines", "fixture");
	mkdirSync(join(root, "01_check", "output"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), `# ${marker}\n`);
	writeFileSync(join(root, "01_check", "CONTEXT.md"), `# One job\n${marker}\n\n## Outputs\n- result.txt\n`);
}

describe("workflow tools share the admitted project", () => {
	afterEach(() => vi.clearAllMocks());

	it("discovers and starts the selected project's pipeline without writing to the ambient project", async () => {
		const { harness, project } = await projectHarness();
		definition(harness.tempDir, "AMBIENT_DEFINITION");
		definition(project, "SELECTED_DEFINITION");
		const result = await call(harness, "pipeline", { action: "start", name: "fixture" });
		expect(result.isError, getMessageText(result)).toBe(false);
		const details = result.details as PipelineToolDetails;
		expect(details.run?.definitionPath).toBe(join(project, ".pi", "pipelines", "fixture"));
		expect(existsSync(join(project, ".pi", "pipeline-runs"))).toBe(true);
		expect(existsSync(join(harness.tempDir, ".pi", "pipeline-runs"))).toBe(false);
	});

	it("links checklist steps to a pipeline in the selected project and rejects a foreign stage", async () => {
		const { harness, project } = await projectHarness();
		definition(project, "SELECTED_DEFINITION");
		// Seed through the pipeline's public owner independently of runtime directory wiring.
		const pipeline = createPipelineToolDefinition({
			cwd: () => project,
			agentPipelinesDir: () => join(harness.tempDir, "pipelines"),
			getPipelineRun: () => undefined,
			savePipelineRun: (run) => {
				harness.session.savePipelineRunSnapshot(run);
			},
		});
		const seeded = await pipeline.execute(
			"seed",
			{ action: "start", name: "fixture" },
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		const run = (seeded.details as PipelineToolDetails).run!;
		expect(run).toBeDefined();
		const result = await call(harness, "task_steps", {
			action: "add",
			content: "Inspect project",
			pipelineRunId: run.runId,
			pipelineStageId: "01_check",
		});
		expect(result.isError, getMessageText(result)).toBe(false);
		const denied = await call(harness, "task_steps", {
			action: "add",
			content: "Wrong stage",
			pipelineRunId: run.runId,
			pipelineStageId: "02_foreign",
		});
		expect(denied.isError).toBe(true);
		expect(getMessageText(denied)).toContain("02_foreign");
	});

	it("resolves worktree state from the admitted project and forwards cancellation", async () => {
		const { harness, project } = await projectHarness();
		status.mockResolvedValue({ code: "not_a_git_repo", message: "Synthetic repository probe" });
		const tool = harness.session.agent.state.tools.find((tool) => tool.name === "worktree_sync")!;
		const abort = new AbortController();
		const invocation = await tool.bindInvocation!("worktree", { action: "status" }, abort.signal);
		try {
			await invocation.execute("worktree", { action: "status" }, abort.signal);
			expect(status).toHaveBeenCalledWith(
				expect.objectContaining({ cwd: project, signal: abort.signal }),
				expect.anything(),
			);
		} finally {
			invocation.release();
		}
	});

	it("keeps workflow discovery pinned across selection and reload, then follows selection when unpinned", async () => {
		const { harness, project } = await projectHarness();
		definition(project, "PINNED_DEFINITION");
		definition(harness.tempDir, "AMBIENT_DEFINITION");
		for (const [name, params] of [
			["task_steps", { action: "set", steps: [{ content: "Pinned workflow", status: "in_progress" }] }],
			["task_directory", { action: "bind", taskId: "step-1", workspaceId: "project", pinned: true }],
			["task_directory", { action: "select", workspaceId: "session" }],
		] as const)
			expect((await call(harness, name, params)).isError).toBe(false);
		await harness.session.reload();
		const pinned = await call(harness, "pipeline", { action: "start", name: "fixture" });
		expect(pinned.isError, getMessageText(pinned)).toBe(false);
		expect((pinned.details as PipelineToolDetails).run?.definitionPath).toBe(
			join(project, ".pi", "pipelines", "fixture"),
		);
		expect((await call(harness, "task_directory", { action: "bind", taskId: "step-1", pinned: false })).isError).toBe(
			false,
		);
		const following = await call(harness, "pipeline", { action: "start", name: "fixture" });
		expect(following.isError, getMessageText(following)).toBe(false);
		expect((following.details as PipelineToolDetails).run?.definitionPath).toBe(
			join(harness.tempDir, ".pi", "pipelines", "fixture"),
		);
	});

	it("keeps compact goal completion behind the selected project's active pipeline", async () => {
		const { harness, project } = await projectHarness();
		appendGoalStateSnapshot(
			harness.sessionManager,
			createGoalState({ goalId: "fixture-goal", userGoal: "Inspect fixture", now: "T0" }),
		);
		definition(project, "ACTIVE_PIPELINE");
		expect((await call(harness, "pipeline", { action: "start", name: "fixture" })).isError).toBe(false);
		const completion = await call(harness, "update_goal", { status: "complete" });
		expect(getMessageText(completion)).toContain("pipeline");
		expect(getLatestGoalStateSnapshot(harness.sessionManager)?.status).not.toBe("completed");
	});

	it("verifies relative goal file evidence in the admitted project, not its ambient namesake", async () => {
		const { harness, project } = await projectHarness();
		appendGoalStateSnapshot(
			harness.sessionManager,
			createGoalState({ goalId: "fixture-goal", userGoal: "Inspect fixture", now: "T0" }),
		);
		writeFileSync(join(project, "selected.txt"), "SELECTED_ONLY\n");
		writeFileSync(join(harness.tempDir, "ambient.txt"), "AMBIENT_ONLY\n");
		await call(harness, "goal", {
			action: "add_evidence",
			evidenceId: "selected",
			kind: "file",
			summary: "Selected file",
			uri: "selected.txt",
		});
		await call(harness, "goal", {
			action: "add_evidence",
			evidenceId: "ambient",
			kind: "file",
			summary: "Wrong project",
			uri: "ambient.txt",
		});
		const state = getLatestGoalStateSnapshot(harness.sessionManager)!;
		expect(state.evidence.find((entry) => entry.id === "selected")?.verified).toBe(true);
		expect(state.evidence.find((entry) => entry.id === "ambient")?.verified).toBe(false);
	});
});
