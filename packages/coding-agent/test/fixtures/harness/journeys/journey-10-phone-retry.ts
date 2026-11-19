/** An explicit bot send from a daemon-served phone session survives a transient bundle lease conflict. */
import { expect } from "vitest";
import { botHomeOf } from "../../../../src/core/bots/bot-home.ts";
import { BOT_HOME_COALESCE_MS } from "../../../../src/core/bots/bot-home-watch.ts";
import { readRemoteBotHost } from "../../../../src/core/bots/bot-host-state.ts";
import { BOT_OPEN_RETRY_FIRST_MS } from "../../../../src/core/bots/bot-open-retry.ts";
import { continueBotSession } from "../../../../src/core/bots/bot-session-open.ts";
import { managerSessionHomeNow } from "../../../../src/core/orchestration-homes.ts";
import { acquireSessionBundleLease } from "../../../../src/kernel/session/session-bundle-lifecycle.ts";
import { HARNESS_PROJECT_CWD, type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { createOwnerBot, enqueueBot, waitForBotRosterState } from "./journey-7-shared.ts";
import { currentRequestCarries } from "./shared.ts";

export async function passivePhoneSendRetry(world: HarnessWorld): Promise<void> {
	const agentDir = `${world.agentDir}-phone-retry`;
	const agentId = "retry-reader";
	const soul = "You read the requested line for the owner.";
	const track = "j10-phone-retry";
	const openPhone = () =>
		world.createRootSession("root", {
			agentDir,
			sessionManager: world.createSessionManager(agentDir),
			hostedChannels: "daemon",
			systemOneEnabled: false,
		});
	const first = await openPhone();
	createOwnerBot(first.session, agentId, "worker-c", soul);
	enqueueBot(world, track, "worker-c", soul, {
		name: "first",
		reply: { content: [{ type: "text", text: "Ready." }] },
	});
	await first.session.sendOperatorMessageToBot(agentId, "Remember this session.");
	await withDeadline(
		world.trace,
		"the explicit send establishes a saved bot session",
		world.provider.whenReached(`${track}:first`),
	);
	await waitForBotRosterState(world, first.session, agentId, "idle");
	expect(await world.disposeSessionInBody(first.session)).toBeUndefined();

	const phone = await openPhone();
	const saved = continueBotSession(agentDir, botHomeOf(agentDir, agentId), HARNESS_PROJECT_CWD);
	const lease = acquireSessionBundleLease(saved.getStorageRoots().orchestrationHome, saved.getSessionId(), {
		role: "session",
		opening: true,
		homeNow: managerSessionHomeNow(saved),
	});
	const words = "Read the second line now.";
	enqueueBot(world, track, "worker-c", soul, {
		name: "retried",
		check: (request) => expect(currentRequestCarries(request, words)).toBe(true),
		reply: { content: [{ type: "text", text: "The second line is ready." }] },
	});
	try {
		const result = await phone.session.sendOperatorMessageToBot(agentId, words, { showsWaits: true });
		expect(result).toMatchObject({ mode: "queued", waitsFor: expect.any(String) });
		phone.session.listPersistentBots();
		phone.session.readBotChatMessages(agentId);
		expect(readRemoteBotHost(agentDir, agentId, "retry-observer")).toBeUndefined();
		expect(world.provider.reached).not.toContain(`${track}:retried`);
	} finally {
		lease.release();
	}
	// Deliver the status observer's queued home notices with the lease now free, before the explicit retry comes due.
	world.timers.advance("bot-home-watch", BOT_HOME_COALESCE_MS);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(readRemoteBotHost(agentDir, agentId, "retry-observer")).toBeUndefined();
	expect(world.provider.reached).not.toContain(`${track}:retried`);
	world.timers.advance("provider-admission", BOT_OPEN_RETRY_FIRST_MS);
	await withDeadline(
		world.trace,
		"the passive sender retries without a second command",
		world.provider.whenReached(`${track}:retried`),
	);
	await waitForBotRosterState(world, phone.session, agentId, "idle");
	expect(world.provider.reached.filter((step) => step === `${track}:retried`)).toHaveLength(1);
	expect(await world.disposeSessionInBody(phone.session)).toBeUndefined();
}
