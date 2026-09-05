import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { NativePiActivity, NativePiActivityHost } from "../src/core/collaboration/native-pi-activity.ts";
import { SessionNativePiActivityRuntime } from "../src/core/collaboration/native-pi-runtime.ts";

const mocks = vi.hoisted(() => ({ attach: vi.fn() }));
vi.mock("../src/core/collaboration/native-pi-activity.ts", () => ({ attachNativePiActivity: mocks.attach }));
describe("native Pi session replacement", () => {
	it("serializes release before replacement and waits for a startup already in flight during stop", async () => {
		let attached: ((handle: NativePiActivity) => void) | undefined;
		mocks.attach.mockImplementationOnce(
			() =>
				new Promise<NativePiActivity>((resolve) => {
					attached = resolve;
				}),
		);
		const first = { refresh: vi.fn(), flush: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
		const second = { refresh: vi.fn(), flush: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
		mocks.attach.mockImplementationOnce(async () => {
			expect(first.dispose).toHaveBeenCalledOnce();
			return second;
		});
		const session = { nativeActivity: {}, sessionManager: {}, subscribe: vi.fn() } as unknown as AgentSession;
		const runtime = new SessionNativePiActivityRuntime();
		const starting = runtime.start(session);
		await Promise.resolve();
		const stopping = runtime.stop();
		attached!(first);
		await Promise.all([starting, stopping]);
		expect(first.dispose).toHaveBeenCalledOnce();
		await runtime.start(session);
		await runtime.stop();
		expect(second.dispose).toHaveBeenCalledOnce();
	});
	it("withholds initial settlement until input binding while preserving readiness on session replacement", async () => {
		const isSettled = vi.fn(() => true);
		const handle = { refresh: vi.fn(), flush: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
		let host: NativePiActivityHost | undefined;
		mocks.attach.mockImplementation(async (next: NativePiActivityHost) => {
			host = next;
			return handle;
		});
		const runtime = new SessionNativePiActivityRuntime({ deferInitialSettlement: true });
		const session = {
			nativeActivity: { isSettled },
			sessionManager: {},
			subscribe: vi.fn(),
		} as unknown as AgentSession;
		await runtime.start(session);
		expect(runtime.active).toBe(true);
		expect(host!.isSettled()).toBe(false);
		expect(isSettled).not.toHaveBeenCalled();
		await runtime.activate();
		expect(host!.isSettled()).toBe(true);
		expect(handle.refresh).toHaveBeenCalledOnce();
		await runtime.start(session);
		expect(host!.isSettled()).toBe(true);
		await runtime.stop();
		expect(runtime.active).toBe(false);
	});
	it("does not expose readiness on failed initial acknowledgement and releases the failed connection", async () => {
		const handle = {
			refresh: vi.fn(),
			flush: vi.fn(async () => {
				throw new Error("lost acknowledgement");
			}),
			dispose: vi.fn(async () => {}),
		};
		mocks.attach.mockResolvedValueOnce(handle);
		const runtime = new SessionNativePiActivityRuntime();
		const session = { nativeActivity: {}, sessionManager: {}, subscribe: vi.fn() } as unknown as AgentSession;
		await expect(runtime.start(session)).rejects.toThrow("lost acknowledgement");
		expect(runtime.active).toBe(false);
		expect(handle.dispose).toHaveBeenCalledOnce();
		await runtime.stop();
	});
});
