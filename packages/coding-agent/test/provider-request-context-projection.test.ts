import { createCustomMessage } from "@caupulican/pi-agent-core/messages";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import { buildContextProjection, type ContextProjection } from "../src/core/context/context-projection.ts";
import { ProviderRequestContextController } from "../src/core/provider-request-context-controller.ts";

function userMessage(content: string): AgentMessage {
	return { role: "user", content, timestamp: 1 };
}

function createController(options: {
	current: { value: boolean };
	onPreview(messages: readonly AgentMessage[]): ContextProjection;
	onCommit(projection: ContextProjection): void;
}): ProviderRequestContextController {
	const extension = createCustomMessage("extension-context", "extension", false, undefined, new Date(2).toISOString());
	return new ProviderRequestContextController({
		transformExtensions: async (messages) => ({
			messages,
			transientMessages: [extension],
			isCurrent: () => options.current.value,
		}),
		applyContextGc: (messages) => ({
			messages,
			report: {
				enabled: false,
				packedCount: 0,
				originalTokens: 0,
				packedTokens: 0,
				savedTokens: 0,
				records: [],
			},
			isCurrent: () => true,
			commit: () => {},
		}),
		applyPathAliases: (messages) => ({ messages, legend: "PATH ALIASES\np/a=/repo/a" }),
		previewContextProjection: options.onPreview,
		commitContextProjection: options.onCommit,
	});
}

describe("provider request context projection lifecycle", () => {
	it("captures the final provider-visible messages and publishes only an accepted plan", async () => {
		const current = { value: true };
		let previewMessages: readonly AgentMessage[] = [];
		let committed: ContextProjection | undefined;
		const controller = createController({
			current,
			onPreview: (messages) => {
				previewMessages = messages;
				return buildContextProjection(messages, { turnIndex: 1 });
			},
			onCommit: (projection) => {
				committed = projection;
			},
		});

		const plan = await controller.plan([userMessage("go")], 0);
		expect(previewMessages.map((message) => message.role)).toEqual(["user", "custom", "custom"]);
		expect(
			previewMessages.filter((message) => message.role === "custom").map((message) => message.customType),
		).toEqual(["extension-context", "path_alias_legend"]);
		expect(committed).toBeUndefined();

		expect(plan.prepareCommit?.()).toBe(true);
		plan.commit?.();
		expect(committed?.revision).toBe(buildContextProjection(previewMessages, { turnIndex: 99 }).revision);
	});

	it("never publishes a projection whose contributor became stale before commit", async () => {
		const current = { value: true };
		let commitCount = 0;
		const controller = createController({
			current,
			onPreview: (messages) => buildContextProjection(messages, { turnIndex: 1 }),
			onCommit: () => {
				commitCount++;
			},
		});

		const plan = await controller.plan([userMessage("go")], 0);
		current.value = false;
		expect(plan.prepareCommit?.()).toBe(false);
		expect(() => plan.commit?.()).toThrow(/diverged from its accepted plan/);
		expect(commitCount).toBe(0);
	});
});
