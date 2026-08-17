import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { advanceTaskSteps } from "../src/core/pipelines/increment.ts";
import {
	assembleStageContext,
	discoverPipelineDefinitions,
	findActivePipelineRun,
	formatPipelineContext,
	incrementPipelineRun,
	instantiatePipelineRun,
	isPipelineRun,
	loadPipelineDefinition,
	loadPipelineRunById,
	PipelineIncrementError,
	parseStageContract,
	persistPipelineRun,
	type PipelineRun,
	resolveCurrentProjectPipelineRun,
	resolvePipelineDefinitionForRun,
	scanStageOutput,
	stageOutputDir,
} from "../src/core/pipelines/index.ts";
import { createTaskStepsState } from "../src/core/tasks/task-state.ts";
import { createPipelineToolDefinition } from "../src/core/tools/pipeline.ts";
import { runSignaledWorkerThreads } from "./worker-thread-fixture.ts";

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
		for (const dir of dirs.splice(0).reverse()) rmSync(dir, { recursive: true, force: true });
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-pipeline-"));
		dirs.push(dir);
		return dir;
	}

	function writePipelineStartWorker(dir: string): string {
		const pipelineToolModule = new URL("../src/core/tools/pipeline.ts", import.meta.url).href;
		const workerPath = join(dir, "pipeline-start-worker.mjs");
		writeFileSync(
			workerPath,
			`import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { createPipelineToolDefinition } from ${JSON.stringify(pipelineToolModule)};

const barrier = new Int32Array(workerData.barrier);
const ready = Atomics.add(barrier, 1, 1) + 1;
if (ready < 2) Atomics.wait(barrier, 1, ready, 5_000);
else Atomics.notify(barrier, 1);

const tool = createPipelineToolDefinition({
	cwd: () => workerData.cwd,
	agentPipelinesDir: () => join(workerData.cwd, "agent-pipelines"),
	getPipelineRun: () => undefined,
	savePipelineRun: () => undefined,
	createRunId: () => {
		const admitted = Atomics.add(barrier, 0, 1) + 1;
		if (admitted < 2) Atomics.wait(barrier, 0, admitted, 1_000);
		else Atomics.notify(barrier, 0);
		return workerData.runId;
	},
	now: () => workerData.runId,
});
const result = await tool.execute("start", { action: "start", name: "research" }, undefined, undefined, undefined);
writeFileSync(workerData.resultPath, JSON.stringify({
	applied: result.details?.applied === true,
	runId: result.details?.run?.runId,
}));
parentPort.postMessage({ done: true });
`,
			"utf-8",
		);
		return workerPath;
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

	it("bounds the number of pipeline definitions materialized from one registry", () => {
		const cwd = tempDir();
		for (let index = 0; index < 70; index++) {
			const root = join(cwd, ".pi", "pipelines", `pipeline-${String(index).padStart(2, "0")}`);
			mkdirSync(join(root, "01_stage"), { recursive: true });
			writeFileSync(join(root, "AGENTS.md"), "# bounded pipeline\n");
			writeFileSync(join(root, "01_stage", "CONTEXT.md"), "# stage\n\nOne job: stay bounded.\n");
		}

		const found = discoverPipelineDefinitions({ agentPipelinesDir: join(cwd, "agent-pipelines"), cwd });
		expect(found).toHaveLength(64);
	});

	it("isolates a malformed definition instead of hiding valid pipeline siblings", () => {
		const cwd = tempDir();
		const pipelinesRoot = join(cwd, ".pi", "pipelines");
		writeDefinition(join(pipelinesRoot, "research"));
		const malformedRoot = join(pipelinesRoot, "malformed");
		writeDefinition(malformedRoot);
		writeFileSync(
			join(malformedRoot, "CONTEXT.md"),
			`---\nname: ${"x".repeat(65)}\nform: pipeline\n---\n# malformed\n`,
		);

		const found = discoverPipelineDefinitions({ agentPipelinesDir: join(cwd, "agent-pipelines"), cwd });
		expect(found.map((definition) => definition.name)).toEqual(["research"]);
	});

	it("rejects a persisted run revision outside the safe integer range", () => {
		expect(
			isPipelineRun({
				version: 1,
				revision: Number.MAX_SAFE_INTEGER + 1,
				runId: "run-unsafe-revision",
				pipelineName: "research",
				definitionPath: "/definition",
				runRoot: "/runs/run-unsafe-revision",
				currentStageId: "01_research",
				status: "active",
				createdAt: "T0",
				updatedAt: "T0",
			}),
		).toBe(false);
	});

	it("does not replace a valid manifest when the next revision exceeds the safe integer range", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const run = instantiatePipelineRun({
			definition,
			runId: "run-revision-bound",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-revision-bound"),
			now: "T0",
		});

		expect(() => persistPipelineRun({ ...run, revision: Number.MAX_SAFE_INTEGER }, "T1")).toThrow(/not persisted/);
		expect(loadPipelineRunById(cwd, run.runId)?.revision).toBe(1);
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

	it("refuses increment while exactly linked open task_steps or running tool_tasks remain", () => {
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
		expect(() =>
			incrementPipelineRun(definition, run, "T2", {
				openTaskSteps: [
					{
						id: "step-1",
						content: "Finish research",
						pipelineRunId: run.runId,
						pipelineStageId: "01_research",
					},
				],
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

	it.skipIf(process.platform === "win32")(
		"does not load pipeline contract or input symlinks outside the definition root",
		() => {
			const cwd = tempDir();
			const definitionRoot = join(cwd, ".pi", "pipelines", "research");
			writeDefinition(definitionRoot);
			const externalSecret = join(cwd, "external-secret.md");
			writeFileSync(externalSecret, "EXTERNAL SECRET\n");
			rmSync(join(definitionRoot, "_shared", "rules.md"));
			symlinkSync(externalSecret, join(definitionRoot, "_shared", "rules.md"));

			const definition = loadPipelineDefinition(definitionRoot);
			if (!definition) throw new Error("missing definition");
			const run = instantiatePipelineRun({
				definition,
				runId: "run-symlink-context",
				runRoot: join(cwd, ".pi", "pipeline-runs", "run-symlink-context"),
				now: "T0",
			});
			const assembled = assembleStageContext(definition, run);
			expect(assembled.text).not.toContain("EXTERNAL SECRET");
			expect(assembled.layers.some((layer) => layer.layer === 3)).toBe(false);

			const externalContract = join(cwd, "external-contract.md");
			writeFileSync(externalContract, STAGE_ONE);
			rmSync(join(definitionRoot, "stages", "01_research", "CONTEXT.md"));
			symlinkSync(externalContract, join(definitionRoot, "stages", "01_research", "CONTEXT.md"));
			const reloaded = loadPipelineDefinition(definitionRoot);
			expect(reloaded?.stages.map((stage) => stage.id)).toEqual(["02_draft"]);
		},
	);

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
		expect(tool.executionMode).toBe("sequential");
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

	it("reports durable success when the secondary session snapshot cannot be saved", async () => {
		const cwd = tempDir();
		writeDefinition(join(cwd, ".pi", "pipelines", "research"));
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "agent-pipelines"),
			getPipelineRun: () => undefined,
			savePipelineRun: () => {
				throw new Error("session append unavailable");
			},
			createRunId: () => "run-durable-without-snapshot",
			now: () => "T0",
		});

		const result = await tool.execute(
			"c-durable-start",
			{ action: "start", name: "research" },
			undefined,
			undefined,
			ctx,
		);
		expect(result).toMatchObject({
			details: {
				applied: true,
				run: { runId: "run-durable-without-snapshot" },
				warning: expect.stringContaining("session append unavailable"),
			},
		});
		expect(loadPipelineRunById(cwd, "run-durable-without-snapshot")?.status).toBe("active");
	});

	it("rejects traversal selectors and restored run roots outside the project run directory", async () => {
		const cwd = tempDir();
		writeDefinition(join(cwd, ".pi", "pipelines", "research"));
		const escapedRoot = join(cwd, "escaped");
		mkdirSync(escapedRoot);
		const escapedRun: PipelineRun = {
			version: 1,
			revision: 1,
			runId: "escaped",
			pipelineName: "research",
			definitionPath: join(cwd, "outside-definition"),
			runRoot: escapedRoot,
			currentStageId: "01_research",
			status: "active",
			createdAt: "T0",
			updatedAt: "T0",
		};
		writeFileSync(join(escapedRoot, "run.json"), JSON.stringify(escapedRun));
		expect(loadPipelineRunById(cwd, "../../escaped")).toBeUndefined();

		let saved: PipelineRun | undefined;
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "agent-pipelines"),
			getPipelineRun: () => escapedRun,
			savePipelineRun: (run) => {
				saved = run;
			},
			createRunId: () => "run-replacement",
		});
		const result = await tool.execute("c-unowned", { action: "abandon" }, undefined, undefined, ctx);
		expect(result).toMatchObject({ isError: true, details: { applied: false } });
		expect(saved).toBeUndefined();

		const started = await tool.execute(
			"c-replace-unowned",
			{ action: "start", name: "research" },
			undefined,
			undefined,
			ctx,
		);
		expect(started).toMatchObject({ details: { applied: true, run: { runId: "run-replacement" } } });
		expect(saved?.runId).toBe("run-replacement");
	});

	it("resolves restored definitions only from configured discovery roots", () => {
		const cwd = tempDir();
		const externalDefinition = join(cwd, "external-definition");
		writeDefinition(externalDefinition);
		const resolved = resolvePipelineDefinitionForRun(
			{ agentPipelinesDir: join(cwd, "agent-pipelines"), cwd },
			{ definitionPath: externalDefinition, pipelineName: "research" },
		);
		expect(resolved).toBeUndefined();
	});

	it("allows an owned active run to be abandoned after its definition is removed", async () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		let stored = instantiatePipelineRun({
			definition,
			runId: "run-missing-definition",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-missing-definition"),
			now: "T0",
		});
		rmSync(definitionRoot, { recursive: true, force: true });
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "agent-pipelines"),
			getPipelineRun: () => stored,
			savePipelineRun: (run) => {
				stored = run;
			},
			now: () => "T1",
		});

		const result = await tool.execute("c-abandon-missing", { action: "abandon" }, undefined, undefined, ctx);
		expect(result).toMatchObject({ details: { action: "abandon", applied: true } });
		expect(stored.status).toBe("abandoned");
	});

	it("uses the durable run manifest instead of an older session snapshot", async () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const staleSnapshot = instantiatePipelineRun({
			definition,
			runId: "run-durable-authority",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-durable-authority"),
			now: "T0",
		});
		const durable = persistPipelineRun({ ...staleSnapshot, currentStageId: "02_draft" }, "T1");
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "agent-pipelines"),
			getPipelineRun: () => staleSnapshot,
			savePipelineRun: () => undefined,
		});

		const result = await tool.execute("c-durable-status", { action: "status" }, undefined, undefined, ctx);
		expect(result).toMatchObject({
			details: {
				run: { revision: durable.revision, currentStageId: "02_draft" },
			},
		});
	});

	it("does not let a terminal session snapshot hide another active durable run", async () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const terminalSnapshot = persistPipelineRun(
			{
				...instantiatePipelineRun({
					definition,
					runId: "run-terminal-snapshot",
					runRoot: join(cwd, ".pi", "pipeline-runs", "run-terminal-snapshot"),
					now: "T0",
				}),
				status: "completed",
			},
			"T1",
		);
		instantiatePipelineRun({
			definition,
			runId: "run-still-active",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-still-active"),
			now: "T2",
		});
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "agent-pipelines"),
			getPipelineRun: () => terminalSnapshot,
			savePipelineRun: () => undefined,
			createRunId: () => "run-duplicate",
		});

		const result = await tool.execute(
			"c-active-durable",
			{ action: "start", name: "research" },
			undefined,
			undefined,
			ctx,
		);
		expect(result).toMatchObject({
			isError: true,
			details: { applied: false, run: { runId: "run-still-active", status: "active" } },
		});
	});

	it("resolves an active durable run when the current session has no snapshot", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const active = instantiatePipelineRun({
			definition,
			runId: "run-from-another-session",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-from-another-session"),
			now: "T0",
		});

		expect(resolveCurrentProjectPipelineRun(cwd)).toEqual(active);
	});

	it("does not project the first stage when a durable run names a missing stage", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const run = instantiatePipelineRun({
			definition,
			runId: "run-invalid-stage",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-invalid-stage"),
			now: "T0",
		});

		expect(() => assembleStageContext(definition, { ...run, currentStageId: "99_missing" })).toThrow(
			/missing from definition/,
		);
	});

	it("fails closed when the bounded run scan cannot inspect the complete managed store", async () => {
		const cwd = tempDir();
		writeDefinition(join(cwd, ".pi", "pipelines", "research"));
		const runsRoot = join(cwd, ".pi", "pipeline-runs");
		for (let index = 0; index < 1_025; index++) {
			mkdirSync(join(runsRoot, `.history-${String(index).padStart(4, "0")}`), { recursive: true });
		}
		let allocatedRunId = false;
		const tool = createPipelineToolDefinition({
			cwd: () => cwd,
			agentPipelinesDir: () => join(cwd, "agent-pipelines"),
			getPipelineRun: () => undefined,
			savePipelineRun: () => undefined,
			createRunId: () => {
				allocatedRunId = true;
				return "run-must-not-start";
			},
		});

		const result = await tool.execute(
			"c-bounded-store",
			{ action: "start", name: "research" },
			undefined,
			undefined,
			ctx,
		);
		expect(result).toMatchObject({
			isError: true,
			details: { applied: false, error: expect.stringContaining("entry limit") },
		});
		expect(allocatedRunId).toBe(false);
		expect(readdirSync(runsRoot)).not.toContain("run-must-not-start");
	});

	it("rejects malformed managed entries and duplicate active manifests", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const runsRoot = join(cwd, ".pi", "pipeline-runs");
		mkdirSync(join(runsRoot, ".control"), { recursive: true });
		const first = instantiatePipelineRun({
			definition,
			runId: "run-active-one",
			runRoot: join(runsRoot, "run-active-one"),
			now: "T0",
		});
		expect(findActivePipelineRun(cwd)).toEqual(first);

		mkdirSync(join(runsRoot, "broken-run"));
		expect(() => findActivePipelineRun(cwd)).toThrow(/invalid managed entry: broken-run/);
		rmSync(join(runsRoot, "broken-run"), { recursive: true });
		instantiatePipelineRun({
			definition,
			runId: "run-active-two",
			runRoot: join(runsRoot, "run-active-two"),
			now: "T1",
		});
		expect(() => findActivePipelineRun(cwd)).toThrow(/multiple active runs/);
	});

	it("admits only one active start across concurrent OS workers", async () => {
		const cwd = tempDir();
		writeDefinition(join(cwd, ".pi", "pipelines", "research"));
		const workerPath = writePipelineStartWorker(cwd);
		const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
		const resultPaths = [join(cwd, "worker-1.json"), join(cwd, "worker-2.json")];

		await runSignaledWorkerThreads(
			workerPath,
			resultPaths.map((resultPath, index) => ({
				barrier,
				cwd,
				resultPath,
				runId: `run-worker-${index + 1}`,
			})),
		);

		const results = resultPaths.map(
			(path) => JSON.parse(readFileSync(path, "utf-8")) as { applied: boolean; runId?: string },
		);
		expect(results.filter((result) => result.applied)).toHaveLength(1);
		const active = findActivePipelineRun(cwd);
		if (!active) throw new Error("missing active run");
		expect(active.runId).toBe(results.find((result) => result.applied)?.runId);
		expect(readdirSync(join(cwd, ".pi", "pipeline-runs")).filter((name) => !name.startsWith("."))).toEqual([
			active.runId,
		]);
	}, 15_000);

	it("does not follow project pipeline registry links outside the working directory", () => {
		const cwd = tempDir();
		const external = tempDir();
		const externalDefinitions = join(external, "pipelines");
		writeDefinition(join(externalDefinitions, "research"));
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(externalDefinitions, join(cwd, ".pi", "pipelines"), directoryLinkType);
		expect(discoverPipelineDefinitions({ agentPipelinesDir: join(cwd, "agent-pipelines"), cwd })).toEqual([]);

		const externalRuns = join(external, "runs");
		const externalRunRoot = join(externalRuns, "run-escape");
		mkdirSync(externalRunRoot, { recursive: true });
		const projectedRunRoot = join(cwd, ".pi", "pipeline-runs", "run-escape");
		const escapedRun: PipelineRun = {
			version: 1,
			revision: 1,
			runId: "run-escape",
			pipelineName: "research",
			definitionPath: join(externalDefinitions, "research"),
			runRoot: projectedRunRoot,
			currentStageId: "01_research",
			status: "active",
			createdAt: "T0",
			updatedAt: "T0",
		};
		writeFileSync(join(externalRunRoot, "run.json"), JSON.stringify(escapedRun));
		symlinkSync(externalRuns, join(cwd, ".pi", "pipeline-runs"), directoryLinkType);
		expect(loadPipelineRunById(cwd, "run-escape")).toBeUndefined();

		const parentLinkedCwd = tempDir();
		const externalPi = join(external, "external-pi");
		writeDefinition(join(externalPi, "pipelines", "research"));
		symlinkSync(externalPi, join(parentLinkedCwd, ".pi"), directoryLinkType);
		expect(
			discoverPipelineDefinitions({
				agentPipelinesDir: join(parentLinkedCwd, "agent-pipelines"),
				cwd: parentLinkedCwd,
			}),
		).toEqual([]);
		expect(loadPipelineRunById(parentLinkedCwd, "run-escape")).toBeUndefined();
	});

	it("does not block stage increment when open task steps reference a different stage", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const run = instantiatePipelineRun({
			definition,
			runId: "run-stage-scope",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-stage-scope"),
			goalId: "g1",
			now: "T0",
		});
		writeFileSync(join(stageOutputDir(run.runRoot, definition.stages[0]!), "research.md"), "facts\n");
		// Task step with explicit pipelineStageId: "02_draft" (future stage), should not block 01_research increment
		const advanced = incrementPipelineRun(definition, run, "T2", {
			openTaskSteps: [
				{ id: "step-draft", content: "Write chapter", pipelineRunId: run.runId, pipelineStageId: "02_draft" },
			],
		});
		expect(advanced.result.from).toBe("01_research");
		expect(advanced.result.to).toBe("02_draft");

		// Task step with pipelineStageId: "02_draft" blocks advancing 02_draft
		expect(() =>
			incrementPipelineRun(definition, advanced.run, "T3", {
				openTaskSteps: [
					{ id: "step-draft", content: "Write chapter", pipelineRunId: run.runId, pipelineStageId: "02_draft" },
				],
			}),
		).toThrow(PipelineIncrementError);
	});

	it("ignores unlinked goal work and links belonging to a different pipeline run", () => {
		const cwd = tempDir();
		const definitionRoot = join(cwd, ".pi", "pipelines", "research");
		writeDefinition(definitionRoot);
		const definition = loadPipelineDefinition(definitionRoot);
		if (!definition) throw new Error("missing definition");
		const run = instantiatePipelineRun({
			definition,
			runId: "run-exact-link",
			runRoot: join(cwd, ".pi", "pipeline-runs", "run-exact-link"),
			goalId: "g1",
			now: "T0",
		});
		writeFileSync(join(stageOutputDir(run.runRoot, definition.stages[0]!), "research.md"), "facts\n");

		const advanced = incrementPipelineRun(definition, run, "T1", {
			openTaskSteps: [
				{ id: "step-goal", content: "Finish goal requirement", requirementIds: ["r1"] },
				{
					id: "step-other-run",
					content: "Finish another run's research",
					pipelineRunId: "run-other",
					pipelineStageId: "01_research",
				},
			],
		});
		expect(advanced.result).toMatchObject({ from: "01_research", to: "02_draft" });
	});

	it("returns completed: false when advancing task steps with only blocked steps remaining", () => {
		const state = {
			...createTaskStepsState("T0"),
			steps: [
				{
					id: "step-1",
					status: "completed" as const,
					content: "Step 1",
					notes: [],
					evidence: [],
					createdAt: "T0",
					updatedAt: "T0",
				},
				{
					id: "step-2",
					status: "blocked" as const,
					content: "Step 2 blocked",
					notes: [],
					evidence: [],
					createdAt: "T0",
					updatedAt: "T0",
				},
			],
		};
		const advanced = advanceTaskSteps(state, "T0");
		expect(advanced.result.completed).toBe(false);
		expect(advanced.result.detail).toContain("all remaining steps are blocked");
	});

	it.skipIf(process.platform === "win32")("rejects file symlinks pointing outside the stage output root", () => {
		const cwd = tempDir();
		const stageOutput = join(cwd, "output");
		mkdirSync(stageOutput, { recursive: true });
		const secretDir = join(cwd, "secret");
		mkdirSync(secretDir, { recursive: true });
		writeFileSync(join(secretDir, "secret.txt"), "secret data");

		// Suffix collision directory: /path/output-evil next to /path/output
		const evilDir = join(cwd, "output-evil");
		mkdirSync(evilDir, { recursive: true });
		writeFileSync(join(evilDir, "evil.txt"), "evil data");

		symlinkSync(join(secretDir, "secret.txt"), join(stageOutput, "leak.txt"));
		symlinkSync(join(evilDir, "evil.txt"), join(stageOutput, "leak-evil.txt"));

		const scanned = scanStageOutput(stageOutput);
		expect(scanned).toEqual({ status: "empty", outputFiles: [] });
	});

	it("rejects directory links that escape the stage root, including sibling-prefix targets", () => {
		const cwd = tempDir();
		const stageOutput = join(cwd, "output");
		const external = join(cwd, "external");
		const siblingPrefix = join(cwd, "output-evil");
		mkdirSync(stageOutput);
		mkdirSync(external);
		mkdirSync(siblingPrefix);
		writeFileSync(join(external, "external.txt"), "external data");
		writeFileSync(join(siblingPrefix, "evil.txt"), "evil data");
		const directoryLinkType = process.platform === "win32" ? "junction" : "dir";
		symlinkSync(external, join(stageOutput, "external-link"), directoryLinkType);
		symlinkSync(siblingPrefix, join(stageOutput, "sibling-link"), directoryLinkType);

		expect(scanStageOutput(stageOutput)).toEqual({ status: "empty", outputFiles: [] });
	});

	it("rejects a stage output root that is itself a directory link", () => {
		const cwd = tempDir();
		const external = join(cwd, "external-output");
		mkdirSync(external, { recursive: true });
		writeFileSync(join(external, "external.txt"), "external data");
		const linkedOutput = join(cwd, "output");
		symlinkSync(external, linkedOutput, process.platform === "win32" ? "junction" : "dir");

		expect(scanStageOutput(linkedOutput)).toEqual({ status: "empty", outputFiles: [] });
	});

	it("bounds stage output traversal by depth and visited entry count", () => {
		const cwd = tempDir();
		const depthOutput = join(cwd, "depth-output");
		mkdirSync(depthOutput, { recursive: true });
		let nested = depthOutput;
		for (let depth = 1; depth <= 17; depth++) {
			nested = join(nested, `d${String(depth).padStart(2, "0")}`);
			mkdirSync(nested);
			if (depth === 16) writeFileSync(join(nested, "within-bound.txt"), "within");
			if (depth === 17) writeFileSync(join(nested, "past-bound.txt"), "past");
		}
		const depthScan = scanStageOutput(depthOutput);
		expect(depthScan.outputFiles).toContain(
			`${Array.from({ length: 16 }, (_, index) => `d${String(index + 1).padStart(2, "0")}`).join("/")}/within-bound.txt`,
		);
		expect(depthScan.outputFiles.some((file) => file.endsWith("/past-bound.txt"))).toBe(false);

		const countOutput = join(cwd, "count-output");
		mkdirSync(countOutput);
		for (let index = 0; index < 1_005; index++) {
			writeFileSync(join(countOutput, `file-${String(index).padStart(4, "0")}.txt`), "x");
		}
		expect(scanStageOutput(countOutput).outputFiles).toHaveLength(1_000);
	});
});
