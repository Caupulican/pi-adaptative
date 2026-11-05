import { basename, join } from "node:path";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import {
	PARENT_INPUT_CONSUMED_CUSTOM_TYPE,
	PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	parentInputOf,
} from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../../../src/kernel/session/session-entries.ts";
import { isPlainRecord } from "../../../../src/kernel/utils/value-guards.ts";
import { text } from "../scripted-provider.ts";
import type { HarnessWorld } from "../session-fixture.ts";
import {
	icmContinuousSettings,
	icmContinuousStore,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	utf8Text,
} from "./shared.ts";

export interface CapturedProactiveTurn {
	readonly sessionFile: string;
	readonly entries: readonly SessionEntry[];
	readonly note: string;
}

/** Reconstruct the old wire shape from a real completed turn, retaining all native execution evidence. */
export function legacyTurnEntries(captured: CapturedProactiveTurn): SessionEntry[] {
	const removedParents = new Map<string, string | null>();
	const entries: SessionEntry[] = [];
	let downgraded = 0;
	for (const original of captured.entries) {
		if (original.type === "custom" && original.customType === PARENT_INPUT_CONSUMED_CUSTOM_TYPE) {
			removedParents.set(original.id, original.parentId);
			continue;
		}
		const entry = structuredClone(original);
		const accepted = parentInputOf(entry);
		if (
			accepted &&
			entry.type === "custom_message" &&
			typeof entry.content === "string" &&
			entry.content.includes(captured.note)
		) {
			if (!isPlainRecord(entry.details) || !isPlainRecord(entry.details.parentInput))
				throw new Error("Captured proactive input has no canonical metadata.");
			entry.details.parentInput.version = 1;
			delete entry.details.parentInput.mode;
			downgraded++;
		}
		if (entry.type === "custom" && entry.customType === PARENT_INPUT_SETTLED_CUSTOM_TYPE) {
			if (!isPlainRecord(entry.data)) throw new Error("Captured wake settlement has no structured proof.");
			entry.data = {
				version: 1,
				wakeId: entry.data.wakeId,
				requestId: entry.data.requestId,
				assistantMessageEntryId: entry.data.assistantMessageEntryId,
			};
		}
		entries.push(entry);
	}
	expect(downgraded, "the fixture converts one real accepted turn input to its v1 shape").toBe(1);
	for (const entry of entries) {
		const seen = new Set<string>();
		while (entry.parentId !== null && removedParents.has(entry.parentId)) {
			if (seen.has(entry.parentId)) throw new Error("Captured receipt removal encountered a parent cycle.");
			seen.add(entry.parentId);
			entry.parentId = removedParents.get(entry.parentId)!;
		}
	}
	return entries;
}

/** Invoked after the durability phase has retired its summary tracks; never creates a separate journey. */
export async function runJourney1LegacyProactiveImport(
	world: HarnessWorld,
	captured: CapturedProactiveTurn,
): Promise<void> {
	const rootRequestsBefore = world.provider.requests.filter((request) => request.model.id === "root").length;
	const legacy = legacyTurnEntries(captured);
	const settlementAt = legacy.findIndex(
		(entry) => entry.type === "custom" && entry.customType === PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	);
	expect(settlementAt, "the captured legacy turn has a native wake settlement").toBeGreaterThan(0);
	expect(
		legacy.some((entry) => entry.type === "request_snapshot"),
		"the source retains a real provider request",
	).toBe(true);
	expect(
		legacy.some((entry) => entry.type === "provider_request_terminal"),
		"the source retains a real provider terminal",
	).toBe(true);
	const header = utf8Text(world.io.readFileSync(captured.sessionFile, "utf8"))
		.split("\n")
		.find((line) => line.trim().length > 0);
	if (!header) throw new Error("Captured proactivity session has no physical header.");
	const headerRecord: unknown = JSON.parse(header);
	if (!isPlainRecord(headerRecord) || typeof headerRecord.id !== "string")
		throw new Error("Captured proactivity header has no session identity.");
	const copiedSessionId = `copy-${headerRecord.id}`;
	for (const { tag, sourceEntries, consumed } of [
		{ tag: "modern-consumed", sourceEntries: captured.entries, consumed: true },
		{ tag: "v1-consumed", sourceEntries: legacy, consumed: true },
		{ tag: "v1-pending", sourceEntries: legacy.slice(0, settlementAt), consumed: false },
	]) {
		const agentDir = `${world.agentDir}-proactive-legacy-${tag}`;
		const expectedCount = tag === "modern-consumed" ? 2 : consumed ? 1 : 0;
		const tracks: string[] = [];
		const failures: unknown[] = [];
		let active: AgentSession | undefined;
		for (let size = 1; size <= 64; size *= 2) {
			for (let first = 0; first + size <= 64; first += size) {
				const task =
					size === 1
						? `Compaction: compress message ${first} into`
						: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
				const name = `proactive-legacy-${tag}-${first}+${size}`;
				tracks.push(name);
				world.provider.enqueueTrack(
					name,
					"worker-c",
					(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
					{
						...text(name, "The owner discussed unfinished work and a proactive reminder."),
						optional: true,
					},
				);
			}
		}
		try {
			const manager = world.createSessionManager(agentDir);
			world.io.mkdirSync(manager.getSessionDir(), { recursive: true });
			const sourcePath = join(manager.getSessionDir(), basename(captured.sessionFile));
			const sourceBytes = `${header}\n${sourceEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
			world.io.writeFileSync(sourcePath, sourceBytes);
			let secondSource: { path: string; bytes: string } | undefined;
			if (tag === "modern-consumed") {
				const copiedEntries = structuredClone(captured.entries);
				const copiedPath = join(manager.getSessionDir(), `copy-${basename(captured.sessionFile)}`);
				for (const entry of copiedEntries) {
					if (
						!parentInputOf(entry) ||
						entry.type !== "custom_message" ||
						!isPlainRecord(entry.details) ||
						!isPlainRecord(entry.details.parentInput) ||
						!isPlainRecord(entry.details.parentInput.origin)
					)
						continue;
					entry.details.parentInput.origin.sessionId = copiedSessionId;
					entry.details.parentInput.origin.sessionFile = copiedPath;
				}
				const bytes = `${JSON.stringify({ ...headerRecord, id: copiedSessionId })}\n${copiedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
				world.io.writeFileSync(copiedPath, bytes);
				secondSource = { path: copiedPath, bytes };
			}
			const settings = icmContinuousSettings("worker-c", {
				autoLearn: { enabled: false },
				proactivity: { enabled: false },
			});
			let root = await world.createRootSession("root", {
				agentDir,
				sessionManager: manager,
				systemOneEnabled: false,
				settings,
			});
			active = root.session;
			const store = icmContinuousStore(agentDir);
			await icmWaitForChatIdle(world, agentDir, 1, () => world.io.existsSync(store.migrationFile));
			const remembered = () =>
				icmReadContinuousRecords(world, store).filter((record) => record.text.includes(captured.note));
			expect(
				remembered(),
				consumed
					? `a proven ${tag} note enters fresh legacy ICM once`
					: "an unconsumed v1 note is excluded from fresh legacy ICM",
			).toHaveLength(expectedCount);
			if (secondSource) {
				expect(
					new Set(remembered().map((record) => record.sourceKey)).size,
					"file-local entry IDs from two sessions stay distinct",
				).toBe(2);
				for (const id of [headerRecord.id, copiedSessionId])
					expect(
						remembered().some((record) => record.sourceKey.startsWith(`parent:${id}:`)),
						"each imported session retains its source identity",
					).toBe(true);
				expect(
					utf8Text(world.io.readFileSync(secondSource.path, "utf8")),
					"the second imported source remains unchanged",
				).toBe(secondSource.bytes);
			}
			expect(utf8Text(world.io.readFileSync(sourcePath, "utf8")), "legacy import leaves the source unchanged").toBe(
				sourceBytes,
			);
			const firstDisposal = await world.disposeSessionInBody(root.session);
			active = undefined;
			expect(firstDisposal).toBeUndefined();
			root = await world.createRootSession("root", {
				agentDir,
				sessionManager: world.createSessionManager(agentDir),
				systemOneEnabled: false,
				settings,
			});
			active = root.session;
			await icmWaitForChatIdle(world, agentDir, 1, () => world.io.existsSync(store.migrationFile));
			expect(remembered(), "reopening cannot duplicate or invent legacy proactive consumption").toHaveLength(
				expectedCount,
			);
			const finalDisposal = await world.disposeSessionInBody(root.session);
			active = undefined;
			expect(finalDisposal).toBeUndefined();
		} catch (error) {
			failures.push(error);
		} finally {
			for (const cleanup of [
				async () => {
					if (!active) return;
					const error = await world.disposeSessionInBody(active);
					if (error) throw error;
				},
				() => world.provider.waitForProducers(),
				...tracks.map((track) => () => {
					world.provider.retireOptional(track);
				}),
			]) {
				try {
					await cleanup();
				} catch (error) {
					failures.push(error);
				}
			}
		}
		if (failures.length === 1) throw failures[0];
		if (failures.length > 1)
			throw new AggregateError(failures, "Legacy proactivity assertion and cleanup failed.", { cause: failures[0] });
	}
	expect(world.provider.requests.filter((request) => request.model.id === "root")).toHaveLength(rootRequestsBefore);
	world.trace.mark("root", "proactivity.legacy-v1-consumption");
}
