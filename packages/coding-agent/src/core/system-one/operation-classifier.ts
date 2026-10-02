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

import { existsSync, realpathSync, statSync } from "node:fs";
import nodePath from "node:path";
import { commandFromToolArgs } from "../acquisition/acquisition-boundary.ts";
import { computeScriptFileHash } from "../automation/task-automation-hash.ts";
import { classifyAllEdgeOperations, shellInvocations } from "../autonomy/edge-policy.ts";
import { safeRealpathSync } from "../autonomy/path-scope.ts";
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
			/** Canonical facts that can change what identical-looking arguments execute. */
			readonly identity: OperationJudgmentIdentity;
	  };

export interface OperationInvocationIdentity {
	readonly command: string;
	readonly resolved_executable?: string;
	readonly script?: { readonly path: string; readonly sha256: string };
}

export interface OperationJudgmentIdentity {
	readonly execution_directory: string;
	readonly task_directory: string;
	readonly invocations: readonly OperationInvocationIdentity[];
}

/** Tools that run arbitrary commands or code: what they do is only known by reading them. */
const OPERATION_TOOLS: Readonly<Record<string, JudgedOperationKind>> = {
	bash: "shell",
	run_process: "shell",
	powershell: "shell",
	python: "code",
};
const WRITE_TOOLS = new Set(["write", "edit"]);

const SCRIPT_INTERPRETERS = new Set([
	"bash",
	"bun",
	"deno",
	"node",
	"perl",
	"php",
	"powershell",
	"pwsh",
	"python",
	"python3",
	"ruby",
	"sh",
	"zsh",
]);

function canonicalDirectory(path: string): string {
	try {
		return safeRealpathSync(path);
	} catch {
		return nodePath.resolve(path);
	}
}

function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function resolveExecutable(command: string, cwd: string): string | undefined {
	const hasPath = nodePath.isAbsolute(command) || command.includes("/") || command.includes("\\");
	const candidates = hasPath
		? [nodePath.resolve(cwd, command)]
		: (process.env.PATH ?? "")
				.split(nodePath.delimiter)
				.filter(Boolean)
				.flatMap((directory) => {
					const base = nodePath.join(directory, command);
					return process.platform === "win32"
						? [base, ...[".exe", ".cmd", ".bat", ".com"].map((extension) => `${base}${extension}`)]
						: [base];
				});
	for (const candidate of candidates) {
		if (!existsSync(candidate) || !isRegularFile(candidate)) continue;
		try {
			return realpathSync(candidate);
		} catch {
			return nodePath.resolve(candidate);
		}
	}
	return undefined;
}

function localScript(argv: readonly string[], cwd: string, scopeCwd: string) {
	const executable = nodePath
		.basename(argv[0] ?? "")
		.replace(/\.(?:exe|cmd|bat)$/iu, "")
		.toLowerCase();
	let candidate: string | undefined;
	if (SCRIPT_INTERPRETERS.has(executable)) {
		for (let index = 1; index < argv.length; index++) {
			const argument = argv[index];
			if (["-c", "-e", "--eval", "--command"].includes(argument)) return undefined;
			if (argument === "--") {
				candidate = argv[index + 1];
				break;
			}
			if (!argument.startsWith("-")) {
				candidate = argument;
				break;
			}
		}
	} else if (argv[0] && (nodePath.isAbsolute(argv[0]) || argv[0].includes("/") || argv[0].includes("\\"))) {
		candidate = argv[0];
	}
	if (!candidate) return undefined;
	const path = canonicalDirectory(nodePath.resolve(cwd, candidate));
	const sha256 = computeScriptFileHash(path, scopeCwd);
	return sha256 ? { path, sha256 } : undefined;
}

function invocationIdentity(argv: readonly string[], cwd: string, scopeCwd: string): OperationInvocationIdentity {
	const resolvedExecutable = argv[0] ? resolveExecutable(argv[0], cwd) : undefined;
	const script = argv.length > 0 ? localScript(argv, cwd, scopeCwd) : undefined;
	return {
		command: argv.map((argument) => JSON.stringify(argument)).join(" "),
		...(resolvedExecutable ? { resolved_executable: resolvedExecutable } : {}),
		...(script ? { script } : {}),
	};
}

function processArgv(args: unknown): string[] | undefined {
	const record = args as { executable?: unknown; args?: unknown } | undefined;
	if (typeof record?.executable !== "string" || !record.executable.trim()) return undefined;
	return [
		record.executable.trim(),
		...(Array.isArray(record.args)
			? record.args.filter((argument): argument is string => typeof argument === "string")
			: []),
	];
}

function operationIdentity(toolName: string, args: unknown, operation: string, cwd: string, scopeCwd: string) {
	const executionDirectory = canonicalDirectory(cwd);
	const taskDirectory = canonicalDirectory(scopeCwd);
	let invocations: string[][] = [];
	if (toolName === "run_process") {
		const argv = processArgv(args);
		if (argv) invocations = [argv];
	} else if (toolName === "bash" || toolName === "powershell") {
		invocations = shellInvocations(operation);
	} else if (toolName === "python") {
		const record = args as { scriptPath?: unknown } | undefined;
		const argv = ["python", ...(typeof record?.scriptPath === "string" ? [record.scriptPath] : [])];
		invocations = [argv];
	}
	return {
		execution_directory: executionDirectory,
		task_directory: taskDirectory,
		invocations: invocations.map((argv) => invocationIdentity(argv, executionDirectory, taskDirectory)),
	};
}

function describedOperation(toolName: string, args: unknown): string | undefined {
	if (toolName !== "run_process") return commandFromToolArgs(args);
	const argv = processArgv(args);
	return argv?.map((argument) => JSON.stringify(argument)).join(" ");
}

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
		const operation = describedOperation(input.toolName, input.args);
		return operation
			? {
					kind: "judged",
					operationKind,
					operation,
					identity: operationIdentity(input.toolName, input.args, operation, input.cwd, input.scopeCwd),
				}
			: { kind: "decided" };
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
		return {
			kind: "judged",
			operationKind: "write_outside_task",
			operation: `${input.toolName} ${resolved}`,
			identity: operationIdentity(
				input.toolName,
				input.args,
				`${input.toolName} ${resolved}`,
				input.cwd,
				input.scopeCwd,
			),
		};
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
	/** The engine's model id; a reading is cached only when the model that produced it is known. */
	readonly model?: string;
	evaluate(
		program: {
			readonly schema_version: "2.0";
			readonly program_id: string;
			readonly description: string;
			readonly decisions: readonly unknown[];
		},
		state?: Record<string, unknown>,
		options?: { consequence?: string; signal?: AbortSignal },
	): Promise<{ answers?: Record<string, unknown>; model?: string }>;
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

/** The authority line's `operation` row, as an operation verdict. */
function operationAction(reading: JudgmentReading, actor: "root" | "worker"): OperationVerdict["action"] {
	const decision = decideByAuthority("operation", reading, 0, actor);
	if (decision.action === "proceed" || decision.action === "proceed_with_doubt") return "proceed";
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

/** The four effect questions: what the operation does, whatever the owner asked for. */
export const OPERATION_EFFECT_IDS = [
	"leaves_machine",
	"cannot_be_undone",
	"touches_outside_task",
	"acquires_external_code",
] as const;
export type OperationEffectId = (typeof OPERATION_EFFECT_IDS)[number];
export const OPERATION_REQUEST_ID = "request_authorizes";

/** P(yes) per effect; absent when the answer was missing or malformed. */
export type OperationEffectReading = Readonly<Record<OperationEffectId, number | undefined>>;

/**
 * The state every operation question sees. The four effect questions read only `operation.*`; only
 * `request_authorizes` reads `request`, which is what lets an effect reading be reused across turns.
 */
function operationState(triage: Extract<OperationTriage, { kind: "judged" }>, toolName: string, request: string) {
	return {
		operation: {
			tool: toolName,
			command: triage.operation,
			kind: triage.operationKind,
			...triage.identity,
		},
		request: request || "(no request recorded)",
	};
}

/** The answers to the named questions of the operation program, in one System One request. */
export async function askOperation(
	engine: OperationEffectEngine,
	input: {
		readonly triage: Extract<OperationTriage, { kind: "judged" }>;
		readonly toolName: string;
		readonly request: string;
		readonly questions: readonly (OperationEffectId | typeof OPERATION_REQUEST_ID)[];
		readonly signal?: AbortSignal;
		/** Told the model that answered, whenever the engine reports it. */
		readonly onModel?: (model: string) => void;
		/** Bound on the System One call; running out counts as System One unavailable. */
		readonly timeoutMs?: number;
	},
): Promise<Record<string, unknown>> {
	const bounded = [input.signal, input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const program = {
		...OPERATION_EFFECT_PROGRAM,
		decisions: OPERATION_EFFECT_PROGRAM.decisions.filter((decision) =>
			(input.questions as readonly string[]).includes(decision.id),
		),
	};
	const evaluation = await engine.evaluate(program, operationState(input.triage, input.toolName, input.request), {
		consequence: "high",
		signal: bounded.length > 0 ? AbortSignal.any(bounded) : undefined,
	});
	if (evaluation.model) input.onModel?.(evaluation.model);
	return evaluation.answers ?? {};
}

/**
 * The same questions for several operations in one request (the calls of one assistant message): each
 * operation gets its own copy of the program, its answers keyed `c<index>_<question>` and its
 * instructions pointing at `operations[<index>]`. Returned per operation under the plain question ids.
 */
export async function askOperationBatch(
	engine: OperationEffectEngine,
	input: {
		readonly entries: readonly {
			readonly triage: Extract<OperationTriage, { kind: "judged" }>;
			readonly toolName: string;
		}[];
		readonly request: string;
		readonly signal?: AbortSignal;
		readonly timeoutMs?: number;
		/** Told the model that answered, whenever the engine reports it. */
		readonly onModel?: (model: string) => void;
	},
): Promise<Record<string, unknown>[]> {
	const bounded = [input.signal, input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	const decisions = input.entries.flatMap((_entry, index) =>
		OPERATION_EFFECT_PROGRAM.decisions.map((decision) => ({
			id: `c${index}_${decision.id}`,
			instruction: decision.instruction.replaceAll("`operation.", `\`operations[${index}].`),
		})),
	);
	const state = {
		operations: input.entries.map((entry) => operationState(entry.triage, entry.toolName, input.request).operation),
		request: input.request || "(no request recorded)",
	};
	const evaluation = await engine.evaluate({ ...OPERATION_EFFECT_PROGRAM, decisions }, state, {
		consequence: "high",
		signal: bounded.length > 0 ? AbortSignal.any(bounded) : undefined,
	});
	if (evaluation.model) input.onModel?.(evaluation.model);
	const answers = evaluation.answers ?? {};
	return input.entries.map((_entry, index) =>
		Object.fromEntries([...OPERATION_EFFECT_IDS, OPERATION_REQUEST_ID].map((id) => [id, answers[`c${index}_${id}`]])),
	);
}

export function readOperationEffects(answers: Record<string, unknown>): OperationEffectReading {
	return Object.fromEntries(
		OPERATION_EFFECT_IDS.map((id) => [id, probability(answers[id])]),
	) as OperationEffectReading;
}

export function readOperationRequest(answers: Record<string, unknown>): number | undefined {
	return probability(answers[OPERATION_REQUEST_ID]);
}

/** Whether the effect reading alone settles the operation: no effect established or unsettled. */
export function operationHasNoEffect(effects: OperationEffectReading): boolean {
	return OPERATION_EFFECT_IDS.every((id) => {
		const value = effects[id];
		return value !== undefined && value <= EFFECT_UNSETTLED_ABOVE;
	});
}

/** An operation System One could not judge (error, outage, deadline): the authority line decides what that costs. */
export function unavailableOperationVerdict(error: unknown, actor: "root" | "worker"): OperationVerdict {
	return {
		action: operationAction("unavailable", actor),
		finding: `System One could not judge it (${error instanceof Error ? error.message : String(error)})`,
		notable: true,
	};
}

/** The effect reading and the owner's request, read through the authority line. */
export function verdictFromReadings(
	effects: OperationEffectReading,
	asked: number | undefined,
	actor: "root" | "worker",
): OperationVerdict {
	const established = OPERATION_EFFECT_IDS.filter((id) => (effects[id] ?? 0) >= EFFECT_ESTABLISHED);
	const unsettled = OPERATION_EFFECT_IDS.filter((id) => {
		const value = effects[id];
		return value === undefined || (value > EFFECT_UNSETTLED_ABOVE && value < EFFECT_ESTABLISHED);
	});
	if (established.length === 0 && unsettled.length === 0) {
		return { action: "proceed", finding: "System One found no effect beyond the task", notable: false };
	}
	const described =
		established.length > 0
			? established.map((id) => EFFECT_WORDS[id]).join(", ")
			: `possibly ${unsettled.map((id) => EFFECT_WORDS[id]).join(", possibly ")}`;
	if (asked !== undefined && asked >= REQUEST_ASKS) {
		return { action: "proceed", finding: `${described}; the owner's request asks for it`, notable: true };
	}
	const clearlyNot = asked !== undefined && asked <= REQUEST_DOES_NOT_ASK;
	const reading: JudgmentReading = established.length > 0 && clearlyNot ? "fail" : "ambiguous";
	return {
		action: operationAction(reading, actor),
		finding: `${described}; ${clearlyNot ? "the owner's request does not ask for it" : "the owner's request does not settle it"}`,
		notable: true,
	};
}

/**
 * One batched System One request, read through the authority line: an operation with no likely effect
 * runs silently; one with an established effect runs when the owner's request asks for it, is refused
 * when the request clearly does not, and goes to the operator otherwise; an unsettled effect goes to
 * the operator unless the request asks for it. A System One that cannot answer leaves the operation to
 * run with the doubt shown: code already decided every edge class before the call got here.
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
	let answers: Record<string, unknown>;
	try {
		answers = await askOperation(engine, {
			triage: input.triage,
			toolName: input.toolName,
			request: input.request,
			questions: [...OPERATION_EFFECT_IDS, OPERATION_REQUEST_ID],
			signal: input.signal,
			timeoutMs: input.timeoutMs,
		});
	} catch (error) {
		input.signal?.throwIfAborted();
		return unavailableOperationVerdict(error, input.actor);
	}
	return verdictFromReadings(readOperationEffects(answers), readOperationRequest(answers), input.actor);
}
