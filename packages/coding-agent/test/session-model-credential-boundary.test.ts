// @isolated: uses session harness and stubs provider fetch
// @guards packages/coding-agent/src/core/runtime-builder.ts packages/coding-agent/src/core/session-stream-chain.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

const foreignCredential = "synthetic-unselected-provider-value-729183";
const source = `export const example = "${foreignCredential}";\nexport const ordinary = "evidence";\n`;

afterEach(() => vi.restoreAllMocks());

describe("session model credential boundary", () => {
	it("redacts registered values at the root request while preserving local credential use and history", async () => {
		const harness = await createHarness({ baseToolsOverride: [] });
		try {
			harness.authStorage.set("unused-provider", { type: "api_key", key: foreignCredential });
			let captured = "";
			let transportKey: string | undefined;
			harness.setResponses([
				(context, options) => {
					captured = JSON.stringify(context);
					transportKey = options?.apiKey;
					return fauxAssistantMessage("Checked local evidence.");
				},
			]);
			await harness.session.prompt(`Inspect ordinary evidence: ${foreignCredential}`);

			expect(captured).not.toContain(foreignCredential);
			expect(captured).toContain("ordinary evidence: [REDACTED_SECRET]");
			expect(transportKey).toBe("faux-key");
			expect(await harness.authStorage.getApiKey("unused-provider")).toBe(foreignCredential);
			expect(JSON.stringify(harness.session.messages)).toContain(foreignCredential);
		} finally {
			await harness.cleanup();
		}
	});

	it.each(["isolated", "branch summary"] as const)(
		"redacts %s requests through the same session boundary",
		async (lane) => {
			const harness = await createHarness({ baseToolsOverride: [] });
			try {
				harness.authStorage.set("unused-provider", { type: "api_key", key: foreignCredential });
				let captured = "";
				harness.setResponses([
					(context) => {
						captured = JSON.stringify(context);
						return fauxAssistantMessage("Generated ordinary summary.");
					},
				]);
				if (lane === "isolated") {
					const result = await harness.session.runIsolatedCompletion({
						systemPrompt: "Review ordinary evidence.",
						messages: [],
						requestContext: {
							systemPrompt: `Review ordinary evidence: ${foreignCredential}`,
							messages: [{ role: "user", content: `Local evidence: ${foreignCredential}`, timestamp: 1 }],
						},
						maxTokens: 100,
						laneKind: "worker",
						cacheRetention: "none",
					});
					expect(result.text).toBe("Generated ordinary summary.");
				} else {
					const target = harness.sessionManager.appendMessage({ role: "user", content: "First", timestamp: 1 });
					harness.sessionManager.appendMessage({
						role: "user",
						content: `ordinary evidence: ${foreignCredential}`,
						timestamp: 2,
					});
					expect((await harness.session.navigateTree(target, { summarize: true })).cancelled).toBe(false);
				}
				expect(captured).toContain("ordinary evidence");
				expect(captured).toContain("[REDACTED_SECRET]");
				expect(captured).not.toContain(foreignCredential);
				expect(harness.getPendingResponseCount()).toBe(0);
			} finally {
				await harness.cleanup();
			}
		},
	);

	it("redacts a worker's task and source before the worker provider receives them", async () => {
		const harness = await createHarness();
		try {
			harness.authStorage.set("unused-provider", { type: "api_key", key: foreignCredential });
			writeFileSync(join(harness.tempDir, "source.ts"), source);
			const requests: string[] = [];
			harness.setResponses([
				(context) => {
					requests.push(JSON.stringify(context));
					return fauxAssistantMessage(fauxToolCall("read", { path: "source.ts" }), { stopReason: "toolUse" });
				},
				(context) => {
					requests.push(JSON.stringify(context));
					return fauxAssistantMessage('{"summary":"Inspected source.","status":"completed","findings":[]}');
				},
			]);
			const delegated = await harness.session.runWorkerDelegationOnce({
				instructions: `Read source.ts and inspect ordinary evidence: ${foreignCredential}`,
			});

			expect(delegated, JSON.stringify(delegated)).toMatchObject({ started: true, record: { status: "succeeded" } });
			expect(requests).toHaveLength(2);
			expect(requests.join("\n")).not.toContain(foreignCredential);
			expect(requests[1]).toContain("export const ordinary");
			expect(requests[1]).toContain("[REDACTED_SECRET]");
			expect(await harness.authStorage.getApiKey("unused-provider")).toBe(foreignCredential);
		} finally {
			await harness.cleanup();
		}
	});

	it.each([200, 401])("redacts native System One evidence and retained provider output at HTTP %s", async (status) => {
		const harness = await createHarness();
		try {
			harness.authStorage.set("typesafe", { type: "api_key", key: "synthetic-selected-credential-61729" });
			harness.authStorage.set("unused-provider", { type: "api_key", key: foreignCredential });
			writeFileSync(join(harness.tempDir, "source.ts"), source);
			let body = "";
			let authHeader = "";
			vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
				body = String(init?.body ?? "");
				authHeader = new Headers(init?.headers).get("Authorization") ?? "";
				return Response.json(
					status === 200
						? {
								model: "jev-1.13.0",
								answers: { q: { type: "noul", noul: 1 } },
								usage: { input_tokens: 1, output_tokens: 1 },
							}
						: { error: `Provider rejected evidence ${foreignCredential}` },
					{ status },
				);
			});
			const tool = harness.session.getToolDefinition("systemone");
			if (!tool) throw new Error("Missing native System One tool");
			const result = await tool.execute(
				"review-source",
				{
					action: "evaluate",
					evidenceRefs: ["file:source.ts"],
					evaluation: {
						state: "ordinary evidence",
						questions: { q: { type: "noul", instructions: "Is the ordinary evidence present?" } },
					},
				},
				undefined,
				undefined,
				{} as never,
			);

			expect(body).not.toContain(foreignCredential);
			expect(body).toContain("export const ordinary");
			expect(body).toContain("[REDACTED_SECRET]");
			expect(authHeader).toContain("synthetic-selected-credential-61729");
			expect(result, JSON.stringify(result)).toMatchObject({ isError: status !== 200 });
			expect(JSON.stringify(result)).not.toContain(foreignCredential);
			const details = result.details as { evidence: { id: string } };
			const page = await tool.execute(
				"read-evidence",
				{ action: "evidence", id: details.evidence.id },
				undefined,
				undefined,
				{} as never,
			);
			expect(JSON.stringify(page)).not.toContain(foreignCredential);
			expect(JSON.stringify(page)).toContain("ordinary evidence");
		} finally {
			await harness.cleanup();
		}
	});
});
