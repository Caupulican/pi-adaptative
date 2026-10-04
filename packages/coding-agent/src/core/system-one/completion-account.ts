/**
 * The completion account: what only the model that did the work can say, with evidence.
 *
 * Whether a change stays inside the objective, which assumptions it rested on, which paths it could
 * break and whether the cause of a defect was removed are questions of reasoning, and System One does
 * not reason. The model that made the change states each, citing the evidence it stands on; System
 * One decides a stated claim against that evidence (confirmed, contradicted, or neither), and code
 * decides everything else: that every changed path is accounted for, that every cited id exists and
 * that every claim rests on at least one piece of verified evidence.
 *
 * The questions stay fixed and catalogued (the model never authors one); the account is only state.
 */

import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { GATHER_MORE_LIMIT } from "./authority-line.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import type { CompletionRejectionDetail } from "./policy.ts";
import { type AddedSuppression, addedSuppressions } from "./suppression-scan.ts";
import type { ExecutionState } from "./types.ts";
import { unsettledQuestionId, verdictAt } from "./unsettled-ladder.ts";

export const COMPLETION_ACCOUNT_LIMITS = {
	changes: 50,
	claims: 20,
	/** Targets of one change that System One reads it against. */
	servesJudged: 4,
	evidenceIdsPerClaim: 8,
	textChars: 600,
	pathChars: 400,
	/** Per piece of evidence and per changed path's diff, as System One reads them. */
	evidenceChars: 1_500,
	diffChars: 2_500,
	/** Evidence ids listed back to the model when it must cite some. */
	listedEvidenceIds: 30,
} as const;

const evidenceIds = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
	minItems: 1,
	maxItems: COMPLETION_ACCOUNT_LIMITS.evidenceIdsPerClaim,
	description: "Ids of the goal evidence (or harness verification runs) the claim stands on, from `get`.",
});

export const completionAccountSchema = Type.Object(
	{
		changes: Type.Array(
			Type.Object(
				{
					path: Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.pathChars }),
					reason: Type.String({
						minLength: 1,
						maxLength: COMPLETION_ACCOUNT_LIMITS.textChars,
						description: "What the change does, in one sentence a reader of its diff can check.",
					}),
					evidenceIds: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
							maxItems: COMPLETION_ACCOUNT_LIMITS.evidenceIdsPerClaim,
							description:
								"Evidence ids (from `get`) that show the change does what it serves, when its diff alone does not.",
						}),
					),
					serves: Type.Array(Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.pathChars }), {
						minItems: 1,
						maxItems: COMPLETION_ACCOUNT_LIMITS.servesJudged,
						description:
							"The requirement ids (from `get`) this change serves, or the path of another changed file it is a dependency of.",
					}),
				},
				{ additionalProperties: false },
			),
			{
				maxItems: COMPLETION_ACCOUNT_LIMITS.changes,
				description: "Every file the goal changed: what the change does and which requirement it serves.",
			},
		),
		assumptions: Type.Array(
			Type.Object(
				{
					claim: Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.textChars }),
					evidenceIds,
				},
				{ additionalProperties: false },
			),
			{
				maxItems: COMPLETION_ACCOUNT_LIMITS.claims,
				description:
					"Each assumption the change relied on, with the evidence that establishes it. Empty when none.",
			},
		),
		regressions: Type.Array(
			Type.Object(
				{
					path: Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.textChars }),
					evidenceIds,
				},
				{ additionalProperties: false },
			),
			{
				maxItems: COMPLETION_ACCOUNT_LIMITS.claims,
				description:
					"Each behavior the change could plausibly break, with the evidence of the passing checks that exercise it. Empty when none.",
			},
		),
		cause: Type.Optional(
			Type.Object(
				{
					claim: Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.textChars }),
					evidenceIds,
				},
				{ additionalProperties: false },
			),
		),
	},
	{
		additionalProperties: false,
		description:
			"complete: your account of a goal that changed the repository. Needed so completion rests on your reasoning and your evidence, not on a guess about the diff. Cause is required for a bug fix: the defect's cause and how the change removes it.",
	},
);

export type CompletionAccount = Static<typeof completionAccountSchema>;

/**
 * What the goal tools advertise: a short shape only, because every request carries the tool schemas and the full
 * schema weighed about 700 tokens on each. The account is checked against {@link completionAccountSchema} when it
 * is used, and a malformed one is refused with the first thing wrong.
 */
export const completionAccountInputSchema = Type.Object(
	{},
	{
		additionalProperties: true,
	},
);

export function parseCompletionAccount(
	value: unknown,
): { readonly account: CompletionAccount } | { readonly error: string } {
	if (Value.Check(completionAccountSchema, value)) return { account: value };
	const first = Value.Errors(completionAccountSchema, value)[0];
	return {
		error: first ? `${first.instancePath || "account"}: ${first.message}` : "account does not match its shape",
	};
}

export type AccountTopic = "scope" | "assumption" | "regression" | "cause" | "mask";

/** One stated claim and the evidence System One reads it against. */
export interface AccountClaim {
	readonly topic: AccountTopic;
	/** Short name the refusal quotes. */
	readonly label: string;
	readonly statement: string;
	readonly evidence: string;
	/** Same claim over the same evidence: how many times it has already been left unsettled. */
	readonly fingerprint: string;
}

/** What the account is checked against: the host's own record of the work. */
export interface AccountContext {
	readonly objective: string;
	readonly acceptance: readonly { readonly id: string; readonly text: string }[];
	readonly changedPaths: readonly string[];
	readonly patch: string;
	/** Suppressions the whole work adds, scanned past the patch bound; read from `patch` when absent. */
	readonly suppressions?: readonly AddedSuppression[];
	readonly state: Pick<ExecutionState, "observations" | "verification">;
}

export interface AccountOptions {
	readonly repositoryOutcome: boolean;
	readonly isBugFix: boolean;
}

function normalizePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function samePath(left: string, right: string): boolean {
	const a = normalizePath(left);
	const b = normalizePath(right);
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** The repository-relative paths a patch changes, from its `diff --git` headers. */
export function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) paths.push(match[2] ?? match[1] ?? "");
	return paths.filter((path) => path.length > 0);
}

/** One changed file's part of the patch, bounded. */
export function diffForPath(patch: string, path: string): string | undefined {
	const sections = patch.split(/^(?=diff --git )/m);
	const section = sections.find((candidate) => {
		const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(candidate);
		return header !== null && samePath(header[2] ?? "", path);
	});
	return section?.slice(0, COMPLETION_ACCOUNT_LIMITS.diffChars);
}

interface ResolvedEvidence {
	readonly id: string;
	readonly text: string;
	readonly verified: boolean;
}

function resolveEvidence(id: string, state: AccountContext["state"]): ResolvedEvidence | undefined {
	const observation = state.observations.find((item) => item.id === id || item.id === `OBS-${id}`);
	if (observation) {
		return {
			id,
			text: `${observation.source.trust === "authoritative" ? "[verified]" : "[unverified summary]"} ${observation.text} (${observation.source.locator})`,
			verified: observation.source.trust === "authoritative" && observation.freshness !== "stale",
		};
	}
	const run = state.verification.find((item) => item.id === id);
	if (run) {
		return {
			id,
			text: `[harness verification ${run.status}] ${run.command ?? run.kind}`,
			verified: run.status === "passed",
		};
	}
	return undefined;
}

function citedEvidenceIds(state: AccountContext["state"]): string[] {
	return [
		...state.observations.map((observation) => observation.id.replace(/^OBS-/, "")),
		...state.verification.map((run) => run.id),
	].slice(0, COMPLETION_ACCOUNT_LIMITS.listedEvidenceIds);
}

/** An assumption accounts for a changed file when its claim names the file. */
function claimNamesPath(claim: string, path: string): boolean {
	const name = normalizePath(path).split("/").pop() ?? path;
	return claim.replaceAll("\\", "/").includes(name);
}

const ACCOUNT_SHAPE =
	"Call goal complete again with `account`: { changes: [{ path, reason, serves: [requirement id or the file it supports] }] for every changed file, assumptions: [{ claim, evidenceIds }], regressions: [{ path, evidenceIds }], cause: { claim, evidenceIds } for a bug fix }. Cite evidence ids from `get`.";

function fingerprintOf(statement: string, evidence: string): string {
	return createHash("sha256").update(statement).update("\u0000").update(evidence).digest("hex").slice(0, 16);
}

/**
 * Everything code can decide about an account, and the claims left for System One. A failure here is
 * one specific thing the model can fix; nothing is guessed about the diff.
 */
export function checkCompletionAccount(
	account: CompletionAccount | undefined,
	context: AccountContext,
	options: AccountOptions,
): { failures: CompletionRejectionDetail[]; claims: AccountClaim[] } {
	if (!options.repositoryOutcome) return { failures: [], claims: [] };
	if (!account) {
		const known = citedEvidenceIds(context.state);
		return {
			failures: [
				{
					id: "account_missing",
					reason:
						"The repository changed and completion has no account of it: why each change is needed, what it assumed, what it could break" +
						(options.isBugFix ? ", and the defect's cause" : "") +
						".",
					required_next_proof: `${ACCOUNT_SHAPE}${known.length ? ` Evidence ids you can cite: ${known.join(", ")}.` : " Record evidence first (add_evidence)."}`,
				},
			],
			claims: [],
		};
	}

	const failures: CompletionRejectionDetail[] = [];
	const claims: AccountClaim[] = [];
	const known = citedEvidenceIds(context.state);

	for (const changed of context.changedPaths) {
		if (!account.changes.some((entry) => samePath(entry.path, changed)))
			failures.push({
				id: `account_change_unexplained:${normalizePath(changed)}`,
				reason: `\`${changed}\` changed and the account does not say why.`,
				required_next_proof: `Add { path: "${changed}", reason } to account.changes, or revert the change.`,
			});
	}

	const patchHeader = (path: string) =>
		diffForPath(context.patch, path) ?? "(this file is not in the captured patch, so its content was not captured)";
	for (const entry of account.changes) {
		if (!context.changedPaths.some((changed) => samePath(entry.path, changed))) continue;
		// Which requirement a change serves is the model's call; that the requirement exists is code's.
		const unknown = entry.serves.filter(
			(target) =>
				!context.acceptance.some((criterion) => criterion.id === target) &&
				!context.changedPaths.some((changed) => samePath(changed, target) && !samePath(changed, entry.path)),
		);
		if (unknown.length > 0)
			failures.push({
				id: `account_serves_unknown:${normalizePath(entry.path)}`,
				reason: `\`${entry.path}\` is said to serve ${unknown.map((target) => `\`${target}\``).join(", ")}, which is neither a requirement nor another changed file.`,
				required_next_proof: `Name a requirement id${context.acceptance.length ? ` (${context.acceptance.map((criterion) => criterion.id).join(", ")})` : ""} or the changed file it supports, or revert the change.`,
			});
		// System One decides only whether the diff does what the model says it does.
		const evidence = `Change to ${entry.path}:\n${patchHeader(entry.path)}`;
		claims.push({
			topic: "scope",
			label: `change to ${entry.path}`,
			statement: entry.reason,
			evidence,
			fingerprint: fingerprintOf(entry.reason, evidence),
		});
		// And whether it does serve what the model says it serves: a requirement's text, or the other change.
		const cited = (entry.evidenceIds ?? []).map((id) => ({ id, found: resolveEvidence(id, context.state) }));
		const unknownCited = cited.filter((item) => !item.found).map((item) => item.id);
		if (unknownCited.length > 0)
			failures.push({
				id: "account_unknown_evidence:scope",
				reason: `\`${entry.path}\`: no evidence has the id ${unknownCited.join(", ")}.`,
				required_next_proof: `Cite ids that exist${known.length ? `: ${known.join(", ")}` : "; record evidence first (add_evidence)"}.`,
			});
		const citedText = cited
			.flatMap((item) =>
				item.found ? [`${item.id}: ${item.found.text.slice(0, COMPLETION_ACCOUNT_LIMITS.evidenceChars)}`] : [],
			)
			.join("\n");
		for (const target of entry.serves.slice(0, COMPLETION_ACCOUNT_LIMITS.servesJudged)) {
			const criterion = context.acceptance.find((candidate) => candidate.id === target);
			const supported = criterion
				? {
						statement: `This change helps achieve: ${criterion.text}.`,
						evidence: citedText ? `${patchHeader(entry.path)}\n${citedText}` : patchHeader(entry.path),
					}
				: context.changedPaths.some((changed) => samePath(changed, target))
					? {
							statement: `This change is a dependency of the change to ${target}.`,
							evidence: `Change to ${entry.path}:\n${patchHeader(entry.path)}\nChange to ${target}:\n${patchHeader(target)}`,
						}
					: undefined;
			if (supported)
				claims.push({
					topic: "scope",
					label: `link of ${entry.path} to ${target}`,
					...supported,
					fingerprint: fingerprintOf(supported.statement, supported.evidence),
				});
		}
	}

	const cited = (
		topic: AccountTopic,
		label: string,
		statement: string,
		ids: readonly string[],
		extraEvidence = "",
	): AccountClaim | undefined => {
		const resolved = ids.map((id) => ({ id, found: resolveEvidence(id, context.state) }));
		const unknown = resolved.filter((entry) => !entry.found).map((entry) => entry.id);
		if (unknown.length) {
			failures.push({
				id: `account_unknown_evidence:${topic}`,
				reason: `${label}: no evidence has the id ${unknown.join(", ")}.`,
				required_next_proof: `Cite ids that exist${known.length ? `: ${known.join(", ")}` : "; record evidence first (add_evidence)"}.`,
			});
			return undefined;
		}
		const found = resolved.flatMap((entry) => (entry.found ? [entry.found] : []));
		if (!found.some((entry) => entry.verified)) {
			failures.push({
				id: `account_unverified_evidence:${topic}`,
				reason: `${label}: none of the cited evidence is verified (a passing check, a verified tool, test or file result).`,
				required_next_proof: "Cite evidence the harness verified, or run the check that shows it.",
			});
			return undefined;
		}
		const evidence = [
			...found.map((entry) => `${entry.id}: ${entry.text.slice(0, COMPLETION_ACCOUNT_LIMITS.evidenceChars)}`),
			...(extraEvidence ? [extraEvidence] : []),
		].join("\n");
		const claim: AccountClaim = {
			topic,
			label,
			statement,
			evidence,
			fingerprint: fingerprintOf(statement, evidence),
		};
		claims.push(claim);
		return claim;
	};

	// A suppression hides what a check found. Code decides that each one is accounted for; System One reads the
	// assumption that accounts for it like any other, shown which suppression it answers.
	const suppressions = context.suppressions ?? addedSuppressions(context.patch);
	for (const path of new Set(suppressions.map((hit) => hit.path)))
		if (!account.assumptions.some((assumption) => claimNamesPath(assumption.claim, path))) {
			const hits = suppressions.filter((hit) => hit.path === path);
			failures.push({
				id: `account_suppression_unaccounted:${normalizePath(path)}`,
				reason: `\`${path}\` adds ${hits.length} lint or type-check suppression${hits.length === 1 ? "" : "s"}, first \`${hits[0]?.text}\`.`,
				required_next_proof: `Fix what the suppression silences and remove it, or add an assumption that names \`${path}\` with evidenceIds showing why the silenced rule does not apply here (skill root-cause-debugging).`,
			});
		}
	for (const assumption of account.assumptions)
		cited(
			"assumption",
			`assumption "${assumption.claim.slice(0, 80)}"`,
			assumption.claim,
			assumption.evidenceIds,
			suppressions
				.filter((hit) => claimNamesPath(assumption.claim, hit.path))
				.map((hit) => `The change adds the suppression \`${hit.directive}\` to ${hit.path}.`)
				.join("\n"),
		);
	for (const regression of account.regressions)
		cited(
			"regression",
			`regression path "${regression.path.slice(0, 80)}"`,
			`The behavior "${regression.path}" is exercised by passing checks`,
			regression.evidenceIds,
		);
	if (options.isBugFix) {
		if (!account.cause)
			failures.push({
				id: "account_cause_missing",
				reason: "A bug fix needs the defect's cause and how the change removes it.",
				required_next_proof: "Add account.cause: { claim, evidenceIds } (skill root-cause-debugging).",
			});
		else {
			const cause = cited(
				"cause",
				"the stated cause",
				account.cause.claim,
				account.cause.evidenceIds,
				`The change:\n${context.changedPaths
					.map((path) => diffForPath(context.patch, path) ?? "")
					.filter((diff) => diff.length > 0)
					.join("\n")}`,
			);
			// A fix that only silences the symptom leaves the stated cause in place. The same cited evidence and diff
			// are read against that second claim, in the same System One request: no extra call.
			if (cause) {
				const statement = `The diff changes the mechanism that the stated cause describes: "${account.cause.claim.slice(0, 300)}".`;
				claims.push({
					topic: "mask",
					label: "removal of the cause (the change is not only a symptom mask)",
					statement,
					evidence: cause.evidence,
					fingerprint: fingerprintOf(statement, cause.evidence),
				});
			}
		}
	}
	return { failures, claims };
}

/** Where the count of unsettled claims is kept, so a resumed session does not start asking again from zero. */
export interface AccountPassStore {
	read(): Readonly<Record<string, number>>;
	write(fingerprint: string, passes: number): void;
}

/** System One's side: the same fixed "does the evidence show it / contradict it" pair the unsettled ladder asks. */
export interface AccountJudge {
	evaluateUnsettledItems(
		checks: readonly { readonly statement: string; readonly evidence: string }[],
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

function probabilityOf(answer: unknown): number | undefined {
	const value = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Every claim in one request. A claim is contradicted only on a decisive reading against it (the same band the
 * unsettled ladder settles on), supported when the evidence is read as showing it and not as contradicting it,
 * and otherwise unsettled: the evidence says nothing clear about it.
 */
export async function judgeAccountClaims(
	judge: AccountJudge,
	claims: readonly AccountClaim[],
	signal?: AbortSignal,
	config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
): Promise<{ refuted: AccountClaim[]; unsettled: AccountClaim[] }> {
	if (claims.length === 0) return { refuted: [], unsettled: [] };
	const answers = await judge.evaluateUnsettledItems(
		claims.map((claim) => ({ statement: claim.statement, evidence: claim.evidence })),
		signal,
	);
	const refuted: AccountClaim[] = [];
	const unsettled: AccountClaim[] = [];
	claims.forEach((claim, index) => {
		if (verdictAt(answers, index) === "refuted") {
			refuted.push(claim);
			return;
		}
		const shown = probabilityOf(answers[unsettledQuestionId("shows_true", index)]);
		const contradicted = probabilityOf(answers[unsettledQuestionId("shows_false", index)]);
		const supported =
			shown !== undefined &&
			shown >= config.thresholds.completion.claim_supported_min &&
			(contradicted ?? 0) < config.thresholds.completion.claim_supported_min;
		if (!supported) unsettled.push(claim);
	});
	return { refuted, unsettled };
}

/**
 * What System One's reading of an account asks of the model. A contradicted claim refuses, naming it. A claim
 * the cited evidence does not settle asks for better evidence, at most {@link GATHER_MORE_LIMIT} times for the
 * same claim over the same evidence; after that it stands as a doubt shown with the completion, because the
 * model has reasoned and cited twice and System One has found nothing against it.
 */
export function accountOutcome(
	judged: { refuted: readonly AccountClaim[]; unsettled: readonly AccountClaim[] },
	passes: Map<string, number>,
): { failures: CompletionRejectionDetail[]; advisories: CompletionRejectionDetail[] } {
	const failures: CompletionRejectionDetail[] = judged.refuted.map((claim) => ({
		id: `account_contradicted:${claim.topic}`,
		reason: `The evidence cited for the ${claim.label} contradicts the claim.`,
		required_next_proof:
			claim.topic === "mask"
				? "Reproduce the defect against the current code, revise the change so it removes the cause rather than silencing the symptom, run the check again, and cite that run."
				: "Correct the claim, or fix the work it describes.",
	}));
	const advisories: CompletionRejectionDetail[] = [];
	for (const claim of judged.unsettled) {
		const count = (passes.get(claim.fingerprint) ?? 0) + 1;
		passes.set(claim.fingerprint, count);
		if (count <= GATHER_MORE_LIMIT)
			failures.push({
				id: `account_unsettled:${claim.topic}`,
				reason: `The evidence cited for the ${claim.label} does not settle the claim.`,
				required_next_proof:
					claim.topic === "scope"
						? "Add evidenceIds to that change (evidence that shows it does what it serves), or rewrite its reason to say what its diff does."
						: claim.topic === "mask"
							? "Cite a run that reproduces the defect before the change and passes after it, so the cause is shown removed."
							: "Cite evidence that shows it directly, or run the check that does.",
			});
		else
			advisories.push({
				id: `account_doubt:${claim.topic}`,
				reason: `The ${claim.label} stays unsettled after ${count - 1} evidence passes; it was reasoned and cited, and nothing contradicts it.`,
				required_next_proof: "None required; the doubt is recorded with the completion.",
			});
	}
	return { failures, advisories };
}
