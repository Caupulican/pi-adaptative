import { afterEach, describe, expect, it, vi } from "vitest";
import { createPythonTool, type PythonExecutionRequest } from "../src/core/tools/python.ts";

afterEach(() => vi.restoreAllMocks());

function backend(cwd: string, flavor: "posix" | "win32") {
	const calls: PythonExecutionRequest[] = [];
	const stat = vi.fn(async (path: string) => ({
		isDirectory: () => path === cwd,
		isFile: () => path !== cwd,
	}));
	const resolveRuntime = vi.fn(async () => ({
		status: "ready" as const,
		pythonPath: "backend-python",
		uvPath: "backend-uv",
		pythonInstalled: false,
	}));
	const exec = vi.fn(async (request: PythonExecutionRequest) => {
		calls.push(request);
		return { exitCode: 0, reason: "exited" as const, signal: null };
	});
	const options = {
		pathOptions: { flavor },
		operations: { stat, exec, getEnvironment: async () => ({ variables: {}, caseSensitive: flavor !== "win32" }) },
		resolveRuntime,
		outputReduction: { enabled: false },
	};
	return { cwd, calls, stat, resolveRuntime, exec, options, tool: createPythonTool(cwd, options) };
}

describe("Python backend preflight", () => {
	it.each([
		{ cwd: "/synthetic workspace/é ", flavor: "posix" as const, script: "/synthetic workspace/é /@script.py" },
		{
			cwd: "Q:\\synthetic workspace\\é ",
			flavor: "win32" as const,
			script: "Q:\\synthetic workspace\\é \\@script.py",
		},
		{ cwd: "\\\\fixture-host\\share\\é", flavor: "win32" as const, script: "\\\\fixture-host\\share\\é\\@script.py" },
	])("uses the $flavor backend for cwd, literal script names and execution", async ({ cwd, flavor, script }) => {
		const fixture = backend(cwd, flavor);
		await fixture.tool.execute("script", { scriptPath: "@script.py", args: ["literal $(text)", "é"] });
		expect(fixture.stat.mock.calls.map(([path]) => path)).toEqual([cwd, script]);
		expect(fixture.calls[0]).toMatchObject({
			cwd,
			python: "backend-python",
			args: ["-B", script, "literal $(text)", "é"],
		});
	});

	it.each(["EACCES", "EIO", "ELOOP"])("retains %s instead of misreporting a missing resource", async (code) => {
		const fixture = backend("/synthetic", "posix");
		const error = Object.assign(new Error("synthetic backend failure"), { code });
		fixture.stat.mockRejectedValueOnce(error);
		await expect(fixture.tool.execute("failure", { code: "pass" })).rejects.toBe(error);
		expect(fixture.resolveRuntime).not.toHaveBeenCalled();
		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it("rejects cancellation before any backend preflight or runtime provisioning", async () => {
		const fixture = backend("/synthetic", "posix");
		const controller = new AbortController();
		controller.abort();
		await expect(fixture.tool.execute("aborted", { code: "pass" }, controller.signal)).rejects.toThrow(/abort/i);
		expect(fixture.stat).not.toHaveBeenCalled();
		expect(fixture.resolveRuntime).not.toHaveBeenCalled();
		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it("does not provision a runtime after cancellation during backend stat", async () => {
		const fixture = backend("/synthetic", "posix");
		const controller = new AbortController();
		fixture.stat.mockImplementationOnce(async () => {
			controller.abort();
			return { isDirectory: () => true, isFile: () => false };
		});
		await expect(fixture.tool.execute("aborted", { code: "pass" }, controller.signal)).rejects.toThrow(/abort/i);
		expect(fixture.resolveRuntime).not.toHaveBeenCalled();
		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it("does not execute after cancellation while awaiting runtime discovery", async () => {
		const fixture = backend("/synthetic", "posix");
		const controller = new AbortController();
		fixture.resolveRuntime.mockImplementationOnce(async () => {
			controller.abort();
			return { status: "ready", pythonPath: "backend-python", uvPath: "backend-uv", pythonInstalled: false };
		});
		await expect(fixture.tool.execute("aborted", { code: "pass" }, controller.signal)).rejects.toThrow(/abort/i);
		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it("requires an explicitly selected runtime for custom execution operations", () => {
		const fixture = backend("/synthetic", "posix");
		expect(() => createPythonTool(fixture.cwd, { ...fixture.options, resolveRuntime: undefined })).toThrow(
			/runtime/i,
		);
	});

	it("treats whitespace-only POSIX script names as literal paths", async () => {
		const fixture = backend("/synthetic", "posix");
		await fixture.tool.execute("space-name", { scriptPath: " " });
		expect(fixture.calls[0].args).toEqual(["-B", "/synthetic/ "]);
	});

	it.each(["ENOENT", "ENOTDIR"])("labels missing resources while retaining the %s cause", async (code) => {
		const fixture = backend("/synthetic", "posix");
		const cause = Object.assign(new Error("fixture missing"), { code });
		fixture.stat.mockRejectedValueOnce(cause);
		await expect(fixture.tool.execute("missing", { code: "pass" })).rejects.toMatchObject({
			message: "cwd does not exist: /synthetic",
			cause,
		});
		expect(fixture.exec).not.toHaveBeenCalled();
	});

	it.each(["cwd", "script"])("rejects a wrong-kind %s before runtime discovery", async (kind) => {
		const fixture = backend("/synthetic", "posix");
		if (kind === "script") fixture.stat.mockResolvedValueOnce({ isDirectory: () => true, isFile: () => false });
		fixture.stat.mockResolvedValueOnce({ isDirectory: () => false, isFile: () => false });
		await expect(fixture.tool.execute("wrong-kind", { scriptPath: "file.py" })).rejects.toThrow(/is not a/);
		expect(fixture.resolveRuntime).not.toHaveBeenCalled();
	});

	it("resolves changed cwd and script against a frozen backend dialect", async () => {
		const fixture = backend("/synthetic", "posix");
		fixture.options.pathOptions.flavor = "win32";
		fixture.stat.mockImplementation(async (path) => ({
			isDirectory: () => path === "/synthetic/sub é",
			isFile: () => path === "/synthetic/script.py",
		}));
		await fixture.tool.execute("changed-cwd", { cwd: "sub é", scriptPath: "../script.py" });
		expect(fixture.calls[0]).toMatchObject({ cwd: "/synthetic/sub é", args: ["-B", "/synthetic/script.py"] });
	});

	it("settles a canceled runtime wait while provisioning remains pending", async () => {
		const fixture = backend("/synthetic", "posix");
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof fixture.resolveRuntime>>>();
		const entered = Promise.withResolvers<void>();
		fixture.resolveRuntime.mockImplementationOnce(() => {
			entered.resolve();
			return pending.promise;
		});
		const controller = new AbortController();
		const result = fixture.tool.execute("pending-runtime", { code: "pass" }, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(result).rejects.toThrow(/abort/i);
		pending.reject(new Error("late provisioning failure"));
		expect(fixture.exec).not.toHaveBeenCalled();
	});
});
