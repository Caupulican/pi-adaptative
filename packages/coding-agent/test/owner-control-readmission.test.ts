import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createBuiltInChannelProvider } from "../src/core/channels/built-in-providers.ts";
import type { ChannelJournal } from "../src/core/channels/channel-journal.ts";
import type { InboundChannelEvent } from "../src/core/channels/channel-message.ts";
import { type ResolvedChannelPolicy, resolveChannelPolicies } from "../src/core/channels/channel-policy.ts";
import { ownerSenderDigest } from "../src/core/channels/owner-channel.ts";
import type { OwnerChannelControl, OwnerDraftView } from "../src/core/channels/owner-channel-types.ts";
import { SessionChannels } from "../src/core/channels/session-channels.ts";
import type { ChannelMessage, ChannelProvider, GatewayRegistry } from "../src/core/gateways/channel-provider.ts";
import { ownerSessionStorageRoots } from "../src/kernel/session/session-bundle-paths.ts";
import { SessionManager } from "../src/kernel/session/session-manager.ts";

interface ControlBoundary {
	started: boolean;
	registry: GatewayRegistry;
	runtimes: Map<string, { state: "armed"; holding: boolean; offering: boolean }>;
	receive(name: string, event: ChannelMessage): Promise<void>;
	ownerStatus(
		name: string,
		policy: ResolvedChannelPolicy,
		event: InboundChannelEvent,
		sender: string,
	): { reply: string; present: OwnerDraftView[] };
	stopOwnerTurns(name: string): string;
	journal(name: string): ChannelJournal;
}
const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const close of cleanups.splice(0)) close();
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "pi-owner-control-readmission-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	let policies = resolveChannelPolicies([
		{ telegram: { mode: "explicit", ownerSenders: [42], ownerMaxUsdPerTurn: 1, ownerMaxUsdPerDay: 10 } },
	]);
	let emergency = false;
	const manager = SessionManager.create(dir, ownerSessionStorageRoots(dir));
	const draft: OwnerDraftView = {
		id: "draft-0123456789abcdef",
		classes: [],
		toolName: "synthetic_tool",
		rendering: "synthetic arguments",
		origin: { v: 1, k: "owner-channel", channel: "telegram", verified: true, ref: "original" },
		state: "pending",
		preparedAt: "2026-11-21T00:00:00.000Z",
	};
	const control: OwnerChannelControl = {
		drafts: () => [draft],
		approve: vi.fn(() => "approved" as const),
		deny: vi.fn(() => "denied" as const),
		onDraftHeld: () => () => {},
		waiting: () => ({ sessionId: manager.getSessionId(), cwd: dir, calls: [], work: { busy: false, phase: "idle" } }),
	};
	const channels = new SessionChannels({
		getAgentDir: () => dir,
		getSessionManager: () => manager,
		getModelRegistry: () => {
			throw new Error("No model use in control fixture");
		},
		getChannelPolicies: () => policies,
		subscribeSettings: () => () => {},
		subscribeForegroundActivity: () => () => {},
		isForegroundBusy: () => false,
		sendUserMessage: vi.fn(async () => {}),
		observeNotice: () => true,
		warn: vi.fn(),
		isDisposed: () => false,
		servesChannels: () => true,
		ownerDelivery: {
			deliver: vi.fn(),
			deliverApproval: vi.fn(),
			observeRunUsage: () => () => {},
			holdsForeground: () => false,
			isAnsweringBatch: () => false,
			holdMeteredMoves: () => () => {},
			abortRun: vi.fn(),
		},
		ownerControl: () => control,
		isEmergencyStopEngaged: () => emergency,
		now: () => 100000,
	});
	const core = channels as unknown as ControlBoundary;
	const policy = () => {
		const resolution = policies.get("telegram")!;
		if (resolution.kind !== "policy") throw new Error("Invalid fixture policy");
		return resolution.policy;
	};
	const shipped = () =>
		createBuiltInChannelProvider("telegram", policy(), {
			agentDir: dir,
			warn: vi.fn(),
			fetch: async () => {
				throw new Error("No provider requests in control fixture");
			},
		})!;
	const provider = shipped();
	const send = vi.spyOn(provider, "send").mockImplementation(() => {});
	core.registry.registerChannel(provider);
	core.started = true;
	core.runtimes.set("telegram", { state: "armed", holding: true, offering: false });
	const status = vi.spyOn(core, "ownerStatus").mockReturnValue({ reply: "Synthetic status", present: [] });
	const stop = vi.spyOn(core, "stopOwnerTurns").mockReturnValue("Synthetic stop");
	core.journal("telegram").update(100000, (state) => {
		state.batches.push({
			id: "original",
			sessionId: manager.getSessionId(),
			conversationKey: "private-chat",
			address: "private-address",
			eventDigests: [],
			allowlisted: true,
			acceptedAt: 100000,
			state: "accepted",
			owner: true,
			senderDigest: ownerSenderDigest("telegram", "42", provider),
		});
	});
	vi.spyOn(channels.ownerPush, "presentedAt").mockReturnValue(1);
	const queued: VoidFunction[] = [];
	vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
		queued.push(callback);
	});
	let event = 0;
	return {
		core,
		provider,
		send,
		status,
		stop,
		control,
		shipped,
		emergency: () => {
			emergency = true;
		},
		owners: (ids: number[]) => {
			policies = resolveChannelPolicies([{ telegram: { ...policy(), ownerSenders: ids } }]);
		},
		async enqueue(text: string) {
			await core.receive("telegram", {
				eventId: `synthetic-${++event}`,
				conversationKey: "private-chat",
				address: "private-address",
				sender: { id: "42", verified: true },
				kind: "message",
				text,
				privateChat: true,
				forwarded: false,
			});
			expect(queued).toHaveLength(1);
		},
		async drain() {
			queued.shift()!();
			await nextTurn();
		},
		replace(provider: ChannelProvider) {
			core.registry.registerChannel(provider);
		},
	};
}

it.each(["status", "stop", "deny draft-0123456789abcdef"])(
	"rechecks a revoked sender before queued %s executes",
	async (command) => {
		const f = fixture();
		await f.enqueue(command);
		f.owners([]);
		await f.drain();
		expect(f.status).not.toHaveBeenCalled();
		expect(f.stop).not.toHaveBeenCalled();
		expect(f.control.deny).not.toHaveBeenCalled();
		expect(f.send).not.toHaveBeenCalled();
	},
);
it.each(["status", "stop"])("does not transfer queued %s to a replacement listed owner", async (command) => {
	const f = fixture();
	await f.enqueue(command);
	f.owners([43]);
	await f.drain();
	expect(f.status).not.toHaveBeenCalled();
	expect(f.stop).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
});
it.each(["status", "stop"])("binds queued %s to its admitting shipped provider instance", async (command) => {
	const f = fixture();
	await f.enqueue(command);
	const replacement = f.shipped();
	const sent = vi.spyOn(replacement, "send").mockImplementation(() => {});
	f.replace(replacement);
	await f.drain();
	expect(f.status).not.toHaveBeenCalled();
	expect(f.stop).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
	expect(sent).not.toHaveBeenCalled();
});
it("rejects a rebound sender digest even when the same adapter now normalizes both listed and received ids alike", async () => {
	const f = fixture();
	await f.enqueue("status");
	Object.defineProperty(f.provider, "senderIds", {
		value: { assignedBy: "platform", normalize: (id: string) => `replacement-${id}` },
		configurable: true,
	});
	await f.drain();
	expect(f.status).not.toHaveBeenCalled();
	expect(f.send).not.toHaveBeenCalled();
});
it.each(["status", "stop", "deny draft-0123456789abcdef"])(
	"retains valid %s control during an emergency hold",
	async (command) => {
		const f = fixture();
		await f.enqueue(command);
		f.emergency();
		await f.drain();
		expect(f.send).toHaveBeenCalledOnce();
		if (command === "status") expect(f.status).toHaveBeenCalledOnce();
		else if (command === "stop") expect(f.stop).toHaveBeenCalledWith("telegram");
		else
			expect(f.control.deny).toHaveBeenCalledWith(
				"draft-0123456789abcdef",
				expect.objectContaining({ senderDigest: ownerSenderDigest("telegram", "42", f.provider) }),
			);
	},
);
it("still refuses approval during emergency hold while allowing control replies", async () => {
	const f = fixture();
	await f.enqueue("approve draft-0123456789abcdef");
	f.emergency();
	await f.drain();
	expect(f.control.approve).not.toHaveBeenCalled();
	expect(f.send).toHaveBeenCalledOnce();
	expect(f.send.mock.calls[0]![0].text).toContain("Approve refused");
});
