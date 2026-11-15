/**
 * Why a bot's work did not go through, in the owner's words, for the sentences that name the cause of a failure its host
 * met on its own (an open of its session for owed work, a message that waits for it, a release it owes). An error thrown
 * in the owner's words (`BotOwnerError`) keeps them; the kernel and store failures the owner can act on or wait
 * out are worded here; any other is said in one generic sentence, and its own text goes to the harness log.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	SessionHeldError,
	SessionHomeChangedError,
	type SessionLeaseHolderRef,
	SessionLeaseRegistryError,
} from "../../kernel/session/session-bundle-lifecycle.ts";
import { RoutineRevisionChangedError } from "../delegation/routine-revision.ts";
import { interfaceText } from "../language/interface-text.ts";
import { BotBundleSplitError } from "./bot-bundle-move.ts";
import { BotOwnerError } from "./bot-owner-error.ts";

/** A lock another process kept past the wait: proper-lockfile's `ELOCKED`, or the kernel lock's deadline. */
export function isLockBusy(error: unknown): boolean {
	const { code } = (error ?? {}) as NodeJS.ErrnoException;
	return code === "ELOCKED" || code === "ELOCKDEADLINE";
}

function holderWords(holder: SessionLeaseHolderRef): string {
	const words = interfaceText().botTeam;
	return holder.role === "channel-host"
		? words.botSessionHolderPhone(holder.pid)
		: holder.role === "bot-host"
			? words.botSessionHolderBotHost(holder.pid)
			: words.botSessionHolderSession(holder.pid);
}

/** What failed for bot `agentId` with `error`, in the owner's words (see the module comment). */
export function botFailureText(agentId: string, error: unknown): string {
	const words = interfaceText().botTeam;
	if (error instanceof BotOwnerError) return error.message;
	if (error instanceof SessionHeldError)
		return words.botSessionOpenElsewhere(agentId, error.holders.map(holderWords).join(", "));
	if (error instanceof SessionHomeChangedError) return words.botSessionHomeChanged(agentId);
	if (error instanceof SessionLeaseRegistryError) return words.botSessionLeasesUnreadable(agentId, error.file);
	if (error instanceof BotBundleSplitError)
		return words.botSessionStateSplit(agentId, error.inBotHome.join(", "), error.inOwnerHome.join(", "));
	if (error instanceof RoutineRevisionChangedError) return words.botWatchChangedMeanwhile(agentId);
	if (isLockBusy(error)) return words.botFilesLocked(agentId);
	harnessLog.warn("bots", "a bot failure has no words for the owner", () => ({
		agentId,
		error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
	}));
	return words.botFailureUnworded(agentId);
}
