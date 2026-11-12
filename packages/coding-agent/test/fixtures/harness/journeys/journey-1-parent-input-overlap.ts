/** Composed proof of simultaneous owner-note and detached-wake custody for one physical request. */
import { sep } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
	PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	parentInputConsumptionOf,
	parentInputMessage,
	parentInputOf,
	parentInputOriginalDetails,
	parentWakeSettlementOf,
} from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { verifyParentInputLegacyOverlap } from "./journey-1-parent-input-legacy-overlap.ts";
import { icmContinuousStore, icmReadContinuousRecords, icmReadScheduler } from "./shared.ts";

/** The existing routine journey supplies actual scheduler result, notice, owner steering and provider answer. */
export async function verifyParentInputOverlap(
	world: HarnessWorld,
	manager: SessionManager,
	agentDir: string,
	session: AgentSession,
): Promise<void> {
	const entries = manager.getEntries();
	const notice = entries.find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "harness-notice" &&
			typeof entry.content === "string" &&
			entry.content.includes("Routine failing-review was paused"),
	);
	const result = entries.find(
		(entry) =>
			entry.type === "custom_message" &&
			entry.customType === "routine-completion" &&
			typeof entry.content === "string" &&
			entry.content.includes("routine-failing-5 blocked."),
	);
	if (
		notice?.type !== "custom_message" ||
		typeof notice.content !== "string" ||
		result?.type !== "custom_message" ||
		typeof result.content !== "string"
	)
		throw new Error("H25 requires the actual paused notice and failed routine result.");
	expect(parentInputOf(notice)?.metadata.mode).toBe("next-owner-turn");
	expect(parentInputOf(result)?.metadata.mode).toBe("turn");
	const receipts = entries.flatMap((entry) => {
		const value = parentInputConsumptionOf(entry);
		return value ? [{ entry, value }] : [];
	});
	const owner = receipts.find(
		({ value }) => value.mode === "next-owner-turn" && value.inputs.some((item) => item.entryId === notice.id),
	);
	const wake = receipts.find(
		({ value }) => value.mode === "turn" && value.inputs.some((item) => item.entryId === result.id),
	);
	if (!owner || !wake) throw new Error("H25 requires both independently published consumption receipts.");
	expect(owner.value.requestId).toBe(wake.value.requestId);
	expect(owner.value.requestSnapshotEntryId).toBe(wake.value.requestSnapshotEntryId);
	expect(owner.value.terminalEntryId).toBe(wake.value.terminalEntryId);
	expect(owner.entry.parentId).toBe(owner.value.terminalEntryId);
	const settlement = entries.find((entry) => entry.id === wake.entry.parentId);
	if (!settlement || !parentWakeSettlementOf(settlement)) throw new Error("H25 wake has no native settlement.");
	expect(settlement.parentId).toBe(owner.entry.id);
	expect(wake.entry.parentId).toBe(settlement.id);
	expect(owner.entry).toMatchObject({ type: "custom", customType: PARENT_INPUT_CONSUMED_CUSTOM_TYPE });
	expect(settlement).toMatchObject({ type: "custom", customType: PARENT_INPUT_SETTLED_CUSTOM_TYPE });
	const store = icmContinuousStore(agentDir);
	const prefixes = [notice.id, result.id].map((id) => `parent:${manager.getSessionId()}:${id}:0:`);
	const keys = prefixes.map((prefix) => `${prefix}0`);
	const viewPosition = (path: string): unknown => {
		try {
			const raw = world.io.peekFile(path);
			if (raw === undefined) return "absent";
			const value = (JSON.parse(raw) as { totalMessages?: unknown }).totalMessages;
			return typeof value === "number" ? value : "invalid";
		} catch {
			return "unreadable";
		}
	};
	const views = () => ({ turn: viewPosition(store.turnViewFile), causal: viewPosition(store.causalViewFile) });
	const entryViews = views();
	const operationStart = world.io.operations.length;
	let predicateChecks = 0;
	try {
		await withDeadline(
			world.trace,
			"H25 both original deliveries enter continuous chat",
			world.io.waitForMutation(() => {
				predicateChecks++;
				const records = icmReadContinuousRecords(world, store);
				return keys.every((key) => records.filter((record) => record.sourceKey === key).length === 1);
			}),
		);
	} catch (error) {
		try {
			const records = icmReadContinuousRecords(world, store);
			const observed = prefixes.map((prefix) => {
				const counts = new Map<string, number>();
				for (const record of records) {
					if (record.sourceKey.startsWith(prefix))
						counts.set(record.sourceKey, (counts.get(record.sourceKey) ?? 0) + 1);
				}
				return {
					total: [...counts.values()].reduce((sum, count) => sum + count, 0),
					keys: [...counts].slice(0, 8),
				};
			});
			const rootRaw = world.io.peekFile(store.rootFile);
			const root = rootRaw === undefined ? undefined : (JSON.parse(rootRaw) as { nextId?: unknown });
			const diagnostic = {
				memorySystem: session.getMemorySystem(),
				cwd: manager.getCwd(),
				sessionId: manager.getSessionId(),
				expected: keys,
				observed,
				storePresent: world.io.existsSync(store.root),
				mainPresent: world.io.existsSync(store.mainDir),
				rootPresent: rootRaw !== undefined,
				rootNextId: root?.nextId,
				queue: icmReadScheduler(world, store),
				predicateChecks,
				operations: {
					start: operationStart,
					end: world.io.operations.length,
					lastStoreOperations: world.io.operations
						.filter(
							(operation) => operation.path === store.root || operation.path.startsWith(`${store.root}${sep}`),
						)
						.slice(-12)
						.map((operation) => ({ kind: operation.kind, path: operation.path.slice(store.root.length) })),
				},
				views: { entry: entryViews, failure: views() },
				receiptPositions: { owner: entries.indexOf(owner.entry), wake: entries.indexOf(wake.entry) },
				totalRecords: records.length,
				lastSourceKeys: records.slice(-8).map((record) => record.sourceKey),
				ingestionWarnings: world.warnings
					.filter((warning) => warning.startsWith("Continuous chat ingestion is waiting to retry:"))
					.slice(-4)
					.map((warning) => warning.slice(0, 256)),
			};
			throw new Error(`H25 continuous-chat delivery timeout: ${JSON.stringify(diagnostic)}`, {
				cause: error,
			});
		} catch (diagnosticError) {
			if (diagnosticError instanceof Error && diagnosticError.cause === error) throw diagnosticError;
			throw new AggregateError([error, diagnosticError], "H25 delivery wait and diagnostic failed");
		}
	}
	const records = icmReadContinuousRecords(world, store);
	for (const [index, original] of [notice, result].entries()) {
		const matched = records.filter((record) => record.sourceKey === keys[index]);
		expect(matched).toHaveLength(1);
		expect(matched[0]?.text).toContain(original.content);
	}
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) throw new Error("H25 replay requires the live persisted transcript.");
	const reopened = world.openSessionManager(sessionFile, agentDir);
	for (const original of [notice, result]) {
		const metadata = parentInputOf(original)?.metadata;
		if (!metadata) throw new Error("H25 replay lost its original delivery identity.");
		const receipt = reopened.appendParentInput(
			parentInputMessage(metadata, {
				customType: original.customType,
				content: original.content,
				display: original.display,
				details: parentInputOriginalDetails(original),
			}),
		);
		expect(receipt.created).toBe(false);
		expect(receipt.entries.map((entry) => entry.id)).toEqual([original.id]);
	}
	for (const key of keys)
		expect(icmReadContinuousRecords(world, store).filter((record) => record.sourceKey === key)).toHaveLength(1);
	await verifyParentInputLegacyOverlap(world, manager, owner, wake, settlement, keys);
}
