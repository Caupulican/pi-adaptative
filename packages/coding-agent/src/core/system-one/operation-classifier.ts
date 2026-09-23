/**
 * Operations the deterministic gates cannot decide, judged by System One.
 *
 * The envelope and the edge decide most calls from their own arguments: a read is safe, `rm -rf` of
 * the repository is the edge, a package install is the edge's install class. A few
 * shapes carry an effect none of them can read off the command: code piped into an interpreter, a
 * destructive command whose target is an unexpanded variable, a request that sends data off the
 * machine, a typed write outside the task directory. Those, and only those, are undecidable: System
 * One answers what the operation does (leaves the machine, cannot be undone, touches files outside
 * the task) and whether the owner's request asks for it, and the authority line turns the answers
 * into an action. Everything else never reaches System One.
 */

import nodePath from "node:path";
import { commandFromToolArgs } from "../acquisition/acquisition-boundary.ts";
import { classifyAllEdgeOperations } from "../autonomy/edge-policy.ts";
import { isDecisivelyFalse, isDecisivelyTrue } from "../decision/noul.ts";
import { parseShellCommandSequence } from "../tools/shell-command-parser.ts";
import { decideByAuthority, type JudgmentReading } from "./authority-line.ts";

/** What makes an operation undecidable, named for the record and the operator. */
export type UndecidableReason =
	| "pipe_to_interpreter"
	| "destructive_unexpanded_target"
	| "network_send"
	| "write_outside_task";

export type OperationTriage =
	| { readonly kind: "decided" }
	| {
			readonly kind: "undecidable";
			readonly reasons: readonly UndecidableReason[];
			/** The operation as the operator reads it: the command, or the written path. */
			readonly operation: string;
	  };

const SHELL_TOOLS = new Set(["bash", "run_process", "powershell"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const INTERPRETERS = new Set([
	"bash",
	"sh",
	"zsh",
	"dash",
	"python",
	"node",
	"perl",
	"ruby",
	"pwsh",
	"powershell",
	"iex",
]);
const DESTRUCTIVE = new Set(["rm", "rmdir", "shred", "truncate", "unlink", "del", "rd", "remove-item"]);
const REMOTE_COPY = new Set(["scp", "sftp", "ftp", "nc", "ncat", "netcat"]);
const CURL_SEND = /^(?:-d|--data(?:-[a-z]+)?|-F|--form(?:-string)?|-T|--upload-file|--json)$/;
const SEND_METHOD = /^(?:POST|PUT|PATCH|DELETE)$/i;

function tool(token: string | undefined): string {
	return nodePath
		.basename((token ?? "").toLowerCase())
		.replace(/\.exe$/, "")
		.replace(/[0-9.]+$/, "");
}

function hasExpansion(token: string): boolean {
	return /\$|`|%[A-Za-z_][A-Za-z0-9_]*%/.test(token);
}

function commandReasons(command: string): UndecidableReason[] {
	const sequence = parseShellCommandSequence(command, { redirects: "drop" });
	const reasons = new Set<UndecidableReason>();
	if (!sequence) {
		// An opaque command still says a pipe into an interpreter in its own text.
		if (
			/\|\s*(?:sudo\s+)?(?:bash|sh|zsh|dash|python[0-9.]*|node|perl|ruby|pwsh|powershell|iex)\s*(?:$|[;&|)])/m.test(
				command,
			)
		)
			reasons.add("pipe_to_interpreter");
		return [...reasons];
	}
	sequence.invocations.forEach((rawArgs, index) => {
		const args = rawArgs[0] === "sudo" ? rawArgs.slice(1) : rawArgs;
		const name = tool(args[0]);
		const piped = index > 0 && sequence.connectors[index - 1] === "|";
		// `… | python` runs what arrives on stdin; `… | python -m json.tool` or `-c code` runs its own code.
		const readsCodeFromStdin = args.slice(1).every((arg) => arg === "-" || arg === "-s" || arg === "--");
		if (piped && INTERPRETERS.has(name) && readsCodeFromStdin) reasons.add("pipe_to_interpreter");
		const gitClean = name === "git" && args.includes("clean");
		const findDelete = name === "find" && args.includes("-delete");
		if ((DESTRUCTIVE.has(name) || gitClean || findDelete) && args.slice(1).some(hasExpansion)) {
			reasons.add("destructive_unexpanded_target");
		}
		if (REMOTE_COPY.has(name)) reasons.add("network_send");
		if (name === "rsync" && args.slice(1).some((arg) => /^[^/\s]+:/.test(arg))) reasons.add("network_send");
		if (name === "curl") {
			const sends = args.some(
				(arg, i) =>
					CURL_SEND.test(arg) || ((arg === "-X" || arg === "--request") && SEND_METHOD.test(args[i + 1] ?? "")),
			);
			if (sends) reasons.add("network_send");
		}
		if (
			name === "wget" &&
			args.some((arg) =>
				/^--(?:post-data|post-file|body-data|body-file)|^--method=(?:POST|PUT|PATCH|DELETE)$/i.test(arg),
			)
		)
			reasons.add("network_send");
	});
	return [...reasons];
}

/**
 * Which calls System One must judge. `decided` covers what the edge already owns and ordinary work,
 * so it never reaches System One.
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
	// The edge owns its operations. An acquisition is not skipped: the acquisition screen exists only
	// under an objective charter, and a named shape (a send, a pipe into an interpreter) is an effect
	// the acquisition questions do not ask about.
	if (edge.length > 0) return { kind: "decided" };
	if (SHELL_TOOLS.has(input.toolName)) {
		const command = commandFromToolArgs(input.args);
		if (!command) return { kind: "decided" };
		const reasons = commandReasons(command);
		return reasons.length > 0 ? { kind: "undecidable", reasons, operation: command } : { kind: "decided" };
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
		return { kind: "undecidable", reasons: ["write_outside_task"], operation: `${input.toolName} ${resolved}` };
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
};

/** The authority line's irreversible row, as an operation verdict. */
function irreversibleAction(reading: JudgmentReading, actor: "root" | "worker"): OperationVerdict["action"] {
	const decision = decideByAuthority("irreversible", reading, 0, actor);
	if (decision.action === "proceed") return "proceed";
	return decision.action === "ask_operator" || reading !== "fail" ? "confirm" : "refuse";
}

/**
 * One batched System One request over the four questions, read through the authority line: an
 * operation shown local and reversible proceeds; one System One finds irreversible or outward runs
 * when the owner's request asks for it, is refused when the request clearly does not, and goes to
 * the operator when that is unsettled; an unsettled effect or an unanswered request goes to the
 * operator too.
 */
export async function judgeOperation(
	engine: OperationEffectEngine | undefined,
	input: {
		readonly triage: Extract<OperationTriage, { kind: "undecidable" }>;
		readonly toolName: string;
		readonly scopeCwd: string;
		readonly request: string;
		readonly actor: "root" | "worker";
		readonly signal?: AbortSignal;
		/** Bound on the System One call; running out counts as System One unavailable. */
		readonly timeoutMs?: number;
	},
): Promise<OperationVerdict> {
	let answers: Record<string, unknown> | undefined;
	let failure: string | undefined;
	if (!engine) failure = "System One is not bound";
	else {
		const bounded = [input.signal, input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
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
								why_asked: input.triage.reasons,
							},
							request: input.request || "(no request recorded)",
						},
						{ consequence: "high", signal: bounded.length > 0 ? AbortSignal.any(bounded) : undefined },
					)
				).answers ?? {};
		} catch (error) {
			input.signal?.throwIfAborted();
			failure = error instanceof Error ? error.message : String(error);
		}
	}
	if (!answers) {
		return {
			action: irreversibleAction("unavailable", input.actor),
			finding: `System One could not judge it (${failure}); flagged for ${input.triage.reasons.join(", ")}`,
			notable: true,
		};
	}
	const found = answers;
	const effects = Object.keys(EFFECT_WORDS).filter((id) => isDecisivelyTrue(found[id]));
	if (Object.keys(EFFECT_WORDS).every((id) => isDecisivelyFalse(found[id]))) {
		return { action: "proceed", finding: "System One found it local and reversible", notable: false };
	}
	const described =
		effects.length > 0 ? effects.map((id) => EFFECT_WORDS[id]).join(", ") : "its effect could not be settled";
	if (isDecisivelyTrue(found.request_authorizes)) {
		return { action: "proceed", finding: `${described}; the owner's request asks for it`, notable: true };
	}
	const refused = effects.length > 0 && isDecisivelyFalse(found.request_authorizes);
	return {
		action: irreversibleAction(refused ? "fail" : "ambiguous", input.actor),
		finding: `${described}; ${refused ? "the owner's request does not ask for it" : "the owner's request does not settle it"}`,
		notable: true,
	};
}
