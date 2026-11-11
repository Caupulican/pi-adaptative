/**
 * Watches typed owner messages and supplies the return brief for the first one after an idle gap. The brief is rendered
 * from code facts (the owner-decision queue, the plans and worker outcomes since the gap, the commits the repository
 * logged) and rides on the owner's turn as one transient record. Nothing here holds, refuses or delays a turn beyond
 * the bounded commit read that the brief waits for; a failed build warns and yields no brief.
 */

import { existsSync, readFileSync } from "node:fs";
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
import { execCommand, withoutInheritedGitLocation } from "../exec.ts";
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
	ownerMessageAnswers,
} from "./owner-decision-queue.ts";
import {
	type ReturnBriefCommits,
	type ReturnBriefFacts,
	type ReturnBriefPlan,
	renderReturnBrief,
} from "./return-brief.ts";

/** An owner who returns after this long without a typed message gets the brief. A constant: no setting. */
export const RETURN_BRIEF_IDLE_GAP_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 2_000;
const COMMITS_MAX = 20;
const WORDS = /[\p{L}\p{N}]/u;

/** The brief one owner turn was armed for. Its commit read starts at arming, so a plan rarely waits for it. */
interface ArmedBrief {
	readonly awaySince: number;
	readonly armedAt: number;
	/** The time of the owner message that armed the brief: the message a worker question must precede to be answered by it. */
	readonly messageAt: number;
	readonly commits: Promise<ReturnBriefCommits | undefined>;
	/** The submission the brief belongs to: the first one that plans a request after arming. */
	epoch?: number;
	/** The render, made once and shared by every request of the turn. */
	rendering?: Promise<RenderedBrief | undefined>;
}

/** A rendered brief and the queue items it showed, which the seen state records once a request carrying it is committed. */
interface RenderedBrief {
	readonly text: string;
	readonly shown: readonly OwnerDecisionItem[];
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
	 * progress, and it is rendered once per turn. Its seen state is written by `commit`, when the request carrying it is.
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
		const rendered = await armed.rendering;
		if (!isCurrent()) return NO_BRIEF;
		if (rendered === undefined) return { content: undefined, isCurrent };
		return { content: rendered.text, isCurrent, commit: () => this.markShown(rendered.shown) };
	}

	/** The calls waiting on the owner now, most urgent first. The `/status` section reads it; nothing is written. */
	queue(): readonly OwnerDecisionItem[] {
		const branch = this.deps.sessionManager.getBranch();
		return ownerDecisionQueue(this.readQueueInputs(branch, this.liveOwnerMessageAt(branch)));
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
			const delivered = branch.find((entry) => entry.id === delivery.entryId);
			const messageAt = Date.parse(delivered?.timestamp ?? "");
			if (!Number.isFinite(messageAt))
				throw new Error("the owner message is not on the session branch with a readable time");
			this.armed = {
				awaySince,
				armedAt,
				messageAt,
				commits: readCommitsSince(this.deps.getCwd(), awaySince),
			};
		} catch (error) {
			this.deps.warn(`The return brief was not armed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async render(armed: ArmedBrief): Promise<RenderedBrief | undefined> {
		const commits = await armed.commits;
		const branch = this.deps.sessionManager.getBranch();
		const ledger = this.deps.taskProjection();
		const queue = ownerDecisionQueue(this.readQueueInputs(branch, armed.messageAt));
		const ci = ciSince(branch, armed.awaySince);
		const { newKeys } = advanceOwnerDecisionSeen(
			readSeenState(seenStateFile(this.deps.getAgentDir(), this.deps.getSessionId())),
			queue,
			this.deps.now(),
		);
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
		return text === undefined ? undefined : { text, shown: queue };
	}

	/**
	 * Marks the items a committed request showed as seen. The items keep their first-seen time; a request whose brief was
	 * not committed marks nothing, so its items show as new on the next return. A write that fails is reported: the request
	 * already carries the brief, and only the `[new]` marks are affected.
	 */
	private markShown(shown: readonly OwnerDecisionItem[]): void {
		const file = seenStateFile(this.deps.getAgentDir(), this.deps.getSessionId());
		try {
			withFileLockSync(file, () => {
				const { state } = advanceOwnerDecisionSeen(readSeenState(file), shown, this.deps.now());
				writeFileAtomicSync(file, `${JSON.stringify(state)}\n`);
			});
		} catch (error) {
			this.deps.warn(
				`The return brief's seen state was not saved (${error instanceof Error ? error.message : String(error)}); its items may show as new again.`,
			);
		}
	}

	/**
	 * The owner message the live run is processing, when the owner's own words started or steered it: the newest owner
	 * message on the branch. Undefined when no run is live, or when the run only inherits an owner's authority from the branch.
	 */
	private liveOwnerMessageAt(branch: readonly SessionEntry[]): number | undefined {
		const live = this.deps.liveRun();
		if (live === undefined || !live.decidedInRun) return undefined;
		if (live.origin.k !== "owner-typed" && live.origin.k !== "owner-channel") return undefined;
		let newest: number | undefined;
		for (const at of ownerSpokenTimes(branch)) newest = newest === undefined || at > newest ? at : newest;
		return newest;
	}

	private readQueueInputs(branch: readonly SessionEntry[], processingAt: number | undefined): OwnerDecisionInputs {
		const humanInput = getResumableHumanInputSnapshot(this.deps.sessionManager);
		const ledger = this.deps.taskProjection();
		const liveRun = this.deps.liveRun();
		return {
			drafts: outwardDraftStates(branch, liveRun?.origin.k === "owner-typed", liveRun ? { liveRun } : {}),
			...(humanInput === undefined ? {} : { humanInput }),
			workerQuestions:
				ledger === undefined ? [] : openWorkerQuestions(ledger, ownerSpokenTimes(branch), processingAt),
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
 * A worker question is open while its outcome is the latest one its task recorded and no owner message answers it (see
 * `ownerMessageAnswers`). The outcome's own recording time is the reference: an outcome carries no answered flag.
 */
function openWorkerQuestions(
	ledger: TaskRuntimeProjection,
	ownerTimes: readonly number[],
	processingAt: number | undefined,
): OwnerWorkerQuestionPort[] {
	const questions: OwnerWorkerQuestionPort[] = [];
	for (const task of Object.values(ledger.tasks)) {
		const outcome = task.outcome;
		if (outcome === undefined || isOutcomeFromNewerBuild(outcome) || outcome.nextAction.kind !== "ask_owner")
			continue;
		const recorded = Date.parse(outcome.recordedAt);
		if (ownerTimes.some((at) => ownerMessageAnswers(recorded, at, processingAt))) continue;
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

/**
 * The repository's commits since the instant, newest first, read up to `COMMITS_MAX`. Undefined when the log cannot be
 * read: never zero.
 */
async function readCommitsSince(cwd: string, sinceMs: number): Promise<ReturnBriefCommits | undefined> {
	try {
		const result = await execCommand(
			"git",
			["log", `--since=@${Math.floor(sinceMs / 1000)}`, "-n", String(COMMITS_MAX), "--format=%h%x09%s"],
			cwd,
			{ timeout: GIT_TIMEOUT_MS, env: withoutInheritedGitLocation() },
		);
		if (result.code !== 0) return undefined;
		const shown = result.stdout
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => {
				const [sha = "", ...subject] = line.split("\t");
				return { sha, subject: subject.join("\t") };
			});
		return { shown, capped: shown.length >= COMMITS_MAX };
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
