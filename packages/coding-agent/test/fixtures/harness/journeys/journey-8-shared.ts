/**
 * What the fleet-capacity journey's three legs share: a start's receipt as the root reads it, the two machine-wide
 * fleet state files the product writes (`state/fleet/accounts.json` and `state/fleet/spend.json`), and the scripted
 * root turn a worker's terminal handoff starts.
 *
 * Nothing here decides a journey's facts: every read is the file or the transcript the product itself produced.
 */
import { join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { HARNESS_NOTICE_CUSTOM_TYPE } from "../../../../src/core/harness-notice.ts";
import { resolveProviderAccountKey } from "../../../../src/core/provider-admission/account-key.ts";
import { isRecordObject } from "../../../../src/core/util/value-guards.ts";
import { parentInputOriginalDetails } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import {
	type Barrier,
	HARNESS_PROVIDER,
	type ScriptedReply,
	type ScriptedRequest,
	type ScriptStep,
} from "../scripted-provider.ts";
import type { HarnessWorld } from "../session-fixture.ts";

/** The provider every worker of these legs runs on, so one account's window governs them all. */
export { HARNESS_PROVIDER };

/** One `delegate` result as the root reads it: its text and the details the product attached. */
export interface DelegateReceipt {
	readonly text: string;
	readonly isError: boolean;
	readonly details: Record<string, unknown>;
}

/** The text of one message's content, whichever way the harness shaped it. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecordObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n");
}

/** The text of a request's newest message: what the dispatcher or the parent said last. */
export function newestText(request: ScriptedRequest): string {
	return contentText(request.context.messages.at(-1)?.content);
}

/** Every `delegate` result in the session's transcript, oldest first. */
export function delegateReceipts(session: AgentSession): DelegateReceipt[] {
	const receipts: DelegateReceipt[] = [];
	for (const message of session.messages) {
		if (message.role !== "toolResult" || message.toolName !== "delegate") continue;
		receipts.push({
			text: contentText(message.content),
			isError: message.isError === true,
			details: isRecordObject(message.details) ? message.details : {},
		});
	}
	return receipts;
}

/** What a start result reports about the lane it made. */
export interface StartView {
	readonly started: boolean;
	readonly laneId: string;
	readonly agentId: string;
	/** The state codes the result carries: `["QUEUED"]` for a lane that waits, absent for one that runs. */
	readonly h: unknown;
	/** The result's own text: the line the root reads about the lane. */
	readonly text: string;
}

export function startOf(receipt: DelegateReceipt): StartView {
	const { started, laneId, agentId, h } = receipt.details;
	if (typeof laneId !== "string" || typeof agentId !== "string")
		throw new Error(`a start result carries no lane or agent: ${JSON.stringify(receipt.details)}`);
	return { started: started === true, laneId, agentId, h, text: receipt.text };
}

/**
 * A `delegate start` call for a read-only worker on a pinned model. A start that names the workers already running
 * (`independentOf`) asks for a separate copy: without it the product hands the task to the compatible worker it has.
 */
export function startCall(
	id: string,
	instructions: string,
	modelId: string,
	independentOf: readonly string[] = [],
): { id: string; name: string; arguments: Record<string, unknown> } {
	return {
		id,
		name: "delegate",
		arguments: {
			action: "start",
			model: { provider: HARNESS_PROVIDER, modelId },
			instructions,
			readOnly: true,
			...(independentOf.length > 0
				? {
						parallelWork: {
							independentOf: [...independentOf],
							justification: "Each worker reports on its own, at the same time as the others.",
						},
					}
				: {}),
		},
	};
}

/** The workers the session's accepted starts made so far, oldest first. */
export function startedAgents(session: AgentSession): string[] {
	return delegateReceipts(session)
		.filter((receipt) => !receipt.isError)
		.map((receipt) => startOf(receipt).agentId);
}

/**
 * One root request answered with one start. The start names every worker the session's accepted starts made before it,
 * so it asks for a worker of its own: without that the product hands the task to the compatible worker it already has.
 * One start per request also lets each room decision see the count the start before it left, where a batch of starts
 * would decide all of them against the same count.
 */
export function startStep(
	session: AgentSession,
	name: string,
	callId: string,
	instructions: string,
	modelId: string,
): ScriptStep {
	return {
		name,
		reply: () => ({
			content: [{ type: "toolCall", ...startCall(callId, instructions, modelId, startedAgents(session)) }],
			stopReason: "toolUse",
		}),
	};
}

/** A worker's whole reply: one report call that ends its lane. */
export function submitReport(callId: string, summary: string): ScriptedReply {
	return {
		content: [{ type: "toolCall", id: callId, name: "submit_report", arguments: { status: "completed", summary } }],
		stopReason: "toolUse",
	};
}

/** A script track for one worker: the conversation that carries `marker` in its task, so a shared model tells tracks apart. */
export function carriesMarker(marker: string): (request: ScriptedRequest) => boolean {
	return (request) => request.context.messages.some((message) => contentText(message.content).includes(marker));
}

/**
 * The root turn a worker's terminal handoff starts: its input is that handoff, it answers in plain words, and `arrived`
 * releases so the leg knows the turn happened.
 */
export function handoffTurn(name: string, arrived: Barrier): ScriptStep {
	return {
		name,
		check: (request: ScriptedRequest) => {
			expect(newestText(request), `${name}: the turn's input is a worker terminal handoff`).toContain(
				"Background worker terminal handoff:",
			);
			arrived.release();
		},
		reply: { content: [{ type: "text" as const, text: "Noted." }] },
	};
}

/** Lets every pending microtask and immediate of the world run, with no wait on any clock. */
export function settle(): Promise<void> {
	return new Promise<void>((resolve) => setImmediate(resolve));
}

/** The fleet's own clock: its alarms fire only when a journey advances it; its reads move with the wall clock. */
export function fleetNow(world: HarnessWorld): number {
	return world.timers.port("fleet").now();
}

/** The file the fleet's account windows are shared through. */
export function accountsPath(world: HarnessWorld): string {
	return join(world.agentDir, "state", "fleet", "accounts.json");
}

/** The file the fleet's metered spend is shared through. */
export function spendPath(world: HarnessWorld): string {
	return join(world.agentDir, "state", "fleet", "spend.json");
}

/** The account the scripted provider's requests are charged to, keyed as the product keys it. */
export function scriptedAccountKey(world: HarnessWorld): string {
	return resolveProviderAccountKey(world.authStorage, HARNESS_PROVIDER);
}

/** One account's learned window, as the shared file holds it. */
export interface WindowRecord {
	readonly w: number;
	readonly ssthresh: number;
	readonly lastDecreaseAt: number;
	readonly updatedAt: number;
	readonly blockedUntil?: number;
	readonly blockedAt?: number;
}

/** The record the shared file holds for `accountKey`, or undefined while the file or the record is absent. */
export function accountRecord(world: HarnessWorld, accountKey: string): WindowRecord | undefined {
	const raw = world.io.peekFile(accountsPath(world));
	if (raw === undefined) return undefined;
	const parsed: unknown = JSON.parse(raw);
	if (!isRecordObject(parsed) || !isRecordObject(parsed.accounts)) return undefined;
	const record = parsed.accounts[accountKey];
	if (!isRecordObject(record)) return undefined;
	return {
		w: Number(record.w),
		ssthresh: Number(record.ssthresh),
		lastDecreaseAt: Number(record.lastDecreaseAt),
		updatedAt: Number(record.updatedAt),
		...(typeof record.blockedUntil === "number" ? { blockedUntil: record.blockedUntil } : {}),
		...(typeof record.blockedAt === "number" ? { blockedAt: record.blockedAt } : {}),
	};
}

/**
 * Writes the seed window the leg starts from: an account that serves `window` workers at once under a running ceiling
 * of `ceiling`. It is the record a build writes for itself when nothing has ever refused it.
 */
export function seedAccountWindow(world: HarnessWorld, accountKey: string, window: number, ceiling: number): void {
	world.io.seed(
		accountsPath(world),
		`${JSON.stringify({
			v: 1,
			accounts: { [accountKey]: { w: window, ssthresh: ceiling, lastDecreaseAt: 0, updatedAt: 0 } },
			workers: {},
		})}\n`,
	);
}

/** The metered spend file as the product reads it. */
export interface SpendFileView {
	readonly day: string;
	readonly dayUsd: number;
	readonly goals: Record<string, unknown>;
	readonly windows: ReadonlyArray<readonly [number, number]>;
	readonly reservations: Record<string, unknown>;
	readonly settled: Record<string, unknown>;
}

/** The spend file as it is on disk, or undefined while the product wrote none. */
export function spendFile(world: HarnessWorld): SpendFileView | undefined {
	const raw = world.io.peekFile(spendPath(world));
	if (raw === undefined) return undefined;
	const parsed: unknown = JSON.parse(raw);
	if (!isRecordObject(parsed)) return undefined;
	const windows = Array.isArray(parsed.windows)
		? parsed.windows.flatMap((entry): (readonly [number, number])[] =>
				Array.isArray(entry) && typeof entry[0] === "number" && typeof entry[1] === "number"
					? [[entry[0], entry[1]] as const]
					: [],
			)
		: [];
	return {
		day: String(parsed.day),
		dayUsd: Number(parsed.dayUsd),
		goals: isRecordObject(parsed.goals) ? parsed.goals : {},
		windows,
		reservations: isRecordObject(parsed.reservations) ? parsed.reservations : {},
		settled: isRecordObject(parsed.settled) ? parsed.settled : {},
	};
}

/** The local calendar day the product charges a spend to, from a clock reading. */
export function localDayOf(at: number): string {
	const date = new Date(at);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The start of the 15-minute window a clock reading falls in. */
export function spendWindowOf(at: number): number {
	return Math.floor(at / (15 * 60_000)) * (15 * 60_000);
}

/** Writes the spend file a previous run left: `dayUsd` settled today, and `windowUsd` settled in the current window. */
export function seedSpendFile(world: HarnessWorld, input: { now: number; dayUsd: number; windowUsd: number }): void {
	const windows = input.windowUsd > 0 ? [[spendWindowOf(input.now), input.windowUsd]] : [];
	world.io.seed(
		spendPath(world),
		`${JSON.stringify({
			v: 1,
			day: localDayOf(input.now),
			dayUsd: input.dayUsd,
			goals: {},
			windows,
			reservations: {},
			settled: {},
		})}\n`,
	);
}

/** The harness notices of one kind the session saved, with the text the owner reads. */
export function harnessNotices(
	sessionManager: SessionManager,
	kind: string,
): Array<{ readonly reason: string; readonly text: string }> {
	const notices: Array<{ reason: string; text: string }> = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom_message" || entry.customType !== HARNESS_NOTICE_CUSTOM_TYPE) continue;
		const details = parentInputOriginalDetails(entry);
		if (!isRecordObject(details) || details.kind !== kind) continue;
		notices.push({
			reason: typeof details.reason === "string" ? details.reason : "",
			text: contentText(entry.content),
		});
	}
	return notices;
}

/** Waits until the session saved `count` notices of `kind`: a notice is saved after the turn that observed it. */
export function noticesSaved(sessionManager: SessionManager, kind: string, count: number): Promise<void> {
	if (harnessNotices(sessionManager, kind).length >= count) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const stop = sessionManager.onEntriesPersisted(() => {
			if (harnessNotices(sessionManager, kind).length < count) return;
			stop();
			resolve();
		});
	});
}
