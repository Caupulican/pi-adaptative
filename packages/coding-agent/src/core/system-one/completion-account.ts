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
import { decideByAuthority } from "./authority-line.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import { ModelEvaluationBudgetError } from "./model-evaluation-batches.ts";
import type { CompletionRejectionDetail } from "./policy.ts";
import { type AddedSuppression, addedSuppressions } from "./suppression-scan.ts";
import type { ExecutionState } from "./types.ts";
import { unsettledQuestionId, verdictAt } from "./unsettled-ladder.ts";

export const COMPLETION_ACCOUNT_LIMITS = {
	changes: 50,
	pathsPerChange: 50,
	claims: 20,
	/** Targets of one change that System One reads it against. */
	servesJudged: 4,
	evidenceIdsPerClaim: 8,
	textChars: 600,
	pathChars: 400,
	/** Evidence ids listed back to the model when it must cite some. */
	listedEvidenceIds: 30,
} as const;

const evidenceIds = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
	minItems: 1,
	maxItems: COMPLETION_ACCOUNT_LIMITS.evidenceIdsPerClaim,
	description: "Ids of the goal evidence (or harness verification runs) the claim stands on, from `get`.",
});

const changePath = Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.pathChars });

export const completionAccountSchema = Type.Object(
	{
		changes: Type.Array(
			Type.Object(
				{
					path: Type.Union(
						[
							changePath,
							Type.Array(changePath, {
								minItems: 1,
								maxItems: COMPLETION_ACCOUNT_LIMITS.pathsPerChange,
								uniqueItems: true,
							}),
						],
						{
							description:
								"One changed file, or explicit changed paths sharing the same reason, requirements, and evidence. Every file is reviewed separately; no directories or globs.",
						},
					),
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
				description:
					"Every file the goal changed: what the change does and which requirement it serves. Group explicit paths with identical reasons to account for larger changes.",
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
					paths: Type.Optional(
						Type.Array(Type.String({ minLength: 1, maxLength: COMPLETION_ACCOUNT_LIMITS.pathChars }), {
							minItems: 1,
							maxItems: COMPLETION_ACCOUNT_LIMITS.changes,
							description:
								"Changed paths whose complete diffs establish this cause. Other paths still receive independent scope review. Omit to include every changed path; never shorten production code to fit a review budget.",
						}),
					),
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

type CompletionAccountInput = Static<typeof completionAccountSchema>;
type CompletionAccountChange = Omit<CompletionAccountInput["changes"][number], "path"> & { path: string };
export type CompletionAccount = Omit<CompletionAccountInput, "changes"> & { changes: CompletionAccountChange[] };

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
	if (Value.Check(completionAccountSchema, value))
		return {
			account: {
				...value,
				changes: value.changes.flatMap((entry) =>
					(typeof entry.path === "string" ? [entry.path] : entry.path).map((path) => ({ ...entry, path })),
				),
			},
		};
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
	/** Characters omitted from the captured work patch; its final file section may be partial. */
	readonly patchOmittedChars?: number;
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

/** Resolve one file identity; a shared suffix must never stand for several files. */
function resolvePath(path: string, candidates: readonly string[]): string | undefined {
	const normalized = normalizePath(path);
	const exact = candidates.filter((candidate) => normalizePath(candidate) === normalized);
	if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
	const suffix = candidates.filter((candidate) => {
		const other = normalizePath(candidate);
		return normalized.endsWith(`/${other}`) || other.endsWith(`/${normalized}`);
	});
	return suffix.length === 1 ? suffix[0] : undefined;
}

/** Keep observed repository identities; normalize an older recorded alias only when it is unique. */
export function completionChangedPaths(observed: readonly string[], recorded: readonly string[]): string[] {
	const paths = [...new Set(observed)];
	return [...new Set([...paths, ...recorded.map((path) => resolvePath(path, paths) ?? path)])];
}

/** The paths named by a patch's `diff --git` headers, preserving any repository qualification. */
export function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) paths.push(match[2] ?? match[1] ?? "");
	return paths.filter((path) => path.length > 0);
}

/** One changed file's complete part of the captured patch. */
export function diffForPath(patch: string, path: string, omittedChars = 0): string | undefined {
	const sections = patch.split(/^(?=diff --git )/m);
	const paths = sections.flatMap((candidate) => {
		const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(candidate);
		return header ? [header[2] ?? ""] : [];
	});
	const resolved = resolvePath(path, paths);
	if (resolved === undefined) return undefined;
	const section = sections.find((candidate) => /^diff --git a\/(.+?) b\/(.+)$/m.exec(candidate)?.[2] === resolved);
	if (section === undefined) return undefined;
	return omittedChars > 0 && section === sections.at(-1) ? undefined : section;
}

const MAX_CLAIM_PATCH_SLICE_CHARS = 16_000;

/**
 * Splits a single file's diff along hunk/line boundaries only when its serialized size would exceed
 * a single evaluation batch request, preserving every character of the diff across source-backed claims.
 */
function chunkFileDiffForBudget(fileDiff: string, maxChars = MAX_CLAIM_PATCH_SLICE_CHARS): readonly string[] {
	if (fileDiff.length <= maxChars) return [fileDiff];
	const lines = fileDiff.split("\n");
	const headerLines: string[] = [];
	let index = 0;
	while (index < lines.length && !lines[index]!.startsWith("@@ ")) {
		headerLines.push(lines[index]!);
		index++;
	}
	const header = headerLines.join("\n");
	const bodyLines = lines.slice(index);
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = header.length;
	for (const line of bodyLines) {
		if (current.length > 0 && currentLen + line.length + 1 > maxChars) {
			chunks.push(header ? `${header}\n${current.join("\n")}` : current.join("\n"));
			current = [];
			currentLen = header.length;
		}
		current.push(line);
		currentLen += line.length + 1;
	}
	if (current.length > 0) {
		chunks.push(header ? `${header}\n${current.join("\n")}` : current.join("\n"));
	}
	return chunks.length > 0 ? chunks : [fileDiff];
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

export const COMPLETION_ACCOUNT_GUIDANCE = `Complete repository work with \`account\`: { changes: [{ path, reason, serves: [requirement id or the file it supports], evidenceIds? }] for every changed file, assumptions: [{ claim, evidenceIds }], regressions: [{ path, evidenceIds }], cause: { claim, evidenceIds, paths? } for a bug fix. path may be a string or a list of up to ${COMPLETION_ACCOUNT_LIMITS.pathsPerChange} explicit paths sharing the same reason, serves, and evidenceIds; every file still receives its own scope review. Paths must identify one changed file each; no directories, globs, or ambiguous suffixes. Cite evidence ids from \`get\`. cause.paths selects complete changed-file diffs for the causal claim. Never shrink production code to fit review limits.`;

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
	if ((context.patchOmittedChars ?? 0) > 0)
		return {
			failures: [
				{
					id: "account_diff_incomplete",
					reason: "The repository diff is incomplete; a preview cannot establish completion.",
					required_next_proof:
						"Recapture complete work evidence against the original baseline. Do not shrink or minify production code to fit review limits.",
				},
			],
			claims: [],
		};
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
					required_next_proof: `${COMPLETION_ACCOUNT_GUIDANCE}${known.length ? ` Evidence ids you can cite: ${known.join(", ")}.` : " Record evidence first (add_evidence)."}`,
				},
			],
			claims: [],
		};
	}

	const failures: CompletionRejectionDetail[] = [];
	const claims: AccountClaim[] = [];
	const known = citedEvidenceIds(context.state);
	const changes = account.changes.flatMap((entry) => {
		const path = resolvePath(entry.path, context.changedPaths);
		if (path !== undefined) return [{ ...entry, path }];
		failures.push({
			id: `account_change_unknown:${normalizePath(entry.path)}`,
			reason: `\`${entry.path}\` does not identify one changed file.`,
			required_next_proof: "Name an exact changed path, or a suffix unique among the changed files.",
		});
		return [];
	});

	for (const changed of context.changedPaths) {
		if (!changes.some((entry) => entry.path === changed))
			failures.push({
				id: `account_change_unexplained:${normalizePath(changed)}`,
				reason: `\`${changed}\` changed and the account does not say why.`,
				required_next_proof: `Add { path: "${changed}", reason } to account.changes, or revert the change.`,
			});
	}

	const patchHeader = (path: string) =>
		diffForPath(context.patch, path, context.patchOmittedChars) ??
		"(this file is not in the captured patch, so its content was not captured)";
	for (const entry of changes) {
		// Which requirement a change serves is the model's call; that the requirement exists is code's.
		const unknown = entry.serves.filter((target) => {
			if (context.acceptance.some((criterion) => criterion.id === target)) return false;
			const targetPath = resolvePath(target, context.changedPaths);
			return targetPath === undefined || targetPath === entry.path;
		});
		if (unknown.length > 0)
			failures.push({
				id: `account_serves_unknown:${normalizePath(entry.path)}`,
				reason: `\`${entry.path}\` is said to serve ${unknown.map((target) => `\`${target}\``).join(", ")}, which is neither a requirement nor another changed file.`,
				required_next_proof: `Name a requirement id${context.acceptance.length ? ` (${context.acceptance.map((criterion) => criterion.id).join(", ")})` : ""} or the changed file it supports, or revert the change.`,
			});
		// Resolve once: a bounded patch can omit this file, so every claim can also use verified citations.
		const cited = (entry.evidenceIds ?? []).map((id) => ({ id, found: resolveEvidence(id, context.state) }));
		const unknownCited = cited.filter((item) => !item.found).map((item) => item.id);
		if (unknownCited.length > 0)
			failures.push({
				id: "account_unknown_evidence:scope",
				reason: `\`${entry.path}\`: no evidence has the id ${unknownCited.join(", ")}.`,
				required_next_proof: `Cite ids that exist${known.length ? `: ${known.join(", ")}` : "; record evidence first (add_evidence)"}.`,
			});
		const citedText = cited
			.flatMap((item) => (item.found?.verified ? [`${item.id}: ${item.found.text}`] : []))
			.join("\n");
		const slices = chunkFileDiffForBudget(patchHeader(entry.path));
		for (let sliceIdx = 0; sliceIdx < slices.length; sliceIdx++) {
			const partSuffix = slices.length > 1 ? ` (part ${sliceIdx + 1}/${slices.length})` : "";
			const changeEvidence = [slices[sliceIdx], citedText].filter(Boolean).join("\n");
			const evidence = `Change to ${entry.path}${partSuffix}:\n${changeEvidence}`;
			claims.push({
				topic: "scope",
				label: `change to ${entry.path}${partSuffix}`,
				statement: entry.reason,
				evidence,
				fingerprint: fingerprintOf(entry.reason, evidence),
			});
			// Whether the change serves its named requirement or another changed file uses the same evidence.
			for (const target of entry.serves.slice(0, COMPLETION_ACCOUNT_LIMITS.servesJudged)) {
				const criterion = context.acceptance.find((candidate) => candidate.id === target);
				const targetPath = resolvePath(target, context.changedPaths);
				const targetSlice = chunkFileDiffForBudget(patchHeader(target))[0] ?? "";
				const supported = criterion
					? {
							statement: `This change helps achieve: ${criterion.text}.`,
							evidence: changeEvidence,
						}
					: targetPath !== undefined
						? {
								statement: `This change is a dependency of the change to ${target}.`,
								evidence: `${evidence}\nChange to ${target}:\n${targetSlice}`,
							}
						: undefined;
				if (supported)
					claims.push({
						topic: "scope",
						label: `link of ${entry.path}${partSuffix} to ${target}`,
						...supported,
						fingerprint: fingerprintOf(supported.statement, supported.evidence),
					});
			}
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
			...found.map((entry) => `${entry.id}: ${entry.text}`),
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
			const causePaths = account.cause.paths ?? context.changedPaths;
			const unknownPaths = causePaths.filter((path) => resolvePath(path, context.changedPaths) === undefined);
			if (unknownPaths.length > 0) {
				failures.push({
					id: "account_cause_unknown_paths",
					reason: `Cause evidence names unchanged or ambiguous paths: ${unknownPaths.join(", ")}.`,
					required_next_proof:
						"Select changed paths that establish the mechanism, and cite verified evidence for surrounding unchanged code.",
				});
			}
			const cause = cited(
				"cause",
				"the stated cause",
				account.cause.claim,
				account.cause.evidenceIds,
				`The selected mechanism changes (other files receive independent scope review):\n${causePaths
					.map((path) => diffForPath(context.patch, path, context.patchOmittedChars) ?? "")
					.filter((diff) => diff.length > 0)
					.join("\n")}`,
			);
			// A fix that only silences the symptom leaves the stated cause in place. The same cited evidence and diff
			// are read against that second claim, sharing evidence within each bounded System One request.
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

interface AccountJudgment {
	refuted: readonly AccountClaim[];
	unsettled: readonly AccountClaim[];
	evidenceFailure?: CompletionRejectionDetail;
}

function probabilityOf(answer: unknown): number | undefined {
	const value = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Every claim is evaluated with its complete evidence. A claim is contradicted only on a decisive reading
 * against it (the same band the unsettled ladder settles on), supported when the evidence is read as showing
 * it and not as contradicting it, and otherwise unsettled: the evidence says nothing clear about it.
 */
export async function judgeAccountClaims(
	judge: AccountJudge,
	claims: readonly AccountClaim[],
	signal?: AbortSignal,
	config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
): Promise<{ refuted: AccountClaim[]; unsettled: AccountClaim[]; evidenceFailure?: CompletionRejectionDetail }> {
	if (claims.length === 0) return { refuted: [], unsettled: [] };
	let answers: Record<string, unknown>;
	try {
		answers = await judge.evaluateUnsettledItems(
			claims.map((claim) => ({ statement: claim.statement, evidence: claim.evidence })),
			signal,
		);
	} catch (error) {
		if (!(error instanceof ModelEvaluationBudgetError)) throw error;
		return {
			refuted: [],
			unsettled: [],
			evidenceFailure: {
				id: "account_evidence_oversized",
				reason: error.message,
				required_next_proof:
					"Use account.cause.paths to select the complete diffs needed for the mechanism, and concise verified evidence for the claim. Split an indivisible large claim into source-backed claims. This is an evidence-budget gap, not an evaluator outage or a reason to minify production code.",
			},
		};
	}
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
 * Unsettled account claims hold the objective transition. Repetition changes recovery guidance, never proof.
 */
export function accountOutcome(
	judged: AccountJudgment,
	passes: Map<string, number>,
): { failures: CompletionRejectionDetail[] } {
	if (judged.evidenceFailure) return { failures: [judged.evidenceFailure] };
	const failures: CompletionRejectionDetail[] = judged.refuted.map((claim) => ({
		id: `account_contradicted:${claim.topic}`,
		reason: `The evidence cited for the ${claim.label} contradicts the claim.`,
		required_next_proof:
			claim.topic === "mask"
				? "Reproduce the defect against the current code, revise the change so it removes the cause rather than silencing the symptom, run the check again, and cite that run."
				: "Correct the claim, or fix the work it describes.",
	}));
	for (const claim of judged.unsettled) {
		const count = (passes.get(claim.fingerprint) ?? 0) + 1;
		passes.set(claim.fingerprint, count);
		const decision = decideByAuthority("objective_transition", "ambiguous", count - 1);
		failures.push({
			id: `account_unsettled:${claim.topic}`,
			reason: `The evidence cited for the ${claim.label} does not settle the claim.`,
			required_next_proof:
				decision.action === "owner_question"
					? "The claim remains unresolved. Supply fresh verified evidence or correct the claim; repeating the same account cannot complete the objective."
					: claim.topic === "scope"
						? "Add evidenceIds to that change (evidence that shows it does what it serves), or rewrite its reason to say what its diff does."
						: claim.topic === "mask"
							? "Cite a run that reproduces the defect before the change and passes after it, so the cause is shown removed."
							: "Cite evidence that shows it directly, or run the check that does.",
		});
	}
	return { failures };
}
