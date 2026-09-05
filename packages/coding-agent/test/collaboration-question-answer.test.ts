import { describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import type { HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";

const blocked = {
	pane_id: "w1:p2",
	terminal_id: "t-owned",
	workspace_id: "w1",
	tab_id: "w1:t1",
	agent: "codex",
	name: "reviewer",
	agent_status: "blocked",
	interactive_ready: false,
	launch_pending: false,
	state_change_seq: 3,
	revision: 4,
};
describe("persistent collaboration questions", () => {
	it("arms events before answering once and forwards no working/progress state", async () => {
		let listener: ((event: unknown) => void) | undefined;
		let answered = false;
		const steps: string[] = [];
		const connection: HerdrEventChannel = {
			request: vi.fn(async (method: string) => {
				steps.push(method);
				if (method === "agent.get")
					return {
						type: "agent_info",
						agent: answered ? { ...blocked, agent_status: "done", state_change_seq: 5 } : blocked,
					};
				if (method === "pane.send_input") {
					answered = true;
					listener?.({ event: "pane.agent_status_changed", data: { pane_id: "foreign", agent_status: "done" } });
					listener?.({
						event: "pane.agent_status_changed",
						data: { pane_id: blocked.pane_id, agent_status: "working" },
					});
					listener?.({
						event: "pane_output_changed",
						data: { pane_id: blocked.pane_id, text: "private thoughts" },
					});
					listener?.({
						event: "pane.agent_status_changed",
						data: { pane_id: blocked.pane_id, agent_status: "done" },
					});
				}
				return { type: "ok" };
			}),
			onEvent: (callback) => {
				listener = callback;
				return () => {
					listener = undefined;
				};
			},
			close: vi.fn(),
		};
		const backend = new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			connect: async () => connection,
		});
		const result = await backend.answerQuestion({
			target: "reviewer",
			terminalId: blocked.terminal_id,
			text: "Use the specified path",
			timeoutMs: 5000,
		});
		expect(result.status).toBe("done");
		expect(steps).toEqual(["agent.get", "events.subscribe", "agent.get", "pane.send_input", "agent.get"]);
		expect(JSON.stringify(result)).not.toContain("private thoughts");
		expect(connection.close).toHaveBeenCalledTimes(1);
	});
	it("refuses stale or replaced questions before input, even after subscription", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ agent: blocked })
			.mockResolvedValueOnce({ type: "subscription_started" })
			.mockResolvedValueOnce({ agent: { ...blocked, state_change_seq: 4 } });
		const backend = new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			connect: async () => ({ request, onEvent: () => () => {}, close: vi.fn() }),
		});
		await expect(
			backend.answerQuestion({
				target: "reviewer",
				terminalId: blocked.terminal_id,
				keys: ["enter"],
				timeoutMs: 5000,
			}),
		).rejects.toMatchObject({ code: "question_changed", delivery: "not-submitted" });
		expect(request.mock.calls.some((call) => call[0] === "pane.send_input")).toBe(false);
	});
});
