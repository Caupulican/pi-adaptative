import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getModel } from "@caupulican/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { discoverAndLoadExtensions, disposeExtensionEventSubscriptions } from "../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const countersKey = "__piLazyExtensionTestCounters";

type Counters = {
	imports: string[];
	factories: string[];
	events: string[];
};

declare global {
	// eslint-disable-next-line no-var
	var __piLazyExtensionTestCounters: Counters | undefined;
}

function resetCounters(): void {
	globalThis[countersKey] = { imports: [], factories: [], events: [] } as Counters;
}

function counters(): Counters {
	return globalThis[countersKey] as Counters;
}

function writeLazyPackage(root: string, id: string, toolName: string, resultText = id): void {
	const dir = path.join(root, "extensions", id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "index.ts"),
		`
const counters = globalThis.${countersKey} ??= { imports: [], factories: [], events: [] };
counters.imports.push(${JSON.stringify(id)});
export default function(pi) {
  counters.factories.push(${JSON.stringify(id)});
  pi.events.on("lazy-event", () => counters.events.push(${JSON.stringify(id)}));
  pi.registerTool({
    name: ${JSON.stringify(toolName)},
    label: ${JSON.stringify(toolName)},
    description: ${JSON.stringify(`Lazy tool ${toolName}`)},
    promptSnippet: ${JSON.stringify(`Run ${toolName}`)},
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: ${JSON.stringify(resultText)} }], details: {} }),
  });
}
`,
	);
	fs.writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({
			pi: {
				extensions: ["./index.ts"],
				lazyTools: [
					{
						name: toolName,
						label: toolName,
						description: `Lazy tool ${toolName}`,
						promptSnippet: `Run ${toolName}`,
						parameters: { type: "object", properties: {}, additionalProperties: false },
					},
				],
			},
		}),
	);
}

async function executeLazyTool(root: string, toolName: string) {
	const result = await discoverAndLoadExtensions([], root, root);
	const tool = result.extensions
		.flatMap((extension) => [...extension.tools.values()])
		.find((entry) => entry.definition.name === toolName);
	expect(tool).toBeDefined();
	return tool!.definition.execute("tool-call", {}, undefined, undefined, undefined as never);
}

describe("lazy extension loading", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lazy-ext-"));
		resetCounters();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		delete globalThis.__piLazyExtensionTestCounters;
	});

	it("discovers lazy tool metadata without importing the extension module at boot", async () => {
		writeLazyPackage(tempDir, "a", "lazy_a", "A");

		const result = await discoverAndLoadExtensions([], tempDir, tempDir);

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].lazy?.loaded).toBe(false);
		expect([...result.extensions[0].tools.keys()]).toEqual(["lazy_a"]);
		expect(counters().imports).toEqual([]);
		expect(counters().factories).toEqual([]);

		const output = await result.extensions[0].tools
			.get("lazy_a")!
			.definition.execute("tool-call", {}, undefined, undefined, undefined as never);

		expect(output.content[0]).toEqual({ type: "text", text: "A" });
		expect(result.extensions[0].lazy?.loaded).toBe(true);
		expect(counters().imports).toEqual(["a"]);
		expect(counters().factories).toEqual(["a"]);
	});

	it("loads only the owning extension for the requested lazy tool", async () => {
		writeLazyPackage(tempDir, "a", "lazy_a", "A");
		writeLazyPackage(tempDir, "b", "lazy_b", "B");

		const output = await executeLazyTool(tempDir, "lazy_b");

		expect(output.content[0]).toEqual({ type: "text", text: "B" });
		expect(counters().imports).toEqual(["b"]);
		expect(counters().factories).toEqual(["b"]);
	});

	it("cleans up event subscriptions for lazy extensions that were activated", async () => {
		writeLazyPackage(tempDir, "a", "lazy_a", "A");
		const bus = createEventBus();
		const result = await discoverAndLoadExtensions([], tempDir, tempDir, bus);

		bus.emit("lazy-event", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(counters().events).toEqual([]);

		await result.extensions[0].tools
			.get("lazy_a")!
			.definition.execute("tool-call", {}, undefined, undefined, undefined as never);
		bus.emit("lazy-event", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(counters().events).toEqual(["a"]);

		disposeExtensionEventSubscriptions(result.extensions);
		bus.emit("lazy-event", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(counters().events).toEqual(["a"]);
	});

	it("keeps allowlist and exclude filtering on lazy extension tool metadata", async () => {
		writeLazyPackage(tempDir, "a", "lazy_a", "A");
		writeLazyPackage(tempDir, "b", "lazy_b", "B");
		const agentDir = tempDir;
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(tempDir);

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader,
			tools: ["lazy_a", "read"],
			excludeTools: ["read"],
		});

		expect(session.getAllTools().map((tool) => tool.name)).toEqual(["lazy_a"]);
		expect(counters().imports).toEqual([]);
		session.dispose();
	});
});
