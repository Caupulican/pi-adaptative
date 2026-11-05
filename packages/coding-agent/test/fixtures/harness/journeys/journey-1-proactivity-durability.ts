import { expect } from "vitest";
import { parentInputMessage, parentInputOf } from "../../../../src/kernel/session/parent-input-ledger.ts";
import type { SessionEntry } from "../../../../src/kernel/session/session-entries.ts";
import type { SessionManager } from "../../../../src/kernel/session/session-manager.ts";
import { isPlainRecord } from "../../../../src/kernel/utils/value-guards.ts";
import { calls, createBarrier, type ScriptedRequest, text } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { runJourney1LegacyProactiveImport } from "./journey-1-proactivity-legacy.ts";
import { runJourney1ProactiveUpgrade } from "./journey-1-proactivity-upgrade.ts";
import { icmContinuousSettings, icmContinuousStore, icmReadContinuousRecords, icmWaitForChatIdle } from "./shared.ts";

/** Accepted notes survive the process; only their chosen consumer may settle them. */
export async function runJourney1ProactivityDurability(world: HarnessWorld): Promise<void> {
	const rootRequests = () => world.provider.requests.filter((request) => request.model.id === "root").length;
	for (const delivery of ["turn", "note"] as const) {
		const tracks: string[] = [];
		let releaseConsumer: (() => void) | undefined;
		for (let size = 1; size <= 64; size *= 2)
			for (let first = 0; first + size <= 64; first += size) {
				const task =
					size === 1
						? `Compaction: compress message ${first} into`
						: `Compaction: merge lines ${first}+${size / 2} and ${first + size / 2}+${size / 2},`;
				const name = `proactive-${delivery}-durability-compaction-${first}+${size}`;
				tracks.push(name);
				world.provider.enqueueTrack(
					name,
					"worker-c",
					(request) => JSON.stringify(request.context.messages.at(-1)).includes(task),
					{
						...text(name, "The owner discussed pending work and received a proactive reminder."),
						optional: true,
					},
				);
			}
		try {
			const agentDir = `${world.agentDir}-proactive-durable-${delivery}`;
			const settings = icmContinuousSettings("worker-c", {
				autoLearn: { enabled: false },
				proactivity: { enabled: true, delivery, minOwnerTurnsBetweenRuns: 1 },
			});
			let root = await world.createRootSession("root", {
				agentDir,
				sessionManager: world.createSessionManager(agentDir),
				systemOneEnabled: false,
				settings,
			});
			const note = `The ${delivery} reminder must survive a restart.`;
			world.provider.enqueue("root", text(`proactive-${delivery}-owner`, "Understood."));
			await withDeadline(
				world.trace,
				`${delivery} initial owner`,
				root.session.prompt("Remind me about unfinished work."),
			);
			await icmWaitForChatIdle(world, agentDir, 2);
			root.session.backgroundLanes.clearResearchLaneTimer();
			const beforeReview = rootRequests();
			const file = root.sessionManager.getSessionFile();
			if (!file) throw new Error("Proactivity durability requires a physical session file.");
			let acceptedId: string | undefined;
			let savedNote: Extract<SessionEntry, { type: "custom_message" }> | undefined;
			const stop = root.sessionManager.onEntriesPersisted((event) => {
				for (const id of event.entryIds) {
					const entry = root.sessionManager.getEntry(id);
					if (entry?.type !== "custom_message" || entry.customType !== "proactive-note") continue;
					const accepted = parentInputOf(entry);
					if (!accepted) continue;
					acceptedId = accepted.metadata.deliveryId;
					savedNote = entry;
					// Close at the physical receipt boundary, before an automatic wake can acquire the foreground.
					if (delivery === "turn") root.session.dispose();
				}
			});
			world.provider.enqueue(
				"root",
				calls(`proactive-${delivery}-raise`, [
					{
						id: `raise-${delivery}`,
						name: "raise_note",
						arguments: { kind: "reminder", text: note, why: "Owner requested a reminder." },
					},
				]),
				text(`proactive-${delivery}-review-end`, "none"),
			);
			const result = await withDeadline(
				world.trace,
				`${delivery} acceptance`,
				root.session.backgroundLanes.runProactiveReviewOnce(),
			);
			stop();
			expect(
				result.delivered.map((entry) => entry.text),
				"physical acceptance remains true during shutdown",
			).toEqual([note]);
			expect(acceptedId).toBeDefined();
			expect(rootRequests() - beforeReview, "acceptance alone starts no extra request before the cut").toBe(2);
			expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
			const reopened = world.openSessionManager(file, agentDir);
			if (!savedNote || !isPlainRecord(savedNote.details))
				throw new Error("The accepted note must retain its original payload.");
			const identity = parentInputOf(savedNote)!.metadata;
			const original = {
				customType: savedNote.customType,
				content: savedNote.content,
				display: savedNote.display,
				details: savedNote.details.originalDetails,
			};
			const replay = reopened.appendParentInput(parentInputMessage(identity, original));
			expect(replay.created, "replaying exact acceptance returns the original receipt").toBe(false);
			expect(replay.entries[0]?.id).toBe(savedNote.id);
			expect(
				() =>
					reopened.appendParentInput(parentInputMessage(identity, { ...original, content: `${note} Changed.` })),
				"an accepted identity cannot carry a changed body",
			).toThrow("conflicts with its saved payload");
			const expectedMode = delivery === "turn" ? "turn" : "next-owner-turn";
			const pending = (manager: SessionManager) =>
				manager.getPendingParentInputs(expectedMode).filter((input) => input.metadata.deliveryId === acceptedId);
			expect(pending(reopened), "the original physical note remains pending across restart").toHaveLength(1);
			expect(pending(reopened)[0]?.metadata.mode).toBe(expectedMode);
			const reached = createBarrier();
			const release = createBarrier();
			releaseConsumer = () => release.release();
			const settled = new Promise<void>((resolve) => {
				const off = reopened.onEntriesPersisted(() => {
					if (pending(reopened).length !== 0) return;
					off();
					resolve();
				});
			});
			const response = {
				...text(`proactive-${delivery}-consumer`, "I have considered the reminder."),
				check: (request: ScriptedRequest) => {
					expect(
						JSON.stringify(request.context.messages),
						"the selected consumer receives the original note",
					).toContain(note);
					expect(pending(reopened), "sending a request is not consumption").toHaveLength(1);
					reached.release();
				},
				gate: release.promise,
			};
			if (delivery === "turn") world.provider.enqueue("root", response);
			root = await world.createRootSession("root", {
				agentDir,
				sessionManager: reopened,
				systemOneEnabled: false,
				settings,
			});
			let owner: Promise<void> | undefined;
			if (delivery === "note") {
				world.provider.enqueue("root", {
					...text("proactive-note-internal", "Internal work finished."),
					check: (request) =>
						expect(
							JSON.stringify(request.context.messages),
							"internal turns cannot consume owner-only notes",
						).not.toContain(note),
				});
				await withDeadline(
					world.trace,
					"internal turn with dormant note",
					root.session.sendCustomMessage(
						{
							customType: "internal-work",
							content: "Finish this internal status update.",
							display: true,
							details: undefined,
						},
						{ triggerTurn: true },
					),
				);
				expect(pending(reopened), "an internal response leaves the owner note pending").toHaveLength(1);
				await icmWaitForChatIdle(world, agentDir, 3);
				expect(
					icmReadContinuousRecords(world, icmContinuousStore(agentDir)).some((record) =>
						record.text.includes(note),
					),
					"dormant notes cannot leak through ICM summaries",
				).toBe(false);
				world.provider.enqueue(
					"root",
					{
						...calls("proactive-note-owner-tool", [
							{ id: "proactive-note-goal", name: "get_goal", arguments: {} },
						]),
						check: (request) => expect(JSON.stringify(request.context.messages)).toContain(note),
					},
					response,
				);
				owner = root.session.prompt("What is still pending?");
			}
			try {
				await withDeadline(world.trace, `${delivery} consumer request`, reached.promise);
			} finally {
				release.release();
			}
			if (owner) await withDeadline(world.trace, "owner consumes durable note", owner);
			await withDeadline(world.trace, `${delivery} matching terminal settles note`, settled);
			await icmWaitForChatIdle(world, agentDir, delivery === "turn" ? 4 : 8);
			const remembered = icmReadContinuousRecords(world, icmContinuousStore(agentDir)).filter((record) =>
				record.text.includes(note),
			);
			expect(remembered, "the consumed note enters canonical ICM work history once").toHaveLength(1);
			expect(remembered[0]?.kind).toBe("work");
			expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
			const after = world.openSessionManager(file, agentDir);
			expect(pending(after), "consumption is durable").toHaveLength(0);
			expect(
				after.getEntries().filter((entry) => parentInputOf(entry)?.metadata.deliveryId === acceptedId),
				"restart does not append another accepted note",
			).toHaveLength(1);
			const beforeFinalOpen = rootRequests();
			root = await world.createRootSession("root", {
				agentDir,
				sessionManager: after,
				systemOneEnabled: false,
				settings,
			});
			expect(await world.disposeSessionInBody(root.session)).toBeUndefined();
			expect(rootRequests(), "a settled note never wakes again after reopening").toBe(beforeFinalOpen);
			if (delivery === "turn") {
				await world.provider.waitForProducers();
				for (const name of tracks) world.provider.retireOptional(name);
				tracks.length = 0;
				await runJourney1LegacyProactiveImport(world, { sessionFile: file, entries: after.getEntries(), note });
				await runJourney1ProactiveUpgrade(world, { sessionFile: file, entries: after.getEntries(), note });
			}
		} finally {
			releaseConsumer?.();
			await world.provider.waitForProducers();
			for (const name of tracks) world.provider.retireOptional(name);
		}
	}
	world.trace.mark("root", "proactivity.durable-consumption");
}
