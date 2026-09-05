import { watch } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { runCollaborationPeer } from "../src/cli/collaboration-peer.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(active: boolean) {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: active ? "fire_task" : "launch_workspace",
		launchKey: "recovery",
		task: active ? "work" : undefined,
		agents: [{ provider: "pi" }],
	});
	await f.shutdown();
	f.report.mockClear();
	return f;
}

it.each([false, true])(
	"surfaces an unavailable saved session on restore before its work deadline (active=%s)",
	async (active) => {
		const f = await fixture(active);
		const previous = f.store.load("recovery").agents[0];
		f.backend.listAgents.mockRejectedValue(new Error("saved server is unavailable"));
		await f.start();
		await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(1));
		expect(f.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "collaboration-control-failure" }),
			expect.objectContaining({ triggerTurn: true }),
		);
		expect(f.backend.createWorkspace).toHaveBeenCalledTimes(1);
		expect(f.backend.readAgent).not.toHaveBeenCalled();
		expect(f.backend.prompt).not.toHaveBeenCalled();
		expect(f.report).not.toHaveBeenCalled();
		expect(f.store.load("recovery").agents[0].closed).toBe(previous.closed);
		expect(f.store.load("recovery").agents[0].status).toBe(previous.status);
		await f.shutdown();
		await f.start();
		await vi.waitFor(() => expect(f.backend.listAgents).toHaveBeenCalledTimes(2));
		expect(f.sendMessage).toHaveBeenCalledTimes(1);
	},
);

it("does not adopt a replacement occupant during restoration", async () => {
	const f = await fixture(false);
	const agent = f.store.load("recovery").agents[0];
	const native = f.states.get(agent.backendName!)!;
	f.states.set(agent.backendName!, { ...native, terminalId: "replacement" });
	await f.start();
	await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(1));
	expect(f.backend.closePane).not.toHaveBeenCalled();
	expect(f.backend.startAgent).toHaveBeenCalledTimes(1);
	expect(f.store.load("recovery").agents[0].terminalId).toBe(agent.terminalId);
});

it("reattaches healthy saved identities without reading output or dispatching another task", async () => {
	const f = await fixture(true);
	await f.start();
	await vi.waitFor(() => expect(f.backend.listAgents).toHaveBeenCalledTimes(1));
	expect(f.sendMessage).not.toHaveBeenCalled();
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.backend.readAgent).not.toHaveBeenCalled();
	expect(f.backend.createWorkspace).toHaveBeenCalledTimes(1);
});

it("retains queued peer work until an explicit inspection confirms reattachment", async () => {
	const f = await collaborationFixture();
	cleanups.push(f.cleanup);
	await f.execute({
		action: "launch_workspace",
		launchKey: "mailbox",
		agents: [{ provider: "pi" }, { provider: "claude" }],
	});
	await f.shutdown();
	const launch = f.backend.createWorkspace.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv }];
	runCollaborationPeer(["send", "agent-2", "queued", "Review the contract"], launch[0].env);
	f.backend.listAgents.mockRejectedValue(new Error("server unavailable"));
	await f.start();
	await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(1));
	expect(f.launchTurn).not.toHaveBeenCalled();
	expect(f.store.load("mailbox").mailbox.messages).toHaveLength(1);
	f.backend.listAgents.mockResolvedValue([...f.states.values()]);
	await f.execute({ action: "job_status", jobId: "mailbox" });
	await vi.waitFor(() => expect(f.launchTurn).toHaveBeenCalledTimes(1));
	expect(f.store.load("mailbox").mailbox.messages).toHaveLength(0);
	expect(f.backend.createWorkspace).toHaveBeenCalledTimes(1);
	expect(f.backend.readAgent).not.toHaveBeenCalled();
});

it("pauses mailbox consumption during an explicit reattachment check", async () => {
	let changed: (file: string | Buffer | null) => void = () => {};
	const f = await collaborationFixture({
		watch: (directory, onChange) => {
			changed = onChange;
			return watch(directory, { persistent: false }, (_event, file) => onChange(file));
		},
	});
	cleanups.push(f.cleanup);
	await f.execute({
		action: "launch_workspace",
		launchKey: "pending",
		agents: [{ provider: "pi" }, { provider: "claude" }],
	});
	let release = () => {};
	f.backend.listAgents.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				release = () => resolve([...f.states.values()]);
			}),
	);
	const inspecting = f.execute({ action: "job_status", jobId: "pending" });
	await vi.waitFor(() => expect(f.backend.listAgents).toHaveBeenCalledTimes(1));
	try {
		const launch = f.backend.createWorkspace.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv }];
		runCollaborationPeer(["send", "agent-2", "pending-message", "Review"], launch[0].env);
		changed(null);
		expect(f.launchTurn).not.toHaveBeenCalled();
		expect(f.store.load("pending").mailbox.messages).toHaveLength(1);
	} finally {
		release();
		await inspecting;
	}
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});
