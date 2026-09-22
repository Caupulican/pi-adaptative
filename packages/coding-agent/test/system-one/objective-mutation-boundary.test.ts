import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultActiveToolNames } from "../../src/core/default-tool-surface.ts";
import { classifyDangerousGitBash } from "../../src/core/objective-execution/dangerous-git-bash.ts";
import { ObjectiveMutationLedger } from "../../src/core/objective-execution/objective-mutation-ledger.ts";
import { captureRepoDeliveryFingerprint } from "../../src/core/objective-execution/repo-delivery-fingerprint.ts";
import { repositoryEffectForCall } from "../../src/core/objective-execution/repository-effect.ts";
import { RepositoryMutationObserver } from "../../src/core/objective-execution/repository-mutation-observer.ts";
import { resolveObjectiveWorkspaceSafetyMode } from "../../src/core/objective-execution/workspace-safety.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";

for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
	delete process.env[key];
}

const cleanups: string[] = [];
afterEach(() => {
	while (cleanups.length > 0) {
		const path = cleanups.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

function tempDir(prefix: string): string {
	const path = mkdtempSync(join(realpathSync.native(tmpdir()), prefix));
	cleanups.push(path);
	return path;
}

function git(root: string, args: readonly string[]): void {
	execFileSync("git", args, { cwd: root });
}

function gitRepo(): string {
	const root = tempDir("pi-mb-");
	git(root, ["init"]);
	git(root, ["config", "user.email", "test@example.com"]);
	git(root, ["config", "user.name", "test"]);
	git(root, ["config", "commit.gpgsign", "false"]);
	execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
	const readme = join(root, "README.md");
	const fd = openSync(readme, "w");
	writeSync(fd, "one\n");
	closeSync(fd);
	git(root, ["add", "README.md"]);
	git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
	return root;
}

function gate(cwd: string, hostEffect?: "none" | "observe" | "typed_paths") {
	const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
	return {
		observer,
		gate: new ToolGateController({
			maybeEscalateToolCall: () => undefined,
			getCwd: () => cwd,
			getCapabilityEnvelope: () => undefined,
			recordGateOutcome: () => undefined,
			getExtensionRunner: () => ({ hasHandlers: () => false }) as never,
			repositoryObserver: observer,
			getObjectiveId: () => "obj",
			deliveryActive: () => true,
			...(hostEffect ? { hostRepositoryEffect: () => hostEffect } : {}),
		}),
	};
}

async function settle(
	controller: ToolGateController,
	id: string,
	name: string,
	args: Record<string, unknown>,
	between: () => void,
): Promise<void> {
	const context = {
		toolCall: { type: "toolCall" as const, id, name, arguments: args },
		args,
		assistantMessage: { provider: "test", model: "test" } as never,
		context: {} as never,
	};
	await controller.beforeToolCall(context as Parameters<ToolGateController["beforeToolCall"]>[0], undefined);
	between();
	await controller.afterToolCall({
		...context,
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		isError: false,
	} as Parameters<ToolGateController["afterToolCall"]>[0]);
}

describe("objective mutation boundary", () => {
	it("normalizes quoted lane git and fails closed on a broken quote", () => {
		expect(classifyDangerousGitBash('git commit "-a"').refused).toBe(true);
		expect(classifyDangerousGitBash("git commit '--no-verify'").refused).toBe(true);
		expect(classifyDangerousGitBash("env X=1 git push").refused).toBe(true);
		expect(classifyDangerousGitBash("command git reset --hard").refused).toBe(true);
		expect(classifyDangerousGitBash('"/usr/bin/git" commit -a').refused).toBe(true);
		expect(classifyDangerousGitBash('git.exe add "--all"').refused).toBe(true);
		expect(classifyDangerousGitBash('git commit "').refused).toBe(true);
		expect(classifyDangerousGitBash('git commit -m "wip"').refused).toBe(false);
	});

	it("classifies process tools as observe and a trusted none as none", () => {
		for (const toolName of [
			"python",
			"bash",
			"run_process",
			"run_toolkit_script",
			"improvement_loop",
			"task_automation",
			"runtime_update",
			"worktree_sync",
		]) {
			expect(repositoryEffectForCall({ toolName, args: {}, deliveryActive: true }), toolName).toBe("observe");
		}
		expect(repositoryEffectForCall({ toolName: "pipeline", args: { action: "run" }, deliveryActive: true })).toBe(
			"observe",
		);
		expect(repositoryEffectForCall({ toolName: "pipeline", args: { action: "list" }, deliveryActive: true })).toBe(
			"none",
		);
		expect(repositoryEffectForCall({ toolName: "tool_task", args: { action: "list" }, deliveryActive: true })).toBe(
			"none",
		);
		expect(repositoryEffectForCall({ toolName: "write", args: { path: "README.md" }, deliveryActive: true })).toBe(
			"typed_owned_write",
		);
		expect(repositoryEffectForCall({ toolName: "custom_widget", args: {}, deliveryActive: true })).toBe("observe");
		expect(repositoryEffectForCall({ toolName: "custom_widget", args: {}, deliveryActive: false })).toBe("none");
		expect(
			repositoryEffectForCall({ toolName: "custom_widget", args: {}, deliveryActive: true, hostEffect: "none" }),
		).toBe("none");
		expect(getDefaultActiveToolNames()).toContain("repo_read");
		expect(resolveObjectiveWorkspaceSafetyMode()).toBe("shared_guarded");
	});

	it("observes python and custom tools, and a trusted none does not", async () => {
		const root = gitRepo();
		const read = gate(root);
		await settle(read.gate, "py-read", "python", { code: "print(1)" }, () => undefined);
		expect(read.observer.deliveryBlockReason("obj")).toBeUndefined();
		const wrote = gate(root);
		await settle(wrote.gate, "py-write", "python", { code: "open('README.md','w').write('x')" }, () => {
			const fd = openSync(join(root, "README.md"), "w");
			writeSync(fd, "changed\n");
			closeSync(fd);
		});
		expect(wrote.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const custom = gate(root);
		await settle(custom.gate, "custom", "custom_widget", {}, () => {
			const fd = openSync(join(root, "extra.txt"), "w");
			writeSync(fd, "x\n");
			closeSync(fd);
		});
		expect(custom.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const trusted = gate(root, "none");
		await settle(trusted.gate, "trusted", "custom_widget", {}, () => {
			const fd = openSync(join(root, "trusted.txt"), "w");
			writeSync(fd, "x\n");
			closeSync(fd);
		});
		expect(trusted.observer.deliveryBlockReason("obj")).toBeUndefined();
		const typed = gate(root);
		await settle(typed.gate, "owned", "write", { path: "README.md" }, () => {
			const fd = openSync(join(root, "README.md"), "w");
			writeSync(fd, "owned\n");
			closeSync(fd);
			const extra = openSync(join(root, "hook.txt"), "w");
			writeSync(extra, "hook\n");
			closeSync(extra);
		});
		expect(typed.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
		const escaped = gate(root);
		await settle(escaped.gate, "detach", "bash", { command: "sleep 30 &" }, () => undefined);
		expect(escaped.observer.deliveryBlockReason("obj")).toBeUndefined();
	});

	it("waits for the in-flight token and reports an unstable fingerprint", async () => {
		const root = gitRepo();
		const observer = new RepositoryMutationObserver(new ObjectiveMutationLedger());
		const token = await observer.begin({ callId: "bg", objectiveId: "obj", cwd: root, effect: "observe" });
		let settled = false;
		const pending = observer.waitForQuiescence("obj").then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(observer.hasInFlight("obj")).toBe(true);
		expect(settled).toBe(false);
		await observer.finish({ token, operationSucceeded: true });
		await pending;
		expect(settled).toBe(true);
		let n = 0;
		const unstable = await captureRepoDeliveryFingerprint(root, {
			afterFence: () => {
				n += 1;
				const fd = openSync(join(root, `move-${n}.txt`), "w");
				writeSync(fd, "x\n");
				closeSync(fd);
			},
		});
		expect(unstable).toEqual({ ok: false, reason: "repository_fingerprint_unstable" });
	});

	it("hashes a 40 MiB tracked change and an untracked file without buffering the whole file", async () => {
		const root = gitRepo();
		const chunk = Buffer.alloc(1024 * 1024, 7);
		const trackedPath = join(root, "README.md");
		const trackedFd = openSync(trackedPath, "w");
		for (let index = 0; index < 40; index += 1) writeSync(trackedFd, chunk);
		closeSync(trackedFd);
		const before = await captureRepoDeliveryFingerprint(root);
		const flip = openSync(trackedPath, "r+");
		writeSync(flip, Buffer.from([8]), 0, 1, 40 * 1024 * 1024 - 1);
		closeSync(flip);
		const after = await captureRepoDeliveryFingerprint(root);
		expect(before.ok && after.ok && before.digest !== after.digest).toBe(true);
		const untrackedPath = join(root, "blob.bin");
		const untrackedFd = openSync(untrackedPath, "w");
		for (let index = 0; index < 40; index += 1) writeSync(untrackedFd, chunk);
		closeSync(untrackedFd);
		const withBlob = await captureRepoDeliveryFingerprint(root);
		expect(withBlob.ok && after.ok && withBlob.digest !== after.digest).toBe(true);
	}, 60_000);

	it("keeps a destructive command inside a disposable clone off the owner checkout", () => {
		const owner = gitRepo();
		const ownerHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner, encoding: "utf8" }).trim();
		const clone = tempDir("pi-mb-clone-");
		execFileSync("git", ["clone", owner, clone]);
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: clone });
		execFileSync("git", ["config", "user.name", "test"], { cwd: clone });
		const fd = openSync(join(clone, "README.md"), "w");
		writeSync(fd, "destroyed\n");
		closeSync(fd);
		expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: owner, encoding: "utf8" }).trim()).toBe(ownerHead);
		expect(execFileSync("git", ["status", "--porcelain"], { cwd: owner, encoding: "utf8" })).toBe("");
	});
});
