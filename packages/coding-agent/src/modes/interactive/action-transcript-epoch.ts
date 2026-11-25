/**
 * The revision of action-transcript membership. Tool content updates are tracked by their own row revisions.
 */

let actionTranscriptEpoch = 0;

/** Called when a transcript admits a new action. */
export function bumpActionTranscriptEpoch(): void {
	actionTranscriptEpoch++;
}

export function getActionTranscriptEpoch(): number {
	return actionTranscriptEpoch;
}
