/** Bind a placed job to the scheduled bot input its dispatch actually served, including delayed plan steps. */
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import { visitSessionAncestry } from "../../kernel/session/session-tree.ts";
import { isRoutineBotOccurrenceRef, type TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import { botHomeName } from "../agent-paths.ts";
import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import { botHomeOfDir } from "../orchestration-homes.ts";
import { ROUTINE_BOT_CHANNEL, routineBotOccurrenceRef } from "../routines/routine-bot-reference.ts";
import { entryTurnOrigin, isAddressedInput } from "../turn-origin.ts";

function scope(homeName: string, ref: string): string {
	return createHash("sha256")
		.update(JSON.stringify([homeName, ref]))
		.digest("hex");
}

export function routineJobScope(bot: string, occurrenceId: string): string {
	return scope(botHomeName(bot), routineBotOccurrenceRef(occurrenceId));
}

export function isRoutineJobScope(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sourceRef(origin: TurnOriginRecord | undefined): string | undefined {
	if (origin?.k === "owner-channel" && origin.verified) return origin.routineRef;
	if (
		origin?.channel === ROUTINE_BOT_CHANNEL &&
		(origin.k === "routine" || (origin.k === "host-event" && origin.thirdParty)) &&
		isRoutineBotOccurrenceRef(origin.ref)
	)
		return origin.ref;
	return undefined;
}

const receiptSources = new WeakMap<SessionEntry, string | null>();

/** The receipt is frozen when the work is stated. An intervening owner input cannot retarget a delayed dispatch. */
export function placedRoutineJobScope(manager: SessionManager, receipt: WorkerReceiptOrigin): string | undefined {
	if (
		!receipt.sessionFile ||
		manager.getSessionId() !== receipt.sessionId ||
		manager.getSessionFile() !== receipt.sessionFile
	)
		return undefined;
	const home = botHomeOfDir(manager.getStorageRoots().agentDir, dirname(receipt.sessionFile));
	if (!home) return undefined;
	let ref: string | null = null;
	const visited: SessionEntry[] = [];
	visitSessionAncestry(
		manager.getEntry(receipt.leafId),
		{ size: manager.getEntryCount(), get: (id) => manager.getEntry(id) },
		(entry) => {
			const cached = receiptSources.get(entry);
			if (cached !== undefined) {
				ref = cached;
				return false;
			}
			visited.push(entry);
			const origin = entryTurnOrigin(entry);
			if (isAddressedInput(entry.type === "message" ? entry.message.role : undefined, origin)) {
				ref = sourceRef(origin) ?? null;
				return false;
			}
			return undefined;
		},
	);
	for (const entry of visited) receiptSources.set(entry, ref);
	return ref ? scope(basename(home.homeDir), ref) : undefined;
}
