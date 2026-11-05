import { basename, join, sep } from "node:path";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { expect } from "vitest";
import type { AgentSession } from "../../../../src/core/agent-session.ts";
import { resolveSemanticUsageEntry, SEMANTIC_USAGE_CUSTOM_TYPE } from "../../../../src/core/cost/usage-records.ts";
import type { ContinuousChatRecord } from "../../../../src/core/memory/continuous-chat-contracts.ts";
import {
	createContinuousChatLegacyImportMarker,
	createContinuousChatSessionLedger,
} from "../../../../src/core/memory/continuous-chat-migration.ts";
import { ContinuousChatStore } from "../../../../src/core/memory/continuous-chat-store.ts";
import {
	createContinuousChatLeaf,
	createContinuousChatParent,
} from "../../../../src/core/memory/continuous-chat-tree.ts";
import { MAX_PERSISTED_CUSTOM_ENTRY_BYTES } from "../../../../src/core/session-entry-persistence.ts";
import { runAsyncReleaseSteps } from "../../../../src/core/util/resource-release.ts";
import {
	PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	parentInputOf,
	parentWakeOf,
} from "../../../../src/kernel/session/parent-input-ledger.ts";
import { isPlainRecord } from "../../../../src/kernel/utils/value-guards.ts";
import { calls, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { type CapturedProactiveTurn, legacyTurnEntries } from "./journey-1-proactivity-legacy.ts";
import {
	icmContinuousSettings,
	icmContinuousStore,
	icmLatestResult,
	icmReadContinuousRecords,
	icmWaitForChatIdle,
	utf8Text,
} from "./shared.ts";

/** Existing history keeps its permanent ids while obsolete background projections leave every visible surface. */
export async function runJourney1ProactiveUpgrade(world: HarnessWorld, captured: CapturedProactiveTurn): Promise<void> {
	const legacy = legacyTurnEntries(captured);
	const settlementAt = legacy.findIndex(
		(entry) => entry.type === "custom" && entry.customType === PARENT_INPUT_SETTLED_CUSTOM_TYPE,
	);
	expect(settlementAt).toBeGreaterThan(0);
	const headerLine = utf8Text(world.io.readFileSync(captured.sessionFile, "utf8"))
		.split("\n")
		.find((line) => line.trim());
	if (!headerLine) throw new Error("Upgrade source requires a physical session header.");
	const header: unknown = JSON.parse(headerLine);
	if (!isPlainRecord(header) || typeof header.id !== "string")
		throw new Error("Upgrade source requires a session identity.");
	for (const consumed of [false, true]) {
		const tag = consumed ? "consumed" : "pending";
		const agentDir = `${world.agentDir}-proactive-upgrade-${tag}`;
		const layout = icmContinuousStore(agentDir);
		const settings = icmContinuousSettings("worker-c", {
			autoLearn: { enabled: false },
			proactivity: { enabled: false },
		});
		const manager = world.createSessionManager(agentDir);
		world.io.mkdirSync(manager.getSessionDir(), { recursive: true });
		const entries = consumed ? legacy : legacy.slice(0, settlementAt);
		const sourcePath = join(manager.getSessionDir(), basename(captured.sessionFile));
		const sourceBytes = `${headerLine}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		world.io.writeFileSync(sourcePath, sourceBytes);
		const copiedSources: Array<{ id: string; path: string; bytes: string }> = [];
		if (consumed)
			for (const prefix of ["collision", "excluded", "unadmitted"]) {
				const id = `${prefix}-${header.id}`;
				const path = join(manager.getSessionDir(), `${prefix}-${basename(captured.sessionFile)}`);
				const copy = structuredClone(entries);
				for (const entry of copy) {
					if (
						!parentInputOf(entry) ||
						entry.type !== "custom_message" ||
						!isPlainRecord(entry.details) ||
						!isPlainRecord(entry.details.parentInput) ||
						!isPlainRecord(entry.details.parentInput.origin)
					)
						continue;
					entry.details.parentInput.origin.sessionId = id;
					entry.details.parentInput.origin.sessionFile = path;
				}
				const bytes = `${JSON.stringify({ ...header, id })}\n${copy.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
				world.io.writeFileSync(path, bytes);
				copiedSources.push({ id, path, bytes });
			}
		const expectedConsumed = consumed ? 2 : 0;
		const input = entries.find((entry) => parentInputOf(entry));
		const wake = entries.find((entry) => parentWakeOf(entry));
		if (input?.type !== "custom_message" || wake?.type !== "custom_message")
			throw new Error("Upgrade source lacks its native delivery and wake.");
		const accepted = parentInputOf(input)!;
		const wakeIdentity = parentWakeOf(wake)!;
		const oldInput = `[Harness background delivery ${accepted.metadata.deliveryId}; not owner-authored evidence] ${input.content}`;
		const oldWake = `[Harness background wake ${wakeIdentity.wakeId}; not owner-authored evidence] ${wake.content}`;
		const control = `Ordinary history remains available (${tag}).`;
		const leak = `OBSOLETE-CAUSAL-SUMMARY-${tag}`;
		const unavailable = `UNPROVEN-BACKGROUND-CONTENT-${tag}`;
		const ordinaryUnavailable = `Ordinary history with an unavailable source (${tag}).`;
		const store = new ContinuousChatStore({ agentDir, projectKey: layout.projectKey });
		const tracks: string[] = [];
		const compactionReplies: AssistantMessage[] = [];
		let active: AgentSession | undefined;
		let held = false;
		let primary: { error: unknown } | undefined;
		try {
			await store.acquireRuntimeLease({
				label: `upgrade artifact ${tag}`,
				onLost: () => {
					throw new Error("Upgrade artifact lease lost.");
				},
			});
			held = true;
			await store.recover();
			const date = input.timestamp;
			const results = await store.appendMany([
				{ kind: "user", date, text: control, sourceKey: `upgrade-control-${tag}` },
				{
					kind: "work",
					date,
					text: oldInput,
					sourceKey: `parent:${input.id}:0`,
					source: { sessionId: header.id, entryId: input.id },
				},
				{
					kind: "note",
					date,
					text: `work: ${oldInput}`,
					sourceKey: `${header.id}:${input.id}:0`,
					source: { sessionId: header.id, entryId: input.id },
				},
				{
					kind: "work",
					date,
					text: oldWake,
					sourceKey: `parent:${wake.id}:0`,
					source: { sessionId: header.id, entryId: wake.id },
				},
				{ kind: "user", date, text: "Later ordinary history one.", sourceKey: `upgrade-later-one-${tag}` },
				{ kind: "pi", date, text: "Later ordinary history two.", sourceKey: `upgrade-later-two-${tag}` },
				{
					kind: "work",
					date,
					text: unavailable,
					sourceKey: "parent:missing-parent:0",
					source: { sessionId: "missing-proactive-source", entryId: "missing-parent" },
				},
				{
					kind: "note",
					date,
					text: ordinaryUnavailable,
					sourceKey: "missing-proactive-source:missing-ordinary:0",
					source: { sessionId: "missing-proactive-source", entryId: "missing-ordinary" },
				},
			]);
			const original = results.flatMap((result) => result.records);
			expect(original).toHaveLength(8);
			const leaves = original.map((record) =>
				createContinuousChatLeaf(record, record.id === 0 ? control : `${leak}: ${captured.note}`),
			);
			await store.recover();
			const seedRevision = await store.projectionRevision();
			for (const leaf of leaves) await store.appendNode(leaf, seedRevision);
			for (let id = 0; id < leaves.length; id += 2)
				await store.appendNode(
					createContinuousChatParent(leaves[id]!, leaves[id + 1]!, `${leak}: ${captured.note}`),
					seedRevision,
				);
			await createContinuousChatLegacyImportMarker(store).write({
				version: 1,
				completedAt: date,
				importedSessions: consumed ? 3 : 2,
				skipped: consumed ? [{ sessionId: copiedSources[1]!.id, reason: "superseded_by_recent_history" }] : [],
			});
			await createContinuousChatSessionLedger(store).markSettled([
				header.id,
				...copiedSources.slice(0, 2).map((source) => source.id),
				"missing-admitted-proactive-source",
			]);
			expect(await store.releaseRuntimeLease()).toMatchObject({ kind: "released" });
			held = false;
			// Restore the actual pre-projection artifact schema, retaining its source log, queue and views.
			const oldRoot: unknown = JSON.parse(utf8Text(world.io.readFileSync(layout.rootFile, "utf8")));
			if (!isPlainRecord(oldRoot)) throw new Error("Seeded ICM root is malformed.");
			delete oldRoot.projectionId;
			delete oldRoot.projectionRevision;
			world.io.writeFileSync(layout.rootFile, `${JSON.stringify(oldRoot)}\n`);
			for (const [path, bytes] of [...world.io.fileEntries()]) {
				if (path.startsWith(`${layout.treeDir}${sep}`) && path.endsWith(".jsonl")) {
					const nodes = bytes
						.split("\n")
						.filter((line) => line.trim())
						.map((line) => {
							const node: unknown = JSON.parse(line);
							if (!isPlainRecord(node)) throw new Error("Seeded ICM node is malformed.");
							delete node.projectionRevision;
							return JSON.stringify(node);
						});
					world.io.writeFileSync(path, `${nodes.join("\n")}\n`);
				} else if (path.startsWith(`${store.nodeIndexDir}${sep}`) && path.endsWith(".idx")) {
					// Node byte offsets changed when the new generation field was removed.
					world.io.unlinkSync(path);
				}
			}
			for (const suffix of ["", "-wal", "-shm"]) {
				const path = join(layout.root, `projection.sqlite${suffix}`);
				if (world.io.existsSync(path)) world.io.unlinkSync(path);
			}
			for (let size = 1; size <= 64; size *= 2)
				for (let first = 0; first + size <= 64; first += size) {
					const task =
						size === 1
							? `Compaction: compress message ${first} into`
							: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
					const name = `upgrade-${tag}-${first}+${size}`;
					tracks.push(name);
					world.provider.enqueueTrack(
						name,
						"worker-c",
						(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
						{
							...text(name, "Ordinary history and verified background consumption."),
							optional: true,
							onTerminal: (_request, message) => compactionReplies.push(message),
							check: (request) => {
								const body = JSON.stringify(request.context.messages);
								expect(body, "rebuilt summaries never reuse an obsolete causal suffix").not.toContain(leak);
								expect(body).not.toContain(unavailable);
								if (!consumed)
									expect(body, "pending background inputs stay outside compaction").not.toContain(
										captured.note,
									);
							},
						},
					);
				}
			let countAfterFirstOpen: number | undefined;
			for (const pass of [0, 1]) {
				const warningMark = world.warnings.length;
				const startupReplyMark = compactionReplies.length;
				const root = await world.createRootSession("root", {
					agentDir,
					sessionManager: pass === 0 ? manager : world.createSessionManager(agentDir),
					systemOneEnabled: false,
					settings,
				});
				active = root.session;
				const beforeNavigation = original.length + expectedConsumed + 6 * pass;
				await icmWaitForChatIdle(
					world,
					agentDir,
					beforeNavigation,
					(records) => records.length === beforeNavigation,
				);
				const startupReplies = compactionReplies.slice(startupReplyMark);
				const startupUsage = root.sessionManager.getEntries().flatMap((entry) => {
					const report = resolveSemanticUsageEntry(entry)?.report;
					return report?.route === "history_summary" ? [{ entry, report }] : [];
				});
				if (pass === 0) {
					expect(startupReplies.length, "startup rebuild reaches the physical summary provider").toBeGreaterThan(
						0,
					);
					expect(
						root.sessionManager.hasDurableSessionFile(),
						"paid startup has a durable session before an owner prompt",
					).toBe(true);
				}
				expect(startupUsage, "every physical startup summary is recorded exactly once").toHaveLength(
					startupReplies.length,
				);
				expect(new Set(startupUsage.map(({ report }) => report.reportId)).size).toBe(startupUsage.length);
				expect(
					startupUsage
						.map(({ report }) =>
							JSON.stringify([
								report.responseTimestamp,
								report.provider,
								report.model,
								report.usage.input,
								report.usage.output,
								report.usage.cacheRead,
								report.usage.cacheWrite,
								report.usage.totalTokens,
							]),
						)
						.sort(),
					"receipts preserve every physical response's time, model and token categories",
				).toEqual(
					startupReplies
						.map((reply) =>
							JSON.stringify([
								new Date(reply.timestamp).toISOString(),
								reply.provider,
								reply.model,
								reply.usage.input,
								reply.usage.output,
								reply.usage.cacheRead,
								reply.usage.cacheWrite,
								reply.usage.totalTokens,
							]),
						)
						.sort(),
				);
				for (const { entry, report } of startupUsage) {
					expect(report.origin).toMatchObject({ sessionId: root.session.sessionId });
					const physical = root.sessionManager.readEntryJsonPrefix(entry.id, MAX_PERSISTED_CUSTOM_ENTRY_BYTES);
					expect(physical, "a startup receipt is physically readable before the owner speaks").toBeDefined();
					expect(JSON.parse(physical!)).toMatchObject({
						id: entry.id,
						type: "custom",
						customType: SEMANTIC_USAGE_CUSTOM_TYPE,
						data: report,
					});
				}
				expect(
					world.warnings.slice(warningMark),
					"unavailable background source is retained without blocking ordinary history",
				).toEqual([
					"Background-input history reconciliation retains 1 quarantined source groups and 1 unavailable source sessions; they will be retried when this chat reopens.",
				]);
				world.warnings.splice(warningMark);
				world.provider.enqueue(
					"root",
					{
						...calls(`upgrade-${tag}-${pass}-zoom`, [
							{ id: `upgrade-zoom-${pass}`, name: "zoom", arguments: { id: 1, n: 1, page: 0 } },
						]),
						check: (request) => {
							expect(JSON.stringify(request.context.messages)).not.toContain(leak);
							expect(JSON.stringify(request.context.messages)).not.toContain(unavailable);
							if (!consumed) expect(JSON.stringify(request.context.messages)).not.toContain(captured.note);
						},
					},
					{
						...calls(`upgrade-${tag}-${pass}-date`, [
							{ id: `upgrade-date-${pass}`, name: "date", arguments: { id: 1 } },
						]),
						check: (request) => {
							const result = icmLatestResult(request, "zoom");
							expect(result.isError).toBe(false);
							expect(result.text).toContain("message 1 (work,");
							expect(result.text).not.toContain(captured.note);
						},
					},
					{
						...text(`upgrade-${tag}-${pass}-reply`, "History inspected."),
						check: (request) =>
							expect(icmLatestResult(request, "date")).toEqual({ toolName: "date", isError: false, text: date }),
					},
				);
				await withDeadline(
					world.trace,
					`upgraded ${tag} navigation ${pass}`,
					root.session.prompt("Inspect saved history."),
				);
				await icmWaitForChatIdle(
					world,
					agentDir,
					beforeNavigation + 6,
					(records) => records.length === beforeNavigation + 6,
				);
				const disposal = await world.disposeSessionInBody(active);
				active = undefined;
				expect(disposal).toBeUndefined();
				expect(world.warnings.slice(warningMark), "startup usage leaves no unmatched handoff at shutdown").toEqual(
					[],
				);
				await store.acquireRuntimeLease({
					label: `inspect upgrade ${tag}`,
					onLost: () => {
						throw new Error("Upgrade inspection lease lost.");
					},
				});
				held = true;
				await store.recover();
				const total = await store.totalMessages();
				const visible: ContinuousChatRecord[] = [];
				for (let id = 0; id < total; id++) visible.push((await store.readMessageById(id))!);
				expect(visible[0]?.text, "ordinary history keeps its identity and text").toBe(control);
				expect(visible[6]?.text).toContain("unavailable pending source verification");
				expect(visible[6]?.text).not.toContain(unavailable);
				expect(visible[7]?.text, "missing source cannot quarantine unrelated ordinary history").toBe(
					ordinaryUnavailable,
				);
				for (const record of visible.slice(1, 4)) expect(record.text).not.toContain(captured.note);
				const remembered = visible.filter(
					(record) => record.sourceKey.startsWith("parent:") && record.text.includes(captured.note),
				);
				expect(remembered, "a consumed old input is derived once; pending inputs never are").toHaveLength(
					expectedConsumed,
				);
				if (consumed) {
					for (const id of [header.id, copiedSources[0]!.id])
						expect(
							remembered.some((record) => record.sourceKey.startsWith(`parent:${id}:`)),
							"same entry IDs in two admitted sessions retain distinct source identities",
						).toBe(true);
					expect(
						remembered.some((record) => record.sourceKey.startsWith(`parent:${copiedSources[1]!.id}:`)),
						"settled does not authorize replay of an intentionally excluded source",
					).toBe(false);
					expect(
						remembered.some((record) => record.sourceKey.startsWith(`parent:${copiedSources[2]!.id}:`)),
						"a listed old source outside the original admission does not become replay authority",
					).toBe(false);
				}
				expect(JSON.stringify(await store.readDate(date.slice(0, 10)))).not.toContain(leak);
				const laterNode = await store.readNode({ level: 1, ordinal: 2 });
				expect(laterNode, "the invalidated later summary is rebuilt").toBeDefined();
				expect(laterNode!.text, "a disjoint later summary cannot retain its obsolete causal prefix").not.toContain(
					leak,
				);
				expect((await store.readCausalPrefix(total)).text).not.toContain(leak);
				expect((await store.snapshotTurn()).view).not.toContain(leak);
				const raw = icmReadContinuousRecords(world, layout);
				expect(raw.slice(0, original.length), "upgrade preserves every original record and permanent id").toEqual(
					original,
				);
				if (pass === 0) countAfterFirstOpen = remembered.length;
				else expect(remembered).toHaveLength(countAfterFirstOpen!);
				expect(utf8Text(world.io.readFileSync(sourcePath, "utf8"))).toBe(sourceBytes);
				for (const source of copiedSources)
					expect(utf8Text(world.io.readFileSync(source.path, "utf8"))).toBe(source.bytes);
				expect(await store.releaseRuntimeLease()).toMatchObject({ kind: "released" });
				held = false;
			}
		} catch (error) {
			primary = { error };
			throw error;
		} finally {
			await runAsyncReleaseSteps(
				[
					async () => {
						if (active) expect(await world.disposeSessionInBody(active)).toBeUndefined();
					},
					async () => {
						if (held) expect(await store.releaseRuntimeLease()).toMatchObject({ kind: "released" });
					},
					async () => {
						await world.provider.waitForProducers();
						for (const name of tracks) world.provider.retireOptional(name);
					},
				],
				"Proactive upgrade assertion and cleanup failed",
				primary,
			);
		}
	}
	world.trace.mark("root", "proactivity.existing-icm-upgrade");
}
