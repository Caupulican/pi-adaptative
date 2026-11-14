/**
 * The session side of the owner channel: the owner's words from a verified owner channel (a phone) enter the session here,
 * and the channels core reads back here whether the run they opened still holds the owner's authority. The channels core
 * decides liveness (`live`, asked at every guarded call); the session only keeps each answer by the batch that opened the
 * run. A later run that answers the same batch (a continuation, a wake, a routine) reads the same answer, so it is kept
 * until the delivery is refused, ends undelivered or is evicted at capacity; a remote-owner run whose answer is gone
 * holds no authority.
 */

import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";
import type { AgentEvent } from "../kernel/types.ts";
import type { PromptOptions } from "./agent-session-contracts.ts";
import { createOwnerDraftDecisions } from "./autonomy/owner-draft-decisions.ts";
import type {
	OwnerChannelControl,
	OwnerChannelDelivery,
	OwnerChannelOrigin,
	OwnerDraftView,
	OwnerQuotaAllowance,
	OwnerSessionWork,
} from "./channels/owner-channel-types.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import type { OwnerDecisionItem } from "./owner-decisions/owner-decision-queue.ts";
import { isRemoteOwnerOrigin } from "./turn-origin.ts";

/**
 * The batches whose answers are kept at once; past it the oldest one that neither awaits its approval entry nor decides
 * the run in progress is dropped (its runs hold no authority), and with none such the new delivery is refused.
 */
const MAX_OWNER_CHANNEL_RUNS = 64;
/** The channels cores that can hear the drafts held at once (one per channel hosted by this session). */
const MAX_DRAFT_LISTENERS = 8;

/** What the owner channel uses of the session: its submission path, its agent's events and abort, and its warnings. */
export interface OwnerChannelSessionHost {
	prompt(text: string, options?: PromptOptions): Promise<void>;
	readonly agent: { subscribe(listener: (event: AgentEvent) => void): () => void; abort(reason: string): void };
	/** The session's canonical work state: whether it works now, and why it rests when it does not. */
	getSessionWorkState(): OwnerSessionWork;
	emitHostWarning(message: string): void;
}

/** What the owner channel reads and writes of the session's store: its branch, its identity and its custom entries. */
export type OwnerChannelSessionStore = Pick<
	SessionManager,
	"getBranch" | "appendCustomEntry" | "getSessionId" | "getCwd"
>;

/** The foreground run's authority, and the aborts of the submission that owns it and of its retry. */
export type OwnerChannelForeground = Pick<
	ForegroundRecoveryController,
	"turnOrigin" | "abortSubmission" | "abortRetry"
>;

/** One batch the channels core handed in, by its `ref`. */
interface OwnerChannelRun {
	readonly live: () => boolean;
	readonly senderDigest: string;
	/** The batch was offered under `ownerAuthority: "full"` (`OwnerChannelOrigin.full`). */
	readonly full: boolean;
	/** An accepted approval delivery whose entry has not landed on the branch yet. */
	approvalPending: boolean;
}

export class OwnerChannelSession implements OwnerChannelDelivery {
	private readonly host: OwnerChannelSessionHost;
	private readonly getForeground: () => OwnerChannelForeground;
	/** Aborts the prompt submission that owns the foreground, if one does (`PromptSubmissionController.abortSubmission`). */
	private readonly abortPromptSubmission: (reason: string) => void;
	private readonly getSessionManager: () => OwnerChannelSessionStore;
	private readonly isClosed: () => boolean;
	private readonly readQuotaAllowance: (maxUsedPercent: number) => OwnerQuotaAllowance;
	/** Insertion order is age: the first entry is the oldest. */
	private readonly runs = new Map<string, OwnerChannelRun>();
	private readonly draftListeners = new IndependentObserverSet<(view: OwnerDraftView) => void>();
	private readonly controlValue: OwnerChannelControl;

	constructor(
		host: OwnerChannelSessionHost,
		getForeground: () => OwnerChannelForeground,
		abortPromptSubmission: (reason: string) => void,
		getSessionManager: () => OwnerChannelSessionStore,
		isClosed: () => boolean,
		readQuotaAllowance: (maxUsedPercent: number) => OwnerQuotaAllowance,
		readOwnerDecisions: () => readonly OwnerDecisionItem[],
	) {
		this.readQuotaAllowance = readQuotaAllowance;
		this.host = host;
		this.getForeground = getForeground;
		this.abortPromptSubmission = abortPromptSubmission;
		this.getSessionManager = getSessionManager;
		this.isClosed = isClosed;
		const decisions = createOwnerDraftDecisions({
			getBranch: () => this.getSessionManager().getBranch(),
			appendCustomEntry: (customType, data) => {
				this.getSessionManager().appendCustomEntry(customType, data);
			},
			getLiveRun: () => this.getForeground().turnOrigin.live(),
			isApprovalDeliveryPending: (ref) => this.isApprovalDeliveryPending(ref),
		});
		this.controlValue = {
			drafts: () => decisions.drafts(),
			approve: (draftId, by, policy) => decisions.approve(draftId, by, policy),
			deny: (draftId, by) => decisions.deny(draftId, by),
			onDraftHeld: (listener) => {
				if (this.draftListeners.size >= MAX_DRAFT_LISTENERS)
					throw new Error(`At most ${MAX_DRAFT_LISTENERS} owner-channel draft listeners are kept.`);
				return this.draftListeners.subscribe(listener);
			},
			waiting: () => {
				const shown = new Set(
					decisions.drafts().flatMap((draft) => (isRemoteOwnerOrigin(draft.origin) ? [draft.id] : [])),
				);
				const store = this.getSessionManager();
				const { busy, phase } = this.host.getSessionWorkState();
				return {
					sessionId: store.getSessionId(),
					cwd: store.getCwd(),
					work: { busy, phase },
					calls: readOwnerDecisions().filter((item) => item.source !== "outward_draft" || !shown.has(item.id)),
				};
			},
		};
	}

	deliver(
		text: string,
		origin: OwnerChannelOrigin,
		live: () => boolean,
		onAccepted: (accepted: boolean) => void,
	): void {
		// The channels core's batch is one header line, then the owner's words: only those words are the owner's.
		const header = text.indexOf("\n");
		if (header === -1) {
			onAccepted(false);
			return;
		}
		this.submit(text, text.slice(header + 1), false, origin, live, onAccepted);
	}

	deliverApproval(
		text: string,
		origin: OwnerChannelOrigin,
		live: () => boolean,
		onAccepted: (accepted: boolean) => void,
		requestEntryId: string | undefined,
	): void {
		this.submit(text, "", { requestEntryId }, origin, live, onAccepted);
	}

	observeRunUsage(ref: string, onUsd: (usd: number) => void): () => void {
		let usd = 0;
		return this.host.agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant" || !this.runOpenedBy(ref)) return;
			usd += event.message.usage?.cost?.total ?? 0;
			onUsd(usd);
		});
	}

	quotaAllowance(maxUsedPercent: number): OwnerQuotaAllowance {
		return this.readQuotaAllowance(maxUsedPercent);
	}

	/**
	 * Ends only the run `ref` decided and the submission that owns it (its preparation and tail, its foreground lease, its
	 * retry, the agent run), as the session's interrupt does for those; queued input awaiting admission, the owner's
	 * typed-word judgments, a pending human-input resume and runtime updates are left as they are.
	 */
	abortRun(ref: string): void {
		if (!this.runOpenedBy(ref)) return;
		const reason = "owner channel stop";
		this.abortPromptSubmission(reason);
		const foreground = this.getForeground();
		foreground.abortSubmission(reason);
		foreground.abortRetry();
		this.host.agent.abort(reason);
	}

	/** Whether the run `origin` decided still holds the owner's authority: the channels core's kept answer, false without one. */
	isOwnerChannelLive(origin: TurnOriginRecord): boolean {
		const run = this.runOf(origin);
		return run !== undefined && answersLive(run.live);
	}

	/** Whether the run `origin` decided holds the owner's own authority: offered under "full" and still live. */
	isOwnerChannelFull(origin: TurnOriginRecord): boolean {
		const run = this.runOf(origin);
		return run?.full === true && answersLive(run.live);
	}

	/** The digest of the verified sender whose batch opened the run `origin` decided; none once that batch is dropped. */
	ownerChannelSender(origin: TurnOriginRecord): string | undefined {
		return this.runOf(origin)?.senderDigest;
	}

	/** True from an accepted approval delivery until its entry lands on the branch or it ends undelivered. */
	isApprovalDeliveryPending(ref: string): boolean {
		return this.runs.get(ref)?.approvalPending === true;
	}

	/** A draft held on a remote-owner run, told to every channels core that listens. */
	presentOwnerDraft(view: OwnerDraftView): void {
		this.draftListeners.notify(
			(listener) => listener(view),
			() => this.host.emitHostWarning("An owner-channel draft listener failed."),
		);
	}

	/** The owner's decisions over this session's drafts and the stream of newly held ones. */
	control(): OwnerChannelControl {
		return this.controlValue;
	}

	/**
	 * Submit one owner-channel delivery as a follow-up: never a command, a skill or a template (`PromptOptions.ownerChannel`).
	 * Its answer is kept from now; a delivery not accepted, or one that ends undelivered, drops it. A late callback drops
	 * only the answer it kept, never a later delivery's under the same `ref`.
	 */
	private submit(
		text: string,
		ownerText: string,
		approval: false | { readonly requestEntryId: string | undefined },
		origin: OwnerChannelOrigin,
		live: () => boolean,
		onAccepted: (accepted: boolean) => void,
	): void {
		const run =
			this.isClosed() || this.runs.has(origin.ref) || !answersLive(live) ? undefined : this.keep(origin, live);
		if (run === undefined) {
			onAccepted(false);
			return;
		}
		const drop = (): void => {
			if (this.runs.get(origin.ref) === run) this.runs.delete(origin.ref);
		};
		// The channels core hears exactly one verdict: the submission's own acceptance, or a refusal when it ended (returned
		// or threw) without reaching one.
		let answered = false;
		let delivered = false;
		const answer = (accepted: boolean): void => {
			if (answered) return;
			answered = true;
			if (!accepted) drop();
			else if (approval && !delivered) run.approvalPending = true;
			onAccepted(accepted);
		};
		const settleDelivered = (): void => {
			delivered = true;
			run.approvalPending = false;
		};
		void this.host
			.prompt(text, {
				streamingBehavior: "followUp",
				ownerChannel: {
					origin,
					ownerText,
					approval: approval !== false,
					...(approval && approval.requestEntryId !== undefined ? { answers: approval.requestEntryId } : {}),
					onDelivered: settleDelivered,
					onUndelivered: drop,
					...(run.full ? { full: () => answersLive(live) } : {}),
				},
				preflightResult: (success) => answer(success),
			})
			.then(
				() => answer(false),
				(error: unknown) => {
					answer(false);
					this.host.emitHostWarning(
						`An owner-channel turn failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				},
			);
	}

	/** Keep the batch's answer, evicting at capacity (`MAX_OWNER_CHANNEL_RUNS`); undefined when nothing may be evicted. */
	private keep(origin: OwnerChannelOrigin, live: () => boolean): OwnerChannelRun | undefined {
		if (this.runs.size >= MAX_OWNER_CHANNEL_RUNS) {
			const deciding = this.getForeground().turnOrigin.origin();
			const decidingRef = isRemoteOwnerOrigin(deciding) ? deciding?.ref : undefined;
			let evicted = false;
			for (const [ref, kept] of this.runs) {
				if (kept.approvalPending || ref === decidingRef) continue;
				this.runs.delete(ref);
				evicted = true;
				break;
			}
			if (!evicted) return undefined;
		}
		const run: OwnerChannelRun = {
			live,
			senderDigest: origin.senderDigest,
			full: origin.full === true,
			approvalPending: false,
		};
		this.runs.set(origin.ref, run);
		return run;
	}

	/** The kept batch the remote-owner `origin` names. */
	private runOf(origin: TurnOriginRecord | undefined): OwnerChannelRun | undefined {
		return isRemoteOwnerOrigin(origin) && origin?.ref !== undefined ? this.runs.get(origin.ref) : undefined;
	}

	/** Whether the foreground run in progress is the one the batch `ref` decided. */
	private runOpenedBy(ref: string): boolean {
		const turnOrigin = this.getForeground().turnOrigin;
		const origin = turnOrigin.origin();
		return turnOrigin.isActive() && isRemoteOwnerOrigin(origin) && origin?.ref === ref;
	}
}

/** The channels core's liveness answer; a check that throws is not live. */
function answersLive(live: () => boolean): boolean {
	try {
		return live();
	} catch {
		return false;
	}
}
