/**
 * Pipeline runs inject a fresh deterministic pipeline_context record every turn. The marker is part
 * of the semantic-context GC defaults, so its lower semantic threshold must apply instead of leaving
 * medium-sized stale pages to the generic transient-record threshold.
 */
import { type AgentMessage, createCustomMessage } from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import { applyContextGc } from "../src/core/context-gc.ts";

function pipelinePage(revision: number): AgentMessage {
	return createCustomMessage(
		"pipeline_context",
		`<pipeline_context revision=${revision}>\n${`stage-${revision} `.repeat(115)}\n</pipeline_context>`,
		false,
		{ revision },
		new Date(revision * 1000).toISOString(),
	);
}

describe("pipeline_context GC eligibility", () => {
	it("packs stale pipeline pages through the configured semantic marker threshold", () => {
		const oldPage = pipelinePage(1);
		const currentPage = pipelinePage(2);
		const messages: AgentMessage[] = [oldPage, currentPage];

		const result = applyContextGc(messages, {
			cwd: "/repo",
			preserveRecentMessages: 0,
			minToolResultChars: 1200,
			semanticMemory: { preserveRecentPages: 1, minChars: 900 },
			writePayloads: false,
		});

		expect(result.report.records).toHaveLength(1);
		expect(result.report.records[0]).toMatchObject({
			messageIndex: 0,
			reason: "stale-semantic-memory",
		});
		expect(result.messages[0]).not.toBe(oldPage);
		expect(result.messages[1]).toBe(currentPage);
	});
});
