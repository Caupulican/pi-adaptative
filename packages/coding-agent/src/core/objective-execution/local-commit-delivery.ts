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

interface GitInvocation {
	push: boolean;
	changesRepositoryTarget: boolean;
}

function parseGitInvocation(tokens: readonly string[]): GitInvocation {
	let changesRepositoryTarget = false;
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
	if (!isGitExecutableToken(tokens[index] ?? "")) return { push: false, changesRepositoryTarget };
	index += 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "--") {
			index += 1;
			break;
		}
		if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "--namespace") {
			changesRepositoryTarget = true;
			index += 2;
			continue;
		}
		if (token === "-c") {
			changesRepositoryTarget = true;
			index += 2;
			continue;
		}
		if (token === "--exec-path") {
			index += 2;
			continue;
		}
		if (
			(token.startsWith("-C") && token.length > 2) ||
			token.startsWith("--git-dir=") ||
			token.startsWith("--work-tree=") ||
			token.startsWith("--namespace=")
		) {
			changesRepositoryTarget = true;
			index += 1;
			continue;
		}
		if (token.startsWith("-c") && token.length > 2) {
			changesRepositoryTarget = true;
			index += 1;
			continue;
		}
		if (token.startsWith("--exec-path=")) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		return { push: token.toLowerCase() === "push", changesRepositoryTarget };
	}
	return { push: false, changesRepositoryTarget };
}

function gitSubcommandIsPush(tokens: readonly string[]): boolean {
	return parseGitInvocation(tokens).push;
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

const SHELL_CWD_CHANGERS = new Set(["cd", "pushd", "popd", "chdir", "set-location", "sl", "source", ".", "eval"]);

function segmentChangesWorkingDirectory(tokens: readonly string[]): boolean {
	let index = 0;
	while (index < tokens.length && (tokens[index] ?? "").toLowerCase() === "command") index += 1;
	return SHELL_CWD_CHANGERS.has((tokens[index] ?? "").toLowerCase());
}

/**
 * True only when a tool call definitely pushes from its inherited current checkout.
 * Alternate Git directories and shell commands that may have changed cwd are left to scoped review.
 */
export function toolCallPushesGitAtCwd(toolName: string, args: unknown): boolean {
	const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const name = toolName.toLowerCase();
	if (name === "run_process" || name === "run-process") {
		if (Object.hasOwn(record, "cwd")) return false;
		const executable = typeof record.executable === "string" ? record.executable : "";
		const processArgs = Array.isArray(record.args)
			? record.args.filter((item): item is string => typeof item === "string")
			: [];
		const invocation = parseGitInvocation([executable, ...processArgs]);
		return invocation.push && !invocation.changesRepositoryTarget;
	}
	if (name !== "bash" && name !== "shell" && name !== "powershell") return false;
	if (typeof record.command !== "string") return false;
	const lexed = lexShellCommand(record.command);
	if (!lexed.ok) return false;
	for (let index = 0; index < lexed.segments.length; index += 1) {
		const segment = lexed.segments[index] ?? [];
		const invocation = parseGitInvocation(segment);
		if (!invocation.push) continue;
		if (invocation.changesRepositoryTarget) return false;
		return !lexed.segments.slice(0, index).some(segmentChangesWorkingDirectory);
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

/**
 * System One did not answer, so the request was never classified. The binding is unchanged, which
 * is correct; saying nothing is not, because an unclassified "commit, do not push" is
 * indistinguishable from a classified "no limit asked for" once the turn moves on.
 */
export function deliveryClassificationUnavailableNote(reason: string, boundBranch: string | undefined): string {
	const standing =
		boundBranch === undefined
			? "No delivery limit is bound."
			: `The existing local-commit binding on ${boundBranch || "the current branch"} still holds.`;
	return `DELIVERY CLASSIFICATION UNAVAILABLE: System One did not classify this request (${reason}). ${standing} If this request states a delivery limit, such as commit without pushing, honour it yourself for this task; the harness did not register it.`;
}

export function localCommitPushRefusal(branch: string | undefined): string {
	const where = branch ? `branch '${branch}'` : "the current branch";
	return `Local commit delivery is bound to ${where}. Git push is refused for the root and for every worker. Commit locally. Other branches and worktrees rebase onto ${where}.`;
}
