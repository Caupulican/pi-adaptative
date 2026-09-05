import { describe, expect, it, vi } from "vitest";
import type { CollaborationCommandRunner } from "../src/core/collaboration/command-runner.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import { parseHerdrAgent } from "../src/core/collaboration/herdr-codec.ts";

const agent = {
	pane_id: "w1:p2",
	terminal_id: "t-owned",
	workspace_id: "w1",
	tab_id: "w1:t1",
	agent: "codex",
	name: "reviewer",
	agent_status: "idle",
	interactive_ready: true,
	launch_pending: false,
	state_change_seq: 3,
	revision: 4,
};
const reply = (result: unknown) => ({
	code: 0,
	reason: "exited" as const,
	stdout: JSON.stringify({ result }),
	stderr: "",
});

describe("Herdr collaboration boundary", () => {
	it("requires post-activation source-scoped bridge readiness for Pi, including fresh backend reads", async () => {
		const pi = {
			...agent,
			agent: "pi",
			name: undefined,
			state_labels: { idle: "pi:collaboration:12345678-1234-4234-8234-123456789abc" },
		};
		expect(parseHerdrAgent(pi).interactiveReady).toBe(true);
		for (const invalid of [
			{ ...pi, state_labels: undefined },
			{ ...pi, state_labels: { idle: "pi:collaboration:guessed" } },
			{ ...pi, state_labels: { idle: "herdr:pi" } },
			{ ...pi, launch_pending: true },
			{ ...pi, state_change_seq: 0 },
			{ ...pi, agent_status: "unknown" },
		])
			expect(parseHerdrAgent(invalid).interactiveReady).toBe(false);
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValue(reply({ type: "agent_info", agent: { ...pi, name: "reviewer", state_labels: undefined } }));
		await expect(
			new HerdrBackend({ executable: "herdr", session: "pi-owned", run }).prompt({
				target: "reviewer",
				text: "never paste",
				timeoutMs: 1000,
			}),
		).rejects.toMatchObject({ delivery: "not-submitted" });
		expect(run).toHaveBeenCalledOnce();
	});
	it("reads a stopped snapshot from the structured socket API because the CLI emits plaintext", async () => {
		const request = vi.fn(async () => ({
			type: "pane_read",
			read: { pane_id: "w1:p2", text: "completed evidence", truncated: false, revision: 4 },
		}));
		const close = vi.fn();
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValue({ code: 0, reason: "exited", stdout: "plaintext, not JSON", stderr: "" });
		const backend = new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			run,
			connect: async () => ({ request, close, onEvent: () => () => {} }),
		});
		await expect(backend.readAgent("reviewer", 40)).resolves.toEqual({
			paneId: "w1:p2",
			text: "completed evidence",
			truncated: false,
			revision: 4,
		});
		expect(request).toHaveBeenCalledWith("agent.read", {
			target: "reviewer",
			source: "recent_unwrapped",
			lines: 40,
			format: "text",
			strip_ansi: true,
		});
		expect(run).not.toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});
	it("recognizes named custom readiness in a fresh backend but rejects unnamed, stale, and pending reports", () => {
		const custom = { ...agent, interactive_ready: undefined };
		expect(parseHerdrAgent(custom).interactiveReady).toBe(true);
		for (const invalid of [
			{ ...custom, name: undefined },
			{ ...custom, state_change_seq: 0 },
			{ ...custom, launch_pending: true },
			{ ...custom, agent_status: "unknown" },
			{ ...custom, agent: undefined },
		])
			expect(parseHerdrAgent(invalid).interactiveReady).toBe(false);
		expect(
			parseHerdrAgent({ ...agent, state_labels: { blocked: "Which implementation?" }, agent_status: "blocked" })
				.question,
		).toBe("Which implementation?");
		expect(parseHerdrAgent({ ...agent, state_labels: { blocked: "stale question" } }).question).toBeUndefined();
	});
	it("accepts omitted false/default readiness fields but does not admit that agent for input", async () => {
		const { interactive_ready: _ready, launch_pending: _pending, state_change_seq: _sequence, ...wireAgent } = agent;
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValue(reply({ type: "agent_info", agent: wireAgent }));
		const backend = new HerdrBackend({ executable: "herdr", session: "pi-owned", run });
		expect(await backend.getAgent("reviewer")).toMatchObject({
			interactiveReady: false,
			launchPending: false,
			stateChangeSequence: 0,
		});
		await expect(backend.prompt({ target: "reviewer", text: "x", timeoutMs: 1000 })).rejects.toMatchObject({
			delivery: "not-submitted",
		});
		expect(run).toHaveBeenCalledTimes(2);
	});
	it("accepts the documented silent server-stop CLI success, not empty agent results", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValue({ code: 0, reason: "exited", stdout: "", stderr: "" });
		const backend = new HerdrBackend({ executable: "herdr", session: "pi-owned", run });
		await expect(backend.stopSession()).resolves.toBeUndefined();
		await expect(backend.reportMetadata("w1", { status: "done" }, 1)).resolves.toBeUndefined();
		await expect(backend.closePane("w1:p1")).resolves.toBeUndefined();
		await expect(backend.getAgent("reviewer")).rejects.toThrow("Malformed");
	});
	it("uses explicit session/identity and one atomic prompt-wait without output polling", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(reply({ type: "agent_info", agent }))
			.mockResolvedValueOnce(
				reply({ type: "agent_prompted", agent: { ...agent, agent_status: "done", state_change_seq: 5 } }),
			);
		const backend = new HerdrBackend({ executable: "/bin/herdr", session: "pi-owned", run });
		const result = await backend.prompt({ target: "reviewer", text: "work; $(not-a-shell)", timeoutMs: 30000 });
		expect(result.status).toBe("done");
		expect(run.mock.calls.map((call) => call[1])).toEqual([
			["--session", "pi-owned", "agent", "get", "reviewer"],
			["--session", "pi-owned", "agent", "prompt", "w1:p2", "work; $(not-a-shell)", "--wait", "--timeout", "30000"],
		]);
	});
	it("rejects busy agents before any submission", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValue(reply({ type: "agent_info", agent: { ...agent, agent_status: "working" } }));
		await expect(
			new HerdrBackend({ executable: "herdr", session: "pi-owned", run }).prompt({
				target: "reviewer",
				text: "x",
				timeoutMs: 1000,
			}),
		).rejects.toMatchObject({ delivery: "not-submitted", code: "agent_not_ready" });
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("does not replay an uncertain submission and preserves the delivery classification", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(reply({ type: "agent_info", agent }))
			.mockResolvedValueOnce({ code: null, reason: "timeout", stdout: "", stderr: "secret-output" });
		await expect(
			new HerdrBackend({ executable: "herdr", session: "pi-owned", run }).prompt({
				target: "reviewer",
				text: "x",
				timeoutMs: 1000,
			}),
		).rejects.toMatchObject({ delivery: "unknown", code: "timeout" });
		expect(run).toHaveBeenCalledTimes(2);
	});
	it("rejects a replacement occupant and malformed server success", async () => {
		const run = vi
			.fn<CollaborationCommandRunner>()
			.mockResolvedValueOnce(reply({ type: "agent_info", agent }))
			.mockResolvedValueOnce(reply({ type: "agent_prompted", agent: { ...agent, terminal_id: "foreign" } }));
		await expect(
			new HerdrBackend({ executable: "herdr", session: "pi-owned", run }).prompt({
				target: "reviewer",
				text: "x",
				timeoutMs: 1000,
			}),
		).rejects.toMatchObject({ code: "occupant_changed", delivery: "unknown" });
		run.mockResolvedValue(reply({ type: "agent_info", agent: { ...agent, revision: Number.MAX_SAFE_INTEGER + 1 } }));
		await expect(
			new HerdrBackend({ executable: "herdr", session: "pi-owned", run }).getAgent("reviewer"),
		).rejects.toThrow("Malformed");
	});
	it("never accepts focused/default or option-shaped targets", async () => {
		const run = vi.fn<CollaborationCommandRunner>();
		const backend = new HerdrBackend({ executable: "herdr", session: "pi-owned", run });
		await expect(backend.getAgent("--current")).rejects.toThrow();
		await expect(backend.closeWorkspace("")).rejects.toThrow();
		expect(run).not.toHaveBeenCalled();
	});
});
