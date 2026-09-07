import { realpathSync } from "node:fs";
import { type AgentTool, captureExecutionContext } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractToolPathArguments } from "../src/core/autonomy/envelope-enforcement.ts";
import {
	type CredentialExposureBoundary,
	wrapToolWithCredentialExposureGuard,
} from "../src/core/secrets/credential-exposure-guard.ts";
import type { CredentialPathProbe } from "../src/core/secrets/credential-path-policy.ts";

const parameters = Type.Record(Type.String(), Type.Unknown());
const cases = [
	{ flavor: "win32", root: "D:\\synthetic\\project", path: "D:\\synthetic\\project\\.env.local", blocked: true },
	{ flavor: "win32", root: "D:\\synthetic\\project", path: "D:\\synthetic\\project\\source.ts", blocked: false },
	{ flavor: "posix", root: "/synthetic/project", path: "/synthetic/project/ordinary\\.env.local", blocked: false },
	{ flavor: "posix", root: "/synthetic/project", path: "/synthetic/project/.env.local", blocked: true },
	{ flavor: "win32", root: "D:\\synthetic\\project", path: "D:\\synthetic\\project\\.ENV.LOCAL", blocked: true },
] as const;

afterEach(() => vi.restoreAllMocks());

function fixture(flavor: "posix" | "win32", root: string, boundary?: CredentialExposureBoundary, name = "read") {
	const execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "Synthetic only" }],
		details: {},
	}));
	const release = vi.fn();
	const context = captureExecutionContext({
		sessionId: "synthetic-session",
		generation: 1,
		cwd: root,
		attachment: {
			workspaceId: "synthetic",
			attachmentId: "synthetic-backend",
			root,
			flavor,
			caseSensitive: flavor === "posix",
		},
	});
	const tool: AgentTool<typeof parameters> = {
		name,
		label: "Read",
		description: "Synthetic reader; no filesystem access",
		parameters,
		execute,
		bindInvocation: async () => ({ executionContext: context, execute, release }),
	};
	const guarded = wrapToolWithCredentialExposureGuard(
		tool,
		"/synthetic/operator",
		boundary ?? { redactSensitiveText: (text) => text },
	);
	return {
		execute,
		release,
		context,
		async run(params: Record<string, unknown>, signal?: AbortSignal) {
			const invocation = await guarded.bindInvocation!("synthetic-call", params);
			try {
				return await invocation.execute("synthetic-call", params, signal);
			} finally {
				invocation.release();
			}
		},
	};
}

describe("backend-owned credential paths", () => {
	it.each(cases)("uses $flavor semantics for $path", async ({ flavor, root, path, blocked }) => {
		const test = fixture(flavor, root);
		if (blocked) await expect(test.run({ path })).rejects.toThrow("model-blind");
		else await test.run({ path });
		expect(test.execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
		expect(test.release).toHaveBeenCalledOnce();
	});

	it.each(["file.txt ", " file.txt", " ", "chapter\u202f1.txt"])(
		"preserves literal path bytes in the shared permission projection: %j",
		(path) => {
			expect(extractToolPathArguments("read", { path })).toEqual([path]);
			expect(extractToolPathArguments("read", { paths: [path] })).toEqual([path]);
		},
	);

	it("keeps a protected trailing-space filename distinct from its ordinary namesake", async () => {
		const test = fixture("posix", "/synthetic/project", {
			redactSensitiveText: (text) => text,
			protectedFiles: ["/synthetic/project/private.json "],
		});
		await expect(test.run({ path: "private.json " })).rejects.toThrow("model-blind");
		await test.run({ path: "private.json" });
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it("uses explicit backend facts, including their method receiver, without probing native namesakes", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const flavor = process.platform === "win32" ? "win32" : "posix";
		const root = flavor === "win32" ? "D:\\synthetic\\project" : "/synthetic/project";
		const separator = flavor === "win32" ? "\\" : "/";
		class Probe implements CredentialPathProbe {
			#aliases = new Map([[`${root}${separator}alias`, `${root}${separator}.env.local`]]);
			canonicalPath(path: string) {
				return this.#aliases.get(path);
			}
			isFile() {
				return true;
			}
		}
		const probe = new Probe();
		const getPathProbe = vi.fn(() => probe);
		const test = fixture(flavor, root, { redactSensitiveText: (text) => text, getPathProbe });
		await expect(test.run({ path: "alias" })).rejects.toThrow("model-blind");
		await test.run({ path: "source.ts" });
		expect(getPathProbe).toHaveBeenCalledWith(test.context);
		expect(native).not.toHaveBeenCalled();
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it("does not replace a failed backend file-kind probe with suffix-based permission", async () => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text.replaceAll("SYNTHETIC_PRIVATE", "[redacted]"),
				getPathProbe: () => ({
					canonicalPath: () => undefined,
					isFile: () => {
						throw Object.assign(new Error("SYNTHETIC_PRIVATE backend denied"), { code: "EACCES" });
					},
				}),
			},
			"run_process",
		);
		await expect(test.run({ executable: "rg", args: ["needle", "source.ts"] })).rejects.toThrow(
			"[redacted] backend denied",
		);
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("redacts backend canonicalization failures and never falls back to the operator filesystem", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const test = fixture("posix", "/synthetic/project", {
			redactSensitiveText: (text) => text.replaceAll("SYNTHETIC_PRIVATE", "[redacted]"),
			getPathProbe: () => ({
				canonicalPath: () => {
					throw new Error("SYNTHETIC_PRIVATE backend unavailable");
				},
				isFile: () => true,
			}),
		});
		await expect(test.run({ path: "source.ts" })).rejects.toThrow("[redacted] backend unavailable");
		expect(native).not.toHaveBeenCalled();
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("does not acquire probe facts or execute after cancellation", async () => {
		const getPathProbe = vi.fn(() => ({ canonicalPath: () => undefined, isFile: () => true }));
		const test = fixture("posix", "/synthetic/project", { redactSensitiveText: (text) => text, getPathProbe });
		await expect(
			test.run({ path: "source.ts" }, AbortSignal.abort(new Error("synthetic cancellation"))),
		).rejects.toThrow("synthetic cancellation");
		expect(getPathProbe).not.toHaveBeenCalled();
		expect(test.execute).not.toHaveBeenCalled();
		expect(test.release).toHaveBeenCalledOnce();
	});

	it.each(["ENOENT", "ENOTDIR"])("retains explicit missing-file recovery for %s", async (code) => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text,
				getPathProbe: () => ({
					canonicalPath: () => undefined,
					isFile: () => {
						throw Object.assign(new Error("synthetic missing path"), { code });
					},
				}),
			},
			"run_process",
		);
		await test.run({ executable: "rg", args: ["needle", "source.ts"] });
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it("does not treat a directory with a filename suffix as a missing file", async () => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text,
				getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => false }),
			},
			"run_process",
		);
		await expect(test.run({ executable: "rg", args: ["needle", "source.ts"] })).rejects.toThrow("narrow non-dotenv");
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("checks cancellation again when probe acquisition cancels the invocation", async () => {
		const abort = new AbortController();
		const test = fixture("posix", "/synthetic/project", {
			redactSensitiveText: (text) => text,
			getPathProbe: () => {
				abort.abort(new Error("synthetic cancellation"));
				return { canonicalPath: () => undefined, isFile: () => true };
			},
		});
		await expect(test.run({ path: "source.ts" }, abort.signal)).rejects.toThrow("synthetic cancellation");
		expect(test.execute).not.toHaveBeenCalled();
		expect(test.release).toHaveBeenCalledOnce();
	});

	it.each([
		{ name: "run_process", params: { executable: "printf", args: ["x:y"] } },
		{ name: "run_process", params: { executable: "rg", args: ["x:y", "source.ts"] } },
		{ name: "python", params: { code: "print('x:y'); open('source.ts').read()" } },
		{ name: "powershell", params: { command: "Get-Content source.ts | Select-String 'x:y'" } },
	])("does not turn opaque $name text into a drive-relative file request", async ({ name, params }) => {
		const test = fixture(
			"win32",
			"D:\\synthetic\\project",
			{
				redactSensitiveText: (text) => text,
				getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => true }),
			},
			name,
		);
		await test.run(params);
		expect(test.execute).toHaveBeenCalledOnce();
	});

	it.each(["D:.env.local", "D:private.json", "D:private\\file.txt"])(
		"retains conservative credential screening for opaque %s",
		async (path) => {
			const test = fixture(
				"win32",
				"D:\\synthetic\\project",
				{
					redactSensitiveText: (text) => text,
					protectedFiles: ["D:\\synthetic\\project\\private.json"],
					protectedDirectories: ["D:\\synthetic\\project\\private"],
					getPathProbe: () => ({ canonicalPath: () => undefined, isFile: () => true }),
				},
				"run_process",
			);
			await expect(test.run({ executable: "cat", args: [path] })).rejects.toThrow("credential files");
			expect(test.execute).not.toHaveBeenCalled();
		},
	);

	it("still rejects ambiguous direct file requests", async () => {
		const test = fixture("win32", "D:\\synthetic\\project");
		await expect(test.run({ path: "D:source.ts" })).rejects.toThrow("drive-relative");
		expect(test.execute).not.toHaveBeenCalled();
	});

	it("proves backend mismatch: uses invocation-owned backend authority without native fallback", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const flavor = process.platform === "win32" ? "win32" : "posix";
		const root = flavor === "win32" ? "D:\\synthetic\\project" : "/synthetic/project";
		const separator = flavor === "win32" ? "\\" : "/";
		class FakeBackendAuthority {
			#aliases = new Map([[`${root}${separator}alias.ts`, `${root}${separator}.env.local`]]);
			canonicalPath(path: string) {
				return this.#aliases.get(path);
			}
			isFile() {
				return true;
			}
		}
		const authority = new FakeBackendAuthority();
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Synthetic" }], details: {} }));
		const release = vi.fn();
		const context = captureExecutionContext({
			sessionId: "synthetic-session",
			generation: 1,
			cwd: root,
			attachment: {
				workspaceId: "synthetic",
				attachmentId: "custom-backend-id",
				root,
				flavor,
				caseSensitive: flavor === "posix",
			},
		});
		const tool: AgentTool<typeof parameters> = {
			name: "read",
			label: "Read",
			description: "Synthetic reader",
			parameters,
			execute,
			bindInvocation: async () => ({
				executionContext: context,
				execute,
				release,
				pathAuthority: authority,
			}),
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, "/synthetic/operator", {
			redactSensitiveText: (text) => text,
		});
		const binding = await guarded.bindInvocation!("call", { path: "alias.ts" });
		try {
			await expect(binding.execute("call", { path: "alias.ts" })).rejects.toThrow("model-blind");
		} finally {
			binding.release();
		}
		expect(execute).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();

		const allowedBinding = await guarded.bindInvocation!("call", { path: "source.ts" });
		try {
			await allowedBinding.execute("call", { path: "source.ts" });
		} finally {
			allowedBinding.release();
		}
		expect(execute).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledTimes(2);
	});

	it("distinguishes identical POSIX path strings across different backends", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const root = "/synthetic/shared";
		const target = `${root}/config.json`;

		class DeniedBackendAuthority {
			readonly flavor = "posix" as const;
			readonly caseSensitive = true;
			canonicalPath(path: string) {
				return path === target ? `${root}/.env` : undefined;
			}
			isFile() {
				return true;
			}
		}

		class AllowedBackendAuthority {
			readonly flavor = "posix" as const;
			readonly caseSensitive = true;
			canonicalPath(path: string) {
				return path === target ? `${root}/config.default.json` : undefined;
			}
			isFile() {
				return true;
			}
		}

		const makeTool = (authority: unknown) => {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
			const release = vi.fn();
			const context = captureExecutionContext({
				sessionId: "shared-path-session",
				generation: 1,
				cwd: root,
				attachment: {
					workspaceId: "shared",
					attachmentId: "backend-id",
					root,
					flavor: "posix",
					caseSensitive: true,
				},
			});
			const tool: AgentTool<typeof parameters> = {
				name: "read",
				label: "Read",
				description: "Reader",
				parameters,
				execute,
				bindInvocation: async () => ({
					executionContext: context,
					execute,
					release,
					pathAuthority: authority as any,
				}),
			};
			return {
				guarded: wrapToolWithCredentialExposureGuard(tool, "/operator", { redactSensitiveText: (t) => t }),
				execute,
				release,
			};
		};

		const backendA = makeTool(new DeniedBackendAuthority());
		const bindingA = await backendA.guarded.bindInvocation!("call", { path: "config.json" });
		try {
			await expect(bindingA.execute("call", { path: "config.json" })).rejects.toThrow("model-blind");
		} finally {
			bindingA.release();
		}
		expect(backendA.execute).not.toHaveBeenCalled();
		expect(backendA.release).toHaveBeenCalledOnce();

		const backendB = makeTool(new AllowedBackendAuthority());
		const bindingB = await backendB.guarded.bindInvocation!("call", { path: "config.json" });
		try {
			await bindingB.execute("call", { path: "config.json" });
		} finally {
			bindingB.release();
		}
		expect(backendB.execute).toHaveBeenCalledOnce();
		expect(backendB.release).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
	});

	it("distinguishes identical Windows path strings across different backends", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const root = "C:\\synthetic\\shared";
		const target = `${root}\\Config.DAT`;

		class DeniedWinBackend {
			readonly flavor = "win32" as const;
			readonly caseSensitive = false;
			canonicalPath(path: string) {
				return path.toLowerCase() === target.toLowerCase() ? `${root}\\.env.local` : undefined;
			}
			isFile() {
				return true;
			}
		}

		class AllowedWinBackend {
			readonly flavor = "win32" as const;
			readonly caseSensitive = false;
			canonicalPath(path: string) {
				return path.toLowerCase() === target.toLowerCase() ? `${root}\\Config.default.dat` : undefined;
			}
			isFile() {
				return true;
			}
		}

		const makeTool = (authority: unknown) => {
			const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
			const release = vi.fn();
			const context = captureExecutionContext({
				sessionId: "win-session",
				generation: 1,
				cwd: root,
				attachment: {
					workspaceId: "shared",
					attachmentId: "win-backend-id",
					root,
					flavor: "win32",
					caseSensitive: false,
				},
			});
			const tool: AgentTool<typeof parameters> = {
				name: "read",
				label: "Read",
				description: "Reader",
				parameters,
				execute,
				bindInvocation: async () => ({
					executionContext: context,
					execute,
					release,
					pathAuthority: authority as any,
				}),
			};
			return {
				guarded: wrapToolWithCredentialExposureGuard(tool, "C:\\operator", { redactSensitiveText: (t) => t }),
				execute,
				release,
			};
		};

		const backend1 = makeTool(new DeniedWinBackend());
		const binding1 = await backend1.guarded.bindInvocation!("call", { path: "config.dat" });
		try {
			await expect(binding1.execute("call", { path: "config.dat" })).rejects.toThrow("model-blind");
		} finally {
			binding1.release();
		}
		expect(backend1.execute).not.toHaveBeenCalled();
		expect(backend1.release).toHaveBeenCalledOnce();

		const backend2 = makeTool(new AllowedWinBackend());
		const binding2 = await backend2.guarded.bindInvocation!("call", { path: "config.dat" });
		try {
			await binding2.execute("call", { path: "config.dat" });
		} finally {
			binding2.release();
		}
		expect(backend2.execute).toHaveBeenCalledOnce();
		expect(backend2.release).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
	});

	it("handles UNC share paths on Windows backend without host fallback", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const root = "\\\\server\\share\\synthetic\\project";
		const test = fixture("win32", root);
		await expect(test.run({ path: "\\\\server\\share\\synthetic\\project\\.env" })).rejects.toThrow("model-blind");
		expect(test.execute).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();

		await test.run({ path: "\\\\server\\share\\synthetic\\project\\code.ts" });
		expect(test.execute).toHaveBeenCalledOnce();
		expect(native).not.toHaveBeenCalled();
	});

	it("forwards cancellation during asynchronous authority probing and releases lease once", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const root = "/synthetic/async";
		const abort = new AbortController();

		class AsyncAuthority {
			readonly flavor = "posix" as const;
			readonly caseSensitive = true;
			async canonicalPath(_path: string, signal?: AbortSignal) {
				signal?.throwIfAborted();
				abort.abort(new Error("aborted during async probe"));
				signal?.throwIfAborted();
				return undefined;
			}
			async isFile(_path: string, signal?: AbortSignal) {
				signal?.throwIfAborted();
				return true;
			}
		}

		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "never" }], details: {} }));
		const release = vi.fn();
		const context = captureExecutionContext({
			sessionId: "async-session",
			generation: 1,
			cwd: root,
			attachment: {
				workspaceId: "async",
				attachmentId: "async-backend",
				root,
				flavor: "posix",
				caseSensitive: true,
			},
		});
		const tool: AgentTool<typeof parameters> = {
			name: "read",
			label: "Read",
			description: "Reader",
			parameters,
			execute,
			bindInvocation: async () => ({
				executionContext: context,
				execute,
				release,
				pathAuthority: new AsyncAuthority(),
			}),
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, "/operator", { redactSensitiveText: (t) => t });
		const binding = await guarded.bindInvocation!("call", { path: "source.ts" });
		try {
			await expect(binding.execute("call", { path: "source.ts" }, abort.signal)).rejects.toThrow(
				"aborted during async probe",
			);
		} finally {
			binding.release();
		}
		expect(execute).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
	});

	it("redacts backend errors and never falls back to host filesystem", async () => {
		const native = vi.spyOn(realpathSync, "native");
		const root = "/synthetic/error-backend";

		class BrokenAuthority {
			readonly flavor = "posix" as const;
			readonly caseSensitive = true;
			canonicalPath(): string | undefined {
				throw new Error("SECRET_TOKEN_54321: connection reset by peer");
			}
			isFile() {
				return true;
			}
		}

		const execute = vi.fn();
		const release = vi.fn();
		const context = captureExecutionContext({
			sessionId: "error-session",
			generation: 1,
			cwd: root,
			attachment: {
				workspaceId: "err",
				attachmentId: "err-backend",
				root,
				flavor: "posix",
				caseSensitive: true,
			},
		});
		const tool: AgentTool<typeof parameters> = {
			name: "read",
			label: "Read",
			description: "Reader",
			parameters,
			execute,
			bindInvocation: async () => ({
				executionContext: context,
				execute,
				release,
				pathAuthority: new BrokenAuthority(),
			}),
		};
		const guarded = wrapToolWithCredentialExposureGuard(tool, "/operator", {
			redactSensitiveText: (t) => t.replace(/SECRET_TOKEN_\d+/g, "[REDACTED]"),
		});
		const binding = await guarded.bindInvocation!("call", { path: "source.ts" });
		try {
			const errorPromise = binding.execute("call", { path: "source.ts" });
			await expect(errorPromise).rejects.toThrow("[REDACTED]");
			await expect(errorPromise).rejects.not.toThrow("SECRET_TOKEN_54321");
		} finally {
			binding.release();
		}
		expect(execute).not.toHaveBeenCalled();
		expect(native).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalledOnce();
	});
});
