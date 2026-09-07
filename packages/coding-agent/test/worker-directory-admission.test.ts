import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerDirectoryAdmission } from "../src/core/delegation/worker-directory-admission.ts";
import {
	createWorkerExecutionContract,
	parseWorkerExecutionContract,
	verifierWorkerExecutionContract,
} from "../src/core/orchestration/worker-execution-contract.ts";
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
