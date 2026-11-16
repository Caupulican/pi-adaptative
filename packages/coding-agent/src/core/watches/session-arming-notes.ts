/**
 * The session's own arming notes (`watch-auto-arm.ts`) between the host's tell and the turn that takes them, under an
 * owner's stop of the session's bot. A note is queued for the session's next model step at once
 * (`DurableCustomMessageTurnController.steer`), its handle kept with when the call it follows began until a run takes it
 * in; neither the stop's abort of the turn nor the next run clears that queue, so the owner's stop applied in the session
 * ({@link SessionArmingNotes.endByStop}) takes back every note about a call begun by the stop, which then reaches no
 * run. While a stop of the bot waits to be taken a note is held instead, as a watch's wake is: each delivery pass of the
 * session's watches ({@link SessionArmingNotes.release}) queues it once no stop waits, or drops it when a stop applied
 * since ended the work of its call. In memory, as the note is: a restart tells none.
 */
import type { SteeredMessage } from "../parent-input-steer.ts";

interface ArmingNote {
	/** When the call the note follows began, on `OWNER_STOP_CLOCK`. */
	readonly callStartedAt: number;
	readonly steer: () => SteeredMessage;
	/** Settles the tell: resolved once the note is durable, or with nothing once a stop took it back or dropped it. */
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
	steered?: SteeredMessage;
}

export class SessionArmingNotes {
	private readonly stopWaiting: () => boolean;
	private readonly held = new Set<ArmingNote>();
	private readonly queued = new Set<ArmingNote>();

	/** `stopWaiting`: whether an owner's stop of the session's bot waits to be taken (always false outside a bot's session). */
	constructor(stopWaiting: () => boolean) {
		this.stopWaiting = stopWaiting;
	}

	/** Whether a note waits for a stop of the bot to be taken. */
	get holding(): boolean {
		return this.held.size > 0;
	}

	/**
	 * Tells the session one note about the call begun at `callStartedAt` through `steer`: queued now, or held while a stop
	 * of the bot waits, or while whether one waits could not be read, as a wake is: the next delivery pass reads it again
	 * and warns its failure once per cause ({@link release}). Resolves once the note is durable, or once a stop took it
	 * back or dropped it; rejects when it could not be queued.
	 */
	tell(callStartedAt: number, steer: () => SteeredMessage): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const note: ArmingNote = { callStartedAt, steer, resolve, reject };
			if (this.stopWaitingOrUnread()) this.held.add(note);
			else this.queue(note);
		});
	}

	/** Whether a stop waits, or reading that failed: the pass that releases held notes reads it again and tells why. */
	private stopWaitingOrUnread(): boolean {
		try {
			return this.stopWaiting();
		} catch {
			return true;
		}
	}

	/**
	 * Queues each held note once no stop of the bot waits, dropping one whose call's work a stop applied since ended
	 * (`stopEnded`). Whether a note is still held; throws when whether a stop waits could not be read (tried again then).
	 */
	release(stopEnded: (callStartedAt: number) => boolean): boolean {
		if (this.held.size === 0) return false;
		if (this.stopWaiting()) return true;
		for (const note of [...this.held]) {
			this.held.delete(note);
			if (stopEnded(note.callStartedAt)) note.resolve();
			else this.queue(note);
		}
		return false;
	}

	/**
	 * The owner's stop made at `stopAt` applied in the session: every note about a call begun by then is taken back from
	 * the session's queue, or dropped while held. One a run already took in was read before the stop, and its acceptance
	 * follows as it would.
	 */
	endByStop(stopAt: number): void {
		for (const note of [...this.queued]) {
			if (note.callStartedAt > stopAt) continue;
			this.queued.delete(note);
			if (note.steered?.withdraw() === true) note.resolve();
		}
		for (const note of [...this.held]) {
			if (note.callStartedAt > stopAt) continue;
			this.held.delete(note);
			note.resolve();
		}
	}

	/** The session's watches stopped: a held note is told to no one. */
	close(): void {
		for (const note of this.held) note.resolve();
		this.held.clear();
	}

	private queue(note: ArmingNote): void {
		let steered: SteeredMessage;
		try {
			steered = note.steer();
		} catch (error) {
			// The tell fails with it, and the armer reports it as any failed note.
			note.reject(error);
			return;
		}
		note.steered = steered;
		this.queued.add(note);
		steered.accepted.then(
			() => {
				this.queued.delete(note);
				note.resolve();
			},
			(error: unknown) => {
				this.queued.delete(note);
				note.reject(error);
			},
		);
	}
}
