/** Telegram command replay, independent private conversations and a selected routine replaced from the desktop. */
import { join } from "node:path";
import { expect } from "vitest";
import { OWED_INBOX_SWEEP_MS } from "../../../../src/core/bots/bot-session-owed-work.ts";
import { ChannelJournal } from "../../../../src/core/channels/channel-journal.ts";
import { MAX_PHONE_TASK_COMMANDS } from "../../../../src/core/channels/owner-task.ts";
import { captureWorkerReceiptOrigin } from "../../../../src/core/delegation/worker-receipt-origin.ts";
import { calls } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { FakeBotApi, OWNER_ID, ownerLegUpdate, TOKEN, withFakeBotApi } from "./journey-4-telegram.ts";
import { botSessionFilesText, carries, createOwnerBot } from "./journey-7-shared.ts";

export async function runJourney4PhoneTaskControls(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-phone-tasks`;
	const dir = join(agentDir, "channels");
	world.io.mkdirSync(dir, { recursive: true });
	world.io.writeFileSync(join(dir, "telegram.token"), TOKEN, { mode: 0o600 });
	const journal = new ChannelJournal(agentDir, "telegram");
	const api = new FakeBotApi(() => journal.read().result.seen.map((item) => item.d));
	await withFakeBotApi(world, api, async () => {
		const start = api.nextPoll(undefined);
		const { session, sessionManager } = await world.createRootSession("root", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			systemOneEnabled: false,
			settings: { channels: { telegram: { mode: "explicit", ownerSenders: [OWNER_ID, OWNER_ID + 1] } } },
		});
		await withDeadline(world.trace, "task control transport ready", start);
		const store = session.backgroundLanes.getBotTeamStore();
		createOwnerBot(session, "Atlas", "worker-a", "Review the selected backlog task.");
		const definition = {
			routineId: "Review",
			target: { kind: "bot" as const, agentId: "Atlas" },
			schedule: { kind: "interval" as const, intervalMs: 24 * 60 * 60 * 1000 },
			prompt: "Review the backlog.",
		};
		const original = store.upsertRoutine(definition);
		const before = world.provider.reached.length;
		const send = async (id: number, sender: number, words: string) => {
			const next = api.nextSend();
			api.deliver(ownerLegUpdate(id, sender, words));
			await withDeadline(world.trace, words, next);
		};
		await send(1, OWNER_ID, "select Atlas Review");
		expect(api.texts().at(-1)).toContain("task Review");
		await send(2, OWNER_ID + 1, "task status");
		expect(api.texts().at(-1)).toContain("select <bot-id>");
		const oldEvent = ownerLegUpdate(3, OWNER_ID, "stop task");
		const sent = api.nextSend();
		api.deliver(oldEvent, oldEvent);
		await withDeadline(world.trace, "task stop acknowledgement", sent);
		store.reload(true);
		expect(store.getRoutine("Review")?.enabled).toBe(false);
		expect(journal.read().result.ownerTaskCommands?.filter((row) => row.action === "stop")).toHaveLength(1);
		const paused = store.getRoutine("Review")!;
		store.deleteRoutine("Review", paused.revision);
		const pinned = session.backgroundLanes.captureBotScheduleOrigin();
		const replacement = store.upsertRoutine({ ...definition, ...pinned, createOnly: true });
		expect(replacement.incarnationId).not.toBe(original.incarnationId);
		await send(4, OWNER_ID, "stop task");
		expect(api.texts().at(-1)).toContain("unavailable");
		expect(store.getRoutine("Review")?.enabled).toBe(true);
		expect(world.provider.reached.length, "task controls do not start a model turn").toBe(before);
		await send(5, OWNER_ID, "select Atlas Review");
		await send(6, OWNER_ID, "steer before first run");
		expect(api.texts().at(-1)).toContain("has not run yet");
		expect(world.provider.reached.length).toBe(before);
		// The desktop admitted this exact occurrence before the mobile follow-up.
		const nowMs = Date.parse(replacement.updatedAt);
		const receiptOrigin = captureWorkerReceiptOrigin(sessionManager);
		const occurrence = store.claimManualRoutineOccurrence({
			routineId: "Review",
			commandId: "desktop-run",
			owner: "desktop",
			nowMs,
			leaseMs: 120_000,
			receiptOrigin,
		});
		const dispatch = {
			occurrenceId: occurrence.occurrenceId,
			claimToken: occurrence.claim!.token,
			nowMs,
			dispatchKey: `routine:${occurrence.occurrenceId}`,
		};
		store.markRoutineDispatching(dispatch);
		store.markRoutineRunning(dispatch);
		const recognized = "review only the open blocker";
		world.provider.enqueue(
			"worker-a",
			calls("attempt-unscoped-child", [
				{
					id: "phone-local-worker",
					name: "delegate",
					arguments: { action: "start", instructions: "Start another worker." },
				},
			]),
			{
				name: "task-phone-steer",
				check: (request) => {
					expect(carries(request, "phone task follow-ups can use only")).toBe(true);
					if (!carries(request, recognized))
						throw new Error("The selected bot never received the authenticated steering.");
				},
				reply: { content: [{ type: "text", text: "Checked the open blocker." }] },
			},
		);
		const steering = ownerLegUpdate(7, OWNER_ID, `steer ${recognized}`);
		const queued = api.nextSend();
		api.deliver(steering, steering);
		await withDeadline(world.trace, "steering queued or admitted", queued);
		world.timers.advance("bot-sessions", OWED_INBOX_SWEEP_MS);
		await withDeadline(
			world.trace,
			"selected bot answered one recorded phone command",
			world.io.waitForMutation(
				() =>
					journal
						.read()
						.result.ownerTaskCommands?.some(
							(c) =>
								c.action === "steer" &&
								c.state === "finished" &&
								c.reply?.includes("Checked the open blocker."),
						) === true,
			),
		);
		expect(world.provider.reached.filter((step) => step === "worker-a:task-phone-steer")).toHaveLength(1);
		const transcript = botSessionFilesText(world, "Atlas", agentDir);
		expect(transcript).toContain('"k":"owner-channel"');
		expect(transcript).toContain('"routineRef":"routine:');
		await send(8, OWNER_ID, "status");
		expect(api.texts().at(-1)).toContain("Checked the open blocker.");
		// Model a backlog left by an earlier host with every steering slot and its daily allowance in use.
		const retained = journal.read().result.ownerTaskCommands!.find((c) => c.action === "steer")!;
		expect(retained).toMatchObject({
			projectBound: true,
			cwd: pinned.botProjectCwd,
			occurrenceIds: [occurrence.occurrenceId],
		});
		journal.update(retained.admittedAt, (state) => {
			state.ownerTaskCommands = Array.from({ length: MAX_PHONE_TASK_COMMANDS }, (_, i) => ({
				...retained,
				id: i.toString(16).padStart(4, "0").padEnd(64, "0"),
				state: i === 0 ? "queued" : "finished",
				spend: { reserved: 1, usd: 1 },
			}));
		});
		await send(9, OWNER_ID, "stop task");
		expect(api.texts().at(-1)).toContain("Paused task Review");
		expect(journal.read().result.ownerTaskCommands?.[0]).toMatchObject({
			state: "finished",
			reply: "Stopped before delivery.",
		});
	});
}
