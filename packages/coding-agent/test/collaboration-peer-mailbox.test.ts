import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCollaborationPeer } from "../src/cli/collaboration-peer.ts";
import type { CollaborationBackend } from "../src/core/collaboration/backend.ts";
import { CollaborationCoordinator } from "../src/core/collaboration/coordinator.ts";
import { CollaborationJobStore } from "../src/core/collaboration/job-store.ts";
import { bootstrapCollaborationPeers } from "../src/core/collaboration/peer-bootstrap.ts";
import { collaborationFixture } from "./helpers/collaboration-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function mailbox() {
	const root = await mkdtemp(join(tmpdir(), "pi-collaboration-peers-"));
	roots.push(root);
	const store = new CollaborationJobStore(root, "parent");
	const tokens = { one: "1".repeat(64), two: "2".repeat(64) };
	store.create({
		id: "team",
		parentSessionId: "parent",
		sessionName: "pi-team",
		cwd: root,
		title: "team",
		createdAt: 1,
		deadlineSeconds: 30,
		agents: Object.entries(tokens).map(([id, token]) => ({
			id,
			name: id,
			provider: "pi",
			cwd: root,
			args: [],
			env: {},
			backendName: id,
			paneId: `pane-${id}`,
			terminalId: id,
			peerTokenHash: createHash("sha256").update(token).digest("hex"),
			profile: { identity: id, allowedTools: ["read", "bash"], writePaths: [] },
		})),
	});
	const report = vi.fn();
	const launchTurn = vi.fn(async () => {});
	const closePane = vi.fn(async () => {});
	const backend = {
		getAgent: async (id: string) => ({ paneId: `pane-${id}`, terminalId: id }),
		closePane,
	} as unknown as CollaborationBackend;
	const coordinator = new CollaborationCoordinator({ store, report, launchTurn, backend: async () => backend });
	const send = (messageId = "message-one", text = "Review parser edge cases") =>
		store.enqueuePeerMessage("team", { senderId: "one", recipientId: "two", messageId, text, token: tokens.one });
	return { root, store, tokens, report, launchTurn, closePane, backend, coordinator, send };
}

it("authenticates exact members, persists no raw secret, and makes exact replay inert", async () => {
	const f = await mailbox();
	expect(() =>
		f.store.enqueuePeerMessage("team", {
			senderId: "one",
			recipientId: "two",
			messageId: "wrong",
			text: "x",
			token: f.tokens.two,
		}),
	).toThrow(/credential/);
	expect(() =>
		f.store.enqueuePeerMessage("team", {
			senderId: "one",
			recipientId: "foreign",
			messageId: "wrong",
			text: "x",
			token: f.tokens.one,
		}),
	).toThrow(/recipient/);
	expect(() =>
		f.store.enqueuePeerMessage("team", {
			senderId: "one",
			recipientId: "one",
			messageId: "wrong",
			text: "x",
			token: f.tokens.one,
		}),
	).toThrow(/recipient/);
	const receipt = f.send();
	const before = await readFile(f.store.path("team"), "utf8");
	expect(f.send()).toEqual(receipt);
	expect(() => f.send("message-one", "different intent")).toThrow(/reuse/);
	expect(await readFile(f.store.path("team"), "utf8")).toBe(before);
	expect(before).not.toContain(f.tokens.one);
	expect(f.store.load("team").mailbox.messages).toHaveLength(1);
});

it("reserves one existing durable turn atomically with message consumption across owners", async () => {
	const f = await mailbox();
	f.send();
	const other = new CollaborationCoordinator({
		store: new CollaborationJobStore(f.root, "parent"),
		report: f.report,
		launchTurn: f.launchTurn,
		backend: async () => f.backend,
	});
	await Promise.all([f.coordinator.drainPeerMessages(), other.drainPeerMessages()]);
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.store.load("team")).toMatchObject({
		mailbox: { messages: [], receipts: [{ state: "reserved", turnId: expect.any(String) }] },
		agents: [{ turn: 0 }, { turn: 1, status: "reserved", prompt: expect.stringContaining("Peer message from one") }],
	});
	expect(f.report).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ phase: "dispatch", laneId: "collaboration:team:two" }),
	);
});

it("retains queued peer work until its existing backend has been reconciled as available", async () => {
	const f = await mailbox();
	f.send();
	await f.coordinator.drainPeerMessages(new Set());
	expect(f.launchTurn).not.toHaveBeenCalled();
	expect(f.store.load("team")).toMatchObject({
		mailbox: { messages: [{ messageId: "message-one" }], receipts: [{ state: "queued" }] },
		agents: [{ turn: 0 }, { turn: 0 }],
	});
	await f.coordinator.drainPeerMessages(new Set(["team"]));
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});

it("does not replace active work, an unacknowledged terminal, or a pending question", async () => {
	const f = await mailbox();
	const turn = f.store.reserveTurn("team", "two", "original work");
	f.send();
	await f.coordinator.drainPeerMessages();
	expect(f.launchTurn).not.toHaveBeenCalled();
	f.store.finishTurn("team", "two", turn.turnId, "done", "original evidence");
	expect(f.store.reservePeerTurn("team", "two")).toBeUndefined();
	f.store.update("team", (job) => {
		job.agents[1].status = "blocked";
	});
	f.coordinator.refresh();
	await f.coordinator.drainPeerMessages();
	expect(f.launchTurn).not.toHaveBeenCalled();
	expect(f.store.load("team").mailbox.messages).toHaveLength(1);
	expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: "terminal", status: "blocked" }));
});

it("never requeues or replays an uncertain peer delivery after restart", async () => {
	const f = await mailbox();
	f.send();
	f.launchTurn.mockRejectedValueOnce(new Error("acknowledgement lost"));
	await expect(f.coordinator.drainPeerMessages()).rejects.toThrow(/acknowledgement lost/);
	expect(f.closePane).toHaveBeenCalledExactlyOnceWith("pane-two");
	expect(f.store.load("team")).toMatchObject({
		mailbox: { messages: [], receipts: [{ state: "reserved" }] },
		agents: [{}, { closed: true, status: "failed" }],
	});
	const restored = new CollaborationCoordinator({
		store: f.store,
		report: f.report,
		launchTurn: f.launchTurn,
		backend: async () => f.backend,
	});
	await restored.drainPeerMessages();
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
});

it("stops admitting later peer turns after owner disposal while retaining the admitted turn", async () => {
	const f = await mailbox();
	f.send();
	f.store.enqueuePeerMessage("team", {
		senderId: "two",
		recipientId: "one",
		messageId: "reverse",
		text: "Review the response",
		token: f.tokens.two,
	});
	let release: () => void = () => {};
	f.launchTurn.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const draining = f.coordinator.drainPeerMessages();
	f.coordinator.dispose();
	release();
	await draining;
	expect(f.launchTurn).toHaveBeenCalledTimes(1);
	expect(f.closePane).not.toHaveBeenCalled();
	expect(f.store.load("team").mailbox.messages).toHaveLength(1);
	const restored = new CollaborationCoordinator({
		store: f.store,
		report: f.report,
		launchTurn: f.launchTurn,
		backend: async () => f.backend,
	});
	await restored.drainPeerMessages();
	expect(f.launchTurn).toHaveBeenCalledTimes(2);
	expect(f.store.load("team").agents.map((agent) => agent.turn)).toEqual([1, 1]);
});

it("bounds UTF-8 message bytes, queued count, and lifetime receipts before mutation", async () => {
	const f = await mailbox();
	expect(() => f.send("too-large", "界".repeat(1366))).toThrow(/4096/);
	expect(() => f.send("empty", "  ")).toThrow(/message/);
	for (let index = 0; index < 32; index++) f.send(`message-${index}`);
	expect(() => f.send("overflow")).toThrow(/32/);
	expect(f.store.load("team").mailbox.messages).toHaveLength(32);
});

it("retains all lifetime receipts so an evicted identity can never become new work", async () => {
	const f = await mailbox();
	for (let index = 0; index < 128; index++) {
		f.send(`message-${index}`);
		const turn = f.store.reservePeerTurn("team", "two")!;
		f.store.finishTurn("team", "two", turn.turnId, "done", "verified");
		f.coordinator.refresh();
	}
	expect(() => f.send("past-bound")).toThrow(/128/);
	expect(f.send("message-0")).toMatchObject({ state: "reserved" });
	expect(f.store.load("team").mailbox.messages).toEqual([]);
});

it("rejects a corrupted pending message or receipt before the turn can be reserved", async () => {
	const f = await mailbox();
	f.send();
	const job = f.store.load("team");
	job.mailbox.messages[0].text = "mutated without matching receipt";
	await writeFile(f.store.path("team"), JSON.stringify(job));
	expect(() => f.store.reservePeerTurn("team", "two")).toThrow(/receipt/);
	expect(JSON.parse(await readFile(f.store.path("team"), "utf8")).agents[1].turn).toBe(0);
});

it("uses injected pane credentials for finite CLI submission and does not accept raw-token overrides", async () => {
	const f = await mailbox();
	const env = {
		PI_COLLABORATION_STATE_DIR: f.root,
		PI_COLLABORATION_PARENT_ID: "parent",
		PI_COLLABORATION_JOB_ID: "team",
		PI_COLLABORATION_AGENT_ID: "one",
		PI_COLLABORATION_PEER_TOKEN: f.tokens.one,
	};
	expect(runCollaborationPeer(["send", "two", "cli-message", "bounded request"], env)).toMatchObject({
		state: "queued",
	});
	expect(() => runCollaborationPeer(["send", "two", "cli-message", "bounded request", f.tokens.one], env)).toThrow(
		/Usage/,
	);
	expect(() =>
		runCollaborationPeer(["send", "two", "second", "x"], { ...env, PI_COLLABORATION_PARENT_ID: "foreign" }),
	).toThrow(/parent/);
	const current = f.store.load("team");
	expect(() =>
		bootstrapCollaborationPeers(
			{
				...current,
				agents: current.agents.map((agent) => ({ ...agent, env: { PI_COLLABORATION_PEER_TOKEN: "untrusted" } })),
			},
			f.root,
		),
	).toThrow(/reserved/);
});

it("runs the real source CLI peer mode to completion without loading a model turn", async () => {
	const f = await mailbox();
	const output = execFileSync(
		process.execPath,
		[
			"--conditions=pi-source",
			resolve(import.meta.dirname, "../src/cli.ts"),
			"--collaboration-peer",
			"send",
			"two",
			"source-cli",
			"A bounded request",
		],
		{
			cwd: f.root,
			env: {
				...process.env,
				PI_COLLABORATION_STATE_DIR: f.root,
				PI_COLLABORATION_PARENT_ID: "parent",
				PI_COLLABORATION_JOB_ID: "team",
				PI_COLLABORATION_AGENT_ID: "one",
				PI_COLLABORATION_PEER_TOKEN: f.tokens.one,
			},
			encoding: "utf8",
			timeout: 15000,
			maxBuffer: 8192,
		},
	);
	expect(JSON.parse(output)).toMatchObject({ messageId: "source-cli", state: "queued" });
	expect(f.store.load("team").agents.map((agent) => agent.turn)).toEqual([0, 0]);
	expect(output).not.toContain(f.tokens.one);
});

it("refuses active dismiss and retains pending mailbox evidence for stopped or dismissed peers", async () => {
	const f = await mailbox();
	const turn = f.store.reserveTurn("team", "two", "active");
	f.send();
	expect(() => f.store.dismiss("team")).toThrow(/active/);
	expect(f.store.load("team").dismissed).toBe(false);
	f.store.finishTurn("team", "two", turn.turnId, "done", "finished");
	f.coordinator.refresh();
	f.store.dismiss("team");
	await f.coordinator.drainPeerMessages();
	expect(f.launchTurn).not.toHaveBeenCalled();
	expect(f.store.load("team").mailbox.messages).toHaveLength(1);
});

it("does not archive an acknowledged done team while its peer queue still holds accepted work", async () => {
	const f = await mailbox();
	for (const agentId of ["one", "two"]) {
		const turn = f.store.reserveTurn("team", agentId, "initial work");
		f.store.finishTurn("team", agentId, turn.turnId, "done", "verified");
	}
	f.coordinator.refresh();
	f.send();
	expect(() => f.store.archive("team")).toThrow(/peer/);
	f.store.dismiss("team");
	expect(f.store.archive("team")).toContain("archive");
});

it("delivers a native peer message from the filesystem event and never peeks or replays after resume", async () => {
	const f = await collaborationFixture();
	try {
		await f.execute({
			action: "launch_workspace",
			launchKey: "peer-event",
			agents: [{ provider: "pi" }, { provider: "claude" }],
		});
		const launch = f.backend.createWorkspace.mock.calls[0] as unknown as [{ env: NodeJS.ProcessEnv }];
		let delivered: () => void = () => {};
		const event = new Promise<void>((resolve) => {
			delivered = resolve;
		});
		f.launchTurn.mockImplementationOnce(async () => {
			delivered();
		});
		runCollaborationPeer(["send", "agent-2", "native-message", "Review the shared contract only"], launch[0].env);
		const guard = setTimeout(delivered, 3000);
		try {
			await event;
		} finally {
			clearTimeout(guard);
		}
		expect(f.launchTurn).toHaveBeenCalledTimes(1);
		expect(f.store.load("peer-event").agents[1]).toMatchObject({ status: "reserved", turn: 1 });
		expect(f.backend.prompt).not.toHaveBeenCalled();
		expect(f.backend.readAgent).not.toHaveBeenCalled();
		expect(f.report.mock.calls.filter(([value]) => value.phase === "terminal")).toEqual([]);
		runCollaborationPeer(["send", "agent-2", "native-message", "Review the shared contract only"], launch[0].env);
		await f.shutdown();
		await f.start();
		expect(f.launchTurn).toHaveBeenCalledTimes(1);
	} finally {
		await f.cleanup();
	}
});
