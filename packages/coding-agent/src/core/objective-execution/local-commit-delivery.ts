/**
 * A task bound to local commits refuses `git push` on the root and on every worker.
 * Quote-aware: `echo git push` is not a push. A real `git push`, including after sudo, is.
 */
import { execFileSync } from "node:child_process";
import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import { isGitExecutableToken, lexShellCommand } from "./git-shell-lexer.ts";

/** The branch checked out at `cwd`, or undefined when detached or not a git checkout. */
export function readHeadBranch(cwd: string): string | undefined {
	try {
		const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (!name || name === "HEAD") return undefined;
		return name;
	} catch {
		return undefined;
	}
}

const LEADING_WRAPPERS = new Set(["sudo", "command", "exec", "nohup", "time", "nice", "doas"]);

function gitSubcommandIsPush(tokens: readonly string[]): boolean {
	let index = 0;
	while (index < tokens.length && LEADING_WRAPPERS.has((tokens[index] ?? "").toLowerCase())) {
		const wrapper = (tokens[index] ?? "").toLowerCase();
		index += 1;
		if (wrapper === "sudo" || wrapper === "doas") {
			while (index < tokens.length && (tokens[index] ?? "").startsWith("-")) {
				const flag = tokens[index] ?? "";
				index += flag === "-u" || flag === "-g" || flag === "-C" ? 2 : 1;
			}
		}
	}
	if (!isGitExecutableToken(tokens[index] ?? "")) return false;
	index += 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "--") {
			index += 1;
			break;
		}
		if (
			token === "-c" ||
			token === "-C" ||
			token === "--git-dir" ||
			token === "--work-tree" ||
			token === "--namespace" ||
			token === "--exec-path"
		) {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		return token.toLowerCase() === "push";
	}
	return false;
}

function withoutQuotes(command: string): string {
	return command.replace(/'(?:\\.|[^'])*'/g, " ").replace(/"(?:\\.|[^"\\])*"/g, " ");
}

/** True when a shell command invokes `git push`. */
export function commandPushesGit(command: string): boolean {
	const lexed = lexShellCommand(command);
	const segments = lexed.ok
		? lexed.segments
		: withoutQuotes(command)
				.split(/[|&;\n\r]+/)
				.map((part) => part.trim().split(/\s+/).filter(Boolean));
	return segments.some((segment) => gitSubcommandIsPush(segment));
}

/** True when this tool call would run `git push`. */
export function toolCallPushesGit(toolName: string, args: unknown): boolean {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const name = toolName.toLowerCase();
	if (name === "bash" || name === "shell" || name === "powershell") {
		return typeof record.command === "string" && commandPushesGit(record.command);
	}
	if (name === "run_process" || name === "run-process") {
		const executable = typeof record.executable === "string" ? record.executable : "";
		const processArgs = Array.isArray(record.args)
			? record.args.filter((item): item is string => typeof item === "string")
			: [];
		if (!executable) return false;
		return gitSubcommandIsPush([executable, ...processArgs]);
	}
	return false;
}

export interface DeliveryBindingClassification {
	/** The user is imposing local commits and forbidding push. */
	blocksPush: boolean;
	/** The user is lifting that restriction, including over a specification written in a file. */
	liftsPushBlock: boolean;
}

/**
 * The user owns the binding. A lift clears it. A block sets it to the branch they are on.
 * Saying both in one request leaves the current binding unchanged. Silence leaves it unchanged.
 * A file specification does not decide this; only the classified request does.
 */
export type RuleAuthority = "unset" | "ask" | "user" | "written";

/**
 * The live request is above AGENTS.md and standing user rules.
 * An explicit override follows the request. A contradiction without that override asks the user.
 * A full handoff lets System One settle: the request holds, or the written rule holds.
 * Silence leaves the written rules in force.
 */
export function resolveRuleAuthority(classified: {
	rulesDiffer: boolean;
	overridesWrittenRules: boolean;
	fullHandoff: boolean;
	requestHolds: boolean;
}): RuleAuthority {
	if (classified.overridesWrittenRules) return "user";
	if (classified.rulesDiffer && classified.fullHandoff) return classified.requestHolds ? "user" : "written";
	if (classified.rulesDiffer) return "ask";
	return "unset";
}

export const RULE_CONFLICT_NOTE =
	"RULE CONFLICT: this request differs from AGENTS.md or a standing user rule. Ask the user which holds. The user is above AGENTS.md once they choose.";

export const RULE_SETTLED_USER_NOTE =
	"RULE SETTLEMENT: the user handed this off. System One settled it on the user's request, above the written rule.";

export const RULE_SETTLED_WRITTEN_NOTE =
	"RULE SETTLEMENT: the user handed this off. System One settled it on the written rule.";

export function resolveDeliveryBinding(
	current: string | undefined,
	classified: DeliveryBindingClassification,
	headBranch: string | undefined,
): string | undefined {
	if (classified.liftsPushBlock && !classified.blocksPush) return undefined;
	if (classified.blocksPush && !classified.liftsPushBlock) return headBranch ?? "";
	return current;
}

/** The session's local-commit binding. Absent means the task is not under this delivery. */
export interface LocalCommitPolicy {
	/** Checked-out branch, or "" when the task is bound and HEAD is detached. */
	branch(): string | undefined;
}

/** One place the root gate and the worker gate ask whether this call is a forbidden push. */
export function refuseLocalPush(
	policy: LocalCommitPolicy | undefined,
	toolName: string,
	args: unknown,
): { block: true; reason: string } | undefined {
	const branch = policy?.branch();
	if (branch === undefined || !toolCallPushesGit(toolName, args)) return undefined;
	return { block: true, reason: localCommitPushRefusal(branch || undefined) };
}

/** Delivery under this policy commits locally and does not push. */
export function applyLocalCommitCharter(charter: ExecutionCharter): ExecutionCharter {
	return {
		...charter,
		git: { ...charter.git, commit: true, push: false, force_push: false },
		delivery: {
			...charter.delivery,
			git: { ...charter.delivery.git, push: false },
		},
	};
}

export function localCommitPushRefusal(branch: string | undefined): string {
	const where = branch ? `branch '${branch}'` : "the current branch";
	return `Local commit delivery is bound to ${where}. Git push is refused for the root and for every worker. Commit locally. Other branches and worktrees rebase onto ${where}.`;
}
