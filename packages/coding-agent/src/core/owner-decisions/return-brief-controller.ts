/**
 * Watches typed owner messages and supplies the return brief for the first one after an idle gap. The brief is rendered
 * from code facts (the owner-decision queue, the plans and worker outcomes since the gap, the commits the repository
 * logged) and rides on the owner's turn as one transient record. Nothing here holds, refuses or delays a turn beyond
 * the bounded commit read that the brief waits for; a failed build warns and yields no brief.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import { withFileLockSync, writeFileAtomicSync } from "../../kernel/storage/atomic-file.ts";
import { stateFile } from "../agent-paths.ts";
import { outwardDraftStates } from "../agent-session-edge.ts";
import {
	type OwnerDecisionsStatus,
	ownerDecisionsSection,
	type SessionAutonomyStatus,
	type StatusSection,
} from "../autonomy-status/autonomy-status.ts";
import { isOutcomeFromNewerBuild } from "../delegation/worker-outcome-contract.ts";
import { getResumableHumanInputSnapshot } from "../human-input.ts";
import { ownerPasteRestorer } from "../learning/owner-evidence-ledger.ts";
import type { TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { isOwnerSpokenInputId, type OwnerInputDelivery, type OwnerInputLedger } from "../owner-input-ledger.ts";
import { listPlanViews } from "../plan/plan-view.ts";
import { actAheadRecordOf } from "../proactivity/act-ahead-record.ts";
import { ownerTypedText } from "../security/owner-paste-boundary.ts";
import type { SessionBranchEntrySource } from "../session-snapshot.ts";
import { ownerFollowUpPath, readOwnerFollowUps } from "../system-one/owner-question-routing.ts";
import type { LiveRunOrigin } from "../turn-origin.ts";
import { messageContentText } from "../util/message-content-text.ts";
import {
	advanceOwnerDecisionSeen,
	decodeOwnerDecisionSeen,
	type OwnerActAheadPort,
	type OwnerDecisionInputs,
	type OwnerDecisionItem,
	type OwnerDecisionSeenState,
	type OwnerWorkerQuestionPort,
	ownerDecisionQueue,
} from "./owner-decision-queue.ts";
import { type ReturnBriefFacts, type ReturnBriefPlan, renderReturnBrief } from "./return-brief.ts";

/** An owner who returns after this long without a typed message gets the brief. A constant: no setting. */
export const RETURN_BRIEF_IDLE_GAP_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 2_000;
const COMMITS_MAX = 20;
const WORDS = /[\p{L}\p{N}]/u;

const execFileAsync = promisify(execFile);

interface Commit {
	readonly sha: string;
	readonly subject: string;
}

/** The brief one owner turn was armed for. Its commit read starts at arming, so a plan rarely waits for it. */
interface ArmedBrief {
	readonly awaySince: number;
	readonly armedAt: number;
	readonly commits: Promise<readonly Commit[] | undefined>;
	/** The submission the brief belongs to: the first one that plans a request after arming. */
	epoch?: number;
	/** The render, made once and shared by every request of the turn. */
	rendering?: Promise<string | undefined>;
}

export interface ReturnBriefControllerDeps {
	getSessionId(): string;
	getAgentDir(): string;
	getCwd(): string;
	now(): number;
	readonly ownerInputs: Pick<OwnerInputLedger, "onDelivered">;
	readonly sessionManager: SessionBranchEntrySource & { getBranch(): readonly SessionEntry[] };
	/** The worker ledger's projection (plans, worker outcomes); undefined while no worker ledger is loaded. */
	taskProjection(): TaskRuntimeProjection | undefined;
	/** The foreground submission in progress; a brief belongs to the one that plans its first request. */
	currentSubmissionEpoch(): number | undefined;
	/** The run in progress and the origin that decided it: a held draft reads pending only while its owner's run is live. */
	liveRun(): LiveRunOrigin | undefined;
	warn(message: string): void;
}

/** The plan of a request with no brief to carry. It tracks nothing, so it never invalidates the request. */
const NO_BRIEF: ReturnBriefPlan = { content: undefined, isCurrent: () => true };

export class ReturnBriefController {
	private readonly deps: ReturnBriefControllerDeps;
	private readonly unsubscribe: () => void;
	private armed: ArmedBrief | undefined;

	constructor(deps: ReturnBriefControllerDeps) {
		this.deps = deps;
		this.unsubscribe = deps.ownerInputs.onDelivered((delivery) => this.onDelivered(delivery));
	}

	/**
	 * The brief for the request being planned. `content` is set only while the owner turn it was made for is the one in
	 * progress, and it is rendered and written once per turn.
	 */
	async previewReturnBrief(): Promise<ReturnBriefPlan> {
		const armed = this.armed;
		if (armed === undefined) return NO_BRIEF;
		armed.epoch ??= this.deps.currentSubmissionEpoch();
		const epoch = armed.epoch;
		const isCurrent = (): boolean =>
			this.armed === armed && epoch !== undefined && this.deps.currentSubmissionEpoch() === epoch;
		if (!isCurrent()) return NO_BRIEF;
		armed.rendering ??= this.render(armed).catch((error: unknown) => {
			this.deps.warn(`The return brief was not built: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		});
		const content = await armed.rendering;
		return isCurrent() ? { content, isCurrent } : NO_BRIEF;
	}

	/** The calls waiting on the owner now, most urgent first. The `/status` section reads it; nothing is written. */
	queue(): readonly OwnerDecisionItem[] {
		return ownerDecisionQueue(this.readQueueInputs(this.deps.sessionManager.getBranch()));
	}

	/** The status with its `ownerDecisions` section: the queue as it stands, read from the same stores the brief reads. */
	withOwnerDecisions(status: SessionAutonomyStatus): SessionAutonomyStatus {
		return { ...status, ownerDecisions: this.ownerDecisionsSection() };
	}

	/** A queue that cannot be read is an unavailable section with its reason; the rest of the status still reads. */
	private ownerDecisionsSection(): StatusSection<OwnerDecisionsStatus> {
		try {
			return ownerDecisionsSection(this.queue());
		} catch (error) {
			return {
				status: "unavailable",
				reason: `the waiting owner decisions could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	dispose(): void {
		this.unsubscribe();
		this.armed = undefined;
	}

	private onDelivered(delivery: OwnerInputDelivery): void {
		if (!isOwnerSpokenInputId(delivery.id) || delivery.message.role !== "user") return;
		try {
			const branch = this.deps.sessionManager.getBranch();
			const restore = ownerPasteRestorer(branch);
			const text = messageContentText(delivery.message.content);
			if (!hasTypedWords(text, restore, delivery.entryId)) return;
			const armedAt = this.deps.now();
			const awaySince = previousTypedOwnerAt(branch, delivery.id, restore);
			if (awaySince === undefined || armedAt - awaySince < RETURN_BRIEF_IDLE_GAP_MS) return;
			this.armed = { awaySince, armedAt, commits: readCommitsSince(this.deps.getCwd(), awaySince) };
		} catch (error) {
			this.deps.warn(`The return brief was not armed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async render(armed: ArmedBrief): Promise<string | undefined> {
		const commits = await armed.commits;
		const branch = this.deps.sessionManager.getBranch();
		const ledger = this.deps.taskProjection();
		const queue = ownerDecisionQueue(this.readQueueInputs(branch));
		const ci = ciSince(branch, armed.awaySince);
		const file = seenStateFile(this.deps.getAgentDir(), this.deps.getSessionId());
		return withFileLockSync(file, () => {
			const now = this.deps.now();
			const { state, newKeys } = advanceOwnerDecisionSeen(readSeenState(file), queue, now);
			const facts: ReturnBriefFacts = {
				awaySince: armed.awaySince,
				now: armed.armedAt,
				plansSettled: ledger === undefined ? [] : plansClosedSince(ledger, armed.awaySince),
				workerOutcomes: ledger === undefined ? {} : workerOutcomesSince(ledger, armed.awaySince),
				commits,
				...(ci === undefined ? {} : { ci }),
				queue,
				newKeys,
			};
			const text = renderReturnBrief(facts);
			// The seen state moves only when the owner is shown something: a brief with no text shows nothing new.
			if (text !== undefined) writeFileAtomicSync(file, `${JSON.stringify(state)}\n`);
			return text;
		});
	}

	private readQueueInputs(branch: readonly SessionEntry[]): OwnerDecisionInputs {
		const humanInput = getResumableHumanInputSnapshot(this.deps.sessionManager);
		const ledger = this.deps.taskProjection();
		const liveRun = this.deps.liveRun();
		return {
			drafts: outwardDraftStates(branch, liveRun?.origin.k === "owner-typed", liveRun ? { liveRun } : {}),
			...(humanInput === undefined ? {} : { humanInput }),
			workerQuestions: ledger === undefined ? [] : openWorkerQuestions(ledger, ownerSpokenTimes(branch)),
			plans: ledger === undefined ? [] : listPlanViews(ledger),
			followUps: readOwnerFollowUps(ownerFollowUpPath(this.deps.getAgentDir(), this.deps.getSessionId())),
			actAhead: latestActAhead(branch),
		};
	}
}

type OwnerPasteRestorer = ReturnType<typeof ownerPasteRestorer>;

/** Whether the owner's typed words (pasted spans elided) hold a letter or a digit. */
function hasTypedWords(text: string, restore: OwnerPasteRestorer, entryId: string | undefined): boolean {
	const pasted = restore(entryId, text);
	return WORDS.test(ownerTypedText({ text, ...(pasted ? { pasted } : {}) }));
}

/**
 * The epoch time of the owner's latest typed message before the one being delivered, or undefined when there is none. The
 * scan walks back from the end of the branch and stops at its first match, so the delivered entry itself is skipped.
 */
function previousTypedOwnerAt(
	branch: readonly SessionEntry[],
	deliveredId: string,
	restore: OwnerPasteRestorer,
): number | undefined {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry === undefined || entry.type !== "message" || entry.message.role !== "user") continue;
		const id = entry.ownerInputId;
		if (id === undefined || id === deliveredId || !isOwnerSpokenInputId(id)) continue;
		const text = messageContentText(entry.message.content);
		if (!hasTypedWords(text, restore, entry.id)) continue;
		const at = Date.parse(entry.timestamp);
		return Number.isFinite(at) ? at : undefined;
	}
	return undefined;
}

/** The epoch times of every owner-spoken user message on the branch: an owner message after an outcome answers it. */
function ownerSpokenTimes(branch: readonly SessionEntry[]): number[] {
	const times: number[] = [];
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		if (entry.ownerInputId === undefined || !isOwnerSpokenInputId(entry.ownerInputId)) continue;
		const at = Date.parse(entry.timestamp);
		if (Number.isFinite(at)) times.push(at);
	}
	return times;
}

/**
 * A worker question is open while its outcome is the latest one its task recorded and no owner message came after it.
 * The outcome's own recording time is the reference: an outcome carries no answered flag.
 */
function openWorkerQuestions(ledger: TaskRuntimeProjection, ownerTimes: readonly number[]): OwnerWorkerQuestionPort[] {
	const questions: OwnerWorkerQuestionPort[] = [];
	for (const task of Object.values(ledger.tasks)) {
		const outcome = task.outcome;
		if (outcome === undefined || isOutcomeFromNewerBuild(outcome) || outcome.nextAction.kind !== "ask_owner")
			continue;
		const recorded = Date.parse(outcome.recordedAt);
		if (ownerTimes.some((at) => at > recorded)) continue;
		questions.push({
			outcomeId: outcome.outcomeId,
			question: outcome.nextAction.question,
			at: outcome.recordedAt,
			...(outcome.taskId === undefined ? {} : { taskId: outcome.taskId }),
		});
	}
	return questions;
}

/** The latest act-ahead record of each episode on the branch, with whether its saved patch is still on disk. */
function latestActAhead(branch: readonly SessionEntry[]): OwnerActAheadPort[] {
	const latest = new Map<string, OwnerActAheadPort>();
	for (const entry of branch) {
		const record = actAheadRecordOf(entry);
		if (record === undefined) continue;
		const patchPresent = record.patchPath !== undefined && existsSync(record.patchPath);
		latest.set(record.episode, {
			episode: record.episode,
			phase: record.phase,
			at: entry.timestamp,
			patchPresent,
			...(record.patchPath === undefined ? {} : { patchPath: record.patchPath }),
		});
	}
	return [...latest.values()];
}

/**
 * The CI fact: an act-ahead episode that started from a CI log names a failing CI run. No other CI source exists in a
 * session, so the brief states CI only when such a record was written after the gap began.
 */
function ciSince(branch: readonly SessionEntry[], awaySince: number): { conclusion: string; at: number } | undefined {
	let latest: { conclusion: string; at: number } | undefined;
	for (const entry of branch) {
		const record = actAheadRecordOf(entry);
		const at = Date.parse(entry.timestamp);
		if (record?.basis !== "ci-log" || !(at > awaySince)) continue;
		latest = { conclusion: "failure", at };
	}
	return latest;
}

function plansClosedSince(
	ledger: TaskRuntimeProjection,
	awaySince: number,
): { planId: string; title: string; outcome: string }[] {
	return listPlanViews(ledger)
		.filter((view) => {
			const closedAt = Date.parse(ledger.plans[view.planId]?.closed?.closedAt ?? "");
			return closedAt > awaySince;
		})
		.map((view) => ({ planId: view.planId, title: view.title, outcome: view.closedReason ?? "closed" }));
}

function workerOutcomesSince(ledger: TaskRuntimeProjection, awaySince: number): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const task of Object.values(ledger.tasks)) {
		const outcome = task.outcome;
		if (outcome === undefined || isOutcomeFromNewerBuild(outcome)) continue;
		if (!(Date.parse(outcome.recordedAt) > awaySince)) continue;
		counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
	}
	return counts;
}

/** The repository's commits since the instant, newest first. Undefined when the log cannot be read: never zero. */
async function readCommitsSince(cwd: string, sinceMs: number): Promise<readonly Commit[] | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["log", `--since=@${Math.floor(sinceMs / 1000)}`, "-n", String(COMMITS_MAX), "--format=%h%x09%s"],
			{ cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
		);
		return stdout
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [sha = "", ...subject] = line.split("\t");
				return { sha, subject: subject.join("\t") };
			});
	} catch {
		return undefined;
	}
}

function seenStateFile(agentDir: string, sessionId: string): string {
	return stateFile(agentDir, "owner-decisions", `${sessionId}.json`);
}

/** The seen state on disk. A file this build cannot read counts as no state: every waiting call is then shown as new. */
function readSeenState(file: string): OwnerDecisionSeenState | undefined {
	if (!existsSync(file)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf-8"));
	} catch {
		return undefined;
	}
	return decodeOwnerDecisionSeen(parsed);
}
