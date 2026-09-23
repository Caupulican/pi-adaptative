import type { AssistantMessage } from "@caupulican/pi-ai";
import { visibleWidth } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ForegroundRouteSnapshot } from "../src/core/model-router-controller.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ReplyBylineTracker, replyByline, replyModelRef } from "../src/modes/interactive/components/reply-byline.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ROUTED: ForegroundRouteSnapshot = {
	rootModel: "anthropic/claude-opus-5-5",
	activeModel: "openrouter/inclusionai/ling-3.0-flash-sante:free",
	source: "model_router_system_one",
	tier: "cheap",
	risk: null,
	reasonCode: null,
	switched: true,
};

const DIRECT: ForegroundRouteSnapshot = {
	rootModel: "anthropic/claude-opus-5-5",
	activeModel: "anthropic/claude-opus-5-5",
	source: "direct",
	tier: null,
	risk: null,
	reasonCode: null,
	switched: false,
};

function reply(model: string, text: string, responseModel?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		...(responseModel ? { responseModel } : {}),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("reply byline", () => {
	beforeAll(() => initTheme(undefined, false));

	it("names the session's own model as root and a routed one with who chose it", () => {
		expect(replyByline("anthropic/claude-opus-5-5", DIRECT)).toEqual({
			text: "root · claude-opus-5-5",
			routed: false,
		});
		expect(replyByline("openrouter/inclusionai/ling-3.0-flash-sante:free", ROUTED)).toEqual({
			text: "routed · inclusionai/ling-3.0-flash-sante:free · cheap via model-router/System One",
			routed: true,
		});
		// No route on record (a reloaded root reply) reads as root.
		expect(replyByline("anthropic/claude-opus-5-5", undefined).routed).toBe(false);
	});

	it("names the model that actually answered when the provider resolved an alias", () => {
		expect(replyModelRef(reply("auto", "x", "claude-sonnet-5"))).toBe("anthropic/claude-sonnet-5");
		expect(replyModelRef(reply("claude-opus-5-5", "x"))).toBe("anthropic/claude-opus-5-5");
	});

	it("shows once per reply and again only when the model changes", () => {
		const tracker = new ReplyBylineTracker();
		expect(tracker.shouldShow("a/model-1")).toBe(true);
		expect(tracker.shouldShow("a/model-1")).toBe(false);
		expect(tracker.shouldShow("a/model-2")).toBe(true);
		tracker.ownerMessage();
		expect(tracker.shouldShow("a/model-2")).toBe(true);
	});

	it("renders one row above the reply that never wraps, keeping the actor at narrow widths", () => {
		const byline = replyByline("openrouter/inclusionai/ling-3.0-flash-sante:free", ROUTED);
		const component = new AssistantMessageComponent(reply("ling", "Hello there."), true, undefined, { byline });
		const wide = component.render(120).map(stripAnsi);
		const bylineRow = wide.findIndex((line) => line.includes("routed · inclusionai/ling-3.0-flash-sante:free"));
		const textRow = wide.findIndex((line) => line.includes("Hello there."));
		expect(bylineRow).toBeGreaterThanOrEqual(0);
		expect(textRow).toBe(bylineRow + 1);

		const narrow = new AssistantMessageComponent(reply("ling", "Hello there."), true, undefined, { byline })
			.render(40)
			.map(stripAnsi);
		const narrowByline = narrow.filter((line) => line.includes("routed ·"));
		expect(narrowByline).toHaveLength(1);
		expect(visibleWidth(narrowByline[0])).toBeLessThanOrEqual(40);
	});
});
