import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshXaiToken } from "../src/utils/oauth/xai.ts";

afterEach(() => {
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
