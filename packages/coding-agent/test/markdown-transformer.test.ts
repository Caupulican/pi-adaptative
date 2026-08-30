import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { AssistantMessage } from "@caupulican/pi-ai";
import { Container } from "@caupulican/pi-tui";
import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/factory-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("P2g: Markdown transformer pipeline", () => {
	it("chains transformers in load order and skips throwing transformers", async () => {
		const bus = createEventBus();
		const runtime = createExtensionRuntime();

		const ext1 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerMarkdownTransformer((md, _ctx) => {
					return md.replace(/foo/g, "bar");
				});
			},
			process.cwd(),
			bus,
			runtime,
			"ext1",
		);

		const ext2 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerMarkdownTransformer((_md, _ctx) => {
					throw new Error("broken transformer");
				});
			},
			process.cwd(),
			bus,
			runtime,
			"ext2",
		);

		const ext3 = await loadExtensionFromFactory(
			(pi) => {
				pi.registerMarkdownTransformer((md, ctx) => {
					return `${md} [${ctx.messageType}]`;
				});
			},
			process.cwd(),
			bus,
			runtime,
			"ext3",
		);

		const runner = new ExtensionRunner(
			[ext1, ext2, ext3],
			runtime,
			process.cwd(),
			undefined as any,
			undefined as any,
		);

		const transformed = runner.transformMarkdown("foo baz", {
			messageType: "assistant",
			isStreaming: false,
			availableWidth: 80,
		});

		expect(transformed).toBe("bar baz [assistant]");
	});
});

describe("P2g: markdown transformer wiring into the display path", () => {
	it("applies a transform to assistant text and thinking blocks, keyed by messageType", () => {
		initTheme("dark");
		const seen: Array<{ messageType: string; isStreaming: boolean }> = [];
		const transformMarkdown = (markdown: string, ctx: { messageType: string; isStreaming: boolean }) => {
			seen.push({ messageType: ctx.messageType, isStreaming: ctx.isStreaming });
			return markdown.toUpperCase();
		};

		const component = new AssistantMessageComponent(
			assistantMessage([
				{ type: "thinking", thinking: "reasoning about it" },
				{ type: "text", text: "the answer" },
			]),
			false,
			getMarkdownTheme(),
			{ isStreaming: true, transformMarkdown },
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("REASONING ABOUT IT");
		expect(rendered).toContain("THE ANSWER");
		expect(seen).toEqual(
			expect.arrayContaining([
				{ messageType: "assistant-thinking", isStreaming: true },
				{ messageType: "assistant", isStreaming: true },
			]),
		);
	});

	it("applies a transform to user messages with messageType 'user'", () => {
		initTheme("dark");
		const transformMarkdown = (markdown: string, ctx: { messageType: string }) => {
			expect(ctx.messageType).toBe("user");
			return `${markdown} [tagged]`;
		};

		const component = new UserMessageComponent("hello there", getMarkdownTheme(), transformMarkdown);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("hello there [tagged]");
	});

	it("falls back to the untransformed text when a transformer throws, instead of breaking rendering", () => {
		initTheme("dark");
		const throwingTransform = () => {
			throw new Error("boom");
		};

		const assistantComponent = new AssistantMessageComponent(
			assistantMessage([{ type: "text", text: "still visible" }]),
			false,
			getMarkdownTheme(),
			{ transformMarkdown: throwingTransform },
		);
		expect(() => assistantComponent.render(80)).not.toThrow();
		expect(assistantComponent.render(80).join("\n")).toContain("still visible");

		const userComponent = new UserMessageComponent("still visible too", getMarkdownTheme(), throwingTransform);
		expect(() => userComponent.render(80)).not.toThrow();
		expect(userComponent.render(80).join("\n")).toContain("still visible too");
	});

	it("re-runs the transform for a new render width, e.g. on terminal resize", () => {
		initTheme("dark");
		const transformMarkdown = (markdown: string, ctx: { availableWidth: number }) =>
			`${markdown} w=${ctx.availableWidth}`;

		const component = new UserMessageComponent("hi", getMarkdownTheme(), transformMarkdown);

		expect(component.render(80).join("\n")).toContain("hi w=80");
		expect(component.render(40).join("\n")).toContain("hi w=40");
	});
});

describe("P2g: path-alias display integrity", () => {
	it("expands path aliases before markdown transformers ever see the text", () => {
		initTheme("dark");
		const ctx = Object.create((InteractiveMode as any).prototype);
		ctx.chatContainer = new Container();
		ctx.hideThinkingBlock = false;
		ctx.toolOutputExpanded = false;
		ctx.getMarkdownThemeWithSettings = () => getMarkdownTheme();
		ctx.trimLiveTuiHistory = () => {};

		const seenTexts: string[] = [];
		ctx.transformMarkdownForDisplay = (markdown: string) => {
			seenTexts.push(markdown);
			return markdown;
		};

		Object.defineProperty(ctx, "session", {
			value: {
				peekPathAliasTable: () => ({
					cwd: "/repo",
					entries: [{ id: "p/module02.ts", path: "src/core/module02.ts" }],
					reservedIds: [],
				}),
			},
		});

		const message: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Checking p/module02.ts now" },
				{ type: "text", text: "See p/module02.ts for the fix." },
			],
			stopReason: "stop",
		} as unknown as AgentMessage;

		(InteractiveMode as any).prototype.addMessageToChat.call(ctx, message);
		// addMessageToChat only constructs the component; rendering is what triggers the transform
		// chain, exactly like the real chat viewport repainting.
		ctx.chatContainer.render(80);

		expect(seenTexts.some((text: string) => text.includes("src/core/module02.ts"))).toBe(true);
		expect(seenTexts.some((text: string) => text.includes("p/module02.ts"))).toBe(false);
	});
});
