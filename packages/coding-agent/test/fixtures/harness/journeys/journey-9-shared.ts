import "../builtin-install.ts";
import { EventEmitter } from "node:events";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import type { Outcome } from "../../../../src/core/delegation/worker-outcome.ts";
import { isOutcomeFromNewerBuild } from "../../../../src/core/delegation/worker-outcome-contract.ts";
import {
	ORCHESTRATION_SCHEMA_VERSION,
	type OrchestrationProfile,
} from "../../../../src/core/orchestration/contracts.ts";
import { OrchestrationProfileStore } from "../../../../src/core/orchestration/profile-store.ts";
import type { Settings } from "../../../../src/core/settings/settings-schema.ts";
import { builtinBoundary } from "../builtin-boundary.ts";
import type { ScriptedRequest, ScriptStep } from "../scripted-provider.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld } from "../session-fixture.ts";
import { INTAKE_JUDGMENTS_WITHOUT_GRANT } from "./shared.ts";

/**
 * Journey 9 reads one decision table: `decideNextAction` over the facts of a terminal worker attempt. Its settings and its
 * scripted steps live here so each leg file reads as the assertions it makes.
 */

/**
 * The exits this journey pins are decided before the rerun rungs of the table, except the fall-through: no rerun rung is
 * ever placed, so a leg's attempt is never restarted and the exit an attempt earns is the last word on it.
 */
export const J9_SETTINGS: Partial<Settings> = {
	workerDelegation: { outcomes: { escalation: { maxRungs: 0 } } },
};

/**
 * The judgments one root turn of this journey asks: the owner request's intake questions. A start that names a read-only
 * profile grants nothing a screen would have to pass, so neither the capability question nor the tool screen is asked.
 */
export const J9_ROOT_JUDGMENTS = INTAKE_JUDGMENTS_WITHOUT_GRANT;

/** The plain answer a root turn gives when it has nothing to claim: no answer-claim judgment is asked for it. */
export const J9_ROOT_REPLY = "Noted.";

/** One read-only worker profile pinned to one scripted model, with the budget the leg needs. */
export function j9Profile(profileId: string, modelId: string, budgetTokens = 400_000): OrchestrationProfile {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		profileId,
		description: `Read-only worker for the escalation ladder journey (${profileId}).`,
		role: "explorer",
		modelPolicy: {
			mode: "fixed",
			candidates: [{ provider: "harness-script", modelId, thinkingLevel: "off" }],
		},
		capabilityCeiling: ["filesystem.read"],
		readOnly: true,
		toolNames: ["read"],
		resourceProfileNames: [],
		dispatchProfileIds: [],
		budget: { maxTokens: budgetTokens },
		maxConcurrent: 1,
		leaseTtlMs: 60_000,
		requireIndependentVerification: false,
		createdAt: "2026-10-08T00:00:00.000Z",
		updatedAt: "2026-10-08T00:00:00.000Z",
	};
}

export function saveJ9Profile(world: HarnessWorld, profile: OrchestrationProfile): void {
	new OrchestrationProfileStore({
		agentDir: world.agentDir,
		cwd: HARNESS_PROJECT_CWD,
		projectTrusted: false,
	}).save(profile, "global");
}

/** One `delegate` start call, as the root's tool batch carries it. */
export function delegateStart(
	id: string,
	fields: Record<string, unknown>,
): {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
} {
	return { type: "toolCall", id, name: "delegate", arguments: { action: "start", ...fields } };
}

/** One `submit_report` call, as a worker's single provider response carries it. */
export function workerReport(name: string, report: Record<string, unknown>): ScriptStep {
	return {
		name,
		reply: {
			content: [{ type: "toolCall", id: `${name}-call`, name: "submit_report", arguments: report }],
			stopReason: "toolUse",
		},
	};
}

/** A matcher that routes a track to the worker whose task carries this instruction marker. */
export function carriesTask(marker: string): (request: ScriptedRequest) => boolean {
	return (request) => JSON.stringify(request.context.messages).includes(marker);
}

/** The task a worker lane runs: the one whose dispatch carries this instruction marker. */
export function taskForInstructions(session: AgentSession, marker: string): string {
	const snapshot = session.backgroundLanes.getTaskRuntimeSnapshot();
	for (const [taskId, task] of Object.entries(snapshot?.tasks ?? {})) {
		const carries = task.attemptIds.some((attemptId) =>
			snapshot?.attempts[attemptId]?.dispatch.instructions.includes(marker),
		);
		if (carries) return taskId;
	}
	throw new Error(`no worker task carries the instruction marker ${marker}`);
}

/** The outcome recorded for one task, read through the session's task runtime. */
export function recordedOutcome(session: AgentSession, taskId: string): Outcome {
	const stored = session.backgroundLanes.getTaskRuntimeSnapshot()?.tasks[taskId]?.outcome;
	if (!stored || isOutcomeFromNewerBuild(stored)) throw new Error(`the task ${taskId} has no readable outcome`);
	return stored;
}

/** One block of the terminal handoff the root receives for a finished worker. */
export interface HandoffBlock {
	header: string;
	outcome: string;
	next: string;
}

/** Every terminal worker handoff the request's context carries, split into its blocks. */
export function handoffBlocks(request: ScriptedRequest): HandoffBlock[] {
	const delivered = request.context.messages
		.flatMap((message) => (message.role === "user" && typeof message.content !== "string" ? message.content : []))
		.map((block) => (block.type === "text" ? block.text : ""))
		.filter((text) => text.includes("Background worker terminal handoff"))
		.join("\n");
	const blocks: HandoffBlock[] = [];
	let current: HandoffBlock | undefined;
	for (const line of delivered.split("\n")) {
		if (line.startsWith("- ")) {
			current = { header: line.trim(), outcome: "", next: "" };
			blocks.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("  Outcome: ")) current.outcome = line.trim();
		else if (line.startsWith("  Next: ")) current.next = line.trim();
	}
	return blocks;
}

/** One worker's handoff block, once it carries its outcome line and its next step. */
export function completeHandoff(request: ScriptedRequest): HandoffBlock | undefined {
	const blocks = handoffBlocks(request);
	const block = blocks[0];
	return blocks.length === 1 && block !== undefined && block.outcome !== "" && block.next !== "" ? block : undefined;
}

/** The block of a handoff that names this blocker, once every block has carried its outcome line. */
export function blockWithBlocker(blocks: readonly HandoffBlock[], blocker: string): HandoffBlock {
	const found = blocks.find((block) => block.outcome.includes(`blocker: ${blocker};`));
	if (!found) throw new Error(`the handoff carries no block for ${blocker}: ${JSON.stringify(blocks)}`);
	return found;
}

/**
 * The words one `ask_owner` outcome puts in the owner decision queue, as `workerQuestionItem` spells them: the item's
 * prefix and the action's question on one line.
 */
export function queueWords(question: string): string {
	return `A worker is waiting for your decision: ${question}`;
}

/** A scripted host requirement check: how to put the world's spawn back, and what the host spawned meanwhile. */
export interface ScriptedRequirementCheck {
	restore(): void;
	/** The executable of every process the host started while the check was scripted, in order. */
	readonly spawned: readonly string[];
}

/**
 * Answers the one process a passing host requirement check starts. `runRequirementCheck` spawns the check's command in a
 * shell (`src/core/goals/requirement-checks.ts`); the world's process port answers git and the host tools only, so the
 * journey routes that exact command line to the world's shell, which scripts its output and raises the world's failure
 * for an unscripted run. Every other spawn keeps the world's own answer.
 *
 * On Windows the product looks for that shell where Git for Windows installs it (`getBashConfig` in
 * `src/utils/shell.ts`). The world holds no such file until one is seeded, and without it the product reports that the
 * check could not start, so the file is seeded at the path the product probes.
 */
export function scriptRequirementCheckSpawn(world: HarnessWorld, command: string): ScriptedRequirementCheck {
	if (process.platform === "win32" && process.env.ProgramFiles)
		world.io.seed(`${process.env.ProgramFiles}\\Git\\bin\\bash.exe`, "virtual Git Bash\n");
	const spawned: string[] = [];
	const restore = builtinBoundary.replace("process", "spawn", (...args) => {
		world.guard.effects.push({ kind: "process.spawn", arguments: args });
		const [file, argv, options] = args as [
			string,
			readonly string[],
			{ cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } | undefined,
		];
		spawned.push(file);
		if (argv.at(-1) !== command) return world.processes.run("spawn", args);
		expect(file, "a requirement check runs in a shell").toMatch(/(?:^|[\\/])(?:sh|bash)(?:\.exe)?$/iu);
		const child = Object.assign(new EventEmitter(), {
			pid: 0,
			exitCode: null as number | null,
			signalCode: null as NodeJS.Signals | null,
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: () => world.processTable.signal(child.pid, "SIGTERM"),
		});
		let closed = false;
		const close = (code: number, signal: NodeJS.Signals | null): void => {
			if (closed) return;
			closed = true;
			child.exitCode = code;
			child.signalCode = signal;
			world.processTable.releaseChild(child.pid);
			child.emit("exit", code, signal);
			child.emit("close", code, signal);
		};
		child.pid = world.processTable.registerChild({
			detached: false,
			deliver: (signal) => {
				child.signalCode = signal;
				close(1, signal);
			},
		});
		void world.shell
			.exec(command, options?.cwd ?? HARNESS_PROJECT_CWD, {
				onData: (chunk) => child.stdout.emit("data", Buffer.from(chunk)),
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.env ? { env: options.env } : {}),
			})
			.then((result) => close(result.exitCode ?? 1, null))
			.catch((error: unknown) => {
				child.emit("error", error);
				close(1, null);
			});
		return child;
	});
	return { restore, spawned };
}
