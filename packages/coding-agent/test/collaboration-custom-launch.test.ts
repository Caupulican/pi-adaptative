import { describe, expect, it, vi } from "vitest";
import type { CollaborationCommandRunner } from "../src/core/collaboration/command-runner.ts";
import { HerdrBackend } from "../src/core/collaboration/herdr-backend.ts";
import type { HerdrEventChannel } from "../src/core/collaboration/herdr-channel.ts";
import { NativeProviderRegistry } from "../src/core/collaboration/native-provider.ts";

const pane = { pane_id: "w1:p1", terminal_id: "t-owned", workspace_id: "w1", tab_id: "w1:t1" };
describe("custom interactive collaboration launch", () => {
	it.each(["working", "missing-bridge"])(
		"rechecks %s after rename before admitting the native pane",
		async (change) => {
			let onEvent: (event: unknown) => void = () => {};
			let stable = false;
			let renamed: (() => void) | undefined;
			const renameSeen = new Promise<void>((resolve) => {
				renamed = resolve;
			});
			const request = vi.fn(async (method: string) => {
				if (method === "pane.get") return { pane: { ...pane, agent: null } };
				if (method === "agent.get" || method === "agent.rename") {
					const raced = method === "agent.rename" && !stable;
					if (method === "agent.rename") renamed?.();
					return {
						agent: {
							...pane,
							agent: "pi",
							name: "worker",
							agent_status: raced && change === "working" ? "working" : "idle",
							state_change_seq: stable ? 3 : 1,
							revision: 1,
							...(!(raced && change === "missing-bridge")
								? { state_labels: { idle: "pi:collaboration:12345678-1234-4234-8234-123456789abc" } }
								: {}),
						},
					};
				}
				return {};
			});
			const backend = new HerdrBackend({
				executable: "herdr",
				session: "pi-owned",
				socketPath: "/owned/socket",
				connect: async () => ({
					request,
					onEvent: (listener) => {
						onEvent = listener;
						return () => {};
					},
					close: vi.fn(),
				}),
			});
			let admitted = false;
			const starting = backend
				.startAgent({ name: "worker", kind: "pi", paneId: pane.pane_id, command: "pi-opus" })
				.then((agent) => {
					admitted = true;
					return agent;
				});
			await renameSeen;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(admitted).toBe(false);
			stable = true;
			onEvent({ event: "pane.agent_status_changed", data: { pane_id: pane.pane_id } });
			await expect(starting).resolves.toMatchObject({
				status: "idle",
				interactiveReady: true,
				stateChangeSequence: 3,
			});
		},
	);
	it.each([false, true])(
		"preserves wrapper launch and probes while declaring the structured native kind (structured=%s)",
		async (structured) => {
			const run = vi
				.fn<CollaborationCommandRunner>()
				.mockResolvedValueOnce({ code: 0, reason: "exited", stdout: "pi wrapper", stderr: "" })
				.mockResolvedValueOnce({
					code: 0,
					reason: "exited",
					stdout: '{"providers":[{"provider":"openai-codex","configured":true,"status":"valid"}]}',
					stderr: "",
				});
			await new NativeProviderRegistry(run).inspect("pi", { executable: "pi-opus", env: { PI_WORKER: "1" } });
			expect(run.mock.calls.every((call) => call[0] === "pi-opus" && call[2].env?.PI_WORKER === "1")).toBe(true);
			const agent = {
				...pane,
				agent: "pi",
				name: "worker",
				agent_status: "idle",
				interactive_ready: false,
				launch_pending: false,
				state_change_seq: 1,
				revision: 1,
				state_labels: { idle: "pi:collaboration:12345678-1234-4234-8234-123456789abc" },
			};
			const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
				if (method === "pane.get") return { pane: { ...pane, agent: null } };
				if (method === "agent.get" || method === "agent.rename") return { agent };
				return { type: "ok" };
			});
			const connection: HerdrEventChannel = { request, onEvent: () => () => {}, close: vi.fn() };
			const backend = new HerdrBackend({
				executable: "herdr",
				session: "pi-owned",
				socketPath: "/owned/socket",
				connect: async () => connection,
			});
			expect(
				await backend.startAgent({
					name: "worker",
					kind: "pi",
					paneId: pane.pane_id,
					...(structured
						? { executable: "pi-opus", args: ["--model", "chosen"] }
						: { command: "PI_WORKER=1 pi-opus" }),
				}),
			).toMatchObject({ name: "worker", terminalId: "t-owned" });
			expect(request.mock.calls.map((call) => call[0])).toEqual([
				"pane.get",
				"events.subscribe",
				"pane.get",
				"pane.send_input",
				"agent.get",
				"agent.rename",
			]);
			expect(request).toHaveBeenCalledWith("pane.send_input", {
				pane_id: pane.pane_id,
				text: structured
					? `${process.platform === "win32" ? "& " : "HERDR_AGENT='pi' "}'pi-opus' '--model' 'chosen'`
					: "PI_WORKER=1 pi-opus",
				keys: ["enter"],
			});
		},
	);
	it("does not paste into an early guessed Pi idle before the native bridge activation", async () => {
		let onEvent: (event: unknown) => void = () => {};
		let sourceReady = false;
		let firstRead: (() => void) | undefined;
		const observed = new Promise<void>((resolve) => {
			firstRead = resolve;
		});
		const request = vi.fn(async (method: string) => {
			if (method === "pane.get") return { pane: { ...pane, agent: null } };
			if (method === "agent.get" || method === "agent.rename") {
				firstRead?.();
				return {
					agent: {
						...pane,
						agent: "pi",
						name: method === "agent.rename" ? "worker" : null,
						agent_status: "idle",
						interactive_ready: true,
						state_change_seq: sourceReady ? 4 : 1,
						revision: 5,
						...(sourceReady
							? { state_labels: { idle: "pi:collaboration:12345678-1234-4234-8234-123456789abc" } }
							: {}),
					},
				};
			}
			return {};
		});
		const backend = new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			connect: async () => ({
				request,
				onEvent: (listener) => {
					onEvent = listener;
					return () => {};
				},
				close: vi.fn(),
			}),
		});
		const starting = backend.startAgent({ name: "worker", kind: "pi", paneId: pane.pane_id, command: "pi-opus" });
		await observed;
		await Promise.resolve();
		expect(request.mock.calls.some((call) => call[0] === "agent.rename")).toBe(false);
		sourceReady = true;
		onEvent({ event: "pane_agent_status_changed", data: { pane_id: pane.pane_id } });
		await expect(starting).resolves.toMatchObject({ interactiveReady: true, name: "worker" });
	});
	it("rejects a shell occupant replacement before the custom command is written", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ pane: { ...pane, agent: null } })
			.mockResolvedValueOnce({ type: "subscription_started" })
			.mockResolvedValueOnce({ pane: { ...pane, terminal_id: "foreign", agent: null } });
		const backend = new HerdrBackend({
			executable: "herdr",
			session: "pi-owned",
			socketPath: "/owned/socket",
			connect: async () => ({ request, onEvent: () => () => {}, close: vi.fn() }),
		});
		await expect(
			backend.startAgent({ name: "worker", kind: "pi", paneId: pane.pane_id, command: "pi-opus" }),
		).rejects.toMatchObject({ code: "pane_busy", delivery: "not-submitted" });
		expect(request.mock.calls.some((call) => call[0] === "pane.send_input")).toBe(false);
	});
});
