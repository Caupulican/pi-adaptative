import type { AgentTool } from "@caupulican/pi-agent-core/types";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { JevEvaluationRequest } from "../../src/core/system-one/adapter.ts";
import { SystemOneController } from "../../src/core/system-one/controller.ts";
import { ExecutionStore } from "../../src/core/system-one/execution-state.ts";
import { OPTIONAL_TOOL_INTENT_CUSTOM_TYPE, readOptionalToolIntent } from "../../src/core/tool-applicability-gate.ts";
import { createHarness } from "./harness.ts";

/**
 * An owner judgment is as fresh as the submission it judges, not as the moment it was evaluated.
 * An older submission that is judged late never overrides the policy of a newer one, and both
 * messages still reach the model in submission order.
 */

const USE = "Use secret store for this task.";
const STOP = "Stop using secret store.";

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function intentAnswers(request: string): Record<string, unknown> {
	return {
		changes_model_pools: { noul: 0.01 },
		optional_tool_task: { choice: request === USE ? "replace" : "continue", confidence: 0.99 },
		optional_tool_0: {
			choice: request === USE ? "request" : request === STOP ? "revoke" : "unchanged",
			confidence: 0.99,
		},
	};
}

function classifier() {
	return new SystemOneController({
		store: new ExecutionStore({
			run_id: "owner-judgment-order",
			objective: { request: "", normalized_goal: "", acceptance_criteria: [], constraints: [] },
			repo: { root: "/repo", baseline_revision: "baseline" },
		}),
		adapter: {
			evaluate: async (input: JevEvaluationRequest) => {
				const request = (input.state as { user_request?: string }).user_request;
				return { model: "jev-1.13.0", answers: request === undefined ? {} : intentAnswers(request), latency_ms: 1 };
			},
		},
	});
}

function userTexts(messages: readonly unknown[]): string[] {
	return messages.flatMap((message) => {
		const value = message as { role?: string; content?: unknown };
		if (value.role !== "user") return [];
		if (typeof value.content === "string") return [value.content];
		if (!Array.isArray(value.content)) return [];
		return [
			value.content
				.filter((part: { type?: string }) => part.type === "text")
				.map((part: { text?: string }) => part.text ?? "")
				.join(""),
		];
	});
}

/**
 * X runs; the older submission waits in its input transform until X ends, then runs as its own turn
 * and is held at its pre-run boundary while the newer submission is judged and queued.
 */
async function lateOlderJudgment(older: string, newer: string) {
	const runs: string[] = [];
	const probe: AgentTool = {
		name: "secret_store",
		label: "Fake credential tool",
		description: "Faux applicability probe",
		readOnly: true,
		parameters: Type.Object({}),
		execute: async () => {
			runs.push("executed");
			return { content: [{ type: "text", text: "probe" }], details: {} };
		},
	};
	const transformEntered = deferred();
	const transformRelease = deferred();
	const preRunEntered = deferred();
	const preRunRelease = deferred();
	const harness = await createHarness({
		systemOneController: classifier(),
		baseToolsOverride: [probe],
		settings: { modelRouter: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text === older) {
						transformEntered.resolve();
						await transformRelease.promise;
					}
					return { action: "continue" };
				});
				pi.on("before_agent_start", async (event) => {
					if (event.prompt === older) {
						preRunEntered.resolve();
						await preRunRelease.promise;
					}
					return undefined;
				});
			},
		],
	});
	harness.session.setSteeringMode("all");
	const requests: string[][] = [];
	const xSeen = deferred();
	const xRelease = deferred<AssistantMessage>();
	let attempted = false;
	const respond: FauxResponseFactory = (context) => {
		const texts = userTexts(context.messages);
		requests.push(texts);
		if (requests.length === 1) {
			xSeen.resolve();
			return xRelease.promise;
		}
		if (!attempted && texts.includes(older) && texts.includes(newer)) {
			attempted = true;
			return fauxAssistantMessage(fauxToolCall("secret_store", {}), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("done");
	};
	harness.setResponses(Array.from({ length: 10 }, () => respond));

	const x = harness.session.prompt("X words");
	await xSeen.promise;
	const olderRun = harness.session.prompt(older, { streamingBehavior: "steer" });
	await transformEntered.promise;
	xRelease.resolve(fauxAssistantMessage("x done"));
	await x;
	transformRelease.resolve();
	await preRunEntered.promise;
	// The older submission owns the foreground; the newer one is judged and queued into its run now.
	await harness.session.prompt(newer, { streamingBehavior: "steer" });
	preRunRelease.resolve();
	await olderRun;
	return {
		harness,
		runs,
		requests,
		attempted: () => attempted,
		allowedTools: () =>
			readOptionalToolIntent(
				harness.sessionManager.getLatestCustomEntryOnBranch(OPTIONAL_TOOL_INTENT_CUSTOM_TYPE)?.data,
			)?.allowedTools,
	};
}

function delivered(requests: readonly string[][], texts: readonly string[]): string[] | undefined {
	return requests.at(-1)?.filter((text) => texts.includes(text));
}

describe("owner judgments follow submission order", () => {
	it("an older permission judged late never overrides a newer prohibition", async () => {
		const result = await lateOlderJudgment(USE, STOP);
		try {
			expect(delivered(result.requests, [USE, STOP])).toEqual([USE, STOP]);
			expect(result.attempted()).toBe(true);
			expect(result.runs).toEqual([]);
			expect(result.allowedTools()).toEqual([]);
		} finally {
			result.harness.cleanup();
		}
	});

	it("control: a genuinely newer permission still applies over an older prohibition", async () => {
		const result = await lateOlderJudgment(STOP, USE);
		try {
			expect(delivered(result.requests, [USE, STOP])).toEqual([STOP, USE]);
			expect(result.attempted()).toBe(true);
			expect(result.runs).toEqual(["executed"]);
			expect(result.allowedTools()?.map((tool) => tool.toolName)).toEqual(["secret_store"]);
		} finally {
			result.harness.cleanup();
		}
	});
});
