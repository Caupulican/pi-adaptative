import { expect } from "vitest";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

/** Reload commands queued by a live provider run cross only its settled cleanup boundary. */
export async function runQueuedReloadInteraction(world: HarnessWorld): Promise<void> {
	for (const ordering of ["queued-cleanup", "normal-idle"] as const) {
		for (const failAfterReload of [false, true]) {
			const label = `h2-${ordering}-${failAfterReload ? "handler-failed" : "handler-completed"}`;
			const words = `Answer this ${label} owner request.`;
			const answer = `The ${label} owner request was answered.`;
			const failure = `${label}: command failed after its accepted reload`;
			const reached = createBarrier();
			const release = createBarrier();
			const commandAccepted = createBarrier();
			const accepted: boolean[] = [];
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			let handlerEntered = 0;
			let handlerReloaded = 0;
			let lifecycleReloads = 0;
			let sendQueuedCommand: (() => void) | undefined;
			const agentDir = `${world.agentDir}-${label}`;
			const manager = world.createSessionManager(agentDir);
			const runtimeIntentEntries = () =>
				manager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "h2-queued-runtime-intent" &&
							entry.content === label,
					);
			let runtimeIntentEntryId: string | undefined;
			const owner = await world.createRootSession("root", {
				agentDir,
				sessionManager: manager,
				extensionFactories: [
					(pi) => {
						sendQueuedCommand = () =>
							pi.sendUserMessage("/h2-cleanup-reload", {
								deliverAs: "steer",
								processSlashCommands: true,
								onAccepted: (value) => {
									accepted.push(value);
									commandAccepted.release();
								},
							});
						pi.registerCommand("h2-cleanup-reload", {
							description: "Reload at the command's actual foreground boundary.",
							handler: async (_args, ctx) => {
								handlerEntered++;
								await ctx.reload();
								handlerReloaded++;
								if (failAfterReload) throw new Error(failure);
							},
						});
						pi.on("session_start", async (event) => {
							if (event.reason === "reload") lifecycleReloads++;
						});
					},
				],
			});
			await owner.session.bindExtensions({
				uiContext: world.humanInput.ui,
				onError: (error) =>
					errors.push({ extensionPath: error.extensionPath, event: error.event, error: error.error }),
			});
			const readBefore = owner.session.getToolDefinition("read");
			const requestsBefore = world.provider.reached.length;
			world.systemOne.enterPhase(label, {});
			world.provider.enqueue("root", {
				name: `${label}-owner`,
				check: (request) => {
					const inputs = request.context.messages.filter(
						(message) => message.role === "user" && JSON.stringify(message.content).includes(words),
					);
					if (inputs.length !== 1) throw new Error(`${label}: the provider did not receive one owner input`);
					reached.release();
				},
				gate: release.promise,
				reply: { content: [{ type: "text", text: answer }] },
			});
			const run = owner.session.prompt(words);
			try {
				await withDeadline(world.trace, `${label} reached live provider`, reached.promise);
				if (ordering === "normal-idle") {
					release.release();
					await withDeadline(world.trace, `${label} ordinary turn completed`, run);
					const custom = owner.session.sendCustomMessage({
						customType: "h2-queued-runtime-intent",
						content: label,
						display: false,
					});
					expect(
						runtimeIntentEntries(),
						"an idle public custom message persists before its returned promise is awaited",
					).toHaveLength(1);
					runtimeIntentEntryId = runtimeIntentEntries()[0]?.id;
					await withDeadline(world.trace, `${label} immediate custom message settled`, custom);
				}
				if (ordering === "queued-cleanup") {
					if (!sendQueuedCommand)
						throw new Error(`${label}: the real extension factory did not expose its sender`);
					sendQueuedCommand();
					expect(
						owner.session.getSteeringMessages(),
						"the void extension send publishes pending input before the caller can await",
					).toEqual(["/h2-cleanup-reload"]);
					await withDeadline(world.trace, `${label} real void sender acceptance`, commandAccepted.promise);
				} else {
					await withDeadline(
						world.trace,
						`${label} public session message accepted`,
						owner.session.sendUserMessage("/h2-cleanup-reload", {
							deliverAs: "steer",
							processSlashCommands: true,
							onAccepted: (value) => accepted.push(value),
						}),
					);
				}
				expect(accepted, "the public message receives one command acceptance").toEqual([true]);
				if (ordering === "queued-cleanup") {
					expect(
						owner.session.getQueuedExtensionCommands(),
						"the real running turn owns the queued command",
					).toEqual(["/h2-cleanup-reload"]);
					expect(handlerEntered, "queued command cannot run while the provider is physically held").toBe(0);
					expect(lifecycleReloads, "no replacement starts in the live provider run").toBe(0);
					expect(owner.session.getToolDefinition("read"), "held provider retains its tool generation").toBe(
						readBefore,
					);
				}
				release.release();
				await withDeadline(world.trace, `${label} owner and cleanup joined`, run);
				await withDeadline(world.trace, `${label} foreground idle`, owner.session.waitForForegroundIdle());
				expect(handlerEntered).toBe(1);
				expect(handlerReloaded, "the exact cleanup or idle command authority completes reload").toBe(1);
				expect(lifecycleReloads, "one command requests one real replacement").toBe(1);
				expect(owner.session.getToolDefinition("read")).not.toBe(readBefore);
				expect(owner.session.getQueuedExtensionCommands()).toEqual([]);
				expect(owner.session.pendingMessageCount).toBe(0);
				expect(errors, "post-reload failure preserves command metadata on the current host exactly once").toEqual(
					failAfterReload
						? [{ extensionPath: "command:h2-cleanup-reload", event: "command", error: failure }]
						: [],
				);
				expect(
					world.provider.reached.slice(requestsBefore),
					"the slash command opens no extra provider round",
				).toEqual([`root:${label}-owner`]);
				expect(owner.session.getLastAssistantText()).toBe(answer);
				const branch = manager.getBranch();
				if (ordering === "normal-idle")
					expect(
						runtimeIntentEntries().map((entry) => entry.id),
						"the exact immediate custom entry survives command reload once without another provider request",
					).toEqual([runtimeIntentEntryId]);
				expect(
					branch.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(words),
					),
					"the command preserves the owner input on its durable branch",
				).toHaveLength(1);
				expect(
					branch.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							JSON.stringify(entry.message.content).includes(answer),
					),
					"the command preserves one durable final response",
				).toHaveLength(1);
				expect(
					branch.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes("/h2-cleanup-reload"),
					),
					"handled commands never become model user messages",
				).toBe(false);
				expect(manager.inspectSessionLifecycle().balanced).toBe(true);
			} finally {
				release.release();
				await withDeadline(world.trace, `${label} run joined`, run);
				expect(await world.disposeSessionInBody(owner.session)).toBeUndefined();
			}
			world.trace.mark("root", `${label}.command-settled`);
		}
	}
}
