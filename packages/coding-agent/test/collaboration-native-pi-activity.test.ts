import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEventListener } from "../src/core/agent-session-contracts.ts";
import { attachNativePiActivity } from "../src/core/collaboration/native-pi-activity.ts";
import type { NativePiQuestionReporter } from "../src/core/collaboration/native-pi-question.ts";
import { createHumanInputRequest, resolveHumanInput } from "../src/core/human-input.ts";

async function fixture(initiallySettled = true, questionReporter?: NativePiQuestionReporter) {
	let busy = false;
	let epoch: number | undefined;
	let settled = initiallySettled;
	let listener: AgentSessionEventListener = () => {};
	let changed = () => {};
	let pendingChanged = () => {};
	let channelEvent: (event: unknown) => void = () => {};
	const waiters: Array<() => void> = [];
	const reports: Array<Record<string, unknown>> = [];
	const sessionManager = SessionManager.inMemory();
	const close = vi.fn();
	const onError = vi.fn();
	const reporter = await attachNativePiActivity(
		{
			sessionManager,
			foreground: {
				get isBusy() {
					return busy;
				},
				getCurrentSubmissionEpoch: () => epoch,
				waitForIdle: () => (busy ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
				subscribeActivity: (callback) => {
					changed = callback;
					return () => {
						changed = () => {};
					};
				},
			},
			isSettled: () => settled,
			subscribePendingContinuation: (callback) => {
				pendingChanged = callback;
				return () => {
					pendingChanged = () => {};
				};
			},
			subscribe: (callback) => {
				listener = callback;
				return () => {
					listener = () => {};
				};
			},
		},
		{
			env: { HERDR_ENV: "1", HERDR_PANE_ID: "pane:1", HERDR_SOCKET_PATH: "/owned/socket" },
			onError,
			questionReporter,
			connect: async () => ({
				close,
				onEvent: (callback) => {
					channelEvent = callback;
					return () => {
						channelEvent = () => {};
					};
				},
				request: async (method, params) => {
					if (
						method === "pane.report_metadata" &&
						params.clear_state_labels &&
						Object.keys(params.state_labels as object).length
					)
						throw new Error("cannot set and clear the same metadata field");
					reports.push({ method, ...params });
					return {};
				},
			}),
		},
	);
	return {
		reporter: reporter!,
		reports,
		sessionManager,
		close,
		onError,
		channelEvent: (event: unknown) => channelEvent(event),
		event: (event: Parameters<AgentSessionEventListener>[0]) => listener(event),
		start: () => {
			busy = true;
			epoch = (epoch ?? 0) + 1;
			changed();
		},
		end: () => {
			busy = false;
			epoch = undefined;
			changed();
			for (const resolve of waiters.splice(0)) resolve();
		},
		pending: (value: boolean) => {
			settled = !value;
			pendingChanged();
		},
	};
}

describe("native Pi lifecycle reporting", () => {
	it("persists only the selected queued question and publishes its successor before the next blocked report", async () => {
		const waiting = vi.fn();
		const settled = vi.fn();
		const f = await fixture(true, { waiting, settled });
		await f.reporter.flush();
		f.start();
		const requests = ["First decision?", "Second decision with full choices?"].map((question) =>
			createHumanInputRequest({
				source: "tool",
				acceptsImages: false,
				questions: [{ id: question, header: "Choice", question, options: [] }],
			}),
		);
		const answers: Array<() => void> = [];
		const pending = requests.map((request) =>
			resolveHumanInput({
				sessionManager: f.sessionManager,
				request,
				present: () =>
					new Promise((resolve) => {
						answers.push(() => resolve({ answers: [], imageContents: [], cancelled: true }));
					}),
			}),
		);
		await f.reporter.flush();
		expect(waiting).toHaveBeenCalledTimes(1);
		expect(waiting).toHaveBeenLastCalledWith(requests[0]);
		f.event({ type: "agent_end", messages: [], willRetry: false });
		await f.reporter.flush();
		expect(waiting).toHaveBeenCalledTimes(1);
		answers[0]();
		await pending[0];
		await f.reporter.flush();
		expect(settled).toHaveBeenCalledWith(requests[0].requestId);
		expect(waiting).toHaveBeenCalledTimes(2);
		expect(waiting).toHaveBeenLastCalledWith(requests[1]);
		expect(f.reports.at(-1)?.message).toContain("Second decision with full choices?");
		answers[1]();
		await pending[1];
		f.end();
		await f.reporter.dispose();
	});
	it("publishes source-scoped readiness only after startup is settled", async () => {
		const f = await fixture(false);
		await f.reporter.flush();
		expect(f.reports.some((report) => report.method === "pane.report_metadata")).toBe(false);
		f.pending(false);
		await f.reporter.flush();
		const metadata = f.reports.at(-2)!;
		expect(metadata).toMatchObject({
			method: "pane.report_metadata",
			agent: "pi",
			state_labels: { idle: metadata.source },
			applies_to_source: metadata.source,
		});
		expect(metadata.source).toMatch(/^pi:collaboration:[a-f0-9-]{36}$/);
		expect(f.reports.at(-1)?.state).toBe("idle");
		await f.reporter.dispose();
	});
	it("withholds settlement through retry/repair lease, queued continuation, and a superseding submission", async () => {
		const f = await fixture();
		await f.reporter.flush();
		expect(f.reports[0]).toMatchObject({
			method: "events.subscribe",
			subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }],
		});
		f.start();
		f.event({ type: "agent_end", messages: [], willRetry: false });
		await f.reporter.flush();
		expect(f.reports.filter((report) => report.method === "pane.report_agent").map((report) => report.state)).toEqual(
			["idle", "working"],
		);
		f.pending(true);
		f.end();
		await f.reporter.flush();
		expect(f.reports.at(-1)?.state).toBe("working");
		f.pending(false);
		f.start();
		f.end();
		f.start();
		await f.reporter.flush();
		expect(f.reports.at(-1)?.state).toBe("working");
		f.end();
		await f.reporter.flush();
		expect(f.reports.at(-1)?.state).toBe("idle");
		await f.reporter.dispose();
		expect(f.reports.at(-1)?.method).toBe("pane.release_agent");
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("reports questions through the presenter owner, never forwards thought/tool text, and resumes working after the answer", async () => {
		const waiting = vi.fn(() => {
			expect(f.reports.at(-1)?.state).not.toBe("blocked");
		});
		const settled = vi.fn(() => {
			expect(f.reports.at(-1)?.state).toBe("blocked");
		});
		const f = await fixture(true, { waiting, settled });
		await f.reporter.flush();
		f.start();
		let answer: (() => void) | undefined;
		const request = createHumanInputRequest({
			source: "tool",
			questions: [{ id: "q", header: "Choice", question: "Which implementation?", options: [] }],
			acceptsImages: false,
		});
		const presentation = resolveHumanInput({
			sessionManager: f.sessionManager,
			request,
			present: () =>
				new Promise((resolve) => {
					answer = () => resolve({ answers: [], imageContents: [], cancelled: true });
				}),
		});
		await f.reporter.flush();
		expect(waiting).toHaveBeenCalledWith(request);
		expect(f.reports.at(-1)).toMatchObject({
			state: "blocked",
			message: expect.stringContaining("Which implementation?"),
		});
		expect(f.reports.at(-2)).toMatchObject({
			method: "pane.report_metadata",
			state_labels: {
				blocked: expect.stringContaining("Which implementation?"),
				idle: expect.stringMatching(/^pi:collaboration:/),
			},
		});
		f.event({
			type: "tool_execution_start",
			toolCallId: "secret",
			toolName: "bash",
			args: { text: "private tool text" },
		});
		await f.reporter.flush();
		expect(JSON.stringify(f.reports)).not.toContain("private tool text");
		answer!();
		await presentation;
		expect(settled).toHaveBeenCalledWith(request.requestId);
		await f.reporter.flush();
		expect(f.reports.at(-1)?.state).toBe("working");
		expect(f.reports.at(-2)?.state_labels).toEqual({ idle: f.reports.at(-2)?.source });
		f.end();
		await f.reporter.dispose();
	});
	it("does not connect outside an explicitly injected Herdr pane", async () => {
		const connect = vi.fn();
		await expect(
			attachNativePiActivity({} as Parameters<typeof attachNativePiActivity>[0], { env: {}, connect }),
		).resolves.toBeUndefined();
		expect(connect).not.toHaveBeenCalled();
	});
	it("publishes final idle from continuation cancellation without a foreground or session event", async () => {
		const f = await fixture();
		await f.reporter.flush();
		f.pending(true);
		await f.reporter.flush();
		expect(f.reports.at(-1)?.state).toBe("working");
		f.pending(false);
		await f.reporter.flush();
		expect(f.reports.at(-1)?.state).toBe("idle");
		await f.reporter.dispose();
	});
	it("fails closed on an idle connection loss without waiting for a new agent turn", async () => {
		const f = await fixture();
		await f.reporter.flush();
		f.channelEvent({ error: { code: "connection_closed" } });
		expect(f.onError).toHaveBeenCalledOnce();
		await expect(f.reporter.flush()).rejects.toThrow("connection failed");
		await expect(f.reporter.dispose()).rejects.toThrow("connection failed");
		const count = f.reports.length;
		f.start();
		expect(f.reports).toHaveLength(count);
	});
});
