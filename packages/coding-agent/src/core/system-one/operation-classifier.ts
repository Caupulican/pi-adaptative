/**
 * System One judges every operation that can have an effect beyond the task.
 *
 * A pattern list cannot decide what a shell command, a script or a program does: there are more
 * languages and more ways to say the same thing than any list covers, and a model blocked on one
 * spelling reaches for another (measured live: a blocked `curl` POST came back as Python `urllib`).
 * So the only deterministic decisions here are by tool contract and exact path: a tool that cannot
 * have effects (reading, searching, planning) and a typed write inside the task directory are
 * ordinary work, and the edge keeps its literal extreme-destruction rules. Every shell or code call,
 * and every write outside the task, goes to System One, which answers what the operation does (leaves
 * the machine, cannot be undone, touches files outside the task, acquires external code) and whether the
 * owner's request asks for it; the authority line turns the answers into an action.
 */

import nodePath from "node:path";
import { commandFromToolArgs } from "../acquisition/acquisition-boundary.ts";
import { classifyAllEdgeOperations } from "../autonomy/edge-policy.ts";
import { decideByAuthority, type JudgmentReading } from "./authority-line.ts";

/** Why System One is asked: the operation runs code, or writes outside the task. */
export type JudgedOperationKind = "shell" | "code" | "write_outside_task";

export type OperationTriage =
	| { readonly kind: "decided" }
	| {
			readonly kind: "judged";
			readonly operationKind: JudgedOperationKind;
			/** The operation as the operator reads it: the command, the code, or the written path. */
			readonly operation: string;
	  };

/** Tools that run arbitrary commands or code: what they do is only known by reading them. */
const OPERATION_TOOLS: Readonly<Record<string, JudgedOperationKind>> = {
	bash: "shell",
	run_process: "shell",
	powershell: "shell",
	python: "code",
};
const WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * Which calls System One must judge. `decided` covers what the edge already owns, tools that cannot
 * have effects, and writes inside the task (or the temp directory); everything else is judged.
 */
export function triageOperation(input: {
	toolName: string;
	args: unknown;
	cwd: string;
	scopeCwd: string;
	tempDir: string;
}): OperationTriage {
	const edge = classifyAllEdgeOperations({
		toolName: input.toolName,
		args: input.args,
		cwd: input.cwd,
		scopeCwd: input.scopeCwd,
	});
	if (edge.length > 0) return { kind: "decided" };
	const operationKind = OPERATION_TOOLS[input.toolName];
	if (operationKind) {
		const operation = commandFromToolArgs(input.args);
		return operation ? { kind: "judged", operationKind, operation } : { kind: "decided" };
	}
	if (WRITE_TOOLS.has(input.toolName)) {
		const path = (input.args as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string" || !path.trim()) return { kind: "decided" };
		const resolved = nodePath.resolve(input.cwd, path);
		const inside = (root: string) => {
			const relative = nodePath.relative(nodePath.resolve(root), resolved);
			return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
		};
		if (inside(input.scopeCwd) || inside(input.tempDir)) return { kind: "decided" };
		return { kind: "judged", operationKind: "write_outside_task", operation: `${input.toolName} ${resolved}` };
	}
	return { kind: "decided" };
}

/** The questions, one condition each, high meaning yes (TypeSafe's Noul rules). */
export const OPERATION_EFFECT_PROGRAM = {
	schema_version: "2.0",
	program_id: "JEV-OPERATION-EFFECT",
	description:
		"What one operation the deterministic gates cannot decide does, and whether the owner's request asks for it.",
	decisions: [
		{
			id: "leaves_machine",
			instruction:
				"Does `operation.command` send data, files or a request that changes something to a computer other than this one?",
		},
		{
			id: "cannot_be_undone",
			instruction:
				"Would the effect of `operation.command` be impossible to undo from the files and git history left on this machine?",
		},
		{
			id: "touches_outside_task",
			instruction: "Does `operation.command` create, change or delete files outside `operation.task_directory`?",
		},
		{
			id: "acquires_external_code",
			instruction:
				"Does `operation.command` download or install code, packages or programs from outside this machine?",
		},
		{
			id: "request_authorizes",
			instruction: "Does `request` ask for, or directly require, the effect of `operation.command`?",
		},
	],
} as const;

/** The session's batched-question engine, as the retention planner and the acquisition gate use it. */
export interface OperationEffectEngine {
	evaluate(
		program: {
			readonly schema_version: "2.0";
			readonly program_id: string;
			readonly description: string;
			readonly decisions: readonly unknown[];
		},
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{ answers?: Record<string, unknown> }>;
}

export interface OperationVerdict {
	/**
	 * `proceed`: runs. `confirm`: the operator decides (a worker is refused). `refuse`: System One
	 * found an irreversible or outward effect the owner's request does not ask for. An operator grant
	 * of `operation.irreversible` is standing authority over both of the latter.
	 */
	readonly action: "proceed" | "confirm" | "refuse";
	/** What System One found, or why it could not answer, for the operator. */
	readonly finding: string;
	/** True when something unsettled or consequential should be visible to the operator. */
	readonly notable: boolean;
}

const EFFECT_WORDS: Readonly<Record<string, string>> = {
	leaves_machine: "leaves the machine",
	cannot_be_undone: "cannot be undone",
	touches_outside_task: "touches files outside the task",
	acquires_external_code: "acquires external code",
};

/** The authority line's irreversible row, as an operation verdict. */
function irreversibleAction(reading: JudgmentReading, actor: "root" | "worker"): OperationVerdict["action"] {
	const decision = decideByAuthority("irreversible", reading, 0, actor);
	if (decision.action === "proceed") return "proceed";
	return decision.action === "ask_operator" ? "confirm" : "refuse";
}

/**
 * How the answers read. Every shell call reaches this gate, so the reading scales with what an
 * interruption costs (TypeSafe: thresholds follow the cost of the action): an effect is established
 * at the noul hard-fail band, unsettled above an even chance, absent below it. Probed live: `npm test`,
 * `git status`, a build script and a `sed` edit stay at or below 0.22 on every effect; `pip install`
 * reads 0.99 acquires external code; a Python POST reads 0.93 leaves the machine.
 */
const EFFECT_ESTABLISHED = 0.8;
const EFFECT_UNSETTLED_ABOVE = 0.5;
/** The owner's request: asks for it at 0.8 or above, clearly does not at 0.2 or below. */
const REQUEST_ASKS = 0.8;
const REQUEST_DOES_NOT_ASK = 0.2;

function probability(answer: unknown): number | undefined {
	const noul = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}

/**
 * One batched System One request, read through the authority line: an operation with no likely effect
 * runs silently; one with an established effect runs when the owner's request asks for it, is refused
 * when the request clearly does not, and goes to the operator otherwise; an unsettled effect goes to
 * the operator unless the request asks for it; an unanswered request goes to the operator (a worker
 * is refused).
 */
export async function judgeOperation(
	engine: OperationEffectEngine,
	input: {
		readonly triage: Extract<OperationTriage, { kind: "judged" }>;
		readonly toolName: string;
		readonly scopeCwd: string;
		readonly request: string;
		readonly actor: "root" | "worker";
		readonly signal?: AbortSignal;
		/** Bound on the System One call; running out counts as System One unavailable. */
		readonly timeoutMs?: number;
	},
): Promise<OperationVerdict> {
	const bounded = [input.signal, input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	let answers: Record<string, unknown>;
	try {
		answers =
			(
				await engine.evaluate(
					OPERATION_EFFECT_PROGRAM,
					{
						operation: {
							tool: input.toolName,
							command: input.triage.operation,
							task_directory: input.scopeCwd,
							kind: input.triage.operationKind,
						},
						request: input.request || "(no request recorded)",
					},
					{ consequence: "high", signal: bounded.length > 0 ? AbortSignal.any(bounded) : undefined },
				)
			).answers ?? {};
	} catch (error) {
		input.signal?.throwIfAborted();
		return {
			action: irreversibleAction("unavailable", input.actor),
			finding: `System One could not judge it (${error instanceof Error ? error.message : String(error)})`,
			notable: true,
		};
	}
	const effectIds = Object.keys(EFFECT_WORDS);
	const read = (id: string) => probability(answers[id]);
	const established = effectIds.filter((id) => (read(id) ?? 0) >= EFFECT_ESTABLISHED);
	const unsettled = effectIds.filter((id) => {
		const value = read(id);
		return value === undefined || (value > EFFECT_UNSETTLED_ABOVE && value < EFFECT_ESTABLISHED);
	});
	if (established.length === 0 && unsettled.length === 0) {
		return { action: "proceed", finding: "System One found no effect beyond the task", notable: false };
	}
	const described =
		established.length > 0
			? established.map((id) => EFFECT_WORDS[id]).join(", ")
			: `possibly ${unsettled.map((id) => EFFECT_WORDS[id]).join(", possibly ")}`;
	const asked = read("request_authorizes");
	if (asked !== undefined && asked >= REQUEST_ASKS) {
		return { action: "proceed", finding: `${described}; the owner's request asks for it`, notable: true };
	}
	const clearlyNot = asked !== undefined && asked <= REQUEST_DOES_NOT_ASK;
	const reading: JudgmentReading = established.length > 0 && clearlyNot ? "fail" : "ambiguous";
	return {
		action: irreversibleAction(reading, input.actor),
		finding: `${described}; ${clearlyNot ? "the owner's request does not ask for it" : "the owner's request does not settle it"}`,
		notable: true,
	};
}
