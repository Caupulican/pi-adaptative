/**
 * Why a bot's work did not go through, in the owner's words, for the sentences that name the cause of a failure its host
 * met on its own (an open of its session for owed work, a message that waits for it, a release it owes). An error thrown
 * in the owner's words (`BotOwnerError`) keeps them; the kernel and store failures the owner can act on or wait
 * out are worded here; any other is said in one generic sentence. Each failure's own text, with every cause under it,
 * goes to the harness log.
 */
import { harnessLog } from "../../kernel/harness-log.ts";
import {
	SessionHeldError,
	SessionHomeChangedError,
	type SessionLeaseHolderRef,
	SessionLeaseRegistryError,
} from "../../kernel/session/session-bundle-lifecycle.ts";
import { FileLockDeadlineError, isFileLockContentionError } from "../../kernel/storage/atomic-file.ts";
import { RoutineRevisionChangedError } from "../delegation/routine-revision.ts";
import { interfaceText } from "../language/interface-text.ts";
import { BotBundleSplitError } from "./bot-bundle-move.ts";
import { BotOwnerError } from "./bot-owner-error.ts";

/**
 * A lock another process holds past the wait, wherever its file lies: an acquisition the storage owner judged contention
 * (proper-lockfile's `ELOCKED`, or a Windows `EPERM` while that lock's directory is torn down), or the lock's deadline.
 */
export function isLockBusy(error: unknown): boolean {
	return isFileLockContentionError(error) || error instanceof FileLockDeadlineError;
}

/** How many causes under a failure the log follows. */
const MAX_LOGGED_CAUSES = 8;

/** `error` and the causes under it, each as its name and message, outermost first. */
function causeChain(error: unknown): string[] {
	const chain: string[] = [];
	let link: unknown = error;
	while (chain.length <= MAX_LOGGED_CAUSES) {
		chain.push(link instanceof Error ? `${link.name}: ${link.message}` : String(link));
		if (!(link instanceof Error) || link.cause === undefined) break;
		link = link.cause;
	}
	return chain;
}

function holderWords(holder: SessionLeaseHolderRef): string {
	const text = interfaceText();
	const words = text.botTeam;
	const process =
		holder.role === "channel-host"
			? words.botSessionHolderPhone(holder.pid)
			: holder.role === "bot-host"
				? words.botSessionHolderBotHost(holder.pid)
				: words.botSessionHolderSession(holder.pid);
	if (!holder.elsewhere) return process;
	return words.botSessionHolderOnMachine(process, holder.elsewhere.hostname ?? text.sessions.hosted.otherMachine);
}

/** The owner's words for `error` when this module words it, else undefined (see the module comment). */
function wordsFor(agentId: string, error: unknown): string | undefined {
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
	return undefined;
}

/** A failure of the bots' own upkeep that names no bot (`what`), its cause chain written to the harness log. */
export function logBotsFailure(what: string, error: unknown): void {
	harnessLog.warn("bots", what, () => ({ error: causeChain(error).join(" <- caused by ") }));
}

/** What failed for bot `agentId` with `error`, in the owner's words; the failure's cause chain goes to the harness log. */
export function botFailureText(agentId: string, error: unknown): string {
	const worded = wordsFor(agentId, error);
	harnessLog.warn("bots", worded === undefined ? "a bot failure has no words for the owner" : "a bot failure", () => ({
		agentId,
		error: causeChain(error).join(" <- caused by "),
	}));
	return worded ?? interfaceText().botTeam.botFailureUnworded(agentId);
}

/**
 * `error` as a {@link BotOwnerError} in the owner's words, keeping it as the cause, when it is a kernel failure of the
 * bot's session that only this module words (its home changed while it opened, a lease registry that needs inspection,
 * a move split between homes); else `error` itself. For a failure thrown on to the owner, whose message they read.
 */
export function inOwnerWords(agentId: string, error: unknown): unknown {
	const kernel =
		error instanceof SessionHomeChangedError ||
		error instanceof SessionLeaseRegistryError ||
		error instanceof BotBundleSplitError;
	return kernel ? new BotOwnerError(botFailureText(agentId, error), { cause: error }) : error;
}
