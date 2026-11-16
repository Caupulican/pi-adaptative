/**
 * Whether the checkout's CI workflow (`.github/workflows/ci.yml`, the workflow the CI source reads) runs for a pushed
 * commit, read as GitHub reads it for a push: the workflow file at that commit, its `on` triggers, a `push` trigger's
 * branch filters, the commit message's skip instruction and, when only a pull request runs it, the open pull requests
 * from the pushed branch and their base branches. `none` is said only when those facts settle it; a trigger or filter
 * this reader does not judge (paths, another workflow's run, a branch's creation) and a file or listing it cannot read
 * are `unknown`, and the host arms its watch as it would for a run.
 */
import { parse } from "yaml";
import type { CiPushTriggers, CiPushVerdict } from "../../core/watches/github-watch-source.ts";
import type { CiCommandPort } from "./ci-provider.ts";
import { CI_WORKFLOW } from "./ci-status-record.ts";

const WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW}`;
/** The activity a push to an open pull request's head branch emits, and the activities run when a trigger names none. */
const SYNCHRONIZE = "synchronize";
const PULL_REQUEST_DEFAULT_TYPES = ["opened", SYNCHRONIZE, "reopened"];
/** Events no push starts a run of: a workflow triggered only by these does not run for a push. */
const NOT_FROM_A_PUSH = new Set([
	"branch_protection_rule",
	"delete",
	"deployment",
	"deployment_status",
	"discussion",
	"discussion_comment",
	"fork",
	"gollum",
	"issue_comment",
	"issues",
	"label",
	"merge_group",
	"milestone",
	"page_build",
	"project",
	"project_card",
	"project_column",
	"public",
	"pull_request_review",
	"pull_request_review_comment",
	"registry_package",
	"release",
	"repository_dispatch",
	"schedule",
	"watch",
	"workflow_call",
	"workflow_dispatch",
]);
/** A head commit message that asks GitHub to skip the push's and pull request's workflow runs. */
const SKIP_INSTRUCTION = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks: ?true$/imu;
const MAX_OPEN_PULL_REQUESTS = 100;

/** A branch filter's verdict: whether it admits the branch, or why this reader cannot say. */
type Admits = boolean | { readonly unknown: string };

class UnjudgedFilter extends Error {}

function plainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A filter's patterns: one string or a list of strings. */
function patterns(value: unknown, key: string): readonly string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return value;
	throw new UnjudgedFilter(`its \`${key}\` filter is not a list of patterns`);
}

function escaped(character: string): string {
	return character.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

/**
 * GitHub's filter pattern as a regular expression: `**` any characters, `*` any but `/`, `?` and `+` zero-or-one and
 * one-or-more of the preceding character, `[...]` one listed character or range, a backslash escaping the next character.
 */
function filterPattern(glob: string): RegExp {
	let source = "";
	for (let index = 0; index < glob.length; index += 1) {
		const character = glob[index] ?? "";
		if (character === "\\" && index + 1 < glob.length) {
			index += 1;
			source += escaped(glob[index] ?? "");
		} else if (character === "*") {
			const any = glob[index + 1] === "*";
			if (any) index += 1;
			source += any ? "(?:.*)" : "(?:[^/]*)";
		} else if (character === "?" || character === "+") {
			if (source.length === 0) throw new UnjudgedFilter(`its pattern ${glob} repeats nothing`);
			source += character;
		} else if (character === "[") {
			const end = glob.indexOf("]", index + 1);
			const listed = end < 0 ? "" : glob.slice(index + 1, end);
			if (!/^[A-Za-z0-9_.-]+$/u.test(listed))
				throw new UnjudgedFilter(`its pattern ${glob} has a class this reader does not judge`);
			source += `[${listed}]`;
			index = end;
		} else source += escaped(character);
	}
	return new RegExp(`^(?:${source})$`, "u");
}

/** The ordered patterns over `name`: the last that matches decides, a `!` pattern excluding what it matches. */
function matches(name: string, list: readonly string[]): boolean {
	let matched = false;
	for (const pattern of list) {
		const negated = pattern.startsWith("!");
		if (filterPattern(negated ? pattern.slice(1) : pattern).test(name)) matched = !negated;
	}
	return matched;
}

/**
 * Whether an event's filters admit `branch` (a push's own branch, or a pull request's base): `branches` or
 * `branches-ignore`; with neither, a push trigger that filters only tags runs for no branch. A paths filter is not judged.
 */
function admitsBranch(config: unknown, branch: string, event: string): Admits {
	if (config === null || config === undefined) return true;
	if (!plainObject(config)) return { unknown: `its ${event} trigger is not a mapping` };
	if (config.paths !== undefined || config["paths-ignore"] !== undefined)
		return { unknown: `its ${event} trigger filters the changed paths, which the host does not judge` };
	const [included, ignored] = [config.branches, config["branches-ignore"]];
	if (included !== undefined && ignored !== undefined)
		return { unknown: `its ${event} trigger names both branches and branches-ignore, which GitHub refuses` };
	try {
		if (included !== undefined) return matches(branch, patterns(included, "branches"));
		if (ignored !== undefined) return !matches(branch, patterns(ignored, "branches-ignore"));
	} catch (error) {
		if (error instanceof UnjudgedFilter) return { unknown: error.message };
		throw error;
	}
	return !(event === "push" && (config.tags !== undefined || config["tags-ignore"] !== undefined));
}

/** The workflow's `on` as its events and each one's configuration; undefined when it names none this reader can read. */
function events(on: unknown): ReadonlyMap<string, unknown> | undefined {
	if (typeof on === "string") return new Map([[on, null]]);
	if (Array.isArray(on) && on.every((item): item is string => typeof item === "string"))
		return new Map(on.map((event) => [event, null]));
	if (plainObject(on)) return new Map(Object.entries(on));
	return undefined;
}

function unknown(why: string): CiPushVerdict {
	return { verdict: "unknown", why };
}

export class CiWorkflowTriggers implements CiPushTriggers {
	private readonly port: CiCommandPort;

	/** `port` runs `git` and `gh` in the checkout the CI source follows. */
	constructor(port: CiCommandPort) {
		this.port = port;
	}

	async runsOnPush(push: { readonly sha: string; readonly ref: string }, signal: AbortSignal): Promise<CiPushVerdict> {
		const branch = push.ref.startsWith("refs/heads/") ? push.ref.slice("refs/heads/".length) : push.ref;
		if (branch.startsWith("refs/"))
			return { verdict: "none", why: `the push updated ${push.ref}, which is no branch` };
		let workflow: string | undefined;
		let message: string;
		try {
			const listed = await this.port.run(
				"git",
				["ls-tree", "--full-tree", "--name-only", push.sha, "--", WORKFLOW_PATH],
				signal,
			);
			if (listed.trim().length > 0)
				workflow = await this.port.run("git", ["cat-file", "blob", `${push.sha}:${WORKFLOW_PATH}`], signal);
			message = await this.port.run("git", ["log", "-1", "--format=%B", push.sha], signal);
		} catch (error) {
			signal.throwIfAborted();
			return unknown(`the commit's ${WORKFLOW_PATH} could not be read: ${errorText(error)}`);
		}
		if (workflow === undefined) return { verdict: "none", why: `the commit holds no ${WORKFLOW_PATH}` };
		let triggers: ReadonlyMap<string, unknown> | undefined;
		try {
			const document: unknown = parse(workflow);
			triggers = plainObject(document) ? events(document.on) : undefined;
		} catch (error) {
			return unknown(`its ${WORKFLOW_PATH} does not parse: ${errorText(error)}`);
		}
		if (!triggers) return unknown(`its ${WORKFLOW_PATH} names no triggers this reader can read`);
		const unjudged = [...triggers.keys()].find(
			(event) =>
				event !== "push" &&
				event !== "pull_request" &&
				event !== "pull_request_target" &&
				!NOT_FROM_A_PUSH.has(event),
		);
		if (unjudged !== undefined)
			return unknown(`its ${WORKFLOW_PATH} also runs on ${unjudged}, which the host does not judge`);
		const fromPullRequest = triggers.has("pull_request") || triggers.has("pull_request_target");
		if (SKIP_INSTRUCTION.test(message) && (triggers.has("push") || fromPullRequest))
			return { verdict: "none", why: "its commit message asks GitHub to skip CI" };
		const onPush = triggers.has("push") ? admitsBranch(triggers.get("push"), branch, "push") : false;
		if (onPush === true) return { verdict: "runs" };
		if (!fromPullRequest)
			return typeof onPush === "object"
				? unknown(onPush.unknown)
				: { verdict: "none", why: `${WORKFLOW_PATH} runs for no push to ${branch}` };
		return this.fromPullRequests(triggers, branch, onPush, signal);
	}

	/** A push the push trigger does not run for: whether an open pull request from its branch runs the workflow. */
	private async fromPullRequests(
		triggers: ReadonlyMap<string, unknown>,
		branch: string,
		onPush: Admits,
		signal: AbortSignal,
	): Promise<CiPushVerdict> {
		let bases: readonly string[];
		try {
			const listed: unknown = JSON.parse(
				await this.port.run(
					"gh",
					[
						"pr",
						"list",
						"--head",
						branch,
						"--state",
						"open",
						"--json",
						"baseRefName",
						"--limit",
						String(MAX_OPEN_PULL_REQUESTS),
					],
					signal,
				),
			);
			if (!Array.isArray(listed) || listed.length >= MAX_OPEN_PULL_REQUESTS)
				throw new Error("the listing is not complete");
			bases = listed.map((entry: unknown) => {
				const base = plainObject(entry) ? entry.baseRefName : undefined;
				if (typeof base !== "string" || base.length === 0) throw new Error("a pull request names no base branch");
				return base;
			});
		} catch (error) {
			signal.throwIfAborted();
			return unknown(`the open pull requests from ${branch} could not be read: ${errorText(error)}`);
		}
		if (bases.length > 0 && triggers.has("pull_request_target"))
			return unknown(
				"a pull request from its branch is open, and pull_request_target runs the base branch's workflow",
			);
		const reasons = typeof onPush === "object" ? [onPush.unknown] : [];
		const config = triggers.get("pull_request");
		if (bases.length > 0 && config !== undefined) {
			const types = plainObject(config) && config.types !== undefined ? config.types : PULL_REQUEST_DEFAULT_TYPES;
			const synchronizes =
				typeof types === "string" ? types === SYNCHRONIZE : Array.isArray(types) && types.includes(SYNCHRONIZE);
			if (synchronizes)
				for (const base of bases) {
					const admitted = admitsBranch(config, base, "pull_request");
					if (admitted === true) return { verdict: "runs" };
					if (typeof admitted === "object") reasons.push(admitted.unknown);
				}
		}
		if (reasons.length > 0) return unknown(reasons.join("; "));
		return {
			verdict: "none",
			why:
				bases.length === 0
					? `${WORKFLOW_PATH} runs for no push to ${branch}, and no pull request from it is open`
					: `${WORKFLOW_PATH} runs for no push to ${branch}, nor for the pull requests open from it`,
		};
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
