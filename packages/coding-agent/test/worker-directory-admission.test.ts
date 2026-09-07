import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerDirectoryAdmission } from "../src/core/delegation/worker-directory-admission.ts";
import {
	createWorkerExecutionContract,
	parseWorkerExecutionContract,
	verifierWorkerExecutionContract,
} from "../src/core/orchestration/worker-execution-contract.ts";
import { wrapToolWithCredentialExposureGuard } from "../src/core/secrets/credential-exposure-guard.ts";
import {
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-worker-identity-"));
	roots.push(root);
	const cwd = join(root, "project 日本語");
	await mkdir(cwd);
	const profile = createTestWorkerOrchestrationProfile({
		profileId: "fixture",
		model: { provider: "faux", id: "fixture-model" },
	});
	const source = createWorkerExecutionContract({
		worker: {
			profile,
			modelBinding: profile.modelPolicy.candidates[0]!,
			authority: { ...createTestWorkerExecutionAuthority(profile, cwd), cwd },
		},
	});
	return { cwd, source, admission: new WorkerDirectoryAdmission(), signal: new AbortController().signal };
}

describe("worker directory admission", () => {
	it("captures immutable per-task context and retains the native executor receiver and recovery", async () => {
		const { source, admission, signal } = await fixture();
		const captured = await admission.capture(source, "synthetic-session", signal);
		const context = { ...captured.worker.executionContext!, taskId: "first-task" };
		const tool: AgentTool = {
			name: "read",
			label: "read",
			description: "synthetic receiver",
			parameters: Type.Object({}),
			failureRecovery: { getFailureCorrection: () => "synthetic correction" },
			async execute() {
				expect(this).toBe(tool);
				return { content: [{ type: "text", text: "fixture" }], details: {} };
			},
		};
		const first = admission.bindTool(tool, context);
		context.taskId = "second-task";
		const second = admission.bindTool(tool, context);
		for (const [bound, taskId] of [
			[first, "first-task"],
			[second, "second-task"],
		] as const) {
			const binding = await bound.bindInvocation!("call", {}, signal);
			expect(binding.executionContext.taskId).toBe(taskId);
			expect(binding.failureRecovery).toBe(tool.failureRecovery);
			await binding.execute("call", {});
			binding.release();
		}
	});

	it.each([false, true])("keeps credential checks around admitted native execution (blocked=%s)", async (blocked) => {
		const { cwd, source, admission, signal } = await fixture();
		const captured = await admission.capture(source, "synthetic-session", signal);
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "fixture" }], details: {} }));
		const tool: AgentTool = {
			name: "read",
			label: "read",
			description: "synthetic read",
			parameters: Type.Object({ path: Type.String() }),
			execute,
		};
		const guarded = wrapToolWithCredentialExposureGuard(
			admission.bindTool(tool, captured.worker.executionContext!),
			cwd,
			{
				redactSensitiveText: (text) => text,
				protectedFiles: [join(cwd, "private.json")],
			},
		);
		const args = { path: blocked ? "private.json" : "public.txt" };
		const binding = await guarded.bindInvocation!("call", args, signal);
		try {
			if (blocked) await expect(binding.execute("call", args)).rejects.toThrow("model-blind");
			else await binding.execute("call", args);
			expect(execute).toHaveBeenCalledTimes(blocked ? 0 : 1);
		} finally {
			binding.release();
		}
	});

	it.each(["unchanged", "replaced", "cancelled"])(
		"preserves backend lease ownership after native admission: %s",
		async (state) => {
			const { cwd, source, admission, signal } = await fixture();
			const captured = await admission.capture(source, "synthetic-session", signal);
			const backendContext = { ...captured.worker.executionContext!, sessionId: "backend-session", generation: 4 };
			const released = vi.fn();
			class BackendInvocation {
				#context = backendContext;
				get executionContext() {
					return this.#context;
				}
				async execute() {
					return { content: [{ type: "text" as const, text: this.#context.sessionId }], details: {} };
				}
				release() {
					expect(this.#context).toBe(backendContext);
					released();
				}
			}
			const acquire = vi.fn(() => new BackendInvocation());
			const fallback = vi.fn(async () => ({ content: [], details: {} }));
			const tool: AgentTool = {
				name: "read",
				label: "read",
				description: "synthetic backend",
				parameters: Type.Object({}),
				execute: fallback,
				async bindInvocation() {
					expect(this).toBe(tool);
					return acquire();
				},
			};
			const bound = admission.bindTool(tool, captured.worker.executionContext!);
			const controller = new AbortController();
			if (state === "replaced") {
				await rename(cwd, `${cwd}-original`);
				await mkdir(cwd);
			}
			if (state === "cancelled") controller.abort(new Error("synthetic cancellation"));
			if (state !== "unchanged") {
				await expect(bound.bindInvocation!("call", {}, controller.signal)).rejects.toThrow(
					state === "replaced" ? "identity changed" : "synthetic cancellation",
				);
				expect(acquire).not.toHaveBeenCalled();
				expect(released).not.toHaveBeenCalled();
			} else {
				const binding = await bound.bindInvocation!("call", {}, controller.signal);
				expect(binding.executionContext).toBe(backendContext);
				expect(await binding.execute("call", {})).toMatchObject({ content: [{ text: "backend-session" }] });
				binding.release();
				expect(acquire).toHaveBeenCalledOnce();
				expect(released).toHaveBeenCalledOnce();
			}
			expect(fallback).not.toHaveBeenCalled();
		},
	);

	it("preserves explicitly admitted legacy recovery without silently weakening a recorded binding", async () => {
		const { cwd, source, admission, signal } = await fixture();
		await expect(admission.validateWorker(source, signal)).rejects.toThrow("identity is unavailable");
		await expect(admission.validateWorker(source, signal, cwd)).resolves.toBeUndefined();
		await expect(admission.validateWorker(source, signal, join(cwd, "other"))).rejects.toThrow("differs");
		const captured = await admission.capture(source, "synthetic-session", signal);
		await rename(cwd, `${cwd}-original`);
		await expect(admission.validateWorker(source, signal, cwd)).rejects.toMatchObject({ code: "ENOENT" });
		await mkdir(cwd);
		await expect(admission.validateWorker(captured, signal, cwd)).rejects.toThrow("identity changed");
	});

	it("round-trips the native identity without mutating the source or recapturing a saved binding", async () => {
		const { cwd, source, admission, signal } = await fixture();
		const captured = await admission.capture(source, "synthetic-session", signal);
		expect(source.worker.executionContext).toBeUndefined();
		expect(captured.worker.executionContext?.cwd).toBe(cwd);
		const replay = parseWorkerExecutionContract(JSON.parse(JSON.stringify(captured)));
		expect(replay).toEqual(captured);
		expect(await admission.capture(replay, "synthetic-session", signal)).toEqual(captured);
		await expect(admission.validateWorker(replay, signal)).resolves.toBeUndefined();
	});

	it("rejects a substituted directory while explicit fresh admission captures its new identity", async () => {
		const { cwd, source, admission, signal } = await fixture();
		const captured = await admission.capture(source, "synthetic-session", signal);
		await admission.validateWorker(captured, signal);
		await rename(cwd, `${cwd}-original`);
		await mkdir(cwd);
		await expect(admission.validateWorker(captured, signal)).rejects.toThrow("identity changed");
		await expect(admission.capture(captured, "synthetic-session", signal)).rejects.toThrow("identity changed");
		const fresh = await admission.capture(source, "synthetic-session", signal);
		expect(fresh.worker.executionContext?.attachment.attachmentId).not.toBe(
			captured.worker.executionContext?.attachment.attachmentId,
		);
		await expect(admission.validateWorker(fresh, signal)).resolves.toBeUndefined();
	});

	it("validates the independently pinned verifier directory and retains its identity on dispatch", async () => {
		const { cwd, source, admission, signal } = await fixture();
		const verifierCwd = join(cwd, "review");
		await mkdir(verifierCwd);
		const verifier = {
			...source.worker,
			profile: { ...source.worker.profile, profileId: "reviewer", role: "verifier" as const },
			authority: { ...source.worker.authority, cwd: verifierCwd },
		};
		const captured = await admission.capture(
			parseWorkerExecutionContract({
				...source,
				worker: {
					...source.worker,
					profile: {
						...source.worker.profile,
						requireIndependentVerification: true,
						verificationProfileId: "reviewer",
					},
				},
				verifier,
			}),
			"synthetic-session",
			signal,
		);
		const dispatch = verifierWorkerExecutionContract(captured);
		expect(dispatch?.worker.executionContext).toEqual(captured.verifier?.executionContext);
		await admission.validateWorker(dispatch, signal);
		await rename(verifierCwd, `${verifierCwd}-original`);
		await mkdir(verifierCwd);
		await expect(admission.validateWorker(dispatch, signal)).rejects.toThrow("identity changed");
		await expect(admission.validateWorker(captured, signal)).resolves.toBeUndefined();
	});

	it("rejects malformed or conflicting directory bindings at the durable contract boundary", async () => {
		const { cwd, source, admission, signal } = await fixture();
		const captured = await admission.capture(source, "synthetic-session", signal);
		for (const change of [{ generation: -1 }, { cwd: join(cwd, "other") }, { unexpected: true }]) {
			expect(() =>
				parseWorkerExecutionContract({
					...captured,
					worker: { ...captured.worker, executionContext: { ...captured.worker.executionContext, ...change } },
				}),
			).toThrow("directory binding");
		}
	});

	it("does not convert cancellation into a fresh binding", async () => {
		const { source, admission } = await fixture();
		const abort = new AbortController();
		abort.abort(new Error("Synthetic cancellation"));
		await expect(admission.capture(source, "synthetic-session", abort.signal)).rejects.toThrow(
			"Synthetic cancellation",
		);
		expect(source.worker.executionContext).toBeUndefined();
	});
});
