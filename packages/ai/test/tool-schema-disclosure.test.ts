import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	measureToolSchemaDisclosureRequest,
	planToolSchemaDisclosure,
	searchDeferredToolSchemas,
	TOOL_SCHEMA_SEARCH_DETAILS_KIND,
	TOOL_SCHEMA_SEARCH_NAME,
} from "../src/tool-schema-disclosure.ts";
import type { Model, Tool } from "../src/types.ts";

function model(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...overrides,
	};
}

function tool(name: string, description = `${name} capability`): Tool {
	return {
		name,
		description,
		parameters: Type.Object({ query: Type.Optional(Type.String()) }),
	};
}

function largeSurface(): Tool[] {
	return [
		tool(TOOL_SCHEMA_SEARCH_NAME),
		tool("read"),
		tool("bash"),
		tool("edit"),
		tool("write"),
		tool("delegate", "delegate parallel worker tasks"),
		tool("memory", "query durable memories"),
		tool("pipeline", "run deployment pipelines"),
		tool("image_generate", "generate visual assets"),
		tool("secret_store", "manage credentials"),
		tool("task_steps", "track execution steps"),
	];
}

describe("tool schema disclosure planning", () => {
	it("keeps a stable eager core and defers the rest on supported first-party Claude models", () => {
		const plan = planToolSchemaDisclosure(model(), largeSurface());

		expect(plan.enabled).toBe(true);
		expect(plan.eagerToolNames).toEqual(new Set([TOOL_SCHEMA_SEARCH_NAME, "read", "bash", "edit", "write"]));
		expect(plan.deferredToolNames).toEqual(
			new Set(["delegate", "memory", "pipeline", "image_generate", "secret_store", "task_steps"]),
		);
		expect(plan.metrics).toMatchObject({ totalToolCount: 11, eagerToolCount: 5, deferredToolCount: 6 });
		expect(plan.metrics.estimatedEagerSchemaTokens).toBeGreaterThan(0);
		expect(plan.metrics.estimatedDeferredSchemaTokens).toBeGreaterThan(0);
	});

	it("fails open when host, model, search tool, or surface size is unsupported", () => {
		const supported = largeSurface();
		const cases = [
			planToolSchemaDisclosure(model({ baseUrl: "https://proxy.example.test" }), supported),
			planToolSchemaDisclosure(model({ id: "claude-opus-3-7" }), supported),
			planToolSchemaDisclosure(model({ id: "claude-opus-4x-unknown" }), supported),
			planToolSchemaDisclosure(
				model(),
				supported.filter((entry) => entry.name !== TOOL_SCHEMA_SEARCH_NAME),
			),
			planToolSchemaDisclosure(model(), supported.slice(0, 10)),
		];

		for (const plan of cases) {
			expect(plan.enabled).toBe(false);
			expect(plan.deferredToolNames.size).toBe(0);
		}
	});

	it("allows an explicit compatible-endpoint override without guessing", () => {
		const plan = planToolSchemaDisclosure(
			model({
				provider: "custom-anthropic",
				baseUrl: "https://proxy.example.test",
				compat: { supportsToolSearch: true },
			}),
			largeSurface(),
		);

		expect(plan.enabled).toBe(true);
	});

	it("searches only the current deferred surface with exact selection and bounded ranking", () => {
		const plan = planToolSchemaDisclosure(model(), largeSurface());
		expect(searchDeferredToolSchemas(plan, "select:delegate,read,missing", 5).map((entry) => entry.name)).toEqual([
			"delegate",
		]);
		expect(searchDeferredToolSchemas(plan, "durable memory", 1).map((entry) => entry.name)).toEqual(["memory"]);
	});

	it("measures only searches resolved by the current provider round trip", () => {
		const plan = planToolSchemaDisclosure(model(), largeSurface());
		const result = {
			role: "toolResult" as const,
			toolCallId: "search-1",
			toolName: TOOL_SCHEMA_SEARCH_NAME,
			content: [{ type: "text" as const, text: "searching" }],
			details: { kind: TOOL_SCHEMA_SEARCH_DETAILS_KIND, query: "missing capability", maxResults: 3 },
			isError: false,
			timestamp: 100,
		};

		expect(measureToolSchemaDisclosureRequest(plan, [result], 250)).toMatchObject({
			searchCount: 1,
			searchMissCount: 1,
			referencedToolCount: 0,
			searchResolutionMs: 150,
		});
		expect(
			measureToolSchemaDisclosureRequest(
				plan,
				[result, { role: "user", content: "later request", timestamp: 200 }],
				250,
			),
		).toMatchObject({ searchCount: 0, searchMissCount: 0, searchResolutionMs: null });
	});
});
