import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTool, captureExecutionContext, type ExecutionContext } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { wrapToolWithCapabilityEnvelopeGate } from "../src/core/autonomy/composite-tool-gate.ts";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import { wrapToolWithEnvelopeScope } from "../src/core/autonomy/envelope-enforcement.ts";
import { applyExtensionSessionHeal, ExtensionSessionScope } from "../src/core/extensions/extension-session-scope.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { Extension, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { wrapToolWithCredentialExposureGuard } from "../src/core/secrets/credential-exposure-guard.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { ToolGateController } from "../src/core/tool-gate-controller.ts";
import { createToolDefinitionFromAgentTool, wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { wrapToolExecution } from "../src/core/tools/tool-execution-wrapper.ts";
import { createHarness } from "./suite/harness.ts";

const parameters = Type.Object({ path: Type.String() });

describe("invocation binding across registry and policy adapters", () => {
	let root: string;
	let ambient: string;
	let executionContext: ExecutionContext;
	let runner: ExtensionRunner;
	let extension: Extension;
	let tool: AgentTool<typeof parameters>;
	const fallback = vi.fn<AgentTool<typeof parameters>["execute"]>();
	const execute = vi.fn<AgentTool<typeof parameters>["execute"]>();
	const release = vi.fn();
	class PrototypeInvocation {
		#context = executionContext;
		get executionContext() {
			return this.#context;
		}
		async execute() {
			expect(this.#context).toBe(executionContext);
			return execute("fixture", { path: "fixture.txt" });
		}
		release() {
			expect(this.#context).toBe(executionContext);
			release();
		}
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-binding-adapters-"));
		ambient = join(root, "ambient");
		const pinned = join(root, "pinned");
		mkdirSync(ambient);
		mkdirSync(pinned);
		executionContext = captureExecutionContext({
			sessionId: "fixture-session",
			generation: 1,
			cwd: pinned,
			attachment: {
				workspaceId: "project",
				attachmentId: "fixture-host",
				root,
				flavor: process.platform === "win32" ? "win32" : "posix",
				caseSensitive: process.platform !== "win32",
			},
		});
		extension = {
			path: "fixture-extension",
			resolvedPath: "fixture-extension",
			sourceInfo: createSyntheticSourceInfo("fixture-extension", { source: "local" }),
			handlers: new Map(),
			tools: new Map(),
			messageRenderers: new Map(),
			markdownTransformers: [],
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
			eventUnsubscribes: [],
			disposers: [],
		};
		runner = new ExtensionRunner(
			[extension],
			createExtensionRuntime(),
			ambient,
			SessionManager.inMemory(),
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		fallback.mockReset().mockResolvedValue({ content: [{ type: "text", text: "ambient" }], details: {} });
		execute.mockReset().mockResolvedValue({ content: [{ type: "text", text: "bound" }], details: {} });
		release.mockReset();
		tool = {
			name: "read",
			label: "read",
			description: "fixture read",
			parameters,
			execute: fallback,
			bindInvocation: async () => ({ executionContext, execute, release }),
		};
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("retains a caller-owned binding through the definition-first registry", async () => {
		const wrapped = wrapToolDefinition(createToolDefinitionFromAgentTool(tool));
		expect(wrapped.bindInvocation).toBeTypeOf("function");
		const binding = await wrapped.bindInvocation!("call", { path: "source.ts" });
		expect(binding.executionContext).toBe(executionContext);
		await binding.execute("call", { path: "source.ts" });
		binding.release();
		expect(execute).toHaveBeenCalledOnce();
		expect(fallback).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
	});

	it.each(["to-definition", "from-definition", "execution-wrapper"])(
		"preserves the binding factory receiver through %s",
		async (boundary) => {
			const definition = createToolDefinitionFromAgentTool(tool);
			tool.bindInvocation = async function () {
				expect(this).toBe(tool);
				return { executionContext, execute, release };
			};
			definition.bindInvocation = async function () {
				expect(this).toBe(definition);
				return { executionContext, execute, release };
			};
			const wrapped =
				boundary === "to-definition"
					? createToolDefinitionFromAgentTool(tool)
					: boundary === "from-definition"
						? wrapToolDefinition(definition)
						: wrapToolExecution(tool, (executor) => executor);
			const binding = await wrapped.bindInvocation!("receiver", { path: "fixture.txt" });
			await binding.execute("receiver", { path: "fixture.txt" });
			binding.release();
			expect(execute).toHaveBeenCalledOnce();
			expect(release).toHaveBeenCalledOnce();
		},
	);

	it.each([false, true])("retains prototype lease methods through nested guards; execute=%s", async (run) => {
		tool.bindInvocation = async () => new PrototypeInvocation();
		const wrapped = wrapToolWithEnvelopeScope(
			wrapToolWithCredentialExposureGuard(tool, ambient, { redactSensitiveText: (text) => text }),
			{ id: "fixture", capabilities: ["filesystem.read"], allowedPaths: [executionContext.cwd] },
			ambient,
		);
		const binding = await wrapped.bindInvocation!("prototype", { path: "fixture.txt" });
		if (run) await binding.execute("prototype", { path: "fixture.txt" });
		binding.release();
		expect(execute).toHaveBeenCalledTimes(run ? 1 : 0);
		expect(release).toHaveBeenCalledOnce();
		expect(fallback).not.toHaveBeenCalled();
	});

	it("retains decorator receivers for ordinary and admitted execution", async () => {
		const wrapped = wrapToolExecution(
			tool,
			(executor) =>
				new (class {
					name = executor.name;
					label = executor.label;
					description = executor.description;
					parameters = executor.parameters;
					#executor = executor;
					execute(...args: Parameters<typeof executor.execute>) {
						return this.#executor.execute(...args);
					}
				})(),
		);
		await wrapped.execute("ordinary", { path: "fixture.txt" });
		const binding = await wrapped.bindInvocation!("bound", { path: "fixture.txt" });
		await binding.execute("bound", { path: "fixture.txt" });
		binding.release();
		expect(fallback).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(release).toHaveBeenCalledOnce();
	});

	it("releases a prototype-owned lease when decoration fails", async () => {
		tool.bindInvocation = async () => new PrototypeInvocation();
		const wrapped = wrapToolExecution(tool, (executor, context) => {
			if (context) throw new Error("synthetic decoration failure");
			return executor;
		});
		await expect(wrapped.bindInvocation!("rejected", { path: "fixture.txt" })).rejects.toThrow("decoration failure");
		expect(release).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps ordinary tools unbound as a negative control", async () => {
		const wrapped = wrapToolDefinition(createToolDefinitionFromAgentTool({ ...tool, bindInvocation: undefined }));
		expect(wrapped.bindInvocation).toBeUndefined();
		await wrapped.execute("call", { path: "source.ts" });
		expect(fallback).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("checks protected relative paths in the bound directory before execution", async () => {
		const guarded = wrapToolWithCredentialExposureGuard(tool, ambient, {
			redactSensitiveText: (text) => text,
			protectedFiles: [join(executionContext.cwd, "private.json")],
		});
		const binding = await guarded.bindInvocation!("call", { path: "private.json" });
		await expect(binding.execute("call", { path: "private.json" })).rejects.toThrow("model-blind");
		expect(execute).not.toHaveBeenCalled();
		await binding.execute("call", { path: "source.ts" });
		expect(execute).toHaveBeenCalledOnce();
		binding.release();
	});

	it("redacts bound progress, final output and failures without dropping bound recovery", async () => {
		const recovery = { getFailureCorrection: () => "bound correction" };
		tool.bindInvocation = async () => ({ executionContext, execute, release, failureRecovery: recovery });
		const guarded = wrapToolWithCredentialExposureGuard(tool, ambient, {
			redactSensitiveText: (text) => text.replaceAll("fixture-secret", "[redacted]"),
		});
		const binding = await guarded.bindInvocation!("call", { path: "source.ts" });
		const result = {
			content: [{ type: "text" as const, text: "fixture-secret" }],
			details: { nested: "fixture-secret" },
		};
		execute.mockImplementationOnce(async (_id, _params, _signal, update) => {
			update?.(result);
			return result;
		});
		const progress = vi.fn();
		expect(await binding.execute("call", { path: "source.ts" }, undefined, progress)).toEqual({
			content: [{ type: "text", text: "[redacted]" }],
			details: { nested: "[redacted]" },
		});
		expect(progress).toHaveBeenCalledWith({
			content: [{ type: "text", text: "[redacted]" }],
			details: { nested: "[redacted]" },
		});
		execute.mockRejectedValueOnce(new Error("fixture-secret"));
		await expect(binding.execute("call", { path: "source.ts" })).rejects.toThrow("[redacted]");
		expect(binding.failureRecovery?.getFailureCorrection).toBeTypeOf("function");
		binding.release();
	});

	it.each(["path", "composite"] as const)("preserves %s envelope enforcement on bound executors", async (kind) => {
		const envelope: CapabilityEnvelope = {
			id: "fixture",
			capabilities: ["filesystem.read"],
			allowedPaths: [executionContext.cwd],
		};
		const guarded =
			kind === "path"
				? wrapToolWithEnvelopeScope(tool, envelope, ambient)
				: wrapToolWithCapabilityEnvelopeGate(tool, ambient, envelope);
		const binding = await guarded.bindInvocation!("call", { path: "../outside.ts" });
		const denied = () => binding.execute("call", { path: "../outside.ts" });
		if (kind === "path") expect(await denied()).toMatchObject({ isError: true });
		else await expect(denied()).rejects.toThrow("autonomy gate");
		expect(execute).not.toHaveBeenCalled();
		await binding.execute("call", { path: "source.ts" });
		expect(execute).toHaveBeenCalledOnce();
		binding.release();
	});

	it("gates relative tool paths at the admitted directory and exposes it to both extension hooks", async () => {
		const observed: ExtensionContext[] = [];
		for (const event of ["tool_call", "tool_result"]) {
			extension.handlers.set(event, [
				async (_event, context) => {
					observed.push(context as ExtensionContext);
				},
			]);
		}
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => ambient,
			getCapabilityEnvelope: () => ({
				id: "fixture",
				capabilities: ["filesystem.read"],
				allowedPaths: [executionContext.cwd],
			}),
			recordGateOutcome: () => {},
			getExtensionRunner: () => runner,
		});
		const args = { path: "source.ts" };
		const context = {
			toolCall: { type: "toolCall" as const, id: "call", name: "read", arguments: args },
			args,
			tool,
			executionContext,
			assistantMessage: fauxAssistantMessage("fixture"),
			context: { systemPrompt: "fixture", messages: [], tools: [tool] },
		};
		expect(await gate.beforeToolCall(context)).toBeUndefined();
		await gate.afterToolCall({ ...context, result: { content: [], details: {} }, isError: false });
		expect(observed.map((ctx) => ctx.cwd)).toEqual([executionContext.cwd, executionContext.cwd]);
		expect(observed.map((ctx) => ctx.executionContext)).toEqual([executionContext, executionContext]);
		expect(runner.createContext().cwd).toBe(ambient);
	});

	it("retains successful extension identity healing for bound invocations", async () => {
		const schema = Type.Object({ boardId: Type.Optional(Type.String()) });
		const scope = new ExtensionSessionScope();
		const definition = applyExtensionSessionHeal(
			{
				name: "fixture",
				label: "fixture",
				description: "fixture",
				parameters: schema,
				execute: async () => ({ content: [], details: {} }),
				bindInvocation: async () => ({
					executionContext,
					release,
					execute: async () => ({ content: [], details: { boardId: "mock-board" } }),
				}),
			},
			"fixture-owner",
			scope,
		);
		const binding = await definition.bindInvocation!("call", {});
		await binding.execute("call", {});
		expect(scope.get("fixture-owner", "boardId")).toBe("mock-board");
		binding.release();
	});

	it.each(["path", "composite"] as const)(
		"does not relocate relative %s grants when binding a different workspace",
		async (kind) => {
			const envelope: CapabilityEnvelope = { id: "fixture", capabilities: ["filesystem.read"], allowedPaths: ["."] };
			const guarded =
				kind === "path"
					? wrapToolWithEnvelopeScope(tool, envelope, ambient)
					: wrapToolWithCapabilityEnvelopeGate(tool, ambient, envelope);
			const binding = await guarded.bindInvocation!("call", { path: "source.ts" });
			const denied = () => binding.execute("call", { path: "source.ts" });
			if (kind === "path") expect(await denied()).toMatchObject({ isError: true });
			else await expect(denied()).rejects.toThrow("autonomy gate");
			expect(execute).not.toHaveBeenCalled();
			await binding.execute("call", { path: join(ambient, "source.ts") });
			expect(execute).toHaveBeenCalledOnce();
			binding.release();
		},
	);

	it("does not mix concurrent extension contexts or bypass stale-runner checks", async () => {
		const arrived = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const seen: string[] = [];
		const other = captureExecutionContext({ ...executionContext, cwd: ambient, generation: 2 });
		extension.handlers.set("tool_call", [
			async (event, value) => {
				const context = value as ExtensionContext;
				if ((event as { toolCallId: string }).toolCallId === "first") {
					arrived.resolve();
					await resume.promise;
				}
				seen.push(context.cwd);
			},
		]);
		const first = runner.emitToolCall(
			{ type: "tool_call", toolCallId: "first", toolName: "read", input: { path: "x" } },
			executionContext,
		);
		await arrived.promise;
		await runner.emitToolCall(
			{ type: "tool_call", toolCallId: "second", toolName: "read", input: { path: "x" } },
			other,
		);
		resume.resolve();
		await first;
		expect(seen).toEqual([ambient, executionContext.cwd]);
		const retained = runner.createContext(executionContext);
		runner.retire("retired fixture");
		expect(() => retained.cwd).toThrow("retired fixture");
		expect(() => retained.executionContext).toThrow("retired fixture");
	});

	it("composes nested guards with one acquisition and releases a rejected decoration", async () => {
		const bind = vi.fn(tool.bindInvocation!);
		tool.bindInvocation = bind;
		const decorated = wrapToolWithEnvelopeScope(
			wrapToolWithCredentialExposureGuard(tool, ambient, {
				redactSensitiveText: (text) => text,
			}),
			{ id: "fixture", capabilities: ["filesystem.read"], allowedPaths: [executionContext.cwd] },
			ambient,
		);
		const binding = await decorated.bindInvocation!("call", { path: "source.ts" });
		await expect(binding.execute("call", { path: ".env" })).rejects.toThrow("model-blind");
		await binding.execute("call", { path: "source.ts" });
		expect(bind).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(release).not.toHaveBeenCalled();
		binding.release();
		expect(release).toHaveBeenCalledOnce();
		const broken = wrapToolExecution(tool, (executor, context) => {
			if (context) throw new Error("fixture decorator failed");
			return executor;
		});
		await expect(broken.bindInvocation!("call", { path: "source.ts" })).rejects.toThrow("fixture decorator failed");
		expect(release).toHaveBeenCalledTimes(2);
		expect(execute).toHaveBeenCalledOnce();
	});

	it("captures mutable backend metadata before guards close over it", async () => {
		const mutable = { ...executionContext };
		tool.bindInvocation = async () => ({ executionContext: mutable, execute, release });
		const guarded = wrapToolWithCredentialExposureGuard(tool, ambient, {
			redactSensitiveText: (text) => text,
			protectedFiles: [join(executionContext.cwd, "private.json")],
		});
		const binding = await guarded.bindInvocation!("call", { path: "private.json" });
		mutable.cwd = ambient;
		expect(binding.executionContext.cwd).toBe(executionContext.cwd);
		await expect(binding.execute("call", { path: "private.json" })).rejects.toThrow("model-blind");
		expect(execute).not.toHaveBeenCalled();
		binding.release();
	});

	it("rechecks hook-edited arguments against the same admitted authority", async () => {
		extension.handlers.set("tool_call", [
			async (event) => {
				(event as { input: { path: string } }).input.path = "../outside.ts";
			},
		]);
		const gate = new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => ambient,
			getCapabilityEnvelope: () => ({
				id: "fixture",
				capabilities: ["filesystem.read"],
				allowedPaths: [executionContext.cwd],
			}),
			recordGateOutcome: () => {},
			getExtensionRunner: () => runner,
		});
		const args = { path: "source.ts" };
		const result = await gate.beforeToolCall({
			toolCall: { type: "toolCall", id: "call", name: "read", arguments: args },
			args,
			executionContext,
			assistantMessage: fauxAssistantMessage("fixture"),
			context: { systemPrompt: "fixture", messages: [], tools: [tool] },
		});
		expect(result).toMatchObject({ block: true });
		expect(result?.reason).toContain("path_scope");
	});

	it("keeps the invocation recovery contract when applying an outer path guard", async () => {
		const recovery = { getFailureCorrection: () => "bound correction" };
		tool.failureRecovery = { getFailureCorrection: () => "ambient correction" };
		tool.bindInvocation = async () => ({ executionContext, execute, release, failureRecovery: recovery });
		const guarded = wrapToolWithEnvelopeScope(tool, { id: "fixture", capabilities: ["filesystem.read"] }, ambient);
		const binding = await guarded.bindInvocation!("call", { path: "source.ts" });
		expect(binding.failureRecovery).toBe(recovery);
		binding.release();
	});

	it.each([
		["source.ts", false],
		[".env", false],
		["source.ts", true],
		[".env", true],
	] as const)(
		"runs the definition-first AgentSession registry with the bound %s call; prototype=%s",
		async (path, prototype) => {
			if (prototype) tool.bindInvocation = async () => new PrototypeInvocation();
			const harness = await createHarness({ tools: [tool], settings: { modelCapability: { mode: "off" } } });
			try {
				harness.session.capabilityEnvelope = {
					id: "fixture",
					capabilities: ["filesystem.read"],
					allowedPaths: [executionContext.cwd],
				};
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
					fauxAssistantMessage("fixture done"),
				]);
				await harness.session.prompt("Exercise the synthetic bound reader");
				const result = harness.session.agent.state.messages.find((message) => message.role === "toolResult");
				expect(result).toMatchObject({ isError: path === ".env" });
				expect(execute).toHaveBeenCalledTimes(path === ".env" ? 0 : 1);
				expect(fallback).not.toHaveBeenCalled();
				expect(release).toHaveBeenCalledOnce();
			} finally {
				await harness.cleanup();
			}
		},
	);
});
