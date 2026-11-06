/**
 * The session side of the owner channel: the owner's words from a verified owner channel (a phone) enter the session here,
 * and the channels core reads back here whether the run they opened still holds the owner's authority. The channels core
 * decides liveness (`live`, asked at every guarded call); the session only keeps each answer by the batch that opened the
 * run and drops it when that run ends, so a remote-owner run whose answer is gone holds no authority.
 */

import type { SessionEntry } from "../kernel/session/session-entries.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import type { TurnOriginRecord } from "../kernel/turn-origin-stamp.ts";
import type { AgentEvent } from "../kernel/types.ts";
import type { PromptOptions } from "./agent-session-contracts.ts";
import type {
	OwnerChannelControl,
	OwnerChannelDelivery,
	OwnerChannelOrigin,
	OwnerDraftDecisions,
	OwnerDraftView,
} from "./channels/owner-channel-types.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import { IndependentObserverSet } from "./observer-dispatch.ts";
import { isRemoteOwnerOrigin, turnOriginOf } from "./turn-origin.ts";

/** The batches whose answers are kept at once; past it the oldest is dropped, and its run holds no authority. */
const MAX_OWNER_CHANNEL_RUNS = 64;
/** The channels cores that can hear the drafts held at once (one per channel hosted by this session). */
const MAX_DRAFT_LISTENERS = 8;

/** What the owner channel uses of the session: its submission path, its interrupt, its agent's events and its warnings. */
export interface OwnerChannelSessionHost {
	prompt(text: string, options?: PromptOptions): Promise<void>;
	abort(reason: string): Promise<void>;
	readonly agent: { subscribe(listener: (event: AgentEvent) => void): () => void };
	emitHostWarning(message: string): void;
}

/** The foreground run's authority and lifetime. */
export type OwnerChannelForeground = Pick<
	ForegroundRecoveryController,
	"turnOrigin" | "subscribeActivity" | "isRunActive" | "getCurrentSubmissionEpoch"
>;

/** What the owner's draft decisions read and write of the session. */
export interface OwnerDraftDecisionsSessionDeps {
	getBranch(): readonly SessionEntry[];
	appendCustomEntry(customType: string, data?: unknown): string;
	getRunOrigin(): TurnOriginRecord | undefined;
	isApprovalDeliveryPending(ref: string): boolean;
}

/** One batch the channels core handed in, by its `ref`. */
interface OwnerChannelRun {
	readonly live: () => boolean;
	readonly senderDigest: string;
	/** A run read its message: the batch's answer is dropped when the foreground next goes idle. */
	ran: boolean;
	/** An accepted approval delivery whose entry has not landed on the branch yet. */
	approvalPending: boolean;
}

export class OwnerChannelSession implements OwnerChannelDelivery {
	private readonly host: OwnerChannelSessionHost;
	private readonly getForeground: () => OwnerChannelForeground;
	private readonly getSessionManager: () => Pick<SessionManager, "getBranch" | "appendCustomEntry">;
	private readonly isClosed: () => boolean;
	/** Insertion order is age: the first entry is the oldest. */
	private readonly runs = new Map<string, OwnerChannelRun>();
	private readonly draftListeners = new IndependentObserverSet<(view: OwnerDraftView) => void>();
	private controlValue: OwnerChannelControl | undefined;
	private observing = false;

	constructor(
		host: OwnerChannelSessionHost,
		getForeground: () => OwnerChannelForeground,
		getSessionManager: () => Pick<SessionManager, "getBranch" | "appendCustomEntry">,
		isClosed: () => boolean,
	) {
		this.host = host;
		this.getForeground = getForeground;
		this.getSessionManager = getSessionManager;
		this.isClosed = isClosed;
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
	): void {
		this.submit(text, "", true, origin, live, onAccepted);
	}

	observeRunUsage(ref: string, onUsd: (usd: number) => void): () => void {
		let usd = 0;
		return this.host.agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant" || !this.runOpenedBy(ref)) return;
			usd += event.message.usage?.cost?.total ?? 0;
			onUsd(usd);
		});
	}

	abortRun(ref: string): void {
		if (this.runOpenedBy(ref)) void this.host.abort("owner channel stop");
	}

	/** Whether the run `origin` decided still holds the owner's authority: the channels core's kept answer, false without one. */
	isOwnerChannelLive(origin: TurnOriginRecord): boolean {
		return this.runOf(origin)?.live() === true;
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

	/** The owner's decisions over this session's drafts and the stream of newly held ones; undefined until decisions exist. */
	control(): OwnerChannelControl | undefined {
		return this.controlValue;
	}

	/** Bind the owner's draft decisions (built over this session) into the control the channels core holds. */
	bindDecisions(create: (deps: OwnerDraftDecisionsSessionDeps) => OwnerDraftDecisions): void {
		const decisions = create({
			getBranch: () => this.getSessionManager().getBranch(),
			appendCustomEntry: (customType, data) => this.getSessionManager().appendCustomEntry(customType, data),
			getRunOrigin: () => this.getForeground().turnOrigin.origin(),
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
		};
	}

	/**
	 * Submit one owner-channel delivery as a follow-up: never a command, a skill or a template (`PromptOptions.ownerChannel`).
	 * Its answer is kept from now; a delivery not accepted, or one that ends undelivered, drops it.
	 */
	private submit(
		text: string,
		ownerText: string,
		approval: boolean,
		origin: OwnerChannelOrigin,
		live: () => boolean,
		onAccepted: (accepted: boolean) => void,
	): void {
		if (this.isClosed() || !live() || this.runs.has(origin.ref)) {
			onAccepted(false);
			return;
		}
		this.observe();
		this.keep(origin, live);
		// The channels core hears exactly one verdict: the submission's own acceptance, or a refusal when it ended (returned
		// or threw) without reaching one.
		let answered = false;
		let delivered = false;
		const answer = (accepted: boolean): void => {
			if (answered) return;
			answered = true;
			const run = this.runs.get(origin.ref);
			if (!accepted) this.runs.delete(origin.ref);
			else if (approval && run && !delivered) run.approvalPending = true;
			onAccepted(accepted);
		};
		const settleDelivered = (): void => {
			delivered = true;
			const run = this.runs.get(origin.ref);
			if (run) run.approvalPending = false;
		};
		void this.host
			.prompt(text, {
				streamingBehavior: "followUp",
				ownerChannel: {
					origin,
					ownerText,
					approval,
					onDelivered: settleDelivered,
					onUndelivered: () => this.runs.delete(origin.ref),
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

	private keep(origin: OwnerChannelOrigin, live: () => boolean): void {
		while (this.runs.size >= MAX_OWNER_CHANNEL_RUNS) {
			const oldest = this.runs.keys().next().value;
			if (oldest === undefined) break;
			this.runs.delete(oldest);
		}
		this.runs.set(origin.ref, { live, senderDigest: origin.senderDigest, ran: false, approvalPending: false });
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

	/**
	 * From the first delivery on: a run that reads an owner-channel message marks its batch, and the batches whose runs
	 * ended are dropped once the foreground is idle (no run and no submission: a retry or a claim correction of the same
	 * submission still runs on them). A closed session keeps none.
	 */
	private observe(): void {
		if (this.observing) return;
		this.observing = true;
		this.host.agent.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "user") return;
			const run = this.runOf(turnOriginOf(event.message));
			if (run) run.ran = true;
		});
		const foreground = this.getForeground();
		foreground.subscribeActivity(() => {
			if (this.isClosed()) {
				this.runs.clear();
				return;
			}
			if (foreground.isRunActive || foreground.getCurrentSubmissionEpoch() !== undefined) return;
			for (const [ref, run] of this.runs) if (run.ran && !run.approvalPending) this.runs.delete(ref);
		});
	}
}
