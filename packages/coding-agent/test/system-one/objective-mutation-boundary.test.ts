import { execFileSync } from "node:child_process";
import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import { afterEach, describe, expect, it } from "vitest";
import { getDefaultActiveToolNames } from "../../src/core/default-tool-surface.ts";
import { createGoalState } from "../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../../src/core/goals/session-goal-state.ts";
import { classifyDangerousGitBash } from "../../src/core/objective-execution/dangerous-git-bash.ts";
import { ObjectiveMutationLedger } from "../../src/core/objective-execution/objective-mutation-ledger.ts";
import { captureRepoDeliveryFingerprint } from "../../src/core/objective-execution/repo-delivery-fingerprint.ts";
import { repositoryEffectForCall, toolRepositoryEffect } from "../../src/core/objective-execution/repository-effect.ts";
import { RepositoryMutationObserver } from "../../src/core/objective-execution/repository-mutation-observer.ts";
import { resolveObjectiveWorkspaceSafetyMode } from "../../src/core/objective-execution/workspace-safety.ts";
import { ToolGateController } from "../../src/core/tool-gate-controller.ts";
import { committedRepo } from "../git-fixture.ts";
import { tempDir as makeTempDir } from "../temp-dir.ts";

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
	const path = makeTempDir(prefix);
	cleanups.push(path);
	return path;
}

function gitRepo(): string {
	return committedRepo("pi-mb-");
}

function gate(cwd: string, hostEffect?: "none" | "observe" | "typed_paths", deliveryActive = true) {
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
			deliveryActive: () => deliveryActive,
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

	it("observes calls by the owner's baseline policy while their potential effect stays opaque for readiness", () => {
		for (const deliveryActive of [true, false]) {
			for (const toolName of [
				"fetch",
				"web_search",
				"webfetch",
				"image_generate",
				"secret_store",
				"delegate",
				"peer",
				"agent_send",
				"list_peers",
				"model_fitness",
				"ask_question",
				"task_steps",
				"task_directory",
				"self_compact",
			]) {
				expect(repositoryEffectForCall({ toolName, args: {}, deliveryActive }), toolName).toBe("none");
				expect(toolRepositoryEffect(toolName), toolName).toBe("opaque");
			}
			// skillify only validates a draft and proposes a path: it holds read authority, so no effect on the repository.
			expect(repositoryEffectForCall({ toolName: "skillify", args: {}, deliveryActive })).toBe("none");
			expect(toolRepositoryEffect("skillify")).toBe("none");
			expect(repositoryEffectForCall({ toolName: "goal", args: { action: "update" }, deliveryActive })).toBe("none");
			expect(repositoryEffectForCall({ toolName: "pipeline", args: { action: "list" }, deliveryActive })).toBe(
				"none",
			);
			for (const toolName of ["bash", "python", "run_process", "extensionify", "worktree_sync"]) {
				expect(repositoryEffectForCall({ toolName, args: {}, deliveryActive }), toolName).toBe("observe");
			}
			expect(repositoryEffectForCall({ toolName: "edit", args: {}, deliveryActive })).toBe("typed_owned_write");
		}
		expect(toolRepositoryEffect("goal", { action: "update" })).toBe("opaque");
		expect(toolRepositoryEffect("pipeline", { action: "list" })).toBe("opaque");
		expect(toolRepositoryEffect("custom_widget")).toBe("opaque");
		expect(toolRepositoryEffect("goal", { action: "get" })).toBe("none");
		expect(toolRepositoryEffect("read")).toBe("none");
	});

	it("characterization (open gap): an in-repository state mutation by an unobserved call goes unrecorded", async () => {
		const root = gitRepo();
		/** A real session whose store is the given directory, flushed to disk by its first reply. */
		const storedSession = (sessionDir: string) => {
			const session = SessionManager.create(root, join(sessionDir, "agent"), join(sessionDir, "sessions"));
			session.appendMessage(fauxAssistantMessage("ready"));
			return session;
		};
		const inRepository = storedSession(join(root, ".pi-state"));
		const appendGoal = () => {
			appendGoalStateSnapshot(inRepository, createGoalState({ goalId: "g1", userGoal: "Ship it", now: "T0" }));
		};
		// The baseline policy leaves goal and planning calls unobserved: the repository changes and nothing
		// records it. This gap is open, not fixed.
		const unobserved = gate(root);
		await settle(unobserved.gate, "goal-update", "goal", { action: "update" }, appendGoal);
		expect(unobserved.observer.deliveryBlockReason("obj")).toBeUndefined();
		// A process call making the same change keeps its baseline evidence requirement.
		const process = gate(root);
		await settle(process.gate, "shell-append", "bash", { command: "true" }, appendGoal);
		expect(process.observer.deliveryBlockReason("obj")).toBe("shell_mutation_unattributed");
	});

	it("journal outage admits baseline-unobserved calls and still refuses observed ones with the actual diagnostic", async () => {
		const root = gitRepo();
		const outage = (deliveryActive: boolean) => {
			const controller = gate(root, undefined, deliveryActive);
			controller.observer.setWorkEvidenceJournal({
				isCurrentBranchAnchor: () => true,
				ensureBaseline: async () => {
					throw new Error("journal offline");
				},
				recordBaselineDiagnostic: async () => {},
				openObservation: async () => {},
				closeObservation: async () => {},
				recordObservedChange: async () => {},
				recoverObservations: async () => {},
				getWorkEvidence: () => [],
			});
			return controller.gate;
		};
		const admit = async (controller: ToolGateController, name: string, args: Record<string, unknown>) => {
			const context = {
				toolCall: { type: "toolCall" as const, id: `${name}-call`, name, arguments: args },
				args,
				assistantMessage: { provider: "test", model: "test" } as never,
				context: {} as never,
			};
			return controller
				.beforeToolCall(context as Parameters<ToolGateController["beforeToolCall"]>[0], undefined)
				.then(
					(result) => ({ admitted: result === undefined }),
					(error: unknown) => ({ refused: error instanceof Error ? error.message : String(error) }),
				);
		};
		for (const deliveryActive of [true, false]) {
			const controller = outage(deliveryActive);
			for (const [name, args] of [
				["fetch", { url: "https://example.invalid" }],
				["delegate", { action: "list" }],
				["ask_question", { question: "Which branch?" }],
				["pipeline", { action: "list" }],
				["read", { path: "README.md" }],
			] as const) {
				expect(await admit(controller, name, args), `${name} delivery=${deliveryActive}`).toEqual({
					admitted: true,
				});
			}
			const unknownTool = await admit(controller, "custom_widget", {});
			expect(unknownTool).toEqual(
				deliveryActive ? { refused: expect.stringContaining("baseline_persistence_failed") } : { admitted: true },
			);
			expect(await admit(controller, "bash", { command: "true" })).toEqual({
				refused: expect.stringContaining("baseline_persistence_failed"),
			});
		}
	});

	it("a no-op fetch overlapping an owned write is not blamed; an overlapping process call still is", async () => {
		const overlap = async (name: string, args: Record<string, unknown>) => {
			const root = gitRepo();
			const controller = gate(root);
			const open = async (id: string, toolName: string, toolArgs: Record<string, unknown>) => {
				const context = {
					toolCall: { type: "toolCall" as const, id, name: toolName, arguments: toolArgs },
					args: toolArgs,
					assistantMessage: { provider: "test", model: "test" } as never,
					context: {} as never,
				};
				await controller.gate.beforeToolCall(
					context as Parameters<ToolGateController["beforeToolCall"]>[0],
					undefined,
				);
				return () =>
					controller.gate.afterToolCall({
						...context,
						result: { content: [{ type: "text", text: "ok" }], details: {} },
						isError: false,
					} as Parameters<ToolGateController["afterToolCall"]>[0]);
			};
			const concurrent = await open("concurrent", name, args);
			const write = await open("owned", "write", { path: "owned.md" });
			const fd = openSync(join(root, "owned.md"), "w");
			writeSync(fd, "owned\n");
			closeSync(fd);
			await write();
			await concurrent();
			return controller.observer.deliveryBlockReason("obj");
		};
		expect(await overlap("fetch", { url: "https://example.invalid" })).toBeUndefined();
		expect(await overlap("bash", { command: "true" })).toBe("shell_mutation_unattributed");
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
