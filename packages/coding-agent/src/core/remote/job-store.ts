/**
 * The durable job stores of the link, under `<agentDir>/remote/jobs/`, one file per job so a plain directory watch sees
 * every change and two sessions never rewrite each other's jobs:
 *
 * - `out/`: a job this machine placed on a peer (the placer's record), keyed `<executorId>.<jobId>`. The owning session
 *   writes it `pending`; whichever session or channel host holds the link to the peer sends it; the owning session applies
 *   the end.
 * - `in/`: a job a peer placed here (the executor's record), keyed `<placerId>.<jobId>`. Created at most once per placer and
 *   job id, with the digest of the offer it admitted: the same offer again is a replay, a different one a conflict. Its
 *   outbox keeps every progress and outcome frame until the placer acknowledges it.
 * - `journal.jsonl`: one line per transition (ids, codes and counts only), bounded by rotation.
 * - `runner.json`: the session that runs placed jobs here, with its model access and room.
 *
 * A record's file is `<machineTag>.<jobId>.json` (`recordFileName`): its machine id as lowercase hex, so a record this build
 * cannot read still names the machine it is with. Every change is a read, change and atomic replace under the record's own lock.
 *
 * A record this build cannot read is never overwritten and never taken for an absent one. A stop of such a record is kept beside
 * it as a cancel marker, `<machineTag>.<jobId>.cancel`, holding only the cancel reason code (`markPath`): the readers honor it
 * until the record reads again (the cancel is then applied to the record and the marker removed) or the record is removed. A marker that is
 * damaged is still that stop, with the reason `marker_unreadable`: damage never drops a stop.
 *
 * File-name budget: ids are at most 64 characters (`WIRE_ID`), so the longest name is 128 hex + 1 + 64 + `.cancel` (7) = 200
 * bytes, and the longest temporary name (`<file>.<pid>.<uuid>.tmp`, a pid of up to seven digits) adds 49, for 249 bytes.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { isProcessOwnerRecord, ownProcessOwner, type ProcessOwner } from "../../kernel/reliability/owner-identity.ts";
import { withFileLockSync, writeFileAtomicSync } from "../util/atomic-file.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { liveRunnerAdvert, type ModelFact, type RunnerAdvert } from "./capabilities.ts";
import {
	digestOutcome,
	JOB_CANCEL_REASONS,
	JOB_REFUSALS,
	type JobCancelReason,
	type JobFrame,
	type JobOffer,
	type JobOutcome,
	type JobPhase,
	type JobRefusal,
	parseJobFrame,
	parsePlacedJobReference,
	placedJobReference,
} from "./job-protocol.ts";
import { WIRE_ID } from "./protocol.ts";

/**
 * How a placed job ended on the placer's side without an outcome from the executor. `plan_stopped` is a fleet stop that is
 * not the owner's (a plan closed, a join settled without the job, a step retired); the record's cancel reason names which.
 */
export const PLACER_ENDINGS = [
	"machine_offline",
	"machine_revoked",
	"remote_lost",
	"remote_deadline",
	"owner_cancelled",
	"plan_stopped",
	"stop_unreadable",
] as const;
export type PlacerEnding = (typeof PLACER_ENDINGS)[number];

/**
 * The placer's ending for a cancel: the owner's stop, the deadline, a revoke, a stop whose reason a damaged marker lost, or else the
 * plan's own stop.
 */
export function endingOfCancel(reason: JobCancelReason): PlacerEnding {
	if (reason === "owner") return "owner_cancelled";
	if (reason === "deadline") return "remote_deadline";
	if (reason === "revoked") return "machine_revoked";
	if (reason === "marker_unreadable") return "stop_unreadable";
	return "plan_stopped";
}

export type PlacerJobState = "pending" | "accepted" | "refused" | "terminal" | "ended";

/** The structured key a placed job was placed under: the placement's idempotency key and, for a plan step, the step. */
export interface PlacementKey {
	readonly idempotencyKey: string;
	readonly plan?: { readonly planId: string; readonly nodeId: string; readonly version: number };
}

export interface PlacerJobRecord {
	readonly v: 1;
	readonly jobId: string;
	readonly executorId: string;
	/** The owner's label for the executor when the job was placed. */
	readonly executorName: string;
	/** The session that placed the job and applies its end. */
	readonly ownerSession: string;
	readonly laneId: string;
	/** The managed lane's attempt, written at placement. Absent on a record a replayed dispatch wrote, or an older build's. */
	readonly attemptId?: string;
	/** Absent on a record an older build wrote: such a record is found through the machine hash alone. */
	readonly placement?: PlacementKey;
	readonly offer: JobOffer;
	readonly offerDigest: string;
	readonly state: PlacerJobState;
	/** Placer clock, epoch milliseconds. */
	readonly createdAt: number;
	/** Placer clock: the lane ends here whatever the executor says. */
	readonly deadlineAt: number;
	readonly refusal?: JobRefusal;
	readonly progress?: { readonly seq: number; readonly phase: JobPhase; readonly line?: string };
	/** The highest executor frame number this record holds (acknowledged). */
	readonly lastSeq: number;
	readonly outcome?: JobOutcome;
	readonly outcomeDigest?: string;
	/** A second outcome with another digest arrived after the first; it was kept out. */
	readonly conflict?: true;
	readonly ending?: PlacerEnding;
	readonly cancel?: JobCancelReason;
	readonly cancelSent?: true;
	/** The managed lane holds the end; nothing more is applied. */
	readonly appliedAt?: number;
}

export type ExecutorJobState = "admitted" | "running" | "terminal";

export interface OutboxEntry {
	readonly seq: number;
	readonly frame: Extract<JobFrame, { t: "job.progress" | "job.outcome" }>;
}

export interface ExecutorJobRecord {
	readonly v: 1;
	readonly placerId: string;
	readonly placerName: string;
	readonly jobId: string;
	readonly offer: JobOffer;
	readonly offerDigest: string;
	readonly state: ExecutorJobState;
	/** Executor clock. */
	readonly admittedAt: number;
	readonly deadlineAt: number;
	/** The offered checkout the job reads, matched by identity at admission. */
	readonly checkout?: string;
	/** The session running the job; a dead runner's job ends as interrupted. */
	readonly runner?: ProcessOwner;
	/** The empty directory an answer-only job starts in, recorded so a restarted runner removes it. */
	readonly workspace?: string;
	readonly laneId?: string;
	/** The last frame number assigned. */
	readonly seq: number;
	readonly outbox: readonly OutboxEntry[];
	readonly ackedSeq: number;
	readonly cancel?: JobCancelReason;
}

const MAX_OUTBOX = 64;
const JOURNAL_MAX_BYTES = 512 * 1024;
/** A finished record is kept this long for replay detection, then removed by the next scan. */
const FINISHED_RETENTION_MS = 7 * 24 * 60 * 60_000;

export const jobsDir = (agentDir: string): string => join(agentDir, "remote", "jobs");
export const outDir = (agentDir: string): string => join(jobsDir(agentDir), "out");
export const inDir = (agentDir: string): string => join(jobsDir(agentDir), "in");

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlanVersion(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** The placement key as a record stores it: a bounded idempotency key and, when present, its plan step. Invalid keys are dropped. */
function placementOf(value: unknown): PlacementKey | undefined {
	if (!isPlainRecord(value)) return undefined;
	const { idempotencyKey, plan } = value;
	if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0 || idempotencyKey.length > 512)
		return undefined;
	if (plan === undefined) return { idempotencyKey };
	if (
		!isPlainRecord(plan) ||
		typeof plan.planId !== "string" ||
		typeof plan.nodeId !== "string" ||
		!isPlanVersion(plan.version)
	)
		return undefined;
	return { idempotencyKey, plan: { planId: plan.planId, nodeId: plan.nodeId, version: plan.version } };
}

function offerOf(value: unknown): JobOffer | undefined {
	const frame = parseJobFrame({ t: "job.offer", offer: value });
	return frame?.t === "job.offer" ? frame.offer : undefined;
}

function outcomeOf(value: unknown): JobOutcome | undefined {
	const frame = parseJobFrame({ t: "job.outcome", jobId: "x", seq: 1, outcome: value });
	return frame?.t === "job.outcome" ? frame.outcome : undefined;
}

function pickOne<T extends string>(values: readonly T[], value: unknown): T | undefined {
	return values.find((entry) => entry === value);
}

function parsePlacerRecord(value: unknown): PlacerJobRecord | undefined {
	if (!isPlainRecord(value) || value.v !== 1) return undefined;
	const offer = offerOf(value.offer);
	const state = pickOne(["pending", "accepted", "refused", "terminal", "ended"] as const, value.state);
	const strings = [
		value.jobId,
		value.executorId,
		value.executorName,
		value.ownerSession,
		value.laneId,
		value.offerDigest,
	];
	if (!offer || !state || !strings.every((entry) => typeof entry === "string")) return undefined;
	if (!isCount(value.createdAt) || !isCount(value.deadlineAt) || !isCount(value.lastSeq)) return undefined;
	const progressFrame = isPlainRecord(value.progress)
		? parseJobFrame({ t: "job.progress", jobId: offer.jobId, ...value.progress })
		: undefined;
	const outcome = value.outcome === undefined ? undefined : outcomeOf(value.outcome);
	const refusal = pickOne(JOB_REFUSALS, value.refusal);
	const ending = pickOne(PLACER_ENDINGS, value.ending);
	const cancel = pickOne(JOB_CANCEL_REASONS, value.cancel);
	const placement = placementOf(value.placement);
	return {
		v: 1,
		jobId: value.jobId as string,
		executorId: value.executorId as string,
		executorName: value.executorName as string,
		ownerSession: value.ownerSession as string,
		laneId: value.laneId as string,
		offer,
		offerDigest: value.offerDigest as string,
		state,
		createdAt: value.createdAt,
		deadlineAt: value.deadlineAt,
		...(refusal ? { refusal } : {}),
		...(progressFrame?.t === "job.progress"
			? {
					progress: {
						seq: progressFrame.seq,
						phase: progressFrame.phase,
						...(progressFrame.line ? { line: progressFrame.line } : {}),
					},
				}
			: {}),
		lastSeq: value.lastSeq,
		...(outcome ? { outcome, outcomeDigest: digestOutcome(outcome) } : {}),
		...(value.conflict === true ? { conflict: true as const } : {}),
		...(ending ? { ending } : {}),
		...(cancel ? { cancel } : {}),
		...(value.cancelSent === true ? { cancelSent: true as const } : {}),
		...(isCount(value.appliedAt) ? { appliedAt: value.appliedAt } : {}),
		...(typeof value.attemptId === "string" && value.attemptId.length > 0 ? { attemptId: value.attemptId } : {}),
		...(placement ? { placement } : {}),
	};
}

function parseOutboxEntry(value: unknown): OutboxEntry | undefined {
	if (!isPlainRecord(value) || !isCount(value.seq)) return undefined;
	const frame = parseJobFrame(value.frame);
	return frame && (frame.t === "job.progress" || frame.t === "job.outcome") && frame.seq === value.seq
		? { seq: value.seq, frame }
		: undefined;
}

function parseExecutorRecord(value: unknown): ExecutorJobRecord | undefined {
	if (!isPlainRecord(value) || value.v !== 1) return undefined;
	const offer = offerOf(value.offer);
	const state = pickOne(["admitted", "running", "terminal"] as const, value.state);
	const strings = [value.placerId, value.placerName, value.jobId, value.offerDigest];
	if (!offer || !state || !strings.every((entry) => typeof entry === "string")) return undefined;
	if (!isCount(value.admittedAt) || !isCount(value.deadlineAt) || !isCount(value.seq) || !isCount(value.ackedSeq))
		return undefined;
	const outbox = Array.isArray(value.outbox) ? value.outbox.map(parseOutboxEntry) : [];
	if (!outbox.every((entry) => entry !== undefined)) return undefined;
	const cancel = pickOne(JOB_CANCEL_REASONS, value.cancel);
	return {
		v: 1,
		placerId: value.placerId as string,
		placerName: value.placerName as string,
		jobId: value.jobId as string,
		offer,
		offerDigest: value.offerDigest as string,
		state,
		admittedAt: value.admittedAt,
		deadlineAt: value.deadlineAt,
		...(typeof value.checkout === "string" ? { checkout: value.checkout } : {}),
		...(isProcessOwnerRecord(value.runner) ? { runner: value.runner } : {}),
		...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
		...(typeof value.laneId === "string" ? { laneId: value.laneId } : {}),
		seq: value.seq,
		outbox: outbox as OutboxEntry[],
		ackedSeq: value.ackedSeq,
		...(cancel ? { cancel } : {}),
	};
}

/**
 * What a record file holds, read now. `absent` only when no file exists. `unreadable` when a file exists that this build does not
 * parse as its record (damaged, or another build's format): an unreadable record is never taken for an absent one.
 */
export type RecordRead<T> =
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable" }
	| { readonly kind: "valid"; readonly record: T };

/** What a record name holds after a create: a readable record (written now, or the one already there), or an unreadable file. */
export type RecordCreate<T> = { readonly kind: "valid"; readonly record: T } | { readonly kind: "unreadable" };

/**
 * A record file this build cannot read. `machineId` and `jobId` are the ones its file name holds; both are undefined for a file
 * whose name holds neither, which still counts for room but names no machine.
 */
export interface UnreadableRecord {
	readonly machineId: string | undefined;
	readonly jobId: string | undefined;
}

/**
 * A cancel marker a directory holds: the record it names (machine and job) and the reason it was cancelled with. It is present
 * whether or not the record it names reads; a reader decides what the marker does from the record's state.
 */
export interface CancelMark {
	readonly machineId: string;
	readonly jobId: string;
	readonly reason: JobCancelReason;
}

/** One directory read in full: its readable records by logical name, every file it cannot read, and its cancel markers. */
export interface RecordScan<T> {
	readonly valid: ReadonlyMap<string, T>;
	readonly unreadable: readonly UnreadableRecord[];
	readonly marks: readonly CancelMark[];
}

/** The placed records of one synchronous pass (`JobStore.placedScan`). */
export type PlacedPass = RecordScan<PlacerJobRecord>;

/** The extension of a record file, and of the cancel marker kept beside it. */
const RECORD_EXTENSION = "json";
const CANCEL_EXTENSION = "cancel";
/** A record or marker file name: the machine id as lowercase hex, the job id, then the extension. */
const NAMED_FILE = /^((?:[0-9a-f]{2})+)\.([A-Za-z0-9_-]+)\.(json|cancel)$/;

/** The machine id and job id of a logical name `<machineId>.<jobId>`; undefined for a name that holds neither. */
function splitRecordName(name: string): { readonly machineId: string; readonly jobId: string } | undefined {
	const separator = name.lastIndexOf(".");
	if (separator < 0) return undefined;
	const machineId = name.slice(0, separator);
	const jobId = name.slice(separator + 1);
	return WIRE_ID.test(machineId) && WIRE_ID.test(jobId) ? { machineId, jobId } : undefined;
}

/**
 * The file a logical record name is stored under: `<machineTag>.<jobId>.<extension>`, the machine id as lowercase hex. Hex is a safe
 * file-name part on Windows and Linux (no reserved character, no case folding) and never spells a reserved device name. Neither part
 * holds a dot, so the file name parses back to its machine and job without reading the file (`parseNamedFile`).
 */
function recordFileName(name: string, extension: string = RECORD_EXTENSION): string {
	const parts = splitRecordName(name);
	if (parts === undefined) throw new Error("a job record name is a machine id and a job id");
	return `${Buffer.from(parts.machineId, "utf8").toString("hex")}.${parts.jobId}.${extension}`;
}

/**
 * The logical name, machine, job and extension a record or marker file name holds; undefined for a file name this build does not parse.
 */
function parseNamedFile(
	file: string,
):
	| { readonly name: string; readonly machineId: string; readonly jobId: string; readonly extension: string }
	| undefined {
	const match = NAMED_FILE.exec(file);
	if (!match) return undefined;
	const machineId = Buffer.from(match[1], "hex").toString("utf8");
	const jobId = match[2];
	return WIRE_ID.test(machineId) && WIRE_ID.test(jobId)
		? { name: `${machineId}.${jobId}`, machineId, jobId, extension: match[3] }
		: undefined;
}

/** Record files this build cannot read, already reported by path: each is reported once, until its file reads again. */
const reportedUnreadable = new Set<string>();

function reportUnreadable(path: string, side: "placer" | "executor", record: UnreadableRecord): void {
	if (reportedUnreadable.has(path)) return;
	reportedUnreadable.add(path);
	harnessLog.warn(
		"link",
		"a job record cannot be read by this build; it is left as it is and counted as an open job",
		{
			side,
			peer: record.machineId ?? "unknown",
			jobId: record.jobId ?? "unknown",
			file: basename(path),
		},
	);
}

/** The reason of a stop whose marker is damaged: the stop is kept, and its reason is not known. */
const MARKER_UNREADABLE: JobCancelReason = "marker_unreadable";

/** A damaged cancel marker is still a stop: its reason is `marker_unreadable`. Reported once, until it reads again. */
function reportUnreadableMark(path: string, side: "placer" | "executor"): void {
	if (reportedUnreadable.has(path)) return;
	reportedUnreadable.add(path);
	harnessLog.warn("link", "a job cancel marker cannot be read by this build; its stop is kept as marker_unreadable", {
		side,
		file: basename(path),
	});
}

/** One directory of JSON records, each changed only under its own file lock, keyed by logical name (`<machineId>.<jobId>`). */
class RecordDir<T> {
	readonly dir: string;
	private readonly side: "placer" | "executor";
	private readonly parse: (value: unknown) => T | undefined;

	constructor(dir: string, side: "placer" | "executor", parse: (value: unknown) => T | undefined) {
		this.dir = dir;
		this.side = side;
		this.parse = parse;
	}

	private path(name: string): string {
		return join(this.dir, recordFileName(name));
	}

	private markPath(name: string): string {
		return join(this.dir, recordFileName(name, CANCEL_EXTENSION));
	}

	/** What the record named `name` holds now. A file this build cannot read is reported once, until it reads again. */
	inspect(name: string): RecordRead<T> {
		const path = this.path(name);
		const state = this.parseFile(path);
		if (state.kind !== "unreadable") {
			reportedUnreadable.delete(path);
			return state;
		}
		const parts = splitRecordName(name);
		reportUnreadable(path, this.side, { machineId: parts?.machineId, jobId: parts?.jobId });
		return state;
	}

	private parseFile(path: string): RecordRead<T> {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			return isMissingPathError(error) ? { kind: "absent" } : { kind: "unreadable" };
		}
		try {
			const record = this.parse(JSON.parse(text));
			return record ? { kind: "valid", record } : { kind: "unreadable" };
		} catch {
			return { kind: "unreadable" };
		}
	}

	/** The record named `name` when it is readable; `undefined` for an absent one and for an unreadable one. */
	read(name: string): T | undefined {
		const state = this.inspect(name);
		return state.kind === "valid" ? state.record : undefined;
	}

	/**
	 * What the cancel marker beside the record named `name` holds. A marker that exists but holds no reason this build reads (damaged, or
	 * another build's) is still a stop: it is `damaged`, and its reason is `marker_unreadable`. Undefined when there is no marker. A damaged
	 * marker is reported once, until it reads again.
	 */
	private readMark(name: string): { readonly reason: JobCancelReason; readonly damaged: boolean } | undefined {
		const path = this.markPath(name);
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if (isMissingPathError(error)) return undefined;
			reportUnreadableMark(path, this.side);
			return { reason: MARKER_UNREADABLE, damaged: true };
		}
		const reason = pickOne(JOB_CANCEL_REASONS, text.trim());
		if (reason === undefined) {
			reportUnreadableMark(path, this.side);
			return { reason: MARKER_UNREADABLE, damaged: true };
		}
		reportedUnreadable.delete(path);
		return { reason, damaged: false };
	}

	/** The reason of the cancel marker beside the record named `name`, or undefined when there is none. A damaged marker's stop is `marker_unreadable`. */
	cancelMarkOf(name: string): JobCancelReason | undefined {
		return this.readMark(name)?.reason;
	}

	/** Keeps a stop for the record named `name` beside it, under the record's lock. The first readable stop kept is the one kept; a damaged marker is replaced. */
	private writeCancelMark(name: string, reason: JobCancelReason): void {
		const current = this.readMark(name);
		if (current !== undefined && !current.damaged) return;
		writeFileAtomicSync(this.markPath(name), `${reason}\n`, { mode: 0o600 });
	}

	/** Keeps a stop for a record this build cannot read, beside it. The record file itself is never written. */
	markCancel(name: string, reason: JobCancelReason): void {
		mkdirSync(this.dir, { recursive: true });
		withFileLockSync(this.path(name), () => this.writeCancelMark(name, reason));
	}

	/** Removes the cancel marker beside the record named `name`, if any. */
	clearCancelMark(name: string): void {
		const path = this.markPath(name);
		rmSync(path, { force: true });
		reportedUnreadable.delete(path);
	}

	/**
	 * Applies `change` to the record under its lock, as `update` does, with one difference: a record this build cannot read is not
	 * changed, and a cancel marker with `reason` is kept beside it instead, so a stop is never lost to an unreadable record. A readable
	 * record that is applied (or already ended) takes its marker away, since the stop now lives in the record.
	 */
	cancel(
		name: string,
		reason: JobCancelReason,
		change: (current: T) => T | undefined,
	): "changed" | "marked" | "unchanged" {
		mkdirSync(this.dir, { recursive: true });
		const path = this.path(name);
		return withFileLockSync(path, (): "changed" | "marked" | "unchanged" => {
			const state = this.inspect(name);
			if (state.kind === "unreadable") {
				this.writeCancelMark(name, reason);
				return "marked";
			}
			if (state.kind === "absent") return "unchanged";
			const next = change(state.record);
			this.clearCancelMark(name);
			if (next === undefined) return "unchanged";
			writeFileAtomicSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
			return "changed";
		});
	}

	/**
	 * The directory read in full, one file each. A file whose name holds no machine id and job id is unreadable and names no machine:
	 * it still counts (`unreadable`), and is reported. Cancel markers are read as they are, and every readable one is returned.
	 */
	scan(): RecordScan<T> {
		const valid = new Map<string, T>();
		const unreadable: UnreadableRecord[] = [];
		const marks: CancelMark[] = [];
		if (!existsSync(this.dir)) return { valid, unreadable, marks };
		for (const file of readdirSync(this.dir)) {
			const parsed = parseNamedFile(file);
			if (parsed === undefined) {
				if (!file.endsWith(`.${RECORD_EXTENSION}`)) continue;
				const entry = { machineId: undefined, jobId: undefined };
				reportUnreadable(join(this.dir, file), this.side, entry);
				unreadable.push(entry);
				continue;
			}
			if (parsed.extension === CANCEL_EXTENSION) {
				const reason = this.cancelMarkOf(parsed.name);
				if (reason !== undefined) marks.push({ machineId: parsed.machineId, jobId: parsed.jobId, reason });
				continue;
			}
			const state = this.inspect(parsed.name);
			if (state.kind === "valid") valid.set(parsed.name, state.record);
			else if (state.kind === "unreadable") unreadable.push({ machineId: parsed.machineId, jobId: parsed.jobId });
		}
		return { valid, unreadable, marks };
	}

	list(): T[] {
		return [...this.scan().valid.values()];
	}

	/** Applies `change` to the current record under its lock; `undefined` from `change` writes nothing. */
	update(name: string, change: (current: T | undefined) => T | undefined): T | undefined {
		mkdirSync(this.dir, { recursive: true });
		const path = this.path(name);
		return withFileLockSync(path, () => {
			const current = this.read(name);
			const next = change(current);
			if (next === undefined) return current;
			writeFileAtomicSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
			return next;
		});
	}

	/**
	 * Writes `record` under `name` unless the name holds a file, under the record's lock. Returns the record now held under the name: the
	 * record written, or the record already there. A file this build cannot read is never overwritten. A cancel marker beside an absent
	 * record belongs to a record that is gone, so it is removed before the new record is written.
	 */
	create(name: string, record: T): RecordCreate<T> {
		mkdirSync(this.dir, { recursive: true });
		const path = this.path(name);
		return withFileLockSync(path, (): RecordCreate<T> => {
			const current = this.inspect(name);
			if (current.kind !== "absent") return current;
			this.clearCancelMark(name);
			writeFileAtomicSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
			return { kind: "valid", record };
		});
	}

	/** Removes the record named `name` and the cancel marker beside it. */
	remove(name: string): void {
		rmSync(this.path(name), { force: true });
		this.clearCancelMark(name);
	}
}

export const executorRecordName = (placerId: string, jobId: string): string => `${placerId}.${jobId}`;
/** The placer's record name of a job placed on `executorId`. */
export const placedRecordName = (executorId: string, jobId: string): string => `${executorId}.${jobId}`;

/**
 * The placed records of each placed-job directory's current synchronous pass. Keyed by directory, not by store, so a write through
 * any store over the directory drops it for all of them.
 */
const placedPasses = new Map<string, PlacedPass>();

/** Both stores of one agent directory. */
export class JobStore {
	readonly agentDir: string;
	readonly out: RecordDir<PlacerJobRecord>;
	readonly in: RecordDir<ExecutorJobRecord>;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.out = new RecordDir(outDir(agentDir), "placer", parsePlacerRecord);
		this.in = new RecordDir(inDir(agentDir), "executor", parseExecutorRecord);
	}

	/**
	 * The placed records of this directory as one synchronous pass reads them: the directory is read once per pass, not once per
	 * call. A fleet pass reads every machine's room in turn; the pass ends with the microtask queue, since other processes write too.
	 */
	placedScan(): PlacedPass {
		const dir = this.out.dir;
		const cached = placedPasses.get(dir);
		if (cached) return cached;
		const pass = this.out.scan();
		placedPasses.set(dir, pass);
		queueMicrotask(() => {
			if (placedPasses.get(dir) === pass) placedPasses.delete(dir);
		});
		return pass;
	}

	/** Drops the directory's pass after a write to `out`: every store over the directory reads it again. */
	private dropPlacedPass(): void {
		placedPasses.delete(this.out.dir);
	}

	/**
	 * Placed jobs on `machineId` that are not sent yet: they will take that machine's room. An unreadable record may be one of them,
	 * so it counts for its machine; one whose name holds no machine counts for every machine, so no room is offered twice.
	 */
	pendingPlacedCount(machineId: string): number {
		const pass = this.placedScan();
		let pending = 0;
		for (const record of pass.valid.values())
			if (record.state === "pending" && record.executorId === machineId) pending += 1;
		for (const entry of pass.unreadable)
			if (entry.machineId === undefined || entry.machineId === machineId) pending += 1;
		return pending;
	}

	/** What the placer's record of the job `jobId` placed on `machineId` holds now. */
	placedState(machineId: string, jobId: string): RecordRead<PlacerJobRecord> {
		return this.out.inspect(placedRecordName(machineId, jobId));
	}

	/**
	 * The machine a placed job `jobId` was placed on, from the record that names it, readable or not; undefined when no record of
	 * this directory names it.
	 */
	placedMachineOf(jobId: string): string | undefined {
		const pass = this.placedScan();
		for (const record of pass.valid.values()) if (record.jobId === jobId) return record.executorId;
		return pass.unreadable.find((entry) => entry.jobId === jobId)?.machineId;
	}

	/**
	 * Creates the placer's record unless the job id already holds a file. Returns what the id holds afterwards: the record written,
	 * the record already there, or `unreadable` (a file this build cannot read is never overwritten).
	 */
	createPlaced(record: PlacerJobRecord): RecordCreate<PlacerJobRecord> {
		this.dropPlacedPass();
		return this.out.create(placedRecordName(record.executorId, record.jobId), record);
	}

	updatePlaced(
		machineId: string,
		jobId: string,
		change: (current: PlacerJobRecord) => PlacerJobRecord | undefined,
	): PlacerJobRecord | undefined {
		this.dropPlacedPass();
		return this.out.update(placedRecordName(machineId, jobId), (current) => (current ? change(current) : undefined));
	}

	/** Keeps a stop for a placed record this build cannot read (`cancel` in the placer's `out/`). */
	markPlacedCancel(machineId: string, jobId: string, reason: JobCancelReason): void {
		this.dropPlacedPass();
		this.out.markCancel(placedRecordName(machineId, jobId), reason);
	}

	/** Removes the cancel marker of a placed record, once the stop it carried is applied to the record. */
	clearPlacedCancelMark(machineId: string, jobId: string): void {
		this.dropPlacedPass();
		this.out.clearCancelMark(placedRecordName(machineId, jobId));
	}

	/** The cancel markers beside the placed records of this directory, in the current pass. */
	placedCancelMarks(): readonly CancelMark[] {
		return this.placedScan().marks;
	}

	/**
	 * Stops an admitted job of `placerId`: a readable record takes the cancel (unless it is finished or already cancelled); a record this
	 * build cannot read takes a cancel marker instead (`RecordDir.cancel`).
	 */
	cancelExecuted(placerId: string, jobId: string, reason: JobCancelReason): "changed" | "marked" | "unchanged" {
		return this.in.cancel(executorRecordName(placerId, jobId), reason, (current) =>
			current.state === "terminal" || current.cancel ? undefined : { ...current, cancel: reason },
		);
	}

	/** Stops every job `placerId` placed here: the readable records and the unreadable ones the store's files name for it. */
	cancelExecutedFrom(placerId: string, reason: JobCancelReason): void {
		const pass = this.in.scan();
		for (const record of pass.valid.values())
			if (record.placerId === placerId) this.cancelExecuted(placerId, record.jobId, reason);
		for (const entry of pass.unreadable)
			if (entry.machineId === placerId && entry.jobId !== undefined)
				this.cancelExecuted(placerId, entry.jobId, reason);
	}

	/**
	 * Admits a peer's offer at most once. A record for the placer and job id with the same digest is a replay (the
	 * placer resent it after a lost link); another digest under the same ids is a conflict and changes nothing. A record
	 * this build cannot read is never overwritten, and is `unreadable`: it is neither a replay nor a conflict this build can judge.
	 */
	admit(
		created: ExecutorJobRecord,
	):
		| { readonly kind: "admitted" | "replay"; readonly record: ExecutorJobRecord }
		| { readonly kind: "conflict" }
		| { readonly kind: "unreadable" } {
		const state = this.in.create(executorRecordName(created.placerId, created.jobId), created);
		if (state.kind === "unreadable") return { kind: "unreadable" };
		if (state.record === created) return { kind: "admitted", record: created };
		return state.record.offerDigest === created.offerDigest
			? { kind: "replay", record: state.record }
			: { kind: "conflict" };
	}

	updateExecuted(
		placerId: string,
		jobId: string,
		change: (current: ExecutorJobRecord) => ExecutorJobRecord | undefined,
	): ExecutorJobRecord | undefined {
		return this.in.update(executorRecordName(placerId, jobId), (current) => (current ? change(current) : undefined));
	}

	/** Appends one outbox frame with the next number; the outbox never holds more than its bound (oldest progress first). */
	appendOutbox(
		placerId: string,
		jobId: string,
		frame: (seq: number) => OutboxEntry["frame"],
		state?: ExecutorJobState,
	): ExecutorJobRecord | undefined {
		return this.updateExecuted(placerId, jobId, (current) => {
			if (current.state === "terminal") return undefined;
			const seq = current.seq + 1;
			let outbox = [...current.outbox, { seq, frame: frame(seq) }];
			while (outbox.length > MAX_OUTBOX) {
				const progress = outbox.findIndex((entry) => entry.frame.t === "job.progress");
				if (progress < 0) break;
				outbox = outbox.filter((_, index) => index !== progress);
			}
			return { ...current, seq, outbox, ...(state ? { state } : {}) };
		});
	}

	/**
	 * Removes finished records older than the retention, so replay detection stays bounded. A placed record is removed once applied and past
	 * retention, whether or not the executor has been acknowledged its outcome: an outcome that arrives later meets no record, and is
	 * acknowledged without being kept (`JobTransport`), so the executor's outbox drains.
	 */
	prune(now: number): void {
		this.dropPlacedPass();
		for (const [name, record] of this.out.scan().valid)
			if (record.appliedAt !== undefined && now - record.appliedAt > FINISHED_RETENTION_MS) this.out.remove(name);
		for (const record of this.prunable(now)) this.in.remove(executorRecordName(record.placerId, record.jobId));
	}

	/** The executor records `prune` removes at `now`: finished, outcome acknowledged by the placer, past retention. */
	prunable(now: number): ExecutorJobRecord[] {
		return this.in
			.list()
			.filter(
				(record) =>
					record.state === "terminal" &&
					record.outbox.length === 0 &&
					now - record.admittedAt > FINISHED_RETENTION_MS,
			);
	}
}

/** One journal line: who, which job, what happened; never a label, an instruction or a summary. */
export function journalJob(
	agentDir: string,
	entry: {
		readonly side: "placer" | "executor";
		readonly jobId: string;
		readonly peer: string;
		readonly event: string;
		readonly code?: string;
	},
): void {
	const path = join(jobsDir(agentDir), "journal.jsonl");
	try {
		mkdirSync(jobsDir(agentDir), { recursive: true });
		if (existsSync(path) && statSync(path).size > JOURNAL_MAX_BYTES) renameSync(path, `${path}.1`);
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
	} catch (error) {
		harnessLog.warn("link", "a job journal line could not be written", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
}

const runnerPath = (agentDir: string): string => join(jobsDir(agentDir), "runner.json");

/** Publishes the session that runs placed jobs here; a peer's advert reads it while that session is alive. */
export function publishRunner(agentDir: string, models: readonly ModelFact[], room: number): void {
	mkdirSync(jobsDir(agentDir), { recursive: true });
	writeFileAtomicSync(
		runnerPath(agentDir),
		`${JSON.stringify({ owner: ownProcessOwner(), models, room, updatedAt: new Date().toISOString() })}\n`,
		{ mode: 0o600 },
	);
}

export function readRunner(agentDir: string): RunnerAdvert | undefined {
	const path = runnerPath(agentDir);
	if (!existsSync(path)) return undefined;
	try {
		return liveRunnerAdvert(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

/**
 * Jobs admitted here from every placer and not finished yet, the unreadable records included: what an advert's room is reduced by.
 * An unreadable record may be a live job, so it counts; a room is never advertised over what this machine may still be running.
 */
export function activeExecutorJobs(store: JobStore): number {
	const scan = store.in.scan();
	let active = scan.unreadable.length;
	for (const record of scan.valid.values()) if (record.state !== "terminal") active += 1;
	return active;
}

/** The references of every placed job this agent directory's store records as ended (outcome recorded). */
export function finishedPlacedJobReferences(agentDir: string): string[] {
	if (!existsSync(inDir(agentDir))) return [];
	return new JobStore(agentDir).in
		.list()
		.filter((record) => record.state === "terminal")
		.map((record) => placedJobReference(record.placerId, record.jobId));
}

/**
 * Whether this agent directory's job store records the placed job named by `reference` as ended (its outcome is in the
 * outbox, or delivered). The store is keyed by placer and job id together, so both must match.
 */
export function placedJobFinished(agentDir: string, reference: string): boolean {
	const key = parsePlacedJobReference(reference);
	if (key === undefined || !existsSync(inDir(agentDir))) return false;
	return new JobStore(agentDir).in
		.list()
		.some((record) => record.placerId === key.placerId && record.jobId === key.jobId && record.state === "terminal");
}
