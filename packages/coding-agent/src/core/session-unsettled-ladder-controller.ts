/**
 * Post-turn answer claim verification, owner and worker unsettled-item queues, owner follow-up recording, and
 * goal-completion owner decisions. The judgments themselves (claim checks, code-duplicate review, the System One and
 * stronger-model ladder) are the session's `SettlementJudges`.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { AgentMessage } from "../kernel/types.ts";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "./agent-session-contracts.ts";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import { isDecisivelyTrue } from "./decision/noul.ts";
import type { ExtensionUIContext } from "./extensions/index.ts";
import type { ForegroundSubmissionLease } from "./foreground-recovery-controller.ts";
import {
	type GoalCompletionOwnerDecisionInput,
	resolveGoalCompletionOwnerDecision,
} from "./goals/goal-completion-owner-decision.ts";
import type { GoalState } from "./goals/goal-state.ts";
import type { ModelRouterController } from "./model-router-controller.ts";
import { decodeWorkerReceiptPublication } from "./orchestration/worker-receipt-publication.ts";
import { recordLessonCandidate } from "./proof/lesson-candidates.ts";
import type { SessionImageStore } from "./session-image-store.ts";
import { isSessionAppendAnchorCurrent } from "./session-snapshot.ts";
import {
	type AnswerClaimChecker,
	type AnswerClaimScope,
	assistantAnswerText,
	type ClaimReceiptEvent,
} from "./system-one/claim-delivery.ts";
import type { CodeDuplicateReviewer } from "./system-one/code-duplicates.ts";
import type { SystemOneController } from "./system-one/controller.ts";
import {
	appendOwnerFollowUp,
	appendUnsettledWorkerFollowUps,
	consultMessage,
	groundConsultAnswer,
	OWNER_QUESTION_CONSULT_PROMPT,
	type OwnerQuestionConsult,
	ownerFollowUpBytes,
	ownerFollowUpPath,
	parseConsultReply,
} from "./system-one/owner-question-routing.ts";
import { SettlementJudges } from "./system-one/settlement-judges.ts";
import { RESERVED_DECISION_KINDS } from "./system-one/unsettled-ladder.ts";
import { resolveTurnMessages } from "./turn-window.ts";
import { turnWorkWindow, WORKER_RECEIPTS_CUSTOM_TYPE, workUnitWindow } from "./work-units.ts";

export interface SessionUnsettledLadderControllerDeps {
	getSessionManager(): SessionManager;
	getAgentDir(): string;
	isChildSession(): boolean;
	isHandoff(): boolean;
	getLastUserRequest(): string;
	getMessages(): readonly AgentMessage[];
	findLastAssistantMessage(): AssistantMessage | undefined;
	getSystemOneController(): SystemOneController | undefined;
	resolveExpensiveModel(): ReturnType<ModelRouterController["resolveExpensiveModel"]>;
	runIsolatedCompletion(opts: IsolatedCompletionOptions): Promise<IsolatedCompletionResult>;
	settleLatestOwnerPolicy(signal?: AbortSignal): Promise<void>;
	getGoalStateSnapshot(): GoalState | undefined;
	getExtensionUIContext(): ExtensionUIContext | undefined;
	getToolArtifactStore(): ArtifactStore;
	getSessionImageStore(): SessionImageStore | undefined;
	sendOwnerItemsMessage(
		items: readonly string[],
		content: string,
		lease: ForegroundSubmissionLease | undefined,
	): Promise<void>;
	emitWarning(message: string): void;
}

export class SessionUnsettledLadderController {
	private readonly deps: SessionUnsettledLadderControllerDeps;
	/** The session's settlement judges: the same instances judge the root's answers and its workers' reports. */
	readonly judges: SettlementJudges;
	readonly codeDuplicates: CodeDuplicateReviewer;
	readonly answerClaims: AnswerClaimChecker;
	private pendingOwnerItems: string[] = [];
	private pendingWorkerItems: { item: string; request: string; sessionId: string }[] = [];
	private ownerItemsFlush = Promise.resolve();
	/** Set while a paused goal holds items the owner was told about; its end posts them. */
	private heldForPausedGoal = false;
	private lastAnnouncedFollowUp?: { sessionId: string; bytes: number };
	private followUpReadErrorSessionId?: string;

	constructor(deps: SessionUnsettledLadderControllerDeps) {
		this.deps = deps;
		this.judges = new SettlementJudges({
			getSystemOneController: () => this.deps.getSystemOneController(),
			resolveExpensiveModel: () => this.deps.resolveExpensiveModel(),
			runIsolatedCompletion: (opts) => this.deps.runIsolatedCompletion(opts),
			warn: (message) => this.deps.emitWarning(message),
			deliverToOwner: (items) => {
				this.deliverToOwner(items);
			},
		});
		this.codeDuplicates = this.judges.codeDuplicates;
		this.answerClaims = this.judges.answerClaims;
	}

	/**
	 * The correction the turn's answer's delivery claims call for, checked over the turn's claim window. The turn is
	 * found from its opening message ({@link resolveTurnMessages}), so a compaction inside the turn neither hands the
	 * check earlier conversation nor drops what survives of the turn. A turn whose opening never entered the
	 * conversation (its run was closed before it started) has no answer of its own: nothing is checked.
	 */
	async claimCorrection(turnOpening: AgentMessage): Promise<string | undefined> {
		const turnMessages = resolveTurnMessages(this.deps.getSessionManager(), turnOpening, this.deps.getMessages());
		if (turnMessages === undefined) return undefined;
		const window = this.claimWindow(turnOpening, turnMessages);
		return this.answerClaims.check(
			assistantAnswerText(this.deps.findLastAssistantMessage()),
			window.messages,
			window.events,
			window.scope,
		);
	}

	/**
	 * What an answer's claims are checked against: the current or most recent work unit, boundary to now,
	 * with the receipts of workers accepted during it; the turn alone when no work unit was ever opened.
	 */
	claimWindow(
		turnOpening: AgentMessage,
		turnMessages: readonly AgentMessage[],
	): {
		messages: readonly AgentMessage[];
		events: readonly ClaimReceiptEvent[];
		scope: AnswerClaimScope;
	} {
		const manager = this.deps.getSessionManager();
		const work = workUnitWindow(manager, WORKER_RECEIPTS_CUSTOM_TYPE);
		const scope: AnswerClaimScope = {
			request: this.deps.getLastUserRequest(),
			boundary: work ? "work_unit" : "turn",
			openingEntryId: work ? work.startEntryId : (manager.getMessageEntryId(turnOpening) ?? null),
			...(work?.workUnit ? { workUnit: work.workUnit } : {}),
		};
		let window = work?.entries;
		if (window === undefined) {
			const openingEntryId = manager.getMessageEntryId(turnOpening);
			if (openingEntryId === undefined)
				return {
					messages: turnMessages,
					events: turnMessages.map((message) => ({ kind: "message", message })),
					scope,
				};
			window = turnWorkWindow(manager, WORKER_RECEIPTS_CUSTOM_TYPE, openingEntryId);
		}
		const events: ClaimReceiptEvent[] = [];
		let malformedPublication = false;
		for (const entry of window) {
			if (entry.kind === "message") events.push(entry);
			else {
				const publication = decodeWorkerReceiptPublication(entry.data);
				if (
					publication &&
					publication.origin.sessionFile === manager.getSessionFile() &&
					isSessionAppendAnchorCurrent(
						{
							getSessionId: () => manager.getSessionId(),
							getLeafId: () => entry.entryId,
							getEntry: (id) => manager.getEntry(id),
						},
						publication.origin,
					)
				)
					events.push({
						kind: "worker",
						entryId: entry.entryId,
						receipts: publication.receipts,
						identity: { id: publication.receiptId, signature: JSON.stringify(publication) },
					});
				else {
					malformedPublication ||= Boolean(
						entry.data && typeof entry.data === "object" && "version" in entry.data && entry.data.version === 2,
					);
					this.deps.emitWarning(
						`Worker receipt ${entry.entryId} is malformed or lacks final acceptance identity; its evidence is unavailable.`,
					);
				}
			}
		}
		if (malformedPublication) {
			// A corrupt v2 row may be a conflicting copy of a valid identity. Do not let
			// skipping it leave the surviving copy authoritative.
			for (let index = events.length - 1; index >= 0; index--)
				if (events[index]?.kind === "worker") events.splice(index, 1);
		}
		const tail: AgentMessage[] = [];
		let unpersistedToolEvidence = false;
		for (const message of turnMessages) {
			if (message.role === "compactionSummary") continue;
			if (manager.getMessageEntryId(message) !== undefined) {
				if (unpersistedToolEvidence)
					throw new Error("Unpersisted claim evidence precedes persisted messages; its branch order is unknown.");
			} else {
				tail.push(message);
				unpersistedToolEvidence ||= message.role === "assistant" || message.role === "toolResult";
			}
		}
		for (const message of tail) events.push({ kind: "message", message });
		return {
			messages: events.flatMap((event) => (event.kind === "message" ? [event.message] : [])),
			events,
			scope,
		};
	}

	/**
	 * A stronger model settles a handed-off owner question only on a basis the owner's request states,
	 * and System One checks that basis before the agent may use the answer.
	 */
	async consultStrongerModel(input: {
		question: string;
		request: string;
		signal?: AbortSignal;
	}): Promise<OwnerQuestionConsult | undefined> {
		const reply = await this.judges.consultExpensiveModel({
			systemPrompt: OWNER_QUESTION_CONSULT_PROMPT,
			message: consultMessage(input),
			laneKind: "owner-question-consult",
			...(input.signal ? { signal: input.signal } : {}),
		});
		const consult = reply ? parseConsultReply(reply.text, reply.ref) : undefined;
		if (consult?.kind !== "answered") return consult;
		return groundConsultAnswer(this.deps.getSystemOneController(), { consult, ...input });
	}

	/** Both in-process and managed worker reports retain their unknowns for parent review. */
	queueWorkerUnsettled(items: readonly string[]): undefined {
		const request = this.deps.getLastUserRequest();
		const sessionId = this.deps.getSessionManager().getSessionId();
		for (const item of items) {
			if (
				!this.pendingWorkerItems.some(
					(entry) => entry.item === item && entry.sessionId === sessionId && entry.request === request,
				)
			)
				this.pendingWorkerItems.push({ item, request, sessionId });
		}
		return undefined;
	}

	announceOwnerFollowUpsWhenPresent(): void {
		if (this.deps.isChildSession() || this.deps.isHandoff()) return;
		const sessionId = this.deps.getSessionManager().getSessionId();
		const path = ownerFollowUpPath(this.deps.getAgentDir(), sessionId);
		let bytes: number;
		try {
			bytes = ownerFollowUpBytes(path);
			this.followUpReadErrorSessionId = undefined;
		} catch (error) {
			if (this.followUpReadErrorSessionId !== sessionId) {
				this.followUpReadErrorSessionId = sessionId;
				this.deps.emitWarning(
					`Could not inspect owner follow-ups in ${path}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return;
		}
		if (bytes <= (this.lastAnnouncedFollowUp?.sessionId === sessionId ? this.lastAnnouncedFollowUp.bytes : 0)) return;
		this.lastAnnouncedFollowUp = { sessionId, bytes };
		this.deps.emitWarning(
			`Owner follow-ups are recorded in ${path}. Review them before relying on unresolved decisions.`,
		);
	}

	/** The owner-completion boundary of the objective-primary loop: a completion System One could not settle. */
	resolveGoalCompletionOwnerDecision(input: GoalCompletionOwnerDecisionInput, signal?: AbortSignal) {
		const sessionManager = this.deps.getSessionManager();
		return resolveGoalCompletionOwnerDecision(
			input,
			{
				sessionManager,
				ui: this.deps.getExtensionUIContext(),
				isHandoff: this.deps.isHandoff(),
				requestText: this.deps.getLastUserRequest(),
				recordOwnerFollowUp: (entry) =>
					appendOwnerFollowUp(ownerFollowUpPath(this.deps.getAgentDir(), sessionManager.getSessionId()), {
						...entry,
						at: new Date().toISOString(),
					}),
				recordLessonCandidate: (entry) =>
					recordLessonCandidate(
						this.deps.getAgentDir(),
						{
							...entry,
							signal: "completion-continued",
							sessionId: sessionManager.getSessionId(),
						},
						(message) => this.deps.emitWarning(message),
					),
				artifactStore: this.deps.getToolArtifactStore(),
				getImageStore: () => this.deps.getSessionImageStore(),
			},
			signal,
		);
	}

	/**
	 * Items nothing could settle go to the owner by the host, never by trusting a model to relay them:
	 * written to the follow-up document under a handoff, and posted to the owner when the turn ends.
	 */
	deliverToOwner(items: readonly string[]): string | undefined {
		if (items.length === 0) return undefined;
		if (this.deps.isHandoff()) return this.recordUnsettledForOwner(items);
		this.pendingOwnerItems.push(...items.filter((item) => !this.pendingOwnerItems.includes(item)));
		return undefined;
	}

	/** Post this turn's unsettled items to the owner as one displayed message, then clear them. */
	flushOwnerItems(lease: ForegroundSubmissionLease | undefined): Promise<void> {
		const flush = this.ownerItemsFlush.then(() => this.flushOwnerItemsNow(lease));
		this.ownerItemsFlush = flush.catch(() => {});
		return flush;
	}

	private async flushOwnerItemsNow(lease: ForegroundSubmissionLease | undefined): Promise<void> {
		if (lease?.signal.aborted) return;
		const sessionId = this.deps.getSessionManager().getSessionId();
		const request = this.deps.getLastUserRequest();
		const isCurrent = () =>
			!lease?.signal.aborted &&
			sessionId === this.deps.getSessionManager().getSessionId() &&
			request === this.deps.getLastUserRequest();
		const judge = this.deps.getSystemOneController();
		const workerItems = this.pendingWorkerItems
			.splice(0)
			.filter((entry) => entry.sessionId === sessionId && entry.request === request);
		let reservedWorkerItems: string[] = [];
		if (judge) {
			const decisions = await Promise.all(
				workerItems.map(async (entry) => {
					try {
						const answers = await judge.evaluateReservedDecision(
							{ question: entry.item, request: entry.request },
							lease?.signal,
						);
						return Object.keys(RESERVED_DECISION_KINDS).some((id) => isDecisivelyTrue(answers[id]))
							? entry
							: undefined;
					} catch (error) {
						this.deps.emitWarning(
							`Worker owner-decision routing unavailable; findings remain with the parent: ${error instanceof Error ? error.message : String(error)}`,
						);
						return undefined;
					}
				}),
			);
			reservedWorkerItems = decisions.flatMap((entry) => (entry ? [entry.item] : []));
		}
		if (this.pendingOwnerItems.length === 0 && reservedWorkerItems.length === 0) return;
		// Whether the owner handed decisions off decides where these items go.
		await this.deps.settleLatestOwnerPolicy(lease?.signal);
		// Classified worker decisions stay local until both waits finish and their publication scope is current.
		if (!isCurrent()) return;
		this.deliverToOwner(reservedWorkerItems);
		const items = this.pendingOwnerItems;
		// A flush that ran during the wait already took them: there is nothing left to post.
		if (items.length === 0) return;
		// Under a handoff the items go to the durable follow-up document and ask no one, exactly as
		// deliverToOwner writes them, so a paused goal has nothing to defer there.
		if (this.deps.isHandoff()) {
			this.recordUnsettledForOwner(items);
			this.pendingOwnerItems = [];
			this.heldForPausedGoal = false;
			return;
		}
		// A paused goal defers the owner's questions until its work resumes. The owner is told once that
		// they wait, and the goal leaving the pause posts them (noteGoalState).
		if (this.deps.getGoalStateSnapshot()?.status === "paused") {
			if (!this.heldForPausedGoal) {
				this.heldForPausedGoal = true;
				this.deps.emitWarning(
					`${items.length} unsettled item(s) for you wait while the goal is paused; they are posted when it resumes or ends.`,
				);
			}
			return;
		}
		this.pendingOwnerItems = [];
		this.heldForPausedGoal = false;
		const content = ["Owner input requested for unresolved decisions:", ...items.map((item) => `- ${item}`)].join(
			"\n",
		);
		await this.deps.sendOwnerItemsMessage(items, content, lease);
	}

	/**
	 * Every persisted goal transition. A goal leaving the pause (resumed, blocked, finished or cleared) posts the
	 * items it held: no turn has to end first for the owner to see them.
	 */
	noteGoalState(state: GoalState): void {
		if (!this.heldForPausedGoal || state.status === "paused") return;
		void this.flushOwnerItems(undefined).catch((error: unknown) =>
			this.deps.emitWarning(
				`Could not post the unsettled items the paused goal held: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	}

	/**
	 * Unsettled findings for the owner. Under a handoff they go to the follow-up document and the run
	 * moves on around them; with the owner in the loop nothing is written and the parent asks them.
	 */
	recordUnsettledForOwner(items: readonly string[]): string | undefined {
		if (!this.deps.isHandoff() || items.length === 0) return undefined;
		return appendUnsettledWorkerFollowUps(
			ownerFollowUpPath(this.deps.getAgentDir(), this.deps.getSessionManager().getSessionId()),
			items,
			this.deps.getLastUserRequest(),
			new Date().toISOString(),
		);
	}
}
