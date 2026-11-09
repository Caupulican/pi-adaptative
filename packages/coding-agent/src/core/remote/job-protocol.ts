/**
 * The job frames of the link (`jobs/1`) and the capability advert (`cap/1`): exact schemas, every field bounded, every
 * frame rebuilt field by field so nothing a peer sends travels past this parser unchecked. Both features ride on
 * protocol 1 and only on a sealed link (`negotiateFeatures` drops them otherwise), so a peer on an older build keeps
 * chatting and never sees one of these frames. A job frame names a job by the id its placer minted; every store is keyed
 * by machine id plus job id, never by a name.
 *
 * What a peer writes here is third-party data: a label, an instruction, a progress line or a summary is shown fenced and
 * never steers this machine as the owner's words. Codes are closed sets, so a peer cannot invent a classification.
 */

import { createHash } from "node:crypto";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import {
	BLOCKER_CODES,
	type BlockerCode,
	OUTCOME_STATUSES,
	type OutcomeStatus,
} from "../delegation/worker-outcome-contract.ts";
import { boundedUtf8Text } from "../util/bounded-line.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import {
	type CapabilityFacts,
	COMMIT_SHA,
	isOneOf,
	parseCapabilityFacts,
	REPO_KEY,
	WIRE_WORD,
} from "./capabilities.ts";
import { WIRE_ID } from "./protocol.ts";

export const CAP_FEATURE = "cap/1";
export const JOBS_FEATURE = "jobs/1";

/** The longest job instruction, in UTF-8 bytes (the fleet's dispatch bound). */
export const MAX_JOB_INSTRUCTIONS_BYTES = 16 * 1024;
/** The longest outcome summary, in UTF-8 bytes (the managed lane's terminal bound). */
export const MAX_JOB_SUMMARY_BYTES = 8 * 1024;

/** The channel a placed job's worker turn names: its origin is the runner's own record, never a channel's message. */
const PLACED_JOB_CHANNEL = "link";

/**
 * A placed job's identity: the placing machine's id and the job id together, the key the job store records it under (a
 * placer may choose any job id, so the job id alone names no job).
 */
export function placedJobReference(placerId: string, jobId: string): string {
	return `${placerId}/${jobId}`;
}

/** The placer id and job id a reference names; undefined for a string that is not one. */
export function parsePlacedJobReference(reference: string): { placerId: string; jobId: string } | undefined {
	const separator = reference.lastIndexOf("/");
	return separator <= 0 || separator === reference.length - 1
		? undefined
		: { placerId: reference.slice(0, separator), jobId: reference.slice(separator + 1) };
}

/**
 * The turn origin a placed job's worker is dispatched with: a third party's words (the placing machine's), named by the
 * job's reference. Durable on the attempt's dispatch, so the worker is recognised after a restart with no other record.
 */
export function placedJobTurnOrigin(placerId: string, jobId: string): TurnOriginRecord {
	return {
		v: 1,
		k: "peer-agent",
		channel: PLACED_JOB_CHANNEL,
		verified: true,
		thirdParty: true,
		ref: placedJobReference(placerId, jobId),
	};
}

/** The placed job's reference a turn origin names when it is a placed job's, else undefined. Only the job runner mints it. */
export function placedJobRef(origin: TurnOriginRecord | undefined): string | undefined {
	return origin?.k === "peer-agent" && origin.channel === PLACED_JOB_CHANNEL && origin.thirdParty === true
		? origin.ref
		: undefined;
}

/**
 * A job's summary text within the summary bound. Text the bound cuts gets `note` after the part that fits, so the placer
 * sees that it was cut and where the whole text is kept; the cut is decided by bytes, and the note counts inside the bound.
 */
export function boundedJobSummary(text: string, note: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_JOB_SUMMARY_BYTES) return text;
	return boundedUtf8Text(text, MAX_JOB_SUMMARY_BYTES - Buffer.byteLength(note, "utf8")) + note;
}
export const MAX_JOB_LABEL_CHARS = 120;
export const MAX_PROGRESS_LINE_CHARS = 200;
/** A job placed by a machine that was itself running a placed job counts one hop; past this the offer is refused. */
export const MAX_JOB_HOPS = 2;
export const MAX_RESUME_ENTRIES = 256;
export const MIN_JOB_DEADLINE_MS = 60_000;
export const MAX_JOB_DEADLINE_MS = 24 * 60 * 60_000;
const MAX_SEQ = 1_000_000;

export const JOB_REFUSALS = [
	"no_room",
	"jobs_disabled",
	"writes_disabled",
	"unknown_repo",
	"base_missing",
	"needs_setup",
	"no_model",
	"peer_budget_out",
	"would_loop",
	"too_deep",
	"envelope_exceeds_ceiling",
	"bad_offer",
	"duplicate_conflict",
	"leader_unsupported",
] as const;
export type JobRefusal = (typeof JOB_REFUSALS)[number];

/**
 * Why a placed job is cancelled. The plan reasons are the fleet's own scope and step ends (`plan-executor.ts`: a plan's close,
 * a join that settled without the job, a step retired by a revision), so the executor records the real reason.
 * `marker_unreadable` is the reason of a stop whose cancel marker is damaged: the stop is kept, its reason is not known.
 */
export const JOB_CANCEL_REASONS = [
	"owner",
	"superseded",
	"deadline",
	"revoked",
	"plan_closed",
	"plan_join_settled",
	"plan_step_superseded",
	"plan_step_removed",
	"plan_step_cancelled",
	"marker_unreadable",
] as const;
export type JobCancelReason = (typeof JOB_CANCEL_REASONS)[number];

export const JOB_PHASES = ["queued", "preparing", "running", "finishing"] as const;
export type JobPhase = (typeof JOB_PHASES)[number];

export interface JobOffer {
	readonly jobId: string;
	readonly v: 1;
	/**
	 * `leader` is reserved for a remote leader; this build refuses it (`leader_unsupported`). `ask` is a conversation
	 * turn with a machine's own session: it travels as an ordinary chat message under the job's id, never as an offer,
	 * so an executor refuses an offer of this kind (`bad_offer`).
	 */
	readonly kind: "task" | "leader" | "ask";
	readonly label: string;
	readonly instructions: string;
	/** What the job may do there. `writes: false` is a read-only job: the worker reads the checkout and answers. */
	readonly envelope: { readonly writes: boolean };
	/** The checkout the job reads, by identity; absent for a job that needs no repository. */
	readonly repo?: { readonly repoKey: string; readonly baseSha?: string };
	/** The provider class the placer prefers; the executor chooses among its own models. */
	readonly model?: { readonly provider?: string; readonly modelClass?: string };
	/** How long the job may run once accepted, a duration (clocks of two machines are never compared). */
	readonly deadlineMs: number;
	/** Machine ids of every placer on the chain, the sender last. */
	readonly hops: readonly string[];
}

export interface JobOutcome {
	readonly status: OutcomeStatus;
	/** The executor's own classification, from the closed taxonomy; absent on a success. */
	readonly blockerCode?: BlockerCode;
	readonly summary: string;
	readonly usage?: { readonly costUsd?: number; readonly totalTokens?: number };
}

export interface JobResumeEntry {
	readonly jobId: string;
	/** The side the sender plays for this job. */
	readonly role: "placer" | "executor";
	readonly lastAckedSeq: number;
}

export type JobFrame =
	| { readonly t: "cap"; readonly facts: CapabilityFacts }
	| { readonly t: "job.offer"; readonly offer: JobOffer }
	| { readonly t: "job.accept"; readonly jobId: string }
	| {
			readonly t: "job.refuse";
			readonly jobId: string;
			readonly reason: JobRefusal;
			/** The stop the sender holds for a job it refuses to answer for (its record's cancel reason); absent when it holds none. */
			readonly cancel?: JobCancelReason;
	  }
	| {
			readonly t: "job.progress";
			readonly jobId: string;
			readonly seq: number;
			readonly phase: JobPhase;
			readonly line?: string;
	  }
	| { readonly t: "job.outcome"; readonly jobId: string; readonly seq: number; readonly outcome: JobOutcome }
	| { readonly t: "job.ack"; readonly jobId: string; readonly seq: number }
	| { readonly t: "job.cancel"; readonly jobId: string; readonly reason: JobCancelReason }
	| { readonly t: "job.resume"; readonly active: readonly JobResumeEntry[] };

/** One proven connection to another machine, as the job layer sees it: whichever side of the link this machine is. */
export interface LinkPeer {
	readonly machineId: string;
	/** The owner's label for the peer: the name the hub gave a joiner, or the hub's own name. */
	readonly name: string;
	/** What the peer is to this machine: the hub it joined, or a machine joined to its hub. */
	readonly role: "hub" | "joiner";
	readonly features: readonly string[];
	/** Writes one frame; false when the connection is gone, the frame passes the bound or its feature is not active. */
	send(frame: JobFrame): boolean;
}

/** What a link end tells the job layer: a peer proven, a peer gone, and every capability or job frame it received. */
export interface LinkPeerListener {
	up(peer: LinkPeer): void;
	down(machineId: string): void;
	receive(machineId: string, frame: JobFrame): void;
}

/** The feature a frame needs negotiated before either side may send or accept it. */
export function featureOfJobFrame(frame: JobFrame): typeof CAP_FEATURE | typeof JOBS_FEATURE {
	return frame.t === "cap" ? CAP_FEATURE : JOBS_FEATURE;
}

function utf8Within(value: unknown, maxBytes: number, allowEmpty = false): value is string {
	return (
		typeof value === "string" &&
		(allowEmpty || value.length > 0) &&
		value.length <= maxBytes &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

function isSeq(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SEQ;
}

function isId(value: unknown): value is string {
	return typeof value === "string" && WIRE_ID.test(value);
}

function parseOffer(value: unknown): JobOffer | undefined {
	if (!isPlainRecord(value) || value.v !== 1 || !isId(value.jobId)) return undefined;
	if (!isOneOf(["task", "leader", "ask"] as const, value.kind)) return undefined;
	if (!utf8Within(value.label, MAX_JOB_LABEL_CHARS * 4) || value.label.length > MAX_JOB_LABEL_CHARS) return undefined;
	if (!utf8Within(value.instructions, MAX_JOB_INSTRUCTIONS_BYTES)) return undefined;
	if (!isPlainRecord(value.envelope) || typeof value.envelope.writes !== "boolean") return undefined;
	if (
		typeof value.deadlineMs !== "number" ||
		!Number.isSafeInteger(value.deadlineMs) ||
		value.deadlineMs < MIN_JOB_DEADLINE_MS ||
		value.deadlineMs > MAX_JOB_DEADLINE_MS
	)
		return undefined;
	// One more than the bound parses, so the executor answers `too_deep` instead of a malformed offer.
	if (!Array.isArray(value.hops) || value.hops.length < 1 || value.hops.length > MAX_JOB_HOPS + 1) return undefined;
	if (!value.hops.every(isId)) return undefined;
	let repo: JobOffer["repo"];
	if (value.repo !== undefined) {
		if (!isPlainRecord(value.repo) || typeof value.repo.repoKey !== "string" || !REPO_KEY.test(value.repo.repoKey))
			return undefined;
		if (
			value.repo.baseSha !== undefined &&
			(typeof value.repo.baseSha !== "string" || !COMMIT_SHA.test(value.repo.baseSha))
		)
			return undefined;
		repo = {
			repoKey: value.repo.repoKey,
			...(typeof value.repo.baseSha === "string" ? { baseSha: value.repo.baseSha } : {}),
		};
	}
	let model: JobOffer["model"];
	if (value.model !== undefined) {
		if (!isPlainRecord(value.model)) return undefined;
		const { provider, modelClass } = value.model;
		if (provider !== undefined && (typeof provider !== "string" || !WIRE_WORD.test(provider))) return undefined;
		if (modelClass !== undefined && (typeof modelClass !== "string" || !WIRE_WORD.test(modelClass))) return undefined;
		model = {
			...(typeof provider === "string" ? { provider } : {}),
			...(typeof modelClass === "string" ? { modelClass } : {}),
		};
	}
	return {
		jobId: value.jobId,
		v: 1,
		kind: value.kind,
		label: value.label,
		instructions: value.instructions,
		envelope: { writes: value.envelope.writes },
		...(repo ? { repo } : {}),
		...(model ? { model } : {}),
		deadlineMs: value.deadlineMs,
		hops: value.hops as string[],
	};
}

function parseOutcome(value: unknown): JobOutcome | undefined {
	if (!isPlainRecord(value) || !isOneOf(OUTCOME_STATUSES, value.status)) return undefined;
	if (!utf8Within(value.summary, MAX_JOB_SUMMARY_BYTES, true)) return undefined;
	if (value.blockerCode !== undefined && !isOneOf(BLOCKER_CODES, value.blockerCode)) return undefined;
	let usage: JobOutcome["usage"];
	if (value.usage !== undefined) {
		if (!isPlainRecord(value.usage)) return undefined;
		const { costUsd, totalTokens } = value.usage;
		if (costUsd !== undefined && (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0))
			return undefined;
		if (
			totalTokens !== undefined &&
			(typeof totalTokens !== "number" || !Number.isSafeInteger(totalTokens) || totalTokens < 0)
		)
			return undefined;
		usage = {
			...(typeof costUsd === "number" ? { costUsd } : {}),
			...(typeof totalTokens === "number" ? { totalTokens } : {}),
		};
	}
	return {
		status: value.status,
		...(typeof value.blockerCode === "string" ? { blockerCode: value.blockerCode as BlockerCode } : {}),
		summary: value.summary,
		...(usage ? { usage } : {}),
	};
}

function parseResumeEntry(value: unknown): JobResumeEntry | undefined {
	return isPlainRecord(value) &&
		isId(value.jobId) &&
		isOneOf(["placer", "executor"] as const, value.role) &&
		typeof value.lastAckedSeq === "number" &&
		Number.isSafeInteger(value.lastAckedSeq) &&
		value.lastAckedSeq >= 0 &&
		value.lastAckedSeq <= MAX_SEQ
		? { jobId: value.jobId, role: value.role, lastAckedSeq: value.lastAckedSeq }
		: undefined;
}

/** A job or capability frame from a decoded record, or undefined for anything malformed or not one of them. */
export function parseJobFrame(value: unknown): JobFrame | undefined {
	if (!isPlainRecord(value) || typeof value.t !== "string") return undefined;
	switch (value.t) {
		case "cap": {
			const facts = parseCapabilityFacts(value.facts);
			return facts ? { t: "cap", facts } : undefined;
		}
		case "job.offer": {
			const offer = parseOffer(value.offer);
			return offer ? { t: "job.offer", offer } : undefined;
		}
		case "job.accept":
			return isId(value.jobId) ? { t: "job.accept", jobId: value.jobId } : undefined;
		case "job.refuse": {
			if (!isId(value.jobId) || !isOneOf(JOB_REFUSALS, value.reason)) return undefined;
			// The stop is optional, and a reason outside the closed set is no reason: the refusal itself still parses.
			const cancel = isOneOf(JOB_CANCEL_REASONS, value.cancel) ? value.cancel : undefined;
			return {
				t: "job.refuse",
				jobId: value.jobId,
				reason: value.reason,
				...(cancel ? { cancel } : {}),
			};
		}
		case "job.progress":
			if (!isId(value.jobId) || !isSeq(value.seq) || !isOneOf(JOB_PHASES, value.phase)) return undefined;
			if (value.line !== undefined && !utf8Within(value.line, MAX_PROGRESS_LINE_CHARS * 4)) return undefined;
			if (typeof value.line === "string" && value.line.length > MAX_PROGRESS_LINE_CHARS) return undefined;
			return {
				t: "job.progress",
				jobId: value.jobId,
				seq: value.seq,
				phase: value.phase,
				...(typeof value.line === "string" ? { line: value.line } : {}),
			};
		case "job.outcome": {
			const outcome = parseOutcome(value.outcome);
			return isId(value.jobId) && isSeq(value.seq) && outcome
				? { t: "job.outcome", jobId: value.jobId, seq: value.seq, outcome }
				: undefined;
		}
		case "job.ack":
			return isId(value.jobId) && isSeq(value.seq)
				? { t: "job.ack", jobId: value.jobId, seq: value.seq }
				: undefined;
		case "job.cancel":
			return isId(value.jobId) && isOneOf(JOB_CANCEL_REASONS, value.reason)
				? { t: "job.cancel", jobId: value.jobId, reason: value.reason }
				: undefined;
		case "job.resume": {
			if (!Array.isArray(value.active) || value.active.length > MAX_RESUME_ENTRIES) return undefined;
			const active = value.active.map(parseResumeEntry);
			return active.every((entry) => entry !== undefined)
				? { t: "job.resume", active: active as JobResumeEntry[] }
				: undefined;
		}
		default:
			return undefined;
	}
}

/**
 * The digest an offer is admitted under. The parser rebuilds an offer in one fixed key order, so the same offer sent
 * twice (a resend after a lost link) digests the same, and a different offer under a reused job id does not.
 */
export function digestOffer(offer: JobOffer): string {
	return createHash("sha256")
		.update(`job-offer/1|${JSON.stringify(parseOffer(offer) ?? offer)}`)
		.digest("hex");
}

/** The digest an outcome is applied under: a second, different outcome for one job is a conflict, never a replacement. */
export function digestOutcome(outcome: JobOutcome): string {
	return createHash("sha256")
		.update(`job-outcome/1|${JSON.stringify(parseOutcome(outcome) ?? outcome)}`)
		.digest("hex");
}
