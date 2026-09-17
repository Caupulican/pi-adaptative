import assert from "node:assert/strict";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionHandler, ToolResultEvent, ToolResultEventResult } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createTestExtensionsResult } from "./suite/test-resources.ts";

async function createRunner(handlers: ExtensionHandler<ToolResultEvent, ToolResultEventResult>[]) {
	const loaded = await createTestExtensionsResult([
		(pi) => {
			for (const handler of handlers) pi.on("tool_result", handler);
		},
	]);
	return new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		process.cwd(),
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
}

function event(): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "fixture",
		toolCallId: "completed",
		input: {},
		content: [{ type: "text", text: "successful operation" }],
		details: { phase: "written" },
		isError: false,
	};
}

describe("tool result handler data ownership", () => {
	it.each(["top-level", "nested"] as const)("contains %s event mutations when a handler fails", async (kind) => {
		const input = event();
		const before = structuredClone(input);
		const runner = await createRunner([
			(current) => {
				if (kind === "top-level") {
					current.content = [{ type: "text", text: "failed mutation" }];
					current.isError = true;
				} else {
					const first = current.content[0];
					if (first.type === "text") first.text = "failed mutation";
					Object.assign(current.details as object, { phase: "failed mutation" });
				}
				throw new Error("handler failed");
			},
			(current) => ({ content: [...current.content, { type: "text", text: "later handler" }] }),
		]);
		const errors = vi.fn();
		runner.onError(errors);
		const result = await runner.emitToolResult(input);
		expect(result).toMatchObject({
			content: [...before.content, { type: "text", text: "later handler" }],
			details: before.details,
			isError: false,
		});
		expect(input).toEqual(before);
		expect(errors).toHaveBeenCalledOnce();
	});

	it.each(["event", "patch"] as const)("detaches retained %s data after handler completion", async (retained) => {
		const input = event();
		const before = structuredClone(input);
		let previous: ToolResultEvent | ToolResultEventResult | undefined;
		const runner = await createRunner([
			(current) => {
				const patch: ToolResultEventResult = {
					content: [{ type: "text", text: "accepted annotation" }],
					details: { phase: "accepted" },
				};
				previous = retained === "event" ? current : patch;
				return patch;
			},
			(current) => {
				const first = previous?.content?.[0];
				if (first?.type === "text") first.text = "late mutation";
				Object.assign(previous?.details as object, { phase: "late mutation" });
				return { content: [...current.content, { type: "text", text: "later handler" }] };
			},
		]);
		const result = await runner.emitToolResult(input);
		expect(result).toMatchObject({
			content: [
				{ type: "text", text: "accepted annotation" },
				{ type: "text", text: "later handler" },
			],
			details: { phase: "accepted" },
			isError: false,
		});
		expect(input).toEqual(before);
	});

	it.each([false, true])(
		"publishes all patch fields only after snapshot traversal succeeds (throws=%s)",
		async (throws) => {
			const keys = vi.fn(() => {
				if (throws) throw new Error("snapshot traversal failed");
				return ["phase"];
			});
			const details = new Proxy({ phase: "proposed" }, { ownKeys: keys });
			const runner = await createRunner([
				() => ({
					content: [{ type: "text", text: "previous" }],
					details: { phase: "previous" },
					isError: true,
					terminate: true,
				}),
				() => ({
					content: [{ type: "text", text: "proposed" }],
					details,
					isError: false,
					terminate: false,
				}),
				(current) => ({ content: [...current.content, { type: "text", text: "later" }] }),
			]);
			const errors = vi.fn();
			runner.onError(errors);
			const result = await runner.emitToolResult(event());
			const phase = throws ? "previous" : "proposed";
			expect(keys).toHaveBeenCalledOnce();
			expect(errors).toHaveBeenCalledTimes(throws ? 1 : 0);
			expect(result).toMatchObject({
				content: [
					{ type: "text", text: phase },
					{ type: "text", text: "later" },
				],
				details: { phase },
				isError: throws,
				terminate: throws,
			});
		},
	);

	it("preserves cyclic records, lazy getters, callable metadata and opaque class handles", async () => {
		class Renderer {
			#value = "class renderer";
			render() {
				return this.#value;
			}
		}
		const renderer = new Renderer();
		class Renderers extends Array<Renderer> {}
		const renderers = new Renderers(renderer);
		const render = () => "callable renderer";
		const lazy = vi.fn(() => "lazy value");
		const details: Record<string, unknown> = { renderer, renderers, render };
		details.self = details;
		Object.defineProperty(details, "lazy", { get: lazy, enumerable: true });
		const input = { ...event(), details };
		const runner = await createRunner([
			(current) => {
				const data = current.details as Record<string, unknown>;
				// Avoid matcher diagnostics inspecting the lazy properties under test.
				assert.notStrictEqual(data, details);
				assert.strictEqual(data.self, data);
				assert.strictEqual(data.renderer, renderer);
				assert.strictEqual(data.renderers, renderers);
				assert.strictEqual(data.render, render);
				expect(renderer.render()).toBe("class renderer");
				expect(render()).toBe("callable renderer");
				expect(lazy).not.toHaveBeenCalled();
				expect(data.lazy).toBe("lazy value");
				return { content: [{ type: "text", text: "annotation" }], details: data };
			},
		]);
		const errors = vi.fn();
		runner.onError(errors);
		const result = await runner.emitToolResult(input);
		expect(errors).not.toHaveBeenCalled();
		expect(result?.content).toEqual([{ type: "text", text: "annotation" }]);
		const output = result?.details as Record<string, unknown>;
		assert.strictEqual(output.self, output);
		assert.strictEqual(output.renderer, renderer);
		assert.strictEqual(output.renderers, renderers);
		assert.strictEqual(output.render, render);
		expect(lazy).toHaveBeenCalledOnce();
	});
});
