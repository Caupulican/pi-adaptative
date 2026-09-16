import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, fauxAssistantMessage, registerFauxProvider } from "@caupulican/pi-ai/faux";
import { afterEach, expect, it } from "vitest";
import { OrchestrationProfileStore } from "../src/core/orchestration/profile-store.ts";
import { createHarness, type HarnessOptions } from "./suite/harness.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sharedOptions(): HarnessOptions & { agentDir: string; sharedFauxProvider: FauxProviderRegistration } {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-shared-specialists-"));
	const sharedFauxProvider = registerFauxProvider();
	cleanups.push(() => {
		sharedFauxProvider.unregister();
		rmSync(agentDir, { recursive: true, force: true });
	});
	return { agentDir, cwd: agentDir, sharedFauxProvider };
}

it("two parent harnesses share one provider registration without resetting its scripted responses", async () => {
	const options = sharedOptions();
	options.sharedFauxProvider.setResponses([fauxAssistantMessage("Kept reply")]);
	const first = await createHarness(options);
	const second = await createHarness(options);
	cleanups.push(first.cleanup, second.cleanup);
	expect(first.faux).toBe(options.sharedFauxProvider);
	expect(second.faux).toBe(options.sharedFauxProvider);
	expect(options.sharedFauxProvider.getPendingResponseCount()).toBe(1);
	expect(first.sessionManager.getSessionId()).not.toBe(second.sessionManager.getSessionId());
});

it("shared profiles are stored under caller-owned agent state", async () => {
	const options = sharedOptions();
	const harness = await createHarness(options);
	cleanups.push(harness.cleanup);
	const profiles = new OrchestrationProfileStore({
		agentDir: options.agentDir,
		cwd: options.cwd!,
		projectTrusted: true,
	}).load();
	expect(profiles.profiles.some((profile) => profile.profileId === "test-worker")).toBe(true);
	await harness.cleanup();
	expect(existsSync(options.agentDir)).toBe(true);
});

it("disposing one parent does not unregister the other parent's shared provider", async () => {
	const options = sharedOptions();
	const first = await createHarness(options);
	const second = await createHarness(options);
	cleanups.push(first.cleanup, second.cleanup);
	await first.cleanup();
	options.sharedFauxProvider.setResponses([fauxAssistantMessage("Surviving parent response")]);
	await second.session.prompt("Continue");
	expect(
		second.session.messages.some(
			(message) =>
				message.role === "assistant" && JSON.stringify(message.content).includes("Surviving parent response"),
		),
	).toBe(true);
	expect(options.sharedFauxProvider.getPendingResponseCount()).toBe(0);
});
