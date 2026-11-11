/**
 * The monotonic revision behind every action-transcript cache key: one counter that moves whenever an
 * admitted tool call's rendered presentation can change, so a viewport can detect change without
 * walking the transcript's children.
 */

let actionTranscriptEpoch = 0;

/** Called by every mutation that can change what an action transcript renders. */
export function bumpActionTranscriptEpoch(): void {
	actionTranscriptEpoch++;
}

export function getActionTranscriptEpoch(): number {
	return actionTranscriptEpoch;
}
