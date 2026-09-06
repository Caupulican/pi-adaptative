import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withExclusiveMutationBarrier } from "../src/core/tools/file-mutation-queue.ts";
import { createPythonTool, type PythonExecutionRequest } from "../src/core/tools/python.ts";

const directories: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function rules(keep: string) {
	return [{ name: "fixture-python", tools: ["python"], match: "^python$", keepLinesMatching: [`^${keep}$`] }];
}

async function fixture() {
	vi.stubEnv("PI_TOOL_FILTER_DISABLED", "0");
	const directory = await mkdtemp(join(tmpdir(), "pi-python-rules-"));
	directories.push(directory);
	const project = join(directory, "project é");
	const agentDir = join(directory, "operator");
	await mkdir(join(project, ".pi"), { recursive: true });
	await mkdir(agentDir);
	await writeFile(join(project, ".pi", "output-filters.json"), JSON.stringify(rules("local")));
	const readOutputRules = vi.fn(async (_path: string, _signal?: AbortSignal): Promise<unknown> => rules("backend"));
	const exec = vi.fn(async (request: PythonExecutionRequest) => {
		request.onStdout(Buffer.from("local\nbackend\noperator\nextra\n"));
		return { exitCode: 0, reason: "exited" as const, signal: null };
	});
	const options = {
		outputDirectory: directory,
		outputReduction: { agentDir },
		resolveRuntime: async () => ({
			status: "ready" as const,
			pythonPath: "fixture-python",
			uvPath: "fixture-uv",
			pythonInstalled: false,
		}),
		operations: {
			readOutputRules,
			stat: async () => ({ isDirectory: () => true, isFile: () => true }),
			getEnvironment: async () => ({ variables: {}, caseSensitive: true }),
			exec,
		},
	};
	return { directory, project, agentDir, readOutputRules, exec, options };
}

describe("Python project output-rule ownership", () => {
	it("uses backend rules when an unrelated operator project has the same path", async () => {
		const f = await fixture();
		const result = await createPythonTool(f.project, f.options).execute("run", { code: "pass" });
		expect(result.content[0]).toEqual({
			type: "text",
			text: "backend\n\n[python output filtered: retained 1 of 4 lines.]\n\n[python exitCode=0]",
		});
		expect(f.readOutputRules).toHaveBeenCalledWith(join(f.project, ".pi", "output-filters.json"), undefined);
	});

	it("keeps native project rules on the native filesystem", async () => {
		const f = await fixture();
		const result = await createPythonTool(f.project, {
			...f.options,
			operations: undefined,
			resolveRuntime: async () => ({
				status: "ready",
				pythonPath: process.platform === "win32" ? "python" : "python3",
				uvPath: "unused-fixture",
				pythonInstalled: false,
			}),
		}).execute("native", { code: "print('local\\nbackend')" });
		expect(result.content[0]).toEqual({
			type: "text",
			text: "local\n\n[python output filtered: retained 1 of 2 lines.]\n\n[python exitCode=0]",
		});
		expect(f.readOutputRules).not.toHaveBeenCalled();
	});

	it("allows fullOutput to recover from a broken project filter without any rule I/O", async () => {
		const f = await fixture();
		await writeFile(join(f.project, ".pi", "output-filters.json"), "not JSON");
		f.readOutputRules.mockRejectedValue(new Error("unreadable backend filter"));
		const result = await createPythonTool(f.project, f.options).execute("raw", { code: "pass", fullOutput: true });
		expect(result.content[0]).toEqual({
			type: "text",
			text: "local\nbackend\noperator\nextra\n\n[python exitCode=0]",
		});
		expect(f.readOutputRules).not.toHaveBeenCalled();
	});

	it.each([
		{ cwd: "/fixture/é ", flavor: "posix" as const, expected: "/fixture/é /.pi/output-filters.json" },
		{ cwd: "Q:\\fixture é", flavor: "win32" as const, expected: "Q:\\fixture é\\.pi\\output-filters.json" },
		{
			cwd: "\\\\fixture-host\\share\\é",
			flavor: "win32" as const,
			expected: "\\\\fixture-host\\share\\é\\.pi\\output-filters.json",
		},
	])("resolves $flavor project rules from the tool root, not a per-call cwd", async ({ cwd, flavor, expected }) => {
		const f = await fixture();
		await createPythonTool(cwd, { ...f.options, pathOptions: { flavor } }).execute("subdirectory", {
			code: "pass",
			cwd: "sub",
		});
		expect(f.readOutputRules).toHaveBeenCalledWith(expected, undefined);
	});

	it("preserves operator, backend project, and explicit extra-file precedence", async () => {
		const f = await fixture();
		await writeFile(join(f.agentDir, "output-filters.json"), JSON.stringify(rules("operator")));
		const extra = join(f.directory, "extra.json");
		await writeFile(extra, JSON.stringify(rules("extra")));
		for (const useExtra of [false, true]) {
			const result = await createPythonTool(f.project, {
				...f.options,
				outputReduction: { agentDir: f.agentDir, rulesFiles: useExtra ? [extra] : [] },
			}).execute("precedence", { code: "pass" });
			expect(result.content[0]).toMatchObject({ text: expect.stringMatching(useExtra ? /^extra\n/ : /^backend\n/) });
		}
	});

	it.each(["ENOENT", "ENOTDIR"])("ignores only absent backend rules (%s), retaining operator rules", async (code) => {
		const f = await fixture();
		await writeFile(join(f.agentDir, "output-filters.json"), JSON.stringify(rules("operator")));
		f.readOutputRules.mockRejectedValue(Object.assign(new Error("fixture absent"), { code }));
		const result = await createPythonTool(f.project, f.options).execute("missing", { code: "pass" });
		expect(result.content[0]).toMatchObject({ text: expect.stringMatching(/^operator\n/) });
	});

	it.each(["EACCES", "EIO", "ELOOP"])("retains %s without executing or substituting local rules", async (code) => {
		const f = await fixture();
		const failure = Object.assign(new Error("fixture backend failure"), { code });
		f.readOutputRules.mockRejectedValue(failure);
		await expect(createPythonTool(f.project, f.options).execute("failure", { code: "pass" })).rejects.toBe(failure);
		expect(f.exec).not.toHaveBeenCalled();
	});

	it("validates backend documents centrally and admits a repaired file on the next call", async () => {
		const f = await fixture();
		f.readOutputRules.mockResolvedValueOnce({ rules: [{ name: "fixture-bad", match: "(" }] });
		const tool = createPythonTool(f.project, f.options);
		expect(f.readOutputRules).not.toHaveBeenCalled();
		await expect(tool.execute("bad", { code: "pass" })).rejects.toThrow(/fixture-bad/);
		expect(f.exec).not.toHaveBeenCalled();
		const repaired = await tool.execute("repaired", { code: "pass" });
		expect(repaired.content[0]).toMatchObject({ text: expect.stringMatching(/^backend\n/) });
		f.readOutputRules.mockResolvedValueOnce(rules("extra"));
		const changed = await tool.execute("changed", { code: "pass" });
		expect(changed.content[0]).toMatchObject({ text: expect.stringMatching(/^extra\n/) });
	});

	it.each(["settings", "environment"])("skips all rule sources when disabled through %s", async (mode) => {
		const f = await fixture();
		await writeFile(join(f.agentDir, "output-filters.json"), "bad JSON");
		if (mode === "environment") vi.stubEnv("PI_TOOL_FILTER_DISABLED", "1");
		const result = await createPythonTool(f.project, {
			...f.options,
			outputReduction: { agentDir: f.agentDir, enabled: mode !== "settings" },
		}).execute("disabled", { code: "pass" });
		expect(result.content[0]).toMatchObject({ text: "local\nbackend\noperator\nextra\n\n[python exitCode=0]" });
		expect(f.readOutputRules).not.toHaveBeenCalled();
	});

	it("cancels a pending backend read without holding the mutation barrier or losing late failure", async () => {
		const f = await fixture();
		const pending = Promise.withResolvers<unknown>();
		const entered = Promise.withResolvers<void>();
		f.readOutputRules.mockImplementationOnce(() => {
			entered.resolve();
			return pending.promise;
		});
		const controller = new AbortController();
		const result = createPythonTool(f.project, f.options).execute("pending", { code: "pass" }, controller.signal);
		await entered.promise;
		try {
			await withExclusiveMutationBarrier(async () => {});
		} finally {
			controller.abort();
		}
		await expect(result).rejects.toThrow(/abort/i);
		pending.reject(new Error("late synthetic rules failure"));
		expect(f.readOutputRules).toHaveBeenCalledWith(join(f.project, ".pi", "output-filters.json"), controller.signal);
		expect(f.exec).not.toHaveBeenCalled();
	});

	it("prevents runtime provisioning when cancellation occurs inside the rule reader", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const resolveRuntime = vi.fn(f.options.resolveRuntime);
		f.readOutputRules.mockImplementationOnce(async () => {
			controller.abort();
			return [];
		});
		await expect(
			createPythonTool(f.project, { ...f.options, resolveRuntime }).execute(
				"cancel",
				{ code: "pass" },
				controller.signal,
			),
		).rejects.toThrow(/abort/i);
		expect(resolveRuntime).not.toHaveBeenCalled();
		expect(f.exec).not.toHaveBeenCalled();
	});

	it("names malformed native JSON before provisioning and allows an unfiltered recovery call", async () => {
		const f = await fixture();
		const path = join(f.project, ".pi", "output-filters.json");
		await writeFile(path, "invalid JSON");
		const resolveRuntime = vi.fn(async () => ({
			status: "ready" as const,
			pythonPath: process.platform === "win32" ? "python" : "python3",
			uvPath: "unused-fixture",
			pythonInstalled: false,
		}));
		const tool = createPythonTool(f.project, { ...f.options, operations: undefined, resolveRuntime });
		await expect(tool.execute("invalid-json", { code: "pass" })).rejects.toMatchObject({
			message: `${path}: invalid output rules JSON`,
			cause: expect.any(SyntaxError),
		});
		expect(resolveRuntime).not.toHaveBeenCalled();
		const result = await tool.execute("raw", { code: "print('recovery')", fullOutput: true });
		expect(result.content[0]).toMatchObject({ text: "recovery\n\n[python exitCode=0]" });
	});

	it("does not mistake an invalid backend response for a missing file", async () => {
		const f = await fixture();
		f.readOutputRules.mockResolvedValue(undefined);
		await expect(
			createPythonTool(f.project, f.options).execute("invalid-document", { code: "pass" }),
		).rejects.toThrow(/expected.*rules/);
		expect(f.exec).not.toHaveBeenCalled();
	});

	it("requires the backend rule reader instead of silently installing a native fallback", async () => {
		const f = await fixture();
		Reflect.deleteProperty(f.options.operations, "readOutputRules");
		expect(() => createPythonTool(f.project, f.options)).toThrow(/output-rule reads/);
	});
});
