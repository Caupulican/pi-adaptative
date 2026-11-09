/** Shared ICM work contracts. Indexed scheduling is owned by continuous-chat-scheduler.ts. */
import { type ContinuousChatNodeCoordinate, continuousChatNodeKey } from "./continuous-chat-tree.ts";

export const CONTINUOUS_CHAT_MAX_CONCURRENT_COMPACTIONS = 8;
export const CONTINUOUS_CHAT_MAX_FAILURE_REASON_CHARACTERS = 512;
export const CONTINUOUS_CHAT_TOP_LEVEL = 52;

export type ContinuousChatWorkItem = ContinuousChatNodeCoordinate;

/** Requested disposition of a claimed compaction without an acknowledged publication. */
export type ContinuousChatWorkAbandonment =
	| { readonly kind: "release" }
	| { readonly kind: "fail"; readonly reason: string; readonly recoveryOnly?: boolean; readonly recoveryKey?: string };

/**
 * Legacy migration value; current failure records live in the indexed scheduler.
 *
 * @deprecated Migration value of the earlier blocked-work records; remove with the one-time continuous-chat import.
 */
export interface ContinuousChatBlockedWork {
	item: ContinuousChatWorkItem;
	retryAfterGeneration: number;
	reason: string;
}

export function continuousChatWorkItemKey(item: ContinuousChatWorkItem): string {
	return continuousChatNodeKey(item);
}
