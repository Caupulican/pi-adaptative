import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExecutionContext, ExecutionPathAuthority } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { wrapToolWithCapabilityEnvelopeGate } from "../src/core/autonomy/composite-tool-gate.ts";
import type { CapabilityEnvelope } from "../src/core/autonomy/contracts.ts";
import { assessPathWithinEnvelopeAsync } from "../src/core/autonomy/envelope-enforcement.ts";
import { credentialToolBlockReasonAsync } from "../src/core/secrets/credential-exposure-guard.ts";

const root = "/synthetic/project";
const context: ExecutionContext = {
	sessionId: "lifecycle-fixture",
	generation: 1,
	cwd: root,
	attachment: { workspaceId: "fixture", attachmentId: "fixture-backend", root, flavor: "posix", caseSensitive: true },
};
const envelope: CapabilityEnvelope = {
	id: "fixture-grant",
	capabilities: ["filesystem.read"],
	allowedPaths: [root],
	deniedPaths: [`${root}/private`],
};

describe("backend authority lifecycle", () => {
	it.each([0, 1, 2, 3, 4])("fences cancellation at lookup %i before composite execution", async (cancelAt) => {
		const abort = new AbortController();
		let lookups = 0;
		const pathAuthority: ExecutionPathAuthority = {
			flavor: "posix",
			async canonicalPath(path, signal) {
				if (++lookups === cancelAt) {
					abort.abort(new Error("Synthetic lookup cancellation"));
					signal?.throwIfAborted();
				}
				return path;
			},
		};
		const execute = vi.fn(async () => ({ content: [], details: {} }));
		const release = vi.fn();
		const tool = wrapToolWithCapabilityEnvelopeGate(
			{
				name: "read",
				label: "Read",
				description: "Synthetic reader",
				parameters: Type.Object({ path: Type.String() }),
				execute,
				async bindInvocation() {
					return { executionContext: context, pathAuthority, execute, release };
				},
			},
			root,
			envelope,
		);
		const params = { path: "source.txt" };
		const binding = await tool.bindInvocation!("fixture-call", params);
		try {
			const result = binding.execute("fixture-call", params, abort.signal);
			if (cancelAt === 0) await result;
			else await expect(result).rejects.toThrow("Synthetic lookup cancellation");
		} finally {
			binding.release();
		}
		expect(execute).toHaveBeenCalledTimes(cancelAt === 0 ? 1 : 0);
		expect(lookups).toBe(cancelAt || 4);
		expect(release).toHaveBeenCalledOnce();
	});

	it.each(["canonicalPath", "safeRealpath", "parent"] as const)(
		"settles cancellation even if %s ignores its signal",
		async (method) => {
			const pending = Promise.withResolvers<string>();
			const started = Promise.withResolvers<void>();
			const abort = new AbortController();
			const probe = () => {
				started.resolve();
				return pending.promise;
			};
			const authority: ExecutionPathAuthority = {
				flavor: "posix",
				canonicalPath: (path) => (method === "parent" && path === `${root}/source.txt` ? undefined : probe()),
				...(method === "safeRealpath" ? { safeRealpath: probe } : {}),
			};
			const result = assessPathWithinEnvelopeAsync(
				{ ...envelope, allowedPaths: [], deniedPaths: [] },
				"source.txt",
				{ cwd: root, pathAuthority: authority, signal: abort.signal },
			);
			let settled = false;
			const observed = result
				.catch(() => {})
				.finally(() => {
					settled = true;
				});
			await started.promise;
			abort.abort(new Error("Synthetic ignored cancellation"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			const settledBeforeBackend = settled;
			pending.reject(new Error("Synthetic late backend rejection"));
			await observed;
			expect(settledBeforeBackend).toBe(true);
			await expect(result).rejects.toThrow("Synthetic ignored cancellation");
		},
	);

	it.each(["canonicalPath", "safeRealpath", "parent"])(
		"observes rejected %s promises in synchronous admission",
		(method) => {
			const fixture = fileURLToPath(new URL("./fixtures/path-authority-sync-probe.mjs", import.meta.url));
			for (const mode of ["sync", "async"]) {
				const result = spawnSync(process.execPath, ["--conditions=pi-source", fixture, method, mode], {
					encoding: "utf8",
					timeout: 10_000,
				});
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
				expect(JSON.parse(result.stdout)).toMatchObject({ allowed: false });
				expect(result.stderr).toBe("");
			}
		},
	);

	it.each([true, false])("shares credential containment with Windows caseSensitive=%s", async (caseSensitive) => {
		const windowsRoot = "D:\\synthetic";
		const windowsContext: ExecutionContext = {
			...context,
			cwd: windowsRoot,
			attachment: { ...context.attachment, root: windowsRoot, flavor: "win32", caseSensitive },
		};
		const authority: ExecutionPathAuthority = {
			flavor: "win32",
			caseSensitive,
			canonicalPath: async (path) => path,
			isFile: () => true,
		};
		const boundary = {
			redactSensitiveText: (text: string) => text,
			protectedDirectories: [`${windowsRoot}\\private`],
		};
		for (const [path, blocked] of [
			["private/key.txt", true],
			["Private/source.txt", !caseSensitive],
			["private-sibling/source.txt", false],
		] as const) {
			const reason = await credentialToolBlockReasonAsync(
				"read",
				{ path },
				windowsRoot,
				boundary,
				windowsContext,
				authority,
			);
			expect(Boolean(reason), path).toBe(blocked);
		}
	});
});
