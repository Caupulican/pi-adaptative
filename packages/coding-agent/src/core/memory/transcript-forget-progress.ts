/**
 * Forget progress of the transcript memory coordinator: the ready jobs a forget dropped before its removal counted them,
 * and whether a refresh of the permanent forget state is already queued on the mailbox. Both are written only through
 * the commands below.
 */
export class ForgetProgress {
	/** Ready jobs dropped when a forget stopped the session's work, counted by the removal that follows. */
	private earlyDropped = 0;
	/** A refresh of the permanent forget state is already queued on the mailbox. */
	private refreshQueued = false;

	addEarlyDropped(count: number): void {
		this.earlyDropped += count;
	}

	clearEarlyDropped(): void {
		this.earlyDropped = 0;
	}

	/** The early-dropped count is taken by the removal that reports it; the count starts again at zero. */
	takeEarlyDropped(): number {
		const dropped = this.earlyDropped;
		this.earlyDropped = 0;
		return dropped;
	}

	/** Marks a refresh queued; false when one already is (nothing new is queued then). */
	queueRefresh(): boolean {
		if (this.refreshQueued) return false;
		this.refreshQueued = true;
		return true;
	}

	/** The queued refresh has started on the mailbox; another may be queued after it. */
	refreshStarted(): void {
		this.refreshQueued = false;
	}

	reset(): void {
		this.earlyDropped = 0;
		this.refreshQueued = false;
	}
}
