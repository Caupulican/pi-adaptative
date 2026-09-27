import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureRepoDeliveryFingerprint } from "../src/core/objective-execution/repo-delivery-fingerprint.ts";
import { committedRepo } from "./git-fixture.ts";

function pendingSpawnFixture(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperties(child, {
		exitCode: { value: null, writable: true },
		pid: { value: undefined, writable: true },
		signalCode: { value: null, writable: true },
		stderr: { value: null },
		stdout: { value: null },
	});
	child.kill = vi.fn(() => true) as ChildProcess["kill"];
	child.unref = vi.fn() as unknown as ChildProcess["unref"];
	return child;
}

describe("repository fingerprint process lifecycle", () => {
	it("anchors status paths to the checkout root when the tool cwd is a subdirectory", async () => {
		const root = committedRepo("pi-fingerprint-subdir-");
		const nested = join(root, "nested");
		mkdirSync(nested);

		const fromRoot = await captureRepoDeliveryFingerprint(root);
		const fromNested = await captureRepoDeliveryFingerprint(nested);
		expect(fromNested).toEqual(fromRoot);

		writeFileSync(join(root, "README.md"), "changed\n");
		const changed = await captureRepoDeliveryFingerprint(nested);
		expect(changed.ok && fromNested.ok && changed.digest !== fromNested.digest).toBe(true);
		expect(changed.ok && changed.entries.get("README.md") !== "deleted").toBe(true);
	});

	it("bounds a Git timeout without signaling a child that never gained spawn ownership", async () => {
		const child = pendingSpawnFixture();
		const spawnGit = vi.fn(() => child);

		const result = await captureRepoDeliveryFingerprint(process.cwd(), {
			gitTimeoutMs: 1,
			spawnGit,
		});

		expect(result).toEqual({ ok: false, reason: "repository_fingerprint_unavailable" });
		expect(spawnGit).toHaveBeenCalledTimes(1);
		expect(spawnGit).toHaveBeenCalledWith(
			"git",
			["rev-parse", "--show-toplevel"],
			expect.objectContaining({ detached: process.platform !== "win32" }),
		);
		expect(child.kill).not.toHaveBeenCalled();
	});
});
