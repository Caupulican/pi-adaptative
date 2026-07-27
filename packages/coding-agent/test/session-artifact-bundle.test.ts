import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { orchestrationSessionDir } from "../src/core/agent-paths.ts";
import {
	deleteForegroundSessionBundle,
	type SessionArtifactPathDeletion,
} from "../src/core/session-artifact-bundle.ts";

const tempDirs: string[] = [];

function createSessionBundle(sessionId: string): {
	agentDir: string;
	sessionPath: string;
	artifactPath: string;
	unrelatedPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-session-artifact-bundle-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const sessionPath = join(root, "sessions", `${sessionId}.jsonl`);
	const artifactPath = orchestrationSessionDir(agentDir, sessionId);
	const unrelatedPath = orchestrationSessionDir(agentDir, "other-session");
	mkdirSync(join(artifactPath, "worker-conversations"), { recursive: true });
	mkdirSync(join(unrelatedPath, "worker-conversations"), { recursive: true });
	mkdirSync(join(root, "sessions"), { recursive: true });
	writeFileSync(sessionPath, "foreground\n");
	writeFileSync(join(artifactPath, "worker-conversations", "worker.jsonl"), "worker\n");
	writeFileSync(join(unrelatedPath, "worker-conversations", "worker.jsonl"), "other worker\n");
	return { agentDir, sessionPath, artifactPath, unrelatedPath };
}

function removing(paths: string[]): (path: string) => Promise<SessionArtifactPathDeletion> {
	return async (path) => {
		paths.push(path);
		rmSync(path, { recursive: true, force: true });
		return { ok: true, method: "trash" };
	};
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("foreground session artifact bundle deletion", () => {
	it("deletes only the exact foreground session and its canonical worker bundle", async () => {
		const bundle = createSessionBundle("session-a");
		const removed: string[] = [];

		const result = await deleteForegroundSessionBundle({
			agentDir: bundle.agentDir,
			parentSessionId: "session-a",
			sessionPath: bundle.sessionPath,
			removePath: removing(removed),
		});

		expect(result).toEqual({
			foreground: { ok: true, method: "trash" },
			workerArtifacts: { ok: true, method: "trash" },
			complete: true,
		});
		expect(removed).toEqual([bundle.sessionPath, bundle.artifactPath]);
		expect(existsSync(bundle.sessionPath)).toBe(false);
		expect(existsSync(bundle.artifactPath)).toBe(false);
		expect(existsSync(bundle.unrelatedPath)).toBe(true);
	});

	it("does not remove worker artifacts when the foreground deletion fails", async () => {
		const bundle = createSessionBundle("session-a");
		const result = await deleteForegroundSessionBundle({
			agentDir: bundle.agentDir,
			parentSessionId: "session-a",
			sessionPath: bundle.sessionPath,
			removePath: async () => ({ ok: false, method: "unlink", error: "permission denied" }),
		});

		expect(result).toEqual({
			foreground: { ok: false, method: "unlink", error: "permission denied" },
			workerArtifacts: { ok: false, method: "preserved" },
			complete: false,
		});
		expect(existsSync(bundle.sessionPath)).toBe(true);
		expect(existsSync(bundle.artifactPath)).toBe(true);
	});

	it("reports an artifact cleanup failure after a recoverable foreground trash move", async () => {
		const bundle = createSessionBundle("session-a");
		const result = await deleteForegroundSessionBundle({
			agentDir: bundle.agentDir,
			parentSessionId: "session-a",
			sessionPath: bundle.sessionPath,
			removePath: async (path) => {
				if (path === bundle.artifactPath) return { ok: false, method: "unlink", error: "artifact locked" };
				rmSync(path, { recursive: true, force: true });
				return { ok: true, method: "trash" };
			},
		});

		expect(result.complete).toBe(false);
		expect(result.foreground).toEqual({ ok: true, method: "trash" });
		expect(result.workerArtifacts).toEqual({ ok: false, method: "unlink", error: "artifact locked" });
		expect(existsSync(bundle.sessionPath)).toBe(false);
		expect(existsSync(bundle.artifactPath)).toBe(true);
	});
});
