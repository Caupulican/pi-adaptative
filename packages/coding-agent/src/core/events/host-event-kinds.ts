import {
	GITHUB_THREAD_EVENT_KINDS,
	type GithubThreadEvent,
	type GithubThreadEventKind,
	githubBranchName,
	githubLogin,
	HOST_EVENT_RECALL_MS,
	type HostEventEnvelope,
	HostEventError,
	hostEventArray,
	hostEventDate,
	hostEventInteger,
	hostEventRecord,
} from "./host-event-contract.ts";

/**
 * Who wrote an event's content. `owner-controlled` facts come from the owner's own systems (a verdict of the owner's
 * workflow, a state change on the owner's repository); `third-party-authored` content was written by someone else and
 * stays untrusted data in every turn it reaches. It derives from the kind, never from a stored per-event field.
 */
export type HostEventAuthorship = "owner-controlled" | "third-party-authored";

/** A scope a listener names to narrow a kind. */
export type HostEventScopeKey = "revision" | "workflow" | "pullRequest" | "branch" | "authors";

/** One declared event kind. Every kind a source emits is declared here, with how a listener may scope it. */
export interface HostEventKindDeclaration {
	readonly source: "ci" | "github";
	/** What a listener names to receive the kind. */
	readonly scope: readonly HostEventScopeKey[];
	/** The event fields whose identity makes a replay idempotent. */
	readonly idempotency: string;
	/** `high`: unscoped listening can flood a session, so a listener must narrow it at save. */
	readonly volume: "low" | "high";
	/** The scopes that narrow a `high` kind enough to listen to it; a listener naming none of them is refused at save. */
	readonly narrowedBy: readonly HostEventScopeKey[];
	/** `superseding`: a later occurrence for the same scope replaces the earlier one; `occurrence`: each stands alone. */
	readonly currency: "superseding" | "occurrence";
	readonly authorship: HostEventAuthorship;
	/** How long a settled occurrence stays in the session ledger for recall before it may be pruned. */
	readonly recallMs: number;
}

export type HostEventKind = HostEventEnvelope["event"]["kind"];

const GITHUB_SCOPE: readonly HostEventScopeKey[] = ["pullRequest", "branch", "authors"];
const GITHUB_RECALL_MS = 24 * 60 * 60 * 1000;

/** The closed kind table. A kind without a delivery path is never declared. */
export const HOST_EVENT_KINDS: { readonly [K in HostEventKind]: HostEventKindDeclaration } = {
	"ci-attempt-terminal": {
		source: "ci",
		scope: ["revision", "workflow"],
		idempotency: "attempt identity (host, repository, workflow, run, attempt)",
		volume: "low",
		narrowedBy: [],
		currency: "superseding",
		authorship: "owner-controlled",
		recallMs: HOST_EVENT_RECALL_MS,
	},
	"pull-request-comment": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "comment id (host, repository, kind, comment)",
		volume: "high",
		narrowedBy: GITHUB_SCOPE,
		currency: "occurrence",
		authorship: "third-party-authored",
		recallMs: GITHUB_RECALL_MS,
	},
	"review-comment": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "review comment id (host, repository, kind, comment)",
		volume: "high",
		narrowedBy: GITHUB_SCOPE,
		currency: "occurrence",
		authorship: "third-party-authored",
		recallMs: GITHUB_RECALL_MS,
	},
	// Reviews are listed per pull request, so only a pull request or its branch can scope them.
	"review-submitted": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "review id (host, repository, kind, review)",
		volume: "high",
		narrowedBy: ["pullRequest", "branch"],
		currency: "occurrence",
		authorship: "third-party-authored",
		recallMs: GITHUB_RECALL_MS,
	},
	"review-requested": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "issue event id (host, repository, kind, event)",
		volume: "low",
		narrowedBy: [],
		currency: "occurrence",
		authorship: "owner-controlled",
		recallMs: GITHUB_RECALL_MS,
	},
	"issue-assigned": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "issue event id (host, repository, kind, event)",
		volume: "low",
		narrowedBy: [],
		currency: "occurrence",
		authorship: "owner-controlled",
		recallMs: GITHUB_RECALL_MS,
	},
	"pull-request-merged": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "issue event id (host, repository, kind, event)",
		volume: "high",
		narrowedBy: GITHUB_SCOPE,
		currency: "occurrence",
		authorship: "owner-controlled",
		recallMs: GITHUB_RECALL_MS,
	},
	"pull-request-closed": {
		source: "github",
		scope: GITHUB_SCOPE,
		idempotency: "issue event id (host, repository, kind, event)",
		volume: "high",
		narrowedBy: GITHUB_SCOPE,
		currency: "occurrence",
		authorship: "owner-controlled",
		recallMs: GITHUB_RECALL_MS,
	},
};

export function hostEventKindOf(envelope: HostEventEnvelope): HostEventKind {
	return envelope.event.kind;
}

export function hostEventAuthorship(envelope: HostEventEnvelope): HostEventAuthorship {
	return HOST_EVENT_KINDS[hostEventKindOf(envelope)].authorship;
}

/** Save-time bounds every event listener inherits, whatever its source. */
export const HOST_EVENT_LISTENER_LIMITS = {
	/** Kinds one listener names. */
	maxKinds: 8,
	/** Author logins one listener names. */
	maxAuthors: 50,
	/** Events one run carries; more are counted, not carried. */
	maxBatch: 25,
	/** Listeners of one source that a session holds at once. */
	maxListenersPerSource: 16,
} as const;

/**
 * What one GitHub listener asks its source to collect, and the predicate that selects its occurrences. `since` is the
 * instant the listener began: an occurrence before it is history and never selected.
 */
export interface GithubThreadInterest {
	readonly kinds: readonly GithubThreadEventKind[];
	readonly pullRequest?: number;
	readonly branch?: string;
	/** Logins compare case-insensitively, as GitHub's do. */
	readonly authors?: readonly string[];
	readonly since: string;
}

export function githubInterestMatches(interest: GithubThreadInterest, event: GithubThreadEvent): boolean {
	if (!interest.kinds.includes(event.kind) || Date.parse(event.occurredAt) < Date.parse(interest.since)) return false;
	if (
		interest.pullRequest !== undefined &&
		(!event.thread.pullRequest || event.thread.number !== interest.pullRequest)
	)
		return false;
	if (interest.branch !== undefined && event.thread.branch !== interest.branch) return false;
	const author = event.author.toLowerCase();
	return interest.authors === undefined || interest.authors.some((login) => login.toLowerCase() === author);
}

export function parseGithubThreadInterest(value: unknown): GithubThreadInterest {
	const entry = hostEventRecord(value, ["kinds", "pullRequest", "branch", "authors", "since"], "GitHub interest");
	const kinds = hostEventArray(
		entry.kinds,
		HOST_EVENT_LISTENER_LIMITS.maxKinds,
		(kind) => {
			if (!GITHUB_THREAD_EVENT_KINDS.some((candidate) => candidate === kind))
				throw new HostEventError("invalid", "GitHub interest names an unknown kind.");
			return kind as GithubThreadEventKind;
		},
		"GitHub interest kinds",
	);
	if (kinds.length === 0) throw new HostEventError("invalid", "GitHub interest names no kind.");
	return {
		kinds,
		...(entry.pullRequest === undefined ? {} : { pullRequest: hostEventInteger(entry.pullRequest, "pullRequest") }),
		...(entry.branch === undefined ? {} : { branch: githubBranchName(entry.branch) }),
		...(entry.authors === undefined
			? {}
			: {
					authors: hostEventArray(
						entry.authors,
						HOST_EVENT_LISTENER_LIMITS.maxAuthors,
						githubLogin,
						"GitHub interest authors",
					),
				}),
		since: hostEventDate(entry.since, "since"),
	};
}

export function isHostEventKind(value: unknown): value is HostEventKind {
	return typeof value === "string" && Object.hasOwn(HOST_EVENT_KINDS, value);
}

/**
 * Why a listener of `source` naming `kinds` under the scopes it names may not be saved, or `undefined`. The rules are
 * the kind table's: a kind of another source is refused, and a high-volume kind needs one of the scopes that narrow it.
 */
export function hostEventListenerRefusal(
	source: HostEventKindDeclaration["source"],
	kinds: readonly string[],
	scopes: ReadonlySet<HostEventScopeKey>,
): string | undefined {
	if (kinds.length === 0) return "names no event kind";
	if (kinds.length > HOST_EVENT_LISTENER_LIMITS.maxKinds)
		return `names more than ${HOST_EVENT_LISTENER_LIMITS.maxKinds} event kinds`;
	if (new Set(kinds).size !== kinds.length) return "names an event kind twice";
	for (const kind of kinds) {
		if (!isHostEventKind(kind) || HOST_EVENT_KINDS[kind].source !== source)
			return `names ${JSON.stringify(kind)}, which is not a ${source} event kind`;
		const declaration = HOST_EVENT_KINDS[kind];
		for (const scope of scopes)
			if (!declaration.scope.includes(scope)) return `scopes ${kind} by ${scope}, which it does not have`;
		if (declaration.volume === "high" && !declaration.narrowedBy.some((scope) => scopes.has(scope)))
			return `listens to every ${kind} of the repository; name ${declaration.narrowedBy.join(", ")} to narrow it`;
	}
	return undefined;
}
