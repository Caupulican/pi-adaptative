import { afterEach, describe, expect, it, vi } from "vitest";
import { pollOAuthDeviceCodeFlow } from "../src/utils/oauth/device-code.ts";
import { loginXai, refreshXaiToken } from "../src/utils/oauth/xai.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("bounded xAI OAuth transport", () => {
	it("keeps native protocol identity and refresh credentials", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(Response.json({ access_token: "access", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const credentials = await refreshXaiToken("refresh");
		expect(credentials.access).toBe("access");
		expect(credentials.refresh).toBe("refresh");
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe("https://auth.x.ai/oauth2/token");
		expect(String(init?.body)).toContain("client_id=b1a00492-073a-47ea-816f-4c329264a828");
		expect(init?.redirect).toBe("error");
	});

	it.each([200, 400])("cancels oversized HTTP %s bodies and releases the reader", async (status) => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(64 * 1024 + 1));
			},
			cancel() {
				cancelled = true;
			},
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status })));
		await expect(refreshXaiToken("refresh")).rejects.toThrow("64 KiB");
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
	});

	it("retains a body timeout instead of reclassifying it as invalid JSON", async () => {
		const timeout = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const error = new DOMException("OAuth body timed out", "TimeoutError");
				timeout.abort(error);
				controller.error(error);
			},
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
		await expect(refreshXaiToken("refresh")).rejects.toMatchObject({ name: "TimeoutError" });
		expect(body.locked).toBe(false);
	});

	it("reports malformed JSON with its HTTP status", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", { status: 400 })));
		await expect(refreshXaiToken("refresh")).rejects.toThrow("invalid JSON (HTTP 400)");
	});
});

describe("Grok device login", () => {
	const device = {
		user_code: "Ab9-C",
		device_code: "device",
		verification_uri: "https://example.org/device",
		expires_in: 120,
		interval: 2,
	};
	const callbacks = () => ({
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onPrompt: vi.fn(),
		onSelect: vi.fn(),
	});

	it.each(["bad\n", "\x1b[31m", "A_B", "９"])(
		"rejects malformed user codes before displaying the link",
		async (code) => {
			const host = callbacks();
			const fetchMock = vi.fn().mockResolvedValue(Response.json({ ...device, user_code: code }));
			vi.stubGlobal("fetch", fetchMock);
			await expect(loginXai(host)).rejects.toThrow("user_code");
			expect(host.onDeviceCode).not.toHaveBeenCalled();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);

	it("adds five seconds on each slow_down and retains the delay through pending responses", async () => {
		vi.useFakeTimers();
		const host = callbacks();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(Response.json(device))
			.mockResolvedValueOnce(Response.json({ error: "slow_down", interval: 1 }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ error: "slow_down", interval: 50 }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ error: "authorization_pending" }, { status: 400 }))
			.mockResolvedValueOnce(Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }));
		vi.stubGlobal("fetch", fetchMock);
		const login = loginXai(host);
		await vi.advanceTimersByTimeAsync(0);
		expect(host.onDeviceCode).toHaveBeenCalledWith(expect.objectContaining({ userCode: device.user_code }));
		for (const [index, delay] of [2_000, 7_000, 12_000, 12_000].entries()) {
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(fetchMock).toHaveBeenCalledTimes(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			expect(fetchMock).toHaveBeenCalledTimes(index + 2);
		}
		await expect(login).resolves.toMatchObject({ access: "access" });
	});

	it("sleeps a long interval in timer-sized chunks without an early poll", async () => {
		vi.useFakeTimers();
		const poll = vi.fn(async () => ({ status: "complete" as const, value: "done" }));
		const totalMs = 2_147_484_000;
		const login = pollOAuthDeviceCodeFlow({
			intervalSeconds: totalMs / 1000,
			waitBeforeFirstPoll: true,
			poll,
		});
		await vi.advanceTimersByTimeAsync(totalMs - 1);
		expect(poll).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		await expect(login).resolves.toBe("done");
	});

	it("drops a successful poll if the caller cancelled during the request", async () => {
		const controller = new AbortController();
		const login = pollOAuthDeviceCodeFlow({
			signal: controller.signal,
			poll: async () => {
				controller.abort();
				return { status: "complete", value: "stale" };
			},
		});
		await expect(login).rejects.toThrow("Login cancelled");
	});
});
