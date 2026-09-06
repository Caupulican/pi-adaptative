import { afterEach, describe, expect, it, vi } from "vitest";
import { withExclusiveMutationBarrier } from "../src/core/tools/file-mutation-queue.ts";
import { createPythonTool, type PythonExecutionRequest } from "../src/core/tools/python.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function fixture(environment: { variables: NodeJS.ProcessEnv; caseSensitive: boolean }) {
	const getEnvironment = vi.fn(async (_cwd: string, _signal?: AbortSignal) => environment);
	const requests: PythonExecutionRequest[] = [];
	const options = {
		pathOptions: { flavor: "posix" as const },
		outputReduction: { enabled: false },
		resolveRuntime: async () => ({
			status: "ready" as const,
			pythonPath: "/backend/python",
			uvPath: "/backend/uv",
			pythonInstalled: false,
		}),
		operations: {
			getEnvironment,
			readOutputRules: async () => [],
			stat: async () => ({ isDirectory: () => true, isFile: () => true }),
			exec: async (request: PythonExecutionRequest) => {
				requests.push(request);
				return { exitCode: 0, reason: "exited" as const, signal: null };
			},
		},
	};
	return { getEnvironment, requests, options };
}

describe("Python execution environment ownership", () => {
	it("retains native inheritance only through the local adapter", async () => {
		vi.stubEnv("PI_FIXTURE_NATIVE", "synthetic-native");
		const result = await createPythonTool(process.cwd(), {
			outputReduction: { enabled: false },
			resolveRuntime: async () => ({
				status: "ready",
				pythonPath: process.platform === "win32" ? "python" : "python3",
				uvPath: "synthetic-unused",
				pythonInstalled: false,
			}),
		}).execute("native", { code: "import os; print(os.environ['PI_FIXTURE_NATIVE'], end='')" });
		expect(result.content[0]).toEqual({ type: "text", text: "synthetic-native\n\n[python exitCode=0]" });
	});

	it("uses only backend variables and explicit additions, without mutating either input", async () => {
		vi.stubEnv("PI_FIXTURE_HOST_ONLY", "synthetic-host-value");
		const base = Object.freeze({ PI_FIXTURE_BACKEND: "backend", PI_FIXTURE_VALUE: "base" });
		const additions = Object.freeze({ PI_FIXTURE_VALUE: "activated", PI_FIXTURE_TEXT: "é\r\n " });
		const backend = fixture({ variables: base, caseSensitive: true });
		const environment = vi.fn(() => additions);
		await createPythonTool("/backend", { ...backend.options, environment }).execute("run", {
			cwd: "sub é",
			code: "pass",
		});
		const sent = backend.requests[0].env;
		expect(sent.PI_FIXTURE_HOST_ONLY).toBeUndefined();
		expect(sent.PI_FIXTURE_BACKEND).toBe("backend");
		expect(sent.PI_FIXTURE_VALUE).toBe("activated");
		expect(sent.PI_FIXTURE_TEXT).toBe("é\r\n ");
		expect(base.PI_FIXTURE_VALUE).toBe("base");
		expect(backend.getEnvironment.mock.calls[0][0]).toBe("/backend/sub é");
		expect(environment.mock.calls).toHaveLength(1);
	});

	it.each([false, true])(
		"uses the backend's environment case policy, independent of path syntax: %s",
		async (caseSensitive) => {
			const backend = fixture({ variables: { PI_FIXTURE_VALUE: "base" }, caseSensitive });
			await createPythonTool("/backend", {
				...backend.options,
				environment: () => ({ pi_fixture_value: "activated", pi_fixture_owner: "must-be-omitted" }),
				omitEnvironmentVariables: ["PI_FIXTURE_OWNER"],
			}).execute("run", { code: "pass" });
			const sent = backend.requests[0].env;
			expect(sent.PI_FIXTURE_VALUE).toBe(caseSensitive ? "base" : undefined);
			expect(sent.pi_fixture_value).toBe("activated");
			expect(sent.pi_fixture_owner).toBe(caseSensitive ? "must-be-omitted" : undefined);
		},
	);

	it("preserves backend lookup failure and never starts execution", async () => {
		const backend = fixture({ variables: {}, caseSensitive: true });
		const failure = new Error("synthetic environment unavailable");
		backend.getEnvironment.mockRejectedValueOnce(failure);
		await expect(createPythonTool("/backend", backend.options).execute("run", { code: "pass" })).rejects.toBe(
			failure,
		);
		expect(backend.requests).toHaveLength(0);
	});

	it("honors cancellation during environment lookup before credential activation or execution", async () => {
		const backend = fixture({ variables: {}, caseSensitive: true });
		const controller = new AbortController();
		backend.getEnvironment.mockImplementationOnce(async () => {
			controller.abort();
			return { variables: {}, caseSensitive: true };
		});
		const environment = vi.fn(() => ({}));
		await expect(
			createPythonTool("/backend", { ...backend.options, environment }).execute(
				"run",
				{ code: "pass" },
				controller.signal,
			),
		).rejects.toThrow(/abort/i);
		expect(environment).not.toHaveBeenCalled();
		expect(backend.requests).toHaveLength(0);
	});

	it("does not execute if credential activation cancels the call", async () => {
		const backend = fixture({ variables: {}, caseSensitive: true });
		const controller = new AbortController();
		const environment = () => {
			controller.abort();
			return {};
		};
		await expect(
			createPythonTool("/backend", { ...backend.options, environment }).execute(
				"run",
				{ code: "pass" },
				controller.signal,
			),
		).rejects.toThrow(/abort/i);
		expect(backend.requests).toHaveLength(0);
	});

	it("detaches a canceled pending environment lookup and handles its late rejection", async () => {
		const backend = fixture({ variables: {}, caseSensitive: true });
		const pending = Promise.withResolvers<Awaited<ReturnType<typeof backend.getEnvironment>>>();
		const entered = Promise.withResolvers<void>();
		backend.getEnvironment.mockImplementationOnce(() => {
			entered.resolve();
			return pending.promise;
		});
		const controller = new AbortController();
		const result = createPythonTool("/backend", backend.options).execute("run", { code: "pass" }, controller.signal);
		await entered.promise;
		controller.abort();
		await expect(result).rejects.toThrow(/abort/i);
		pending.reject(new Error("late synthetic failure"));
		expect(backend.requests).toHaveLength(0);
	});

	it("detaches the backend snapshot while waiting for the mutation barrier", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const captured = Promise.withResolvers<void>();
		let value = "admitted";
		const variables = {
			get PI_FIXTURE_VALUE() {
				captured.resolve();
				return value;
			},
		};
		const backend = fixture({ variables, caseSensitive: true });
		const held = withExclusiveMutationBarrier(async () => {
			entered.resolve();
			await release.promise;
		});
		await entered.promise;
		const result = createPythonTool("/backend", backend.options).execute("run", { code: "pass" });
		try {
			await captured.promise;
			value = "changed after admission";
		} finally {
			release.resolve();
		}
		await held;
		await result;
		expect(backend.requests[0].env.PI_FIXTURE_VALUE).toBe("admitted");
	});
});
