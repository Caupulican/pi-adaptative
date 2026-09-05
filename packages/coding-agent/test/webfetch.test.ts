import TurndownService from "turndown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { createWebFetchTool } from "../src/core/tools/webfetch.ts";
import { PublicWebClient, type PublicWebOperations } from "../src/core/web/public-web-client.ts";

function fixture(responses: Response[]) {
	const close = vi.fn(async () => {});
	const request: PublicWebOperations["request"] = vi.fn(async () => {
		const response = responses.shift();
		if (!response) throw new Error("Unexpected request");
		return { response, close };
	});
	const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
	const client = new PublicWebClient({ lookup, request });
	const tool = createWebFetchTool(process.cwd(), { client });
	return { client, tool, close, request, lookup };
}

async function expectHtmlComplexityRejection(content: string, url = "https://example.com") {
	const f = fixture([new Response(content, { headers: { "content-type": "text/html" } })]);
	// Stop at the expensive conversion boundary: a missing guard must fail without allocating
	// the very amplified DOM/output this test is intended to prevent.
	const conversion = vi.spyOn(TurndownService.prototype, "turndown").mockReturnValue("unreachable conversion");
	try {
		await expect(f.tool.execute("call", { url })).rejects.toThrow(/complexity/i);
		expect(conversion).not.toHaveBeenCalled();
	} finally {
		conversion.mockRestore();
	}
}

afterEach(() => vi.useRealTimers());

describe("WebFetch bounded public HTTP", () => {
	it("uses browser identification, then retries one explicit Cloudflare challenge with Pi identification", async () => {
		const f = fixture([
			new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
			new Response("accepted"),
		]);
		await expect(f.client.get("https://example.com", "text/plain")).resolves.toMatchObject({ text: "accepted" });
		expect(vi.mocked(f.request).mock.calls[0][0].headers["User-Agent"]).toContain("Mozilla/5.0");
		expect(vi.mocked(f.request).mock.calls[1][0].headers["User-Agent"]).toBe("Pi-Adaptative-WebFetch");
		expect(f.lookup).toHaveBeenCalledTimes(2);
		expect(f.close).toHaveBeenCalledTimes(2);
	});
	it.each([undefined, "managed_challenge"])(
		"does not retry an ordinary 403 with mitigation %s",
		async (mitigation) => {
			const f = fixture([
				new Response("denied", { status: 403, headers: mitigation ? { "cf-mitigated": mitigation } : {} }),
			]);
			await expect(f.client.get("https://example.com", "text/plain")).rejects.toThrow(/403/);
			expect(f.request).toHaveBeenCalledOnce();
		},
	);
	it("does not loop on repeated challenges", async () => {
		const f = fixture(
			Array.from(
				{ length: 2 },
				() => new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
			),
		);
		await expect(f.client.get("https://example.com", "text/plain")).rejects.toThrow(/403/);
		expect(f.request).toHaveBeenCalledTimes(2);
	});
	it("does not retry a challenge header without HTTP 403", async () => {
		const f = fixture([new Response("unavailable", { status: 503, headers: { "cf-mitigated": "challenge" } })]);
		await expect(f.client.get("https://example.com", "text/plain")).rejects.toThrow(/503/);
		expect(f.request).toHaveBeenCalledOnce();
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("rejects DNS rebinding between a challenge and its retry before the second connection", async () => {
		const f = fixture([new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } })]);
		f.lookup
			.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
			.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
		await expect(f.client.get("https://example.com", "text/plain")).rejects.toThrow(/public/i);
		expect(f.lookup).toHaveBeenCalledTimes(2);
		expect(f.request).toHaveBeenCalledOnce();
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("the retry shares the original deadline and Effect awaits resource release", async () => {
		vi.useFakeTimers();
		const f = fixture([
			new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge" } }),
			new Response(new ReadableStream()),
		]);
		const original = f.request;
		let first = true;
		const request: PublicWebOperations["request"] = async (input) => {
			if (first) {
				first = false;
				await new Promise((resolve) => setTimeout(resolve, 600));
			}
			return original(input);
		};
		const client = new PublicWebClient({ lookup: f.lookup, request });
		const pending = expect(client.get("https://example.com", "text/plain", 1)).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		expect(f.request).toHaveBeenCalledTimes(2);
		expect(f.close).toHaveBeenCalledTimes(2);
	});
	it.each([
		"file:///etc/passwd",
		"https://user:secret@example.com",
		"http://127.1",
		"http://0x7f000001",
		"http://[::ffff:127.0.0.1]",
		"http://169.254.169.254",
		"http://[fc00::1]",
	])("rejects %s before network I/O", async (url) => {
		const f = fixture([]);
		await expect(f.tool.execute("call", { url })).rejects.toThrow();
		expect(f.request).not.toHaveBeenCalled();
	});
	it("rejects mixed public/private DNS and validates redirects before connecting", async () => {
		const mixed = fixture([]);
		mixed.lookup.mockResolvedValue([
			{ address: "93.184.216.34", family: 4 },
			{ address: "10.0.0.1", family: 4 },
		]);
		await expect(mixed.tool.execute("call", { url: "https://example.com" })).rejects.toThrow(/public/i);
		expect(mixed.request).not.toHaveBeenCalled();
		const redirected = fixture([
			new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
		]);
		await expect(redirected.tool.execute("call", { url: "http://example.com" })).rejects.toThrow(/public/i);
		expect(redirected.request).toHaveBeenCalledTimes(1);
		expect(redirected.close).toHaveBeenCalledTimes(1);
	});
	it("pins the validated address and returns the final URL without automatic redirects", async () => {
		const f = fixture([new Response(null, { status: 302, headers: { location: "/final" } }), new Response("ok")]);
		const result = await f.tool.execute("call", { url: "https://example.com/start" });
		expect(f.request).toHaveBeenLastCalledWith(
			expect.objectContaining({
				url: new URL("https://example.com/final"),
				address: { address: "93.184.216.34", family: 4 },
			}),
		);
		expect(result.details).toMatchObject({ url: "https://example.com/final", bytes: 2 });
		expect(f.close).toHaveBeenCalledTimes(2);
	});
	it.each(["http://example.com/next", "https://example.com/start"])(
		"rejects downgrades and redirect loops: %s",
		async (location) => {
			const f = fixture([new Response(null, { status: 302, headers: { location } })]);
			await expect(f.tool.execute("call", { url: "https://example.com/start" })).rejects.toThrow(
				/redirect|downgrade/i,
			);
			expect(f.request).toHaveBeenCalledTimes(1);
		},
	);
	it("cancels an oversized chunked body even without Content-Length", async () => {
		const cancel = vi.fn();
		const f = fixture([
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array(5 * 1024 * 1024 + 1));
					},
					cancel,
				}),
			),
		]);
		await expect(f.tool.execute("call", { url: "https://example.com" })).rejects.toThrow(/large/i);
		expect(cancel).toHaveBeenCalledOnce();
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("applies one timeout to stalled response bodies and releases the transport", async () => {
		vi.useFakeTimers();
		const cancel = vi.fn();
		const f = fixture([new Response(new ReadableStream({ cancel }))]);
		const pending = expect(f.tool.execute("call", { url: "https://example.com", timeout: 1 })).rejects.toThrow(
			/timed out/i,
		);
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		expect(cancel).toHaveBeenCalledOnce();
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("does not begin I/O after cancellation", async () => {
		const f = fixture([]);
		await expect(f.tool.execute("call", { url: "https://example.com" }, AbortSignal.abort())).rejects.toThrow();
		expect(f.lookup).not.toHaveBeenCalled();
		expect(f.request).not.toHaveBeenCalled();
	});
	it("waits for transport release when parent cancellation races response headers", async () => {
		const controller = new AbortController();
		const released = Promise.withResolvers<void>();
		const closing = Promise.withResolvers<void>();
		let settled = false;
		const f = fixture([]);
		f.close.mockImplementation(async () => {
			closing.resolve();
			await released.promise;
		});
		vi.mocked(f.request).mockImplementation(async () => {
			controller.abort();
			return { response: new Response("raced response"), close: f.close };
		});
		const pending = expect(
			f.client.get("https://example.com", "text/plain", 1, controller.signal).finally(() => {
				settled = true;
			}),
		).rejects.toThrow();
		await closing.promise;
		expect(settled).toBe(false);
		released.resolve();
		await pending;
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("retains body-read failures and releases the transport", async () => {
		const f = fixture([
			new Response(
				new ReadableStream({
					start(controller) {
						controller.error(new Error("injected body failure"));
					},
				}),
			),
		]);
		await expect(f.client.get("https://example.com", "text/plain")).rejects.toThrow("injected body failure");
		expect(f.close).toHaveBeenCalledOnce();
	});
	it("preserves an HTTP failure when transport cleanup also fails", async () => {
		const failed = fixture([new Response("denied", { status: 404 })]);
		failed.close.mockRejectedValue(new Error("cleanup failed"));
		await expect(failed.client.get("https://example.com", "text/plain")).rejects.toThrow("HTTP 404");
		const successful = fixture([new Response("ok")]);
		successful.close.mockRejectedValue(new Error("cleanup failed"));
		await expect(successful.client.get("https://example.com", "text/plain")).rejects.toThrow("cleanup failed");
	});
	it("detaches from stalled DNS at the deadline and never connects on late resolution", async () => {
		vi.useFakeTimers();
		const f = fixture([]);
		let finish!: (addresses: { address: string; family: number }[]) => void;
		f.lookup.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const pending = expect(f.tool.execute("call", { url: "https://example.com", timeout: 1 })).rejects.toThrow(
			/timed out/i,
		);
		await vi.advanceTimersByTimeAsync(1000);
		await pending;
		finish([{ address: "93.184.216.34", family: 4 }]);
		await vi.advanceTimersByTimeAsync(0);
		expect(f.request).not.toHaveBeenCalled();
	});
	it("bounds redirect chains and discards cookies between origins", async () => {
		const f = fixture(
			Array.from(
				{ length: 6 },
				(_, index) =>
					new Response(null, {
						status: 302,
						headers: { location: `https://host${index}.example/`, "set-cookie": "credential=secret" },
					}),
			),
		);
		await expect(f.tool.execute("call", { url: "https://example.com" })).rejects.toThrow(/redirect/i);
		expect(f.request).toHaveBeenCalledTimes(6);
		for (const [request] of vi.mocked(f.request).mock.calls) expect(request.headers).not.toHaveProperty("Cookie");
	});
	it("rejects declared oversize before reading and accepts the exact streamed byte ceiling", async () => {
		const cancel = vi.fn();
		const oversized = fixture([
			new Response(new ReadableStream({ cancel }), { headers: { "content-length": String(5 * 1024 * 1024 + 1) } }),
		]);
		await expect(oversized.tool.execute("call", { url: "https://example.com" })).rejects.toThrow(/large/i);
		expect(cancel).toHaveBeenCalledOnce();
		const exact = fixture([new Response("x".repeat(5 * 1024 * 1024))]);
		const result = await exact.tool.execute("call", { url: "https://example.com" });
		expect(result.details).toMatchObject({ bytes: 5 * 1024 * 1024, truncated: true });
		expect(JSON.stringify(result).length).toBeLessThan(55_000);
	});
	it.each(["http://[4000::1]", "http://[::2]"])("rejects non-global IPv6 space %s", async (url) => {
		const f = fixture([new Response("unexpected")]);
		await expect(f.tool.execute("call", { url })).rejects.toThrow(/public/i);
		expect(f.request).not.toHaveBeenCalled();
	});
	it.each([0, -1, 121, Number.NaN])("rejects invalid timeout %s without a request", async (timeout) => {
		const f = fixture([]);
		await expect(f.tool.execute("call", { url: "https://example.com", timeout })).rejects.toThrow(/timeout/i);
		expect(f.request).not.toHaveBeenCalled();
	});
	it("preserves HTTP failure identity and rejects binary content", async () => {
		for (const response of [
			new Response("no", { status: 404 }),
			new Response("binary", { headers: { "content-type": "application/octet-stream" } }),
		]) {
			const f = fixture([response]);
			await expect(f.tool.execute("call", { url: "https://example.com" })).rejects.toThrow(/404|content type/i);
			expect(f.close).toHaveBeenCalledOnce();
		}
	});
});

describe("WebFetch content and artifact boundary", () => {
	const html =
		'<h1>Title</h1><p>First &amp; second</p><p><a href="/docs">Guide</a></p><script>steal()</script><style>hidden</style><noscript>fallback</noscript>';
	it.each(["markdown", "text", "html"] as const)("converts %s without fetching page subresources", async (format) => {
		const f = fixture([new Response(html, { headers: { "content-type": "TEXT/HTML; charset=utf-8" } })]);
		const result = await f.tool.execute("call", { url: "https://example.com", format });
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		if (format === "html") expect(text).toContain(html);
		else {
			expect(text).toContain("First & second");
			expect(text).not.toMatch(/steal|hidden|fallback/);
			if (format === "markdown") expect(text).toContain("[Guide](https://example.com/docs)");
			else expect(text).toContain("Title\nFirst & second\nGuide");
		}
		expect(f.request).toHaveBeenCalledOnce();
	});
	it("packs large results through the shared artifact owner, never duplicates the body in details", async () => {
		const content = "saved web evidence\n".repeat(5000);
		const store = createInMemoryArtifactStore();
		const f = fixture([new Response(content)]);
		const tool = createWebFetchTool(process.cwd(), { client: f.client, artifactStore: store });
		const result = await tool.execute("web-call", { url: "https://example.com" });
		expect(result.details?.artifactId).toBeTruthy();
		expect(JSON.stringify(result.details).length).toBeLessThan(1000);
		expect(store.read(result.details!.artifactId!)).toMatchObject({
			content,
			ref: { toolName: "webfetch", reproducible: false },
		});
		expect(store.cleanup()).toEqual([]);
	});
	it("rejects excessive HTML depth before recursive conversion", async () => {
		const f = fixture([
			new Response(`${"<div>".repeat(129)}body${"</div>".repeat(129)}`, {
				headers: { "content-type": "text/html" },
			}),
		]);
		await expect(f.tool.execute("call", { url: "https://example.com" })).rejects.toThrow(/complexity/i);
	});
	it.each(["<!-- hidden -->".repeat(50_001), "<span>x</span>".repeat(25_001)])(
		"counts non-element nodes in the HTML complexity budget (%#)",
		async (content) => {
			const control = fixture([
				new Response("<!-- hidden --><span>visible</span>".repeat(100), {
					headers: { "content-type": "text/html" },
				}),
			]);
			await expect(control.tool.execute("control", { url: "https://example.com" })).resolves.toMatchObject({
				details: { truncated: false },
			});
			await expectHtmlComplexityRejection(content);
		},
	);
	it.each([200, 3000])("bounds %i expanded relative links before allocating the converted document", async (count) => {
		const content = '<a href="page">guide</a>'.repeat(count);
		const response = () => new Response(content, { headers: { "content-type": "text/html" } });
		const shortBase = fixture([response()]);
		await expect(shortBase.tool.execute("control", { url: "https://example.com/index" })).resolves.toMatchObject({
			details: { truncated: count === 3000 },
		});
		await expectHtmlComplexityRejection(content, `https://example.com/${"x".repeat(8000)}/index`);
	});
	it("bounds repeated ancestor text traversal, with shallow content as a control", async () => {
		const body = "x".repeat(512 * 1024);
		const shallow = fixture([new Response(`<div>${body}</div>`, { headers: { "content-type": "text/html" } })]);
		await expect(shallow.tool.execute("control", { url: "https://example.com" })).resolves.toMatchObject({
			details: { truncated: true },
		});
		await expectHtmlComplexityRejection(`${"<div>".repeat(64)}${body}${"</div>".repeat(64)}`);
	});
	it("decodes split UTF-8 chunks and declared legacy charset without losing text", async () => {
		const bytes = new TextEncoder().encode("café");
		const f = fixture([
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.subarray(0, 4));
						controller.enqueue(bytes.subarray(4));
						controller.close();
					},
				}),
			),
		]);
		expect(await f.client.get("https://example.com", "text/plain")).toMatchObject({ text: "café" });
		const legacy = fixture([
			new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), {
				headers: { "content-type": "text/plain; charset=iso-8859-1" },
			}),
		]);
		expect(await legacy.client.get("https://example.com", "text/plain")).toMatchObject({ text: "café" });
	});
});
