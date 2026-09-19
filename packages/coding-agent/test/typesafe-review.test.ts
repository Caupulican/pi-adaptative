import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryArtifactStore } from "../src/core/context/context-artifacts.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import { type ReviewInput, TypeSafeReviewer } from "../src/core/review/typesafe-reviewer.ts";
import { createTypeSafeReviewToolDefinition as createTool } from "../src/core/tools/typesafe-review.ts";

function createTypeSafeReviewToolDefinition(reviewer: TypeSafeReviewer) {
	return createTool(reviewer, new TypeSafeEvidenceStore(createInMemoryArtifactStore()));
}

const input: ReviewInput = {
	state: { source: "fixture.ts", code: "return value;", tests: "one pass", limitations: ["fixture only"] },
	questions: {
		claim: {
			instructions: "Does the source return its input unchanged?",
			criteria: { supports: "Proven", contradicts: "Disproven", insufficient: "Missing evidence" },
			expected: "supports",
		},
	},
};
const response = (confidence = 0.99, choice = "supports") => ({
	model: "jev-1.13.0",
	answers: {
		claim: {
			type: "choice",
			choice,
			confidence,
			probabilities: {
				supports: choice === "supports" ? 1 : 0,
				contradicts: choice === "contradicts" ? 1 : 0,
				insufficient: 0,
			},
		},
	},
	usage: { input_tokens: 100, output_tokens: 10 },
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("TypeSafe review boundary", () => {
	it("keeps arbitrary cancellation reasons out of review records", async () => {
		const tool = createTypeSafeReviewToolDefinition(new TypeSafeReviewer({ getApiKey: async () => "fixture-key" }));
		const result = await tool.execute(
			"cancelled",
			{ action: "review", review: input },
			AbortSignal.abort(new Error("fixture-private-credential")),
		);
		expect(result).toMatchObject({ isError: true, details: { accepted: false } });
		expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
	});
	it.each([true, false])("bounds retry exhaustion with provider retry allowed=%s", async (allowed) => {
		const fetcher = vi.fn(async () =>
			Response.json(
				{ error: "Overloaded" },
				{ status: 529, headers: { "retry-after": "0", "x-should-retry": String(allowed) } },
			),
		);
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review(input)).rejects.toThrow("TypeSafe HTTP 529");
		expect(fetcher).toHaveBeenCalledTimes(allowed ? 3 : 1);
		const bodies = fetcher.mock.calls.map((call) => (call as unknown as [string, RequestInit])[1].body);
		expect(new Set(bodies).size).toBe(1);
	});
	it.each([
		{
			action: "evaluate",
			evaluation: { state: "fixture", questions: { q: { type: "invalid", instructions: "Inspect" } } },
		},
		{ action: "evaluate", evaluation: { state: "fixture", questions: { q: { type: "noul", instructions: 42 } } } },
		{
			action: "review",
			review: {
				...input,
				questions: { claim: { ...input.questions.claim, criteria: { supports: "Only option" } } },
			},
		},
	])("keeps canonical validation mandatory behind the compact model schema: $action", async (data) => {
		const fetcher = vi.fn();
		const tool = createTypeSafeReviewToolDefinition(
			new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
		);
		expect(await tool.execute("invalid", JSON.parse(JSON.stringify(data)))).toMatchObject({
			isError: true,
			details: { accepted: false },
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("distinguishes member names from JSON-looking strings and names in separate objects", async () => {
		const raw = {
			...response(),
			metadata: { first: { repeated: '"choice":"contradicts"{}[]\\"' }, second: { repeated: "control" } },
		};
		const reviewer = new TypeSafeReviewer({
			getApiKey: async () => "fixture-key",
			fetch: async () => Response.json(raw),
		});
		expect(await reviewer.review(input)).toMatchObject({ accepted: true, response: raw });
	});
	it.each(["choice", String.raw`ch\u006fice`])(
		"rejects contradictory duplicate JSON member %s and retains both redacted values",
		async (key) => {
			const body = JSON.stringify(response()).replace(
				'"choice":"supports"',
				`"choice":"contradicts","${key}":"supports"`,
			);
			const fetcher = vi.fn(async () => new Response(body));
			const result = await createTypeSafeReviewToolDefinition(
				new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
			).execute("call", { action: "review", review: input });
			expect(result).toMatchObject({
				isError: true,
				details: { accepted: false, error: expect.stringContaining("duplicate JSON") },
			});
			expect(JSON.stringify(result.details)).toContain("contradicts");
			expect(JSON.stringify(result.details)).toContain("supports");
			expect(fetcher).toHaveBeenCalledOnce();
		},
	);
	it.each([200, 401])(
		"retains the exact submitted evidence in local details on HTTP %s without repeating it in model output",
		async (status) => {
			const fetcher = vi.fn(async () =>
				Response.json(status === 200 ? response(0.94) : { error: "Unauthorized" }, { status }),
			);
			const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
			const tool = createTypeSafeReviewToolDefinition(reviewer);
			const result = await tool.execute("call", {
				action: "review",
				review: { ...input, state: "unique evidence snapshot" },
			});
			const call = fetcher.mock.calls[0] as unknown as [string, RequestInit];
			expect(result.details).toMatchObject({ request: JSON.parse(String(call[1].body)), accepted: false });
			expect(JSON.stringify(result.content)).not.toContain("unique evidence snapshot");
			expect(JSON.stringify(result)).not.toContain("fixture-key");
		},
	);
	it.each([
		{
			question: { type: "choice", instructions: null, criteria: { supports: null, contradicts: null } },
			answer: { type: "choice", choice: "supports", confidence: 1, probabilities: { supports: 1, contradicts: 0 } },
		},
		{
			question: { type: "noul", instructions: null, criteria: { true: { meaning: "Present" }, false: ["Absent"] } },
			answer: { type: "noul", noul: 1 },
		},
		{
			question: { type: "noul", instructions: "Is the condition present?", criteria: { true: null, false: null } },
			answer: { type: "noul", noul: 1 },
		},
		{
			question: { type: "score", instructions: null, criteria: [["Absent"], { meaning: "Direct" }] },
			answer: {
				type: "score",
				score: 1,
				confidence: 1,
				probabilities: { "0": 0, "1": 1 },
				legend: { "0": ["Absent"], "1": { meaning: "Direct" } },
			},
		},
	])("preserves advanced EntryType data in $question.type questions and answers", async ({ question, answer }) => {
		const fetcher = vi.fn(async () => Response.json({ ...response(), answers: { entry: answer } }));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		const data = JSON.parse(
			JSON.stringify({ state: { source: "Present and direct" }, questions: { entry: question } }),
		);
		expect((await reviewer.evaluate(data)).response.answers).toEqual({ entry: answer });
		const options = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(String(options[1].body))).toEqual({ model: "jev-latest", ...data });
	});
	it("does not widen state to null when supporting nullable question entries", async () => {
		const fetcher = vi.fn();
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(
			reviewer.evaluate(JSON.parse('{"state":null,"questions":{"q":{"type":"noul","instructions":"Present?"}}}')),
		).rejects.toThrow("Invalid TypeSafe evaluation input");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("rejects null Score levels as the live API does, preserving non-null structured levels", async () => {
		const fetcher = vi.fn();
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		const data = JSON.parse(
			'{"state":"fixture","questions":{"q":{"type":"score","instructions":"Direct?","criteria":[null,{"meaning":"Direct"}]}}}',
		);
		await expect(reviewer.evaluate(data)).rejects.toThrow("Invalid TypeSafe evaluation input");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("requires every question to pass for both floors and preserves complete adverse answers", async () => {
		for (const floor of ["high", "max"] as const) {
			for (const confidence of [0, 0.94, 0.95, 0.98, 0.99, 1]) {
				for (const choice of ["supports", "contradicts"]) {
					const raw = response(confidence, choice);
					const answers = { control: response().answers.claim, claim: raw.answers.claim };
					const reviewer = new TypeSafeReviewer({
						getApiKey: async () => "fixture-key",
						fetch: async () => Response.json({ ...raw, answers }),
					});
					const result = await reviewer.review({
						...input,
						confidence: floor,
						questions: { control: input.questions.claim, ...input.questions },
					});
					expect(result.accepted).toBe(choice === "supports" && confidence >= (floor === "high" ? 0.95 : 0.99));
					expect(result.failures).toEqual(result.accepted ? [] : ["claim"]);
					expect(result.response.answers).toEqual(answers);
				}
			}
		}
	});
	it("redacts credentials decoded from JSON escapes in provider errors", async () => {
		const fetcher = vi.fn(async () => new Response(String.raw`{"error":"\u0066ixture-key"}`, { status: 401 }));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		const result = await createTypeSafeReviewToolDefinition(reviewer).execute("call", {
			action: "review",
			review: input,
		});
		expect(JSON.stringify(result)).not.toContain("fixture-key");
		expect(result).toMatchObject({ isError: true, details: { response: { error: "[REDACTED]" } } });
	});
	it.each([200, 401])("retains and charges every received retry response before final HTTP %s", async (status) => {
		const overload = { error: "overloaded", usage: { input_tokens: 70, output_tokens: 7 } };
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json(overload, { status: 529, headers: { "retry-after": "0" } }))
			.mockResolvedValueOnce(Response.json(response(), { status }));
		const result = await createTypeSafeReviewToolDefinition(
			new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
		).execute("retry", { action: "review", review: input });
		expect(result).toMatchObject({
			isError: status !== 200,
			details: {
				accepted: status === 200,
				transportAttempts: [
					{ status: 529, response: overload },
					{ status, response: response() },
				],
			},
			usage: { input: 170, output: 17, totalTokens: 187 },
		});
		expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
	});
	it("settles cancellation during backoff without another request", async () => {
		const abort = new AbortController();
		const fetcher = vi.fn(async () =>
			Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "15" } }),
		);
		const pending = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }).review(
			input,
			abort.signal,
		);
		const failed = expect(pending).rejects.toThrow("cancelled");
		await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
		abort.abort();
		await failed;
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("bounds native transport time and clears the deadline after abort", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn<typeof fetch>(
			async (_url, options) =>
				new Promise((_resolve, reject) =>
					options?.signal?.addEventListener("abort", () => reject(new Error("fixture-private-key")), {
						once: true,
					}),
				),
		);
		const pending = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }).review(input);
		const failed = expect(pending).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(50_000);
		await failed;
		expect(fetcher).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("charges provider-reported tokens even when malformed answers fail validation", async () => {
		const reviewer = new TypeSafeReviewer({
			getApiKey: async () => "fixture-key",
			fetch: async () => Response.json({ ...response(), answers: {} }),
		});
		const result = await createTypeSafeReviewToolDefinition(reviewer).execute("call", {
			action: "review",
			review: input,
		});
		expect(result).toMatchObject({
			isError: true,
			usage: { input: 100, output: 10, totalTokens: 110 },
			details: { accepted: false },
		});
	});
	it.each(["evaluate", "review"] as const)(
		"charges successful %s tokens through the tool usage contract",
		async (action) => {
			const reviewer = new TypeSafeReviewer({
				getApiKey: async () => "fixture-key",
				fetch: async () => Response.json(response()),
			});
			const result = await createTypeSafeReviewToolDefinition(reviewer).execute("call", {
				action,
				review: input,
				evaluation: {
					state: input.state,
					questions: {
						claim: {
							type: "choice",
							instructions: input.questions.claim.instructions,
							criteria: input.questions.claim.criteria,
						},
					},
				},
			});
			expect(result).toMatchObject({ usage: { input: 100, output: 10, totalTokens: 110 } });
		},
	);
	it("retains the distinction of negative zero evidence by refusing lossy JSON", async () => {
		const fetcher = vi.fn(async () => Response.json(response()));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review({ ...input, state: { value: -0 } })).rejects.toThrow("JSON");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("supports independent Choice, Noul and Score judgments without claiming approval", async () => {
		const answers = {
			route: { type: "choice", choice: "local", confidence: 0.98, probabilities: { local: 1, remote: 0 } },
			present: { type: "noul", noul: 0.8 },
			rank: {
				type: "score",
				score: 1.8,
				confidence: 0.93,
				probabilities: { "0": 0, "1": 0.2, "2": 0.8 },
				legend: { "0": "irrelevant", "1": "related", "2": "direct" },
			},
		};
		const fetcher = vi.fn(async () => Response.json({ ...response(), answers }));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		const result = await reviewer.evaluate({
			state: { task: "Classify and rank this evidence" },
			questions: {
				route: {
					type: "choice",
					instructions: { question: "Which route fits?" },
					criteria: { local: "Local fact", remote: null },
				},
				present: {
					type: "noul",
					instructions: "Is there a direct source?",
					criteria: { true: "A source is present", false: "Absent" },
				},
				rank: {
					type: "score",
					instructions: "How relevant is the evidence?",
					criteria: ["irrelevant", "related", "direct"],
				},
			},
		});
		expect(result.response.answers).toEqual(answers);
		expect(result).not.toHaveProperty("accepted");
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it.each(["status", "review"] as const)("does not expose credential resolver failures through %s", async (action) => {
		const reviewer = new TypeSafeReviewer({
			getApiKey: async () => {
				throw new Error("fixture-private-credential");
			},
		});
		const result = await createTypeSafeReviewToolDefinition(reviewer).execute("call", { action, review: input });
		expect(result).toMatchObject({ isError: true, details: { accepted: false } });
		expect(JSON.stringify(result)).not.toContain("fixture-private-credential");
	});
	it.each([NaN, Infinity, undefined, () => "omitted"])(
		"refuses evidence that JSON would silently change: %s",
		async (value) => {
			const fetcher = vi.fn(async () => Response.json(response()));
			const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
			await expect(reviewer.review({ ...input, state: { evidence: value } })).rejects.toThrow("JSON");
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("captures expectations and evidence before deferred credentials resolve", async () => {
		let resolveKey!: (key: string) => void;
		const reviewer = new TypeSafeReviewer({
			getApiKey: () =>
				new Promise((resolve) => {
					resolveKey = resolve;
				}),
			fetch: async () => Response.json(response()),
		});
		const mutable = structuredClone(input);
		const pending = reviewer.review(mutable);
		mutable.questions.claim.expected = "contradicts";
		mutable.state = "changed";
		resolveKey("fixture-key");
		expect(await pending).toMatchObject({ accepted: true, expected: { claim: "supports" } });
	});
	it("does not retry authentication errors and retains a redacted provider error", async () => {
		const fetcher = vi.fn(async () => Response.json({ error: "fixture-key" }, { status: 401 }));
		const tool = createTypeSafeReviewToolDefinition(
			new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher }),
		);
		const result = await tool.execute("call", { action: "review", review: input });
		expect(result).toMatchObject({ isError: true, details: { accepted: false, response: { error: "[REDACTED]" } } });
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("does not shorten provider retry delays to fit its deadline", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": "120" } }),
		);
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review(input)).rejects.toThrow("Server requested 120s");
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("refuses an oversized response without accepting a partial answer", async () => {
		const cancel = vi.fn();
		const fetcher = vi.fn(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(256 * 1024 + 1));
						},
						cancel,
					}),
				),
		);
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review(input)).rejects.toThrow("exceeds 256 KiB");
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("reports missing setup without sending a request or exposing a key", async () => {
		const fetcher = vi.fn();
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => undefined, fetch: fetcher });
		expect(await reviewer.status()).toMatchObject({ enabled: false, authenticationVerified: false });
		await expect(reviewer.review(input)).rejects.toThrow("/login typesafe");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("verifies authentication upon status connection and caches verification for subsequent calls", async () => {
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes("/models")) return Response.json({ models: [] });
			return Response.json(response());
		});
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		expect(await reviewer.status()).toMatchObject({ enabled: true, authenticationVerified: true });
		expect(fetcher).toHaveBeenCalledWith("https://api.typesafe.ai/v1/models", expect.any(Object));

		// Second call uses cached verification without re-requesting models
		fetcher.mockClear();
		expect(await reviewer.status()).toMatchObject({ enabled: true, authenticationVerified: true });
		expect(fetcher).not.toHaveBeenCalled();

		await reviewer.review(input);
		expect(await reviewer.status()).toMatchObject({ enabled: true, authenticationVerified: true });
	});
	it("reports authentication failure when status connection receives 401", async () => {
		const fetcher = vi.fn(async () => new Response("Unauthorized", { status: 401 }));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "invalid-key", fetch: fetcher });
		expect(await reviewer.status()).toMatchObject({
			enabled: true,
			authenticationVerified: false,
			message: expect.stringContaining("authentication failed"),
		});
		expect(fetcher).toHaveBeenCalledWith("https://api.typesafe.ai/v1/models", expect.any(Object));
	});
	it("sends complete state once to the fixed endpoint and retains the raw judgment", async () => {
		const fetcher = vi.fn(async () => Response.json(response()));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		const result = await reviewer.review(input);
		expect(result).toMatchObject({ accepted: true, threshold: 0.95, response: response() });
		const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.typesafe.ai/v1/systemone");
		expect(options.redirect).toBe("error");
		expect(JSON.parse(String(options.body))).toEqual({
			model: "jev-latest",
			state: input.state,
			questions: {
				claim: {
					type: "choice",
					instructions: input.questions.claim.instructions,
					criteria: input.questions.claim.criteria,
				},
			},
		});
		expect(JSON.stringify(result)).not.toContain("fixture-key");
	});
	it.each([
		[0.94, "supports", false],
		[0.95, "supports", true],
		[1, "contradicts", false],
	] as const)("gates confidence %s and verdict %s without rerolling", async (confidence, choice, accepted) => {
		const fetcher = vi.fn(async () => Response.json(response(confidence, choice)));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		expect((await reviewer.review(input)).accepted).toBe(accepted);
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("max confidence is distinct from high", async () => {
		const reviewer = new TypeSafeReviewer({
			getApiKey: async () => "fixture-key",
			fetch: async () => Response.json(response(0.98)),
		});
		expect(await reviewer.review({ ...input, confidence: "max" })).toMatchObject({
			accepted: false,
			threshold: 0.99,
		});
	});
	it.each([
		{},
		{
			claim: {
				type: "choice",
				choice: "supports",
				confidence: 1,
				probabilities: { supports: 0, contradicts: 1, insufficient: 0 },
			},
		},
		{ claim: { type: "noul", noul: 1 } },
	])("rejects incomplete, contradictory or wrong-type answers", async (answers) => {
		const fetcher = vi.fn(async () => Response.json({ ...response(), answers }));
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review(input)).rejects.toThrow("Invalid TypeSafe response");
		expect(fetcher).toHaveBeenCalledOnce();
	});
	it("rejects secret-bearing state before transport", async () => {
		const fetcher = vi.fn();
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review({ ...input, state: "fixture-key" })).rejects.toThrow("credential");
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("does not send when already cancelled", async () => {
		const fetcher = vi.fn();
		const reviewer = new TypeSafeReviewer({ getApiKey: async () => "fixture-key", fetch: fetcher });
		await expect(reviewer.review(input, AbortSignal.abort())).rejects.toThrow();
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("supports openrouter provider for reviews and status verification", async () => {
		const fetcher = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes("/models")) return Response.json({ data: [] });
			return Response.json(response(0.99, "supports"));
		});
		const reviewer = new TypeSafeReviewer({
			provider: "openrouter",
			getApiKey: async () => "openrouter-key",
			fetch: fetcher,
		});

		const status = await reviewer.status();
		expect(status).toMatchObject({ enabled: true, authenticationVerified: true });
		expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/v1/models", expect.any(Object));

		fetcher.mockClear();
		const result = await reviewer.review(input);
		expect(result).toMatchObject({ accepted: true, threshold: 0.95 });

		const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(JSON.parse(String(options.body))).toMatchObject({
			model: "typesafe/jev-latest",
			state: input.state,
		});
	});
	it("reports openrouter key configuration error when unauthenticated", async () => {
		const reviewer = new TypeSafeReviewer({
			provider: "openrouter",
			getApiKey: async () => undefined,
		});
		const status = await reviewer.status();
		expect(status.enabled).toBe(false);
		expect(status.message).toContain("/login openrouter");
		await expect(reviewer.review(input)).rejects.toThrow("/login openrouter");
	});
});
