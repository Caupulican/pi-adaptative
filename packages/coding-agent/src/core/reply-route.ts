import type { ForegroundRouteSnapshot } from "./model-router-controller.ts";

/**
 * Session custom entry recording the route of a reply that a routed model wrote, keyed by the reply's
 * timestamp, so a reloaded conversation names the same author and route the live one showed.
 */
export const REPLY_ROUTE_CUSTOM_TYPE = "reply_route";

export interface ReplyRouteRecord {
	readonly timestamp: number;
	readonly route: ForegroundRouteSnapshot;
}

/**
 * Session custom entry recording the conversation's talker: the model the opening's judged route chose,
 * which answers every later owner message with no route judged (conversation-continuity stage 1). The
 * talker is the session model; `/model` changes it like any session model change.
 */
export const CONVERSATION_TALKER_CUSTOM_TYPE = "conversation_talker";

export interface ConversationTalkerRecord {
	readonly model: string;
	readonly thinkingLevel: string;
	readonly reasons: readonly string[];
	readonly decidedAt: number;
}
