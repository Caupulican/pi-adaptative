import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { applyGoalAction } from "../src/core/goals/goal-tool-core.ts";
import {
	assembleStageContext,
	discoverPipelineDefinitions,
	formatPipelineContext,
	incrementPipelineRun,
	instantiatePipelineRun,
	loadPipelineDefinition,
	PipelineIncrementError,
	parseStageContract,
	scanStageOutput,
	stageOutputDir,
} from "../src/core/pipelines/index.ts";
import { createPipelineToolDefinition } from "../src/core/tools/pipeline.ts";

const ctx = undefined as unknown as ExtensionContext;

const STAGE_ONE = `# 01_research — gather facts

One job: collect the source facts.

## Inputs
- Reference (every run): ../../_shared/rules.md
- Do NOT load: prior runs

## Process
1. Read the rules.
2. Write the research note.

## Outputs
- research.md → output/

## Human check
Skim the citations.
`;

const STAGE_TWO = `# 02_draft — write the draft

One job: turn research into a draft.

## Inputs
- Working (this run): ../01_research/output/research.md
- Reference (every run): ../../_shared/rules.md

## Process
- Draft from the research note.

## Outputs
- draft.md → output/

## Human check
Read the draft aloud.
`;

function writeDefinition(root: string): void {
	mkdirSync(join(root, "stages", "01_research", "output"), { recursive: true });
	mkdirSync(join(root, "stages", "02_draft", "output"), { recursive: true });
	mkdirSync(join(root, "_shared"), { recursive: true });
	writeFileSync(join(root, "AGENTS.md"), "# Research pipeline\n\nGo to stages/01_research/CONTEXT.md.\n");
	writeFileSync(
		join(root, "CONTEXT.md"),
		`---
name: research
form: pipeline
description: Research then draft
---
# research — the pipeline
`,
	);
	writeFileSync(join(root, "_shared", "rules.md"), "Be brief.\n");
	writeFileSync(join(root, "stages", "01_research", "CONTEXT.md"), STAGE_ONE);
	writeFileSync(join(root, "stages", "02_draft", "CONTEXT.md"), STAGE_TWO);
}

describe("pipeline contracts", () => {
	it("parses working, reference, numbered process, and do-not-load lines", () => {
		const contract = parseStageContract(STAGE_ONE);
		expect(contract.oneJob).toBe("collect the source facts.");
		expect(contract.inputs).toEqual([{ kind: "reference", path: "../../_shared/rules.md" }]);
		expect(contract.doNotLoad).toEqual(["prior runs"]);
		expect(contract.process).toEqual(["Read the rules.", "Write the research note."]);
		expect(contract.outputs).toEqual(["research.md"]);
		expect(contract.humanCheck).toContain("citations");
	});
});

describe("pipeline discovery and increment", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-pipeline-"));
		dirs.push(dir);
		return dir;
	}

	it("discovers an AGENTS.md workspace under .pi/pipelines and prefers L0 AGENTS.md", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const found = discoverPipelineDefinitions({ agentPipelinesDir: join(cwd, "agent-pipelines"), cwd });
		expect(found).toHaveLength(1);
		expect(found[0].name).toBe("research");
		expect(found[0].form).toBe("pipeline");
		expect(found[0].entryFile).toBe(join(definitionRoot, "AGENTS.md"));
		expect(found[0].stages.map((stage) => stage.id)).toEqual(["01_research", "02_draft"]);
	});

	it("treats .gitkeep as empty and increments only after real output files exist", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		writeFileSync(join(definitionRoot, "stages", "01_research", "output", ".gitkeep"), "");
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		let run = instantiatePipelineRun({
			definition,
			runId: "run-1",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-1"),
			now: "T0",
		});
		expect(scanStageOutput(stageOutputDir(run.runRoot, definition.stages[0]!)).status).toBe("empty");
		expect(() => incrementPipelineRun(definition, run, "T1")).toThrow(PipelineIncrementError);
		writeFileSync(join(stageOutputDir(run.runRoot, definition.stages[0]!), "research.md"), "facts\n");
		const advanced = incrementPipelineRun(definition, run, "T2");
		expect(advanced.result).toMatchObject({
			surface: "pipeline",
			from: "01_research",
			to: "02_draft",
			completed: false,
		});
		run = advanced.run;
		writeFileSync(join(stageOutputDir(run.runRoot, definition.stages[1]!), "draft.md"), "draft\n");
		const done = incrementPipelineRun(definition, run, "T3");
		expect(done.result.completed).toBe(true);
		expect(done.run.status).toBe("completed");
	});

	it("refuses increment while linked open task_steps or running tool_tasks remain", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const run = instantiatePipelineRun({
			definition,
			runId: "run-2",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-2"),
			goalId: "g1",
			now: "T0",
		});
		writeFileSync(join(stageOutputDir(run.runRoot, definition.stages[0]!), "research.md"), "facts\n");
		let goal = createGoalState({ goalId: "g1", userGoal: "Ship", now: "T0" });
		const goalResult = applyGoalAction(goal, { action: "add_requirement", requirementId: "r1", text: "Do X" }, "T1");
		if (!goalResult.ok) throw new Error(goalResult.error);
		goal = goalResult.state;
		expect(() =>
			incrementPipelineRun(definition, run, "T2", {
				goal,
				openTaskSteps: [{ id: "step-1", content: "Finish Do X", requirementIds: ["r1"] }],
			}),
		).toThrow(/open task_steps/);
		expect(() =>
			incrementPipelineRun(definition, run, "T2", {
				backgroundToolTasks: [{ taskId: "tool-task-1", toolCallId: "c1", status: "running" }],
			}),
		).toThrow(/tool_task/);
	});

	it("assembles current-stage context and wraps it in a GC marker", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const run = instantiatePipelineRun({
			definition,
			runId: "run-3",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-3"),
			now: "T0",
		});
		const assembled = assembleStageContext(definition, run);
		expect(assembled.layers.some((layer) => layer.layer === 0)).toBe(true);
		expect(assembled.layers.some((layer) => layer.layer === 2)).toBe(true);
		expect(assembled.layers.some((layer) => layer.layer === 3 && layer.text.includes("Be brief"))).toBe(true);
		const text = formatPipelineContext(definition, run, assembled);
		expect(text.startsWith(`<pipeline_context revision=${run.revision}>`)).toBe(true);
		expect(text).toContain("ONE JOB: collect the source facts.");
		expect(text.endsWith("</pipeline_context>")).toBe(true);
	});

	it("lists and starts a run through the pipeline tool without naming a design skill", async () => {
		const cwd = tempDir();
		writeDefinition(join(cwd, ".pi", "pipelines", "research"));
		let stored: ReturnType<typeof instantiatePipelineRun> | undefined;
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "none"),
			getPipelineRun: () => stored,
			savePipelineRun: (run) => {
				stored = run;
			},
			createRunId: () => "run-tool",
			now: () => "T0",
		});
		const empty = await tool.execute("c1", { action: "list" }, undefined, undefined, ctx);
		const emptyText = empty.content[0] && empty.content[0].type === "text" ? empty.content[0].text : "";
		expect(emptyText).toContain("research");
		expect(emptyText).not.toContain("icm-architect");
		const started = await tool.execute("c2", { action: "start", name: "research" }, undefined, undefined, ctx);
		expect(started.details).toMatchObject({ action: "start", applied: true });
		expect(stored?.currentStageId).toBe("01_research");
		const startText = started.content[0] && started.content[0].type === "text" ? started.content[0].text : "";
		expect(startText).not.toContain("icm-architect");
	});
});
