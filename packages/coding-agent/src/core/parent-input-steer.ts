/** The steer mode of parent input delivery: a running turn reads a watch wake at its next model step instead of after it ends. */
import type { CustomMessage } from "../kernel/index.ts";
import type { SessionEntry } from "../kernel/session/session-entries.ts";
import type { SessionManager } from "../kernel/session/session-manager.ts";
import { isPlainRecord } from "../kernel/utils/value-guards.ts";
import type { ForegroundRecoveryController } from "./foreground-recovery-controller.ts";
import type { ParentInputDelivery, ParentInputDeliveryOptions, ParentInputReceipt } from "./parent-input-delivery.ts";
import { getActiveSessionBranchEntries } from "./session-snapshot.ts";

/** The key of the delivery mark a steered input carries in its details: its identity for replay and for wake accounting. */
const STEERED_DELIVERY_KEY = "steeredDelivery";

export interface SteeredDeliveryMark {
	readonly deliveryId: string;
	readonly payloadDigest: string;
}

/** The mark of a steered input's saved entry, or undefined for any other entry. */
export function steeredDeliveryOf(entry: SessionEntry): SteeredDeliveryMark | undefined {
	if (entry.type !== "custom_message" || !isPlainRecord(entry.details)) return undefined;
	const mark = entry.details[STEERED_DELIVERY_KEY];
	return isPlainRecord(mark) && typeof mark.deliveryId === "string" && typeof mark.payloadDigest === "string"
		? { deliveryId: mark.deliveryId, payloadDigest: mark.payloadDigest }
		: undefined;
}

/** The saved entry of an input already steered into this session's branch under `deliveryId`, newest first. */
export function findSteeredDelivery(
	manager: SessionManager,
	deliveryId: string,
): { entryId: string; mark: SteeredDeliveryMark } | undefined {
	const branch = getActiveSessionBranchEntries(manager);
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		const mark = steeredDeliveryOf(entry);
		if (mark?.deliveryId === deliveryId) return { entryId: entry.id, mark };
	}
	return undefined;
}

/** One message queued into the running turn: it settles once the turn took it in and saved it. */
export interface SteeredMessage {
	readonly accepted: Promise<void>;
	/** Takes the message back when no run consumed it yet; false when one did (its acceptance follows). */
	withdraw(): boolean;
	/** Gives up its acceptance: nothing will settle `accepted` once the turn that held it is over and it was never saved. */
	abandon(): void;
}

export interface ParentInputSteerDeps {
	foreground: Pick<ForegroundRecoveryController, "isForegroundOccupied">;
	getSessionManager(): SessionManager;
	/** Queues the message for the running turn's next model step. */
	steer(message: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">): SteeredMessage;
	/** The durable turn path: what an input does when no turn is running to take it. */
	deliverDurable(input: ParentInputDelivery, options?: ParentInputDeliveryOptions): Promise<ParentInputReceipt>;
	/** Throws when the input's session or branch is no longer the one it was produced for. */
	assertAcceptable(manager: SessionManager, input: ParentInputDelivery): void;
}

interface WaitingSteer {
	readonly input: ParentInputDelivery;
	readonly options: ParentInputDeliveryOptions | undefined;
	readonly manager: SessionManager;
	readonly assertBranch: () => void;
	resolve(receipt: ParentInputReceipt): void;
	reject(error: unknown): void;
}

interface QueuedSteer {
	readonly waiting: WaitingSteer;
	readonly steered: SteeredMessage;
}

/**
 * The steer mode of a parent input: a running turn receives the input at its next model step, so an agent that is working
 * hears a wake without waiting for its turn to end, and no turn running starts one through the durable turn path. The input is
 * acknowledged once the turn saved it; its identity is the delivery id, kept in the saved entry, so a redelivery after a
 * restart is the same input and is never appended twice.
 */
export class ParentInputSteerController {
	private readonly deps: ParentInputSteerDeps;
	private readonly waiting = new Set<WaitingSteer>();
	private readonly queued = new Set<QueuedSteer>();
	private closed = false;

	constructor(deps: ParentInputSteerDeps) {
		this.deps = deps;
	}

	async deliver(input: ParentInputDelivery, options?: ParentInputDeliveryOptions): Promise<ParentInputReceipt> {
		if (this.closed) throw new Error("Parent input delivery is closed.");
		const manager = this.deps.getSessionManager();
		const replay = this.replay(manager, input);
		if (replay) return replay;
		if (manager.getParentInput(input.deliveryId) || !this.deps.foreground.isForegroundOccupied)
			return this.deps.deliverDurable(input, options);
		this.deps.assertAcceptable(manager, input);
		return new Promise<ParentInputReceipt>((resolve, reject) => {
			this.waiting.add({ input, options, manager, assertBranch: manager.captureBranchContext(), resolve, reject });
		});
	}

	/** Called immediately before the running turn polls its steering queue: every waiting input joins it. */
	flush(): void {
		for (const waiting of [...this.waiting]) {
			this.waiting.delete(waiting);
			try {
				this.steerInto(waiting);
			} catch (error) {
				waiting.reject(error);
			}
		}
	}

	/**
	 * Called on every foreground activity change (a lease released, a compaction, rewrite or retry cleared): with nothing
	 * occupying the foreground, an input no turn took in yet takes the durable turn path instead of waiting for a boundary.
	 */
	rerouteIdle(): void {
		if (this.closed || this.deps.foreground.isForegroundOccupied) return;
		for (const waiting of [...this.waiting]) {
			this.waiting.delete(waiting);
			this.durable(waiting);
		}
		for (const queued of [...this.queued]) {
			// The run is over. Withdrawn, the turn never took it in. Not withdrawn, a run consumed it: saved, it is done;
			// unsaved (a cleared queue, a message a routed turn dropped), nothing will ever save it, so its acceptance is
			// given up and the saved turn path takes the input.
			const consumed = !queued.steered.withdraw();
			this.queued.delete(queued);
			if (consumed) queued.steered.abandon();
			// A consumed input that was saved resolves with its entry; one that was not takes the saved turn path.
			this.durable(queued.waiting);
		}
	}

	shutdown(): void {
		this.closed = true;
		const error = new Error("Parent input delivery closed.");
		for (const waiting of this.waiting) waiting.reject(error);
		for (const { waiting } of this.queued) waiting.reject(error);
		this.waiting.clear();
		this.queued.clear();
	}

	/** The saved turn path, unless the input was already steered into the branch (then that entry is its receipt). */
	private durable(waiting: WaitingSteer): void {
		let saved: ParentInputReceipt | undefined;
		try {
			saved = this.replay(waiting.manager, waiting.input);
		} catch (error) {
			waiting.reject(error);
			return;
		}
		if (saved) waiting.resolve(saved);
		else this.deps.deliverDurable(waiting.input, waiting.options).then(waiting.resolve, waiting.reject);
	}

	private steerInto(waiting: WaitingSteer): void {
		const { input, manager } = waiting;
		waiting.assertBranch();
		if (this.closed || this.deps.getSessionManager() !== manager) throw new Error("Parent input session changed.");
		this.deps.assertAcceptable(manager, input);
		const replay = this.replay(manager, input);
		if (replay) {
			waiting.resolve(replay);
			return;
		}
		const details = isPlainRecord(input.message.details) ? input.message.details : { value: input.message.details };
		const mark: SteeredDeliveryMark = { deliveryId: input.deliveryId, payloadDigest: input.payloadDigest };
		const steered = this.deps.steer({ ...input.message, details: { ...details, [STEERED_DELIVERY_KEY]: mark } });
		const queued: QueuedSteer = { waiting, steered };
		this.queued.add(queued);
		steered.accepted.then(
			() => {
				this.queued.delete(queued);
				const saved = this.replay(manager, input);
				if (saved) waiting.resolve(saved);
				else waiting.reject(new Error("The steered parent input has no canonical entry."));
			},
			(error: unknown) => {
				this.queued.delete(queued);
				waiting.reject(error);
			},
		);
	}

	/** The receipt of an input steered earlier under this delivery id, once its saved body is the same. */
	private replay(manager: SessionManager, input: ParentInputDelivery): ParentInputReceipt | undefined {
		const found = findSteeredDelivery(manager, input.deliveryId);
		if (!found) return undefined;
		if (found.mark.payloadDigest !== input.payloadDigest)
			throw new Error("A different parent input was already steered under this delivery id.");
		return { entryId: found.entryId, sessionId: manager.getSessionId() };
	}
}
