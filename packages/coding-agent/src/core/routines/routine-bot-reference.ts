/** Stable delivery identity shared by a scheduled bot turn and the jobs that turn places. */
import { createHash } from "node:crypto";

export const ROUTINE_BOT_CHANNEL = "routine";

export function routineBotOccurrenceRef(occurrenceId: string): string {
	return `routine:${createHash("sha256").update(occurrenceId).digest("hex").slice(0, 32)}`;
}
