/**
 * Whether the checkout's CI workflow (`.github/workflows/ci.yml`, the workflow the CI source reads) runs for a pushed
 * commit, read as GitHub reads it for a push: the workflow file at that commit, its `on` triggers, a `push` trigger's
 * branch filters, the commit message's skip instruction and the open pull requests from the pushed branch. A pull
 * request's run follows another file than the pushed commit's: `pull_request` the workflow of the pull request's merge
 * with its base (`refs/pull/<n>/merge`, read once GitHub merged the pushed commit there, which it does a few seconds after
 * the push), `pull_request_target` its base branch's. `none` is said only when those facts settle it: no push run and
 * no open pull request's workflow running for it, or a skip instruction. A trigger or filter this reader does not judge
 * (paths, another workflow's run, a branch's creation, a deployment), a merge GitHub has not computed (a conflict, or not
 * yet), and a file or listing it cannot read are `unknown`: the host arms its watch as it would for a run.
 */
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import type { CiPushTriggers, CiPushVerdict } from "../../core/watches/github-watch-source.ts";
import type { CiCommandPort } from "./ci-provider.ts";
import { CI_WORKFLOW } from "./ci-status-record.ts";

const WORKFLOW_PATH = `.github/workflows/${CI_WORKFLOW}`;
/** The activity a push to an open pull request's head branch emits, and the activities run when a trigger names none. */
const SYNCHRONIZE = "synchronize";
const PULL_REQUEST_DEFAULT_TYPES = ["opened", SYNCHRONIZE, "reopened"];
/**
 * Events no push starts a run of: a workflow triggered only by these does not run for a push. Events an app or another
 * workflow may raise for the pushed commit (a deployment, a release, a repository dispatch) are not among them.
 */
const NOT_FROM_A_PUSH = new Set([
	"branch_protection_rule",
	"delete",
	"discussion",
	"discussion_comment",
	"fork",
	"gollum",
	"issue_comment",
	"issues",
	"label",
	"merge_group",
	"milestone",
	"project",
	"project_card",
	"project_column",
	"public",
	"pull_request_review",
	"pull_request_review_comment",
	"schedule",
	"watch",
	"workflow_call",
	"workflow_dispatch",
]);
/**
 * A head commit message that asks GitHub to skip the push's and its pull requests' workflow runs, in the forms GitHub
 * documents: one of its bracketed words anywhere, or a `skip-checks` trailer after two empty lines at its end.
 */
const SKIP_INSTRUCTION = /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/u;
const SKIP_CHECKS_TRAILER = /\n\n\nskip-checks: ?true\n*$/u;
const SKIPPED = "its commit message asks GitHub to skip the runs of its push and pull requests";
const MAX_OPEN_PULL_REQUESTS = 100;
/** When a pull request's merge ref is read again while GitHub has not merged the pushed commit there yet. */
const MERGE_REREAD_DELAYS_MS = [2_000, 5_000, 10_000] as const;
/** The workflow files and merge a pull request's runs follow, in one read of GitHub's GraphQL API. */
const PULL_REQUEST_WORKFLOWS = `query($owner: String!, $name: String!, $merge: String!, $mergeFile: String!, $baseFile: String!) {
  repository(owner: $owner, name: $name) {
    merge: object(expression: $merge) { ... on Commit { parents(first: 2) { nodes { oid } } } }
    mergeWorkflow: object(expression: $mergeFile) { ... on Blob { text } }
    baseWorkflow: object(expression: $baseFile) { ... on Blob { text } }
  }
}`;

/** An open pull request from the pushed branch: its number and base branch. */
interface OpenPullRequest {
	readonly number: number;
	readonly base: string;
}

/** A workflow file as GitHub holds it at a revision: its text, none there, or why it was not read. */
type WorkflowFile = string | undefined | { readonly unknown: string };

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
	try {
		return new RegExp(`^(?:${source})$`, "u");
	} catch (error) {
		throw new UnjudgedFilter(`its pattern ${glob} does not read as a pattern: ${errorText(error)}`);
	}
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
		const skipped = SKIP_INSTRUCTION.test(message) || SKIP_CHECKS_TRAILER.test(message);
		// A pull request's run reads the workflow of its merge with the base, not the pushed commit's file.
		if (workflow === undefined)
			return skipped
				? { verdict: "none", why: SKIPPED }
				: this.withoutPushRun(push.sha, branch, [], `the commit holds no ${WORKFLOW_PATH}`, signal);
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
		// The skip instruction holds back the push's and its pull requests' runs, the only ones a push starts here.
		if (skipped) return { verdict: "none", why: SKIPPED };
		const onPush = triggers.has("push") ? admitsBranch(triggers.get("push"), branch, "push") : false;
		if (onPush === true) return { verdict: "runs" };
		return this.withoutPushRun(
			push.sha,
			branch,
			typeof onPush === "object" ? [onPush.unknown] : [],
			`${WORKFLOW_PATH} runs for no push to ${branch}`,
			signal,
		);
	}

	/**
	 * A push its own trigger does not run for (`why`, or the `unsettled` reasons it might): `none` only while no open pull
	 * request from its branch runs it, each judged by the workflows its runs follow ({@link pullRequestRuns}).
	 */
	private async withoutPushRun(
		sha: string,
		branch: string,
		unsettled: readonly string[],
		why: string,
		signal: AbortSignal,
	): Promise<CiPushVerdict> {
		let pulls: readonly OpenPullRequest[];
		try {
			pulls = await this.openPullRequests(branch, signal);
		} catch (error) {
			signal.throwIfAborted();
			return unknown(`the open pull requests from ${branch} could not be read: ${errorText(error)}`);
		}
		const reasons = [...unsettled];
		for (const pull of pulls) {
			const runs = await this.pullRequestRuns(pull, sha, signal);
			if (runs === true) return { verdict: "runs" };
			if (runs !== false) reasons.push(runs.unknown);
		}
		if (reasons.length > 0) return unknown(reasons.join("; "));
		return {
			verdict: "none",
			why:
				pulls.length === 0
					? `${why}, and no pull request from it is open`
					: `${why}, and the workflows its open pull requests run follow do not run for the push`,
		};
	}

	/**
	 * Whether a push to an open pull request's head runs the CI workflow for it: its `pull_request` trigger in the workflow
	 * of the pull request's merge (once GitHub merged the pushed commit there, read again a few times while it has not),
	 * or its `pull_request_target` trigger in its base branch's.
	 */
	private async pullRequestRuns(pull: OpenPullRequest, sha: string, signal: AbortSignal): Promise<Admits> {
		const read = await this.pullRequestWorkflows(pull, sha, signal);
		if ("unknown" in read) return read;
		const merge = runsFor(read.merge, "pull_request", pull.base);
		const target = runsFor(read.base, "pull_request_target", pull.base);
		if (merge === true || target === true) return true;
		if (merge === false && target === false) return false;
		const reasons = [merge, target].flatMap((admits) => (typeof admits === "object" ? [admits.unknown] : []));
		return { unknown: `for pull request #${pull.number}, ${reasons.join(", and ")}` };
	}

	/** The workflow files of a pull request's merge holding the pushed commit and of its base branch. */
	private async pullRequestWorkflows(
		pull: OpenPullRequest,
		sha: string,
		signal: AbortSignal,
	): Promise<{ readonly merge: WorkflowFile; readonly base: WorkflowFile } | { readonly unknown: string }> {
		const merge = `refs/pull/${pull.number}/merge`;
		for (let attempt = 0; ; attempt += 1) {
			let repository: Record<string, unknown>;
			try {
				const response: unknown = JSON.parse(
					await this.port.run(
						"gh",
						[
							"api",
							"graphql",
							"-F",
							"owner={owner}",
							"-F",
							"name={repo}",
							"-f",
							`merge=${merge}`,
							"-f",
							`mergeFile=${merge}:${WORKFLOW_PATH}`,
							"-f",
							`baseFile=refs/heads/${pull.base}:${WORKFLOW_PATH}`,
							"-f",
							`query=${PULL_REQUEST_WORKFLOWS}`,
						],
						signal,
					),
				);
				const data = plainObject(response) ? response.data : undefined;
				const found = plainObject(data) ? data.repository : undefined;
				if (!plainObject(found)) throw new Error("GitHub returned no repository");
				repository = found;
			} catch (error) {
				signal.throwIfAborted();
				return { unknown: `the workflows of pull request #${pull.number} could not be read: ${errorText(error)}` };
			}
			const parents = plainObject(repository.merge) ? repository.merge.parents : undefined;
			const nodes = plainObject(parents) && Array.isArray(parents.nodes) ? parents.nodes : [];
			// GitHub's merge of a pull request holds its base and its head as parents, the head second.
			const head = nodes.map((node: unknown) => (plainObject(node) ? node.oid : undefined))[1];
			if (head === sha)
				return { merge: workflowFile(repository.mergeWorkflow), base: workflowFile(repository.baseWorkflow) };
			const wait = MERGE_REREAD_DELAYS_MS[attempt];
			if (wait === undefined)
				return {
					unknown:
						repository.merge === null
							? `GitHub holds no merge of pull request #${pull.number} with its base (a conflict, or not computed yet)`
							: `GitHub has not merged the pushed commit into pull request #${pull.number}'s merge with its base yet`,
				};
			await delay(wait, undefined, { signal });
		}
	}

	/** The open pull requests from `branch`; a listing that may be cut short throws. */
	private async openPullRequests(branch: string, signal: AbortSignal): Promise<readonly OpenPullRequest[]> {
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
					"number,baseRefName",
					"--limit",
					String(MAX_OPEN_PULL_REQUESTS),
				],
				signal,
			),
		);
		if (!Array.isArray(listed) || listed.length >= MAX_OPEN_PULL_REQUESTS)
			throw new Error("the listing is not complete");
		return listed.map((entry: unknown) => {
			const base = plainObject(entry) ? entry.baseRefName : undefined;
			const number = plainObject(entry) ? entry.number : undefined;
			if (typeof base !== "string" || base.length === 0) throw new Error("a pull request names no base branch");
			if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
				throw new Error("a pull request has no number");
			return { number, base };
		});
	}
}

/** A workflow file GitHub's GraphQL API returned (`object(expression:)` as a blob): its text, none there, or unread. */
function workflowFile(object: unknown): WorkflowFile {
	if (object === null || object === undefined) return undefined;
	if (plainObject(object) && typeof object.text === "string") return object.text;
	return { unknown: `its ${WORKFLOW_PATH} is not a text file GitHub returns` };
}

/**
 * Whether a pull request's `event` (`pull_request` or `pull_request_target`) in `file` runs for a push to its head:
 * the trigger present, `synchronize` among its activity types and its filters admitting the base branch.
 */
function runsFor(file: WorkflowFile, event: string, base: string): Admits {
	if (file === undefined) return false;
	if (typeof file === "object") return file;
	let triggers: ReadonlyMap<string, unknown> | undefined;
	try {
		const document: unknown = parse(file);
		triggers = plainObject(document) ? events(document.on) : undefined;
	} catch (error) {
		return { unknown: `the ${WORKFLOW_PATH} its ${event} run follows does not parse: ${errorText(error)}` };
	}
	if (!triggers)
		return { unknown: `the ${WORKFLOW_PATH} its ${event} run follows names no triggers this reader can read` };
	if (!triggers.has(event)) return false;
	const config = triggers.get(event);
	const types = plainObject(config) && config.types !== undefined ? config.types : PULL_REQUEST_DEFAULT_TYPES;
	const synchronizes =
		typeof types === "string" ? types === SYNCHRONIZE : Array.isArray(types) && types.includes(SYNCHRONIZE);
	return synchronizes ? admitsBranch(config, base, event) : false;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
