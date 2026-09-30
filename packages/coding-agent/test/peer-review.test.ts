import type { ThinkingLevel } from "@caupulican/pi-agent-core";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { IsolatedCompletionOptions, IsolatedCompletionResult } from "../src/core/agent-session-contracts.ts";
import { DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/default-tool-surface.ts";
import { PeerReviewController, type PeerReviewRequest } from "../src/core/expert-routing/peer-review.ts";
import {
	MAX_ROUTE_CHOICE_REQUEST_CHARACTERS,
	type RouteChoiceJudge,
} from "../src/core/expert-routing/system-one-choice.ts";
import { envelopeHasToolCapability } from "../src/core/tool-capability-policy.ts";
import { createPeerReviewToolDefinition } from "../src/core/tools/peer-review.ts";
import { WORKER_FORBIDDEN_TOOLS } from "../src/core/worker-tool-ceiling.ts";

const lead: Model<Api> = {
	id: "lead",
	name: "Lead",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 8000,
};
const peer: Model<Api> = { ...lead, id: "peer", name: "Peer", thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
const usage: Usage = {
	input: 20,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
};
const request: PeerReviewRequest = {
	peer: "test/peer",
	thinkingLevel: "high",
	stage: "plan",
	objective: "Fix cancellation lifecycle",
	artifact: "Release on cancellation.",
	evidence: "src/owner.ts: release held resource.",
};
const strongerRequest: PeerReviewRequest = { ...request, selection: "stronger" };
const noFindings = {
	verdict: "no_findings",
	summary: "No candidate in provided snapshot.",
	findings: [],
	limitations: ["No execution evidence."],
};

function fixture() {
	const state = {
		lead: { model: lead, thinkingLevel: "medium" as ThinkingLevel },
		pool: [lead, peer],
		auth: true,
		exhausted: false,
	};
	const calls: IsolatedCompletionOptions[] = [];
	let answer: Record<string, unknown> = { route_choice: { type: "choice", choice: "stronger", confidence: 0.97 } };
	let onJudge: (() => void) | undefined;
	let onRun: (() => void) | undefined;
	let completion: IsolatedCompletionResult = { text: JSON.stringify(noFindings), usage, stopReason: "stop" };
	const judge: RouteChoiceJudge = {
		evaluateRouteChoice: async () => {
			onJudge?.();
			return answer;
		},
	};
	const deps = {
		getLead: () => state.lead,
		getModels: () => state.pool,
		hasAuth: () => state.auth,
		isExhausted: () => state.exhausted,
		getJudge: () => judge,
		requestVerification: () => {},
		captureVerificationFence: () => () => {},
		runCompletion: async (options: IsolatedCompletionOptions) => {
			calls.push(options);
			onRun?.();
			return completion;
		},
	};
	return {
		state,
		calls,
		deps,
		controller: new PeerReviewController(deps),
		setAnswer: (value: Record<string, unknown>) => {
			answer = value;
		},
		setCompletion: (value: IsolatedCompletionResult) => {
			completion = value;
		},
		onJudge: (fn: () => void) => {
			onJudge = fn;
		},
		onRun: (fn: () => void) => {
			onRun = fn;
		},
	};
}

describe("explicit stronger peer review", () => {
	it("publishes only the peer tool name and Peer review label", () => {
		const tool = createPeerReviewToolDefinition(fixture().controller);
		expect(tool.name).toBe("peer");
		expect(tool.label).toBe("Peer review");
		expect(`${tool.promptSnippet}\n${tool.promptGuidelines?.join("\n")}`).not.toMatch(/advisor/i);
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("peer");
		expect(DEFAULT_ACTIVE_TOOL_NAMES).not.toContain("advisor");
	});
	it("requires only delegation for independent review, and adds judgment for stronger review or resolution", () => {
		expect(DEFAULT_ACTIVE_TOOL_NAMES).toContain("peer");
		expect(WORKER_FORBIDDEN_TOOLS.has("peer")).toBe(true);
		expect(envelopeHasToolCapability(["semantic.judge"], "peer", { action: "options" })).toBe(false);
		expect(envelopeHasToolCapability(["workflow.delegate"], "peer", { action: "options" })).toBe(true);
		expect(
			envelopeHasToolCapability(["workflow.delegate"], "peer", {
				action: "review",
				review: { ...request },
			}),
		).toBe(true);
		expect(
			envelopeHasToolCapability(["workflow.delegate"], "peer", {
				action: "review",
				review: { ...request, selection: "stronger" },
			}),
		).toBe(false);
		expect(
			envelopeHasToolCapability(["workflow.delegate", "semantic.judge"], "peer", {
				action: "review",
				review: { ...request, selection: "stronger" },
			}),
		).toBe(true);
		expect(envelopeHasToolCapability(["workflow.delegate"], "peer", { action: "obligations" })).toBe(true);
		expect(envelopeHasToolCapability(["workflow.delegate"], "peer", { action: "resolve" })).toBe(false);
		expect(envelopeHasToolCapability(["workflow.delegate", "semantic.judge"], "peer", { action: "resolve" })).toBe(
			true,
		);
	});
	it("discloses authenticated peers and both supported effort sets without asserting strength", () => {
		const f = fixture();
		expect(f.controller.options()).toMatchObject({
			status: "options",
			strength: "optional_stronger_selection",
			peers: [
				{
					ref: "test/peer",
					thinkingLevels: expect.arrayContaining(["medium", "high", "xhigh", "max"]),
					strongerThinkingLevels: ["high", "xhigh", "max"],
				},
			],
		});
		f.state.auth = false;
		expect(f.controller.options().peers).toEqual([]);
	});

	it("discloses every supported independent effort and the stronger subset from the same peer entry", () => {
		const f = fixture();
		f.state.lead.thinkingLevel = "max";
		expect(f.controller.options()).toMatchObject({
			lead: { thinkingLevel: "max" },
			peers: [
				{
					ref: "test/peer",
					thinkingLevels: expect.arrayContaining(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
					strongerThinkingLevels: [],
				},
			],
		});
	});

	it("allows independent review by a distinct authenticated nonreasoning peer at its supported off effort", async () => {
		const f = fixture();
		const nonreasoningPeer: Model<Api> = { ...peer, id: "nonreasoning", reasoning: false };
		f.state.pool = [lead, nonreasoningPeer];

		expect(f.controller.options().peers).toEqual([
			{ ref: "test/nonreasoning", thinkingLevels: ["off"], strongerThinkingLevels: [] },
		]);
		expect(await f.controller.review({ ...request, peer: "test/nonreasoning", thinkingLevel: "off" })).toMatchObject({
			status: "reviewed",
			selection: "independent",
		});
		expect(f.calls[0]).toMatchObject({ model: nonreasoningPeer, thinkingLevel: "off", tools: [] });
	});

	it("defaults to independent review at equal maximum effort without consulting an unavailable strength judge", async () => {
		const f = fixture();
		f.state.lead.thinkingLevel = "max";
		const independent = new PeerReviewController({ ...f.deps, getJudge: () => undefined });

		const result = await independent.review({ ...request, thinkingLevel: "max" });

		expect(result).toMatchObject({
			status: "reviewed",
			selection: "independent",
			lead: { ref: "test/lead", thinkingLevel: "max" },
			peer: { ref: "test/peer", thinkingLevel: "max" },
			review: noFindings,
			usage,
		});
		expect(result).not.toHaveProperty("strength");
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]).toMatchObject({ model: peer, thinkingLevel: "max", tools: [] });
		expect((await independent.review({ ...strongerRequest, thinkingLevel: "max" })).status).toBe("unavailable");
		expect(f.calls).toHaveLength(1);
	});

	it("pins distinct peer and higher effort in a tool-free call; review never certifies completion", async () => {
		const f = fixture();
		const result = await f.controller.review(strongerRequest);
		expect(result).toMatchObject({
			status: "reviewed",
			validation: "peer_review_only",
			leadMustResolve: true,
			selection: "stronger",
			strength: { source: "system_one_task_judgment", confidence: 0.97 },
			review: noFindings,
			usage,
		});
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]).toMatchObject({
			model: peer,
			thinkingLevel: "high",
			tools: [],
			cacheRetention: "none",
			laneKind: "peer-review",
		});
		expect(f.calls[0]?.history).toBeUndefined();
		expect(result).not.toHaveProperty("accepted");
	});

	it("keeps maximum accepted task input inside the host judgment bound and sends full evidence to the peer", async () => {
		const f = fixture();
		let judged = "";
		const controller = new PeerReviewController({ ...f.deps, getJudge: () => judge });
		const judge: RouteChoiceJudge = {
			evaluateRouteChoice: async ({ request: task }) => {
				judged = task;
				return { route_choice: { type: "choice", choice: "stronger", confidence: 0.99 } };
			},
		};
		const maximal = {
			...strongerRequest,
			objective: "o".repeat(2000),
			artifact: "a".repeat(24_000),
			evidence: "e".repeat(48_000),
		};
		expect((await controller.review(maximal)).status).toBe("reviewed");
		expect(judged.length).toBeLessThanOrEqual(MAX_ROUTE_CHOICE_REQUEST_CHARACTERS);
		expect(judged).toContain(maximal.objective);
		const sent = f.calls[0]?.messages[0]?.content;
		expect(JSON.stringify(sent)).toContain(maximal.artifact);
		expect(JSON.stringify(sent)).toContain(maximal.evidence);
	});

	it("rejects the same underlying model id behind another provider before strength judgment", async () => {
		const f = fixture();
		f.state.pool = [{ ...peer, id: lead.id, provider: "other" }];
		expect(f.controller.options().peers).toEqual([]);
		expect((await f.controller.review({ ...strongerRequest, peer: `other/${lead.id}` })).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
	});

	it("refuses oversized objective or model facts rather than silently cutting judgment evidence", async () => {
		const f = fixture();
		expect((await f.controller.review({ ...strongerRequest, objective: "o".repeat(2001) })).status).toBe(
			"unavailable",
		);
		f.state.pool = [{ ...peer, name: "p".repeat(MAX_ROUTE_CHOICE_REQUEST_CHARACTERS) }];
		expect(await f.controller.review(strongerRequest)).toMatchObject({
			status: "unavailable",
			reason: expect.stringContaining("host judgment limit"),
		});
		expect(f.calls).toHaveLength(0);
	});

	it.each([
		{ ...strongerRequest, peer: "test/lead" },
		{ ...strongerRequest, peer: "other/peer" },
		{ ...strongerRequest, thinkingLevel: "medium" as const },
		{ ...strongerRequest, thinkingLevel: "ultra" as const },
	])("refuses same, outside-pool, equal or unsupported peers before paid review: %j", async (input) => {
		const f = fixture();
		expect((await f.controller.review(input)).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
	});

	it.each([0.949, 1.01, Number.NaN, "0.99"])(
		"rejects invalid or insufficient strength confidence %s",
		async (confidence) => {
			const f = fixture();
			f.setAnswer({ route_choice: { type: "choice", choice: "stronger", confidence } });
			expect((await f.controller.review(strongerRequest)).status).toBe("unavailable");
			expect(f.calls).toHaveLength(0);
		},
	);

	it.each(["not_stronger", "unknown"])("rejects System One's %s without rerolling", async (choice) => {
		const f = fixture();
		f.setAnswer({ route_choice: { type: "choice", choice, confidence: 0.99 } });
		expect((await f.controller.review(strongerRequest)).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
	});

	it("keeps missing judge and evaluator outage diagnostic, never successful", async () => {
		const f = fixture();
		const absent = new PeerReviewController({ ...f.deps, getJudge: () => undefined });
		expect((await absent.review(strongerRequest)).status).toBe("unavailable");
		const offline = new PeerReviewController({
			...f.deps,
			getJudge: () => ({
				evaluateRouteChoice: async () => {
					throw new Error("service offline");
				},
			}),
		});
		expect(await offline.review(strongerRequest)).toMatchObject({ status: "unavailable", reason: "service offline" });
		expect(f.calls).toHaveLength(0);
	});

	it.each(["auth", "quota", "pool", "lead"])("rechecks %s after asynchronous judgment", async (change) => {
		const f = fixture();
		f.onJudge(() => {
			if (change === "auth") f.state.auth = false;
			if (change === "quota") f.state.exhausted = true;
			if (change === "pool") f.state.pool = [lead];
			if (change === "lead") f.state.lead = { ...f.state.lead, model: peer };
		});
		expect((await f.controller.review(strongerRequest)).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
	});

	it("refuses a removed judge after selection and at the provider boundary", async () => {
		const f = fixture();
		let judge: RouteChoiceJudge | undefined = f.deps.getJudge();
		const controller = new PeerReviewController({ ...f.deps, getJudge: () => judge });
		f.onJudge(() => {
			judge = undefined;
		});
		expect((await controller.review(strongerRequest)).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
	});

	it("rechecks admission immediately before transport after provider preparation", async () => {
		const f = fixture();
		let transported = false;
		const controller = new PeerReviewController({
			...f.deps,
			runCompletion: async (options) => {
				f.state.auth = false;
				await options.requestPreflight?.({
					model: peer,
					context: { systemPrompt: options.systemPrompt, messages: options.messages },
				});
				transported = true;
				return { text: JSON.stringify(noFindings), usage, stopReason: "stop" };
			},
		});
		expect((await controller.review(request)).status).toBe("unavailable");
		expect(transported).toBe(false);
	});

	it.each(["length", "error", "aborted", "toolUse"] as const)(
		"rejects incomplete %s responses while retaining reported spend",
		async (stopReason) => {
			const f = fixture();
			f.setCompletion({
				text: JSON.stringify(noFindings),
				usage,
				stopReason,
				errorMessage: stopReason === "error" ? "provider offline" : undefined,
			});
			expect(await f.controller.review(request)).toMatchObject({ status: "unavailable", usage });
		},
	);

	it.each([
		"",
		"not json",
		JSON.stringify({ verdict: "no_findings" }),
		JSON.stringify({ ...noFindings, accepted: true }),
	])("rejects malformed peer result %s", async (text) => {
		const f = fixture();
		f.setCompletion({ text, usage, stopReason: "stop" });
		expect(await f.controller.review(request)).toMatchObject({ status: "unavailable", usage });
	});

	it("returns unresolved candidates with exact supplied evidence and the required reproduction", async () => {
		const f = fixture();
		const review = {
			verdict: "findings",
			summary: "Cancellation may leak.",
			findings: [
				{
					summary: "Verify release ordering",
					evidence: "release held resource",
					requiredCheck: "Cancel while resource is held; assert release exactly once.",
				},
			],
			limitations: [],
		};
		f.setCompletion({ text: JSON.stringify(review), usage, stopReason: "stop" });
		expect(await f.controller.review(request)).toMatchObject({ status: "reviewed", leadMustResolve: true, review });
		f.setCompletion({
			text: JSON.stringify({ ...review, findings: [{ ...review.findings[0], evidence: "invented file" }] }),
			usage,
			stopReason: "stop",
		});
		expect((await f.controller.review(request)).status).toBe("unavailable");
	});

	it("cancels at judgment and rejects stale results after dispatch", async () => {
		const f = fixture();
		const abort = new AbortController();
		f.onJudge(() => abort.abort());
		expect((await f.controller.review(strongerRequest, abort.signal)).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
		const second = fixture();
		second.onRun(() => {
			second.state.lead = { ...second.state.lead, model: peer };
		});
		expect(await second.controller.review(request)).toMatchObject({ status: "unavailable", usage });
	});

	it("does not silently clamp highest-effort leads, oversized evidence or inconsistent verdicts", async () => {
		const f = fixture();
		f.state.lead.thinkingLevel = "ultra";
		expect(f.controller.options().peers).toMatchObject([{ ref: "test/peer", strongerThinkingLevels: [] }]);
		expect((await f.controller.review({ ...strongerRequest, thinkingLevel: "max" })).status).toBe("unavailable");
		expect(f.calls).toHaveLength(0);
		f.state.lead.thinkingLevel = "medium";
		expect((await f.controller.review({ ...request, evidence: "a".repeat(48_001) })).status).toBe("unavailable");
		f.setCompletion({ text: JSON.stringify({ ...noFindings, verdict: "findings" }), usage, stopReason: "stop" });
		expect((await f.controller.review(request)).status).toBe("unavailable");
	});
});
