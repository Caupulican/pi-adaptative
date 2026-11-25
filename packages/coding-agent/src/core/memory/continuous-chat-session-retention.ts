/** Releases a settled ICM turn's canonical payloads without making retention part of run success. */

import type { SessionManager } from "../../kernel/session/session-manager.ts";

interface ActiveContinuousChatHost {
	readonly turns: { current(): unknown };
}

export function releaseIcmSessionPayloads(
	host: ActiveContinuousChatHost | undefined,
	sessionManager: Pick<SessionManager, "releaseSettledMessagePayloads">,
): string | undefined {
	if (host?.turns.current() === undefined) return undefined;
	try {
		sessionManager.releaseSettledMessagePayloads();
		return undefined;
	} catch (error) {
		return `Continuous chat could not release settled transcript payloads: ${error instanceof Error ? error.message : String(error)}`;
	}
}
