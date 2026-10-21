import { expect } from "vitest";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";
import { runManagedReloadRecoveryInteraction } from "./journey-1-managed-reload.ts";
import { runQueuedReloadInteraction } from "./journey-1-queued-reload.ts";
import { runRuntimeCallbackLifetimeInteraction } from "./journey-1-runtime-callbacks.ts";
import { ICM_INTAKE_JUDGMENTS } from "./shared.ts";

/** Extends E4 through the real loader, extension lifecycle, owner ingress, provider and durable branch. */
export async function runRuntimeGenerationReloadInteraction(world: HarnessWorld): Promise<void> {
	for (const outcome of ["committed", "rolled-back", "normal-order"] as const) {
		const label = `h2-${outcome}`;
		const baselineWords = `Establish ${label}.`;
		const words = `Answer the owner input arriving at ${label}.`;
		const response = `The ${label} owner input was answered.`;
		const reached = createBarrier();
		const release = createBarrier();
		const inputWaiting = createBarrier();
		const candidateDisposition = createBarrier();
		const errors: string[] = [];
		let armReload = false;
		let lifecycleEntered = false;
		let lifecycleExited = false;
		let reloadSettled = false;
		let commandReloads = 0;
		let inputWaits = 0;
		let observingOwnerIngress = false;
		const owner = await world.createRootSession("root", {
			sessionManager: world.createSessionManager(),
			extensionFactories: [
				(pi) => {
					pi.registerCommand("h2-reload", {
						description: "Reload through the exact extension command owner.",
						handler: async (_args, ctx) => {
							await ctx.reload();
							commandReloads++;
						},
					});
					pi.on("session_start", async (event) => {
						if (event.reason !== "reload" || !armReload) return;
						armReload = false;
						lifecycleEntered = true;
						// This is the extension's supported fire-and-forget API. Its effect belongs to
						// this candidate, and must wait for commit or report its rollback disposition.
						pi.sendMessage({ customType: "h2-runtime-candidate", content: label, display: false });
						reached.release();
						await release.promise;
						lifecycleExited = true;
						if (outcome === "rolled-back") throw new Error("h2 scripted lifecycle rollback");
					});
				},
			],
		});
		await owner.session.bindExtensions({
			uiContext: world.humanInput.ui,
			onError: (error) => {
				errors.push(error.error);
				if (error.error.includes("Deferred extension message was discarded")) candidateDisposition.release();
			},
		});
		const unsubscribe = owner.session.subscribe((event) => {
			if (event.type === "wait" && event.id === "runtime_generation.admission" && event.phase === "start") {
				if (observingOwnerIngress) {
					inputWaits++;
					inputWaiting.release();
				}
			}
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "h2-runtime-candidate"
			)
				candidateDisposition.release();
		});
		world.systemOne.enterPhase(label, {
			...ICM_INTAKE_JUDGMENTS,
			// The second owner prompt settles the first text-only turn's delivered words.
			carries_0: { kind: "noul", probability: 0.02 },
			// The runtime-disposition label reaches claim screening; it claims no git or verification result.
			...(outcome === "committed"
				? {
						states_tests_pass: { kind: "choice" as const, choice: "no_current_success", confidence: 0.97 },
						states_committed: { kind: "noul" as const, probability: 0.02 },
						states_pushed: { kind: "noul" as const, probability: 0.02 },
						states_published: { kind: "noul" as const, probability: 0.02 },
						states_files_changed: { kind: "noul" as const, probability: 0.02 },
					}
				: {}),
		});
		world.provider.enqueue("root", {
			name: `${label}-baseline`,
			reply: { content: [{ type: "text", text: `The ${label} baseline is established.` }] },
		});
		await withDeadline(world.trace, `${label} establishes durable history`, owner.session.prompt(baselineWords));
		const prefixIds = owner.sessionManager.getBranch().map((entry) => entry.id);
		const originalRead = owner.session.getToolDefinition("read");
		const requestsBefore = world.provider.reached.length;
		world.provider.enqueue("root", {
			name: `${label}-answer`,
			check: (request) => {
				const settledTools = owner.session.getToolDefinition("read");
				if (
					!lifecycleExited ||
					(outcome === "rolled-back" ? settledTools !== originalRead : settledTools === originalRead)
				)
					throw new Error(`${label}: provider request did not observe the settled runtime generation`);
				const inputs = request.context.messages.filter(
					(message) => message.role === "user" && JSON.stringify(message.content).includes(words),
				);
				if (inputs.length !== 1)
					throw new Error(`${label}: provider received ${inputs.length} copies of owner input`);
			},
			reply: { content: [{ type: "text", text: response }] },
		});
		armReload = true;
		if (outcome === "normal-order") release.release();
		const replacing = owner.session.reload().then(
			() => {
				reloadSettled = true;
				return undefined;
			},
			(error: unknown) => {
				reloadSettled = true;
				return error;
			},
		);
		let input: Promise<void> | undefined;
		let reloadError: unknown;
		try {
			await withDeadline(world.trace, `${label} reached real session_start`, reached.promise);
			if (outcome === "normal-order") {
				reloadError = await withDeadline(world.trace, `${label} normal-order reload settled`, replacing);
				await withDeadline(
					world.trace,
					`${label} committed lifecycle message delivered`,
					candidateDisposition.promise,
				);
			}
			const entriesAtGate = JSON.stringify(owner.sessionManager.getEntries());
			const leafAtGate = owner.sessionManager.getLeafId();
			observingOwnerIngress = true;
			input = owner.session.prompt(words);
			if (outcome !== "normal-order") {
				await withDeadline(
					world.trace,
					`${label} owner ingress waits on production generation`,
					inputWaiting.promise,
				);
				expect(lifecycleEntered, "the real candidate lifecycle was entered").toBe(true);
				expect(lifecycleExited, "the candidate lifecycle remains physically held").toBe(false);
				expect(reloadSettled, "the held replacement has not settled").toBe(false);
				expect(JSON.stringify(owner.sessionManager.getEntries()), "waiting input appends no durable entry").toBe(
					entriesAtGate,
				);
				expect(owner.sessionManager.getLeafId(), "waiting input leaves the held generation leaf unchanged").toBe(
					leafAtGate,
				);
				expect(
					world.provider.reached.slice(requestsBefore),
					"no owner provider request escapes the held replacement",
				).toEqual([]);
			}
		} finally {
			observingOwnerIngress = false;
			release.release();
			reloadError = await withDeadline(world.trace, `${label} replacement joined`, replacing);
			if (input) await withDeadline(world.trace, `${label} owner input joined`, input);
		}
		await withDeadline(world.trace, `${label} candidate disposition observed`, candidateDisposition.promise);
		await withDeadline(world.trace, `${label} foreground settled`, owner.session.waitForForegroundIdle());
		expect(lifecycleExited, "the held lifecycle completes after release").toBe(true);
		if (outcome === "rolled-back") {
			expect(
				reloadError instanceof Error ? reloadError.message : undefined,
				"failed candidate remains a visible reload failure",
			).toContain("h2 scripted lifecycle rollback");
			expect(owner.session.getToolDefinition("read"), "rollback restores the previous live tool generation").toBe(
				originalRead,
			);
			expect(
				errors.filter((error) => error.includes("h2 scripted lifecycle rollback")),
				"the lifecycle failure is disclosed once",
			).toHaveLength(1);
			expect(
				errors.filter((error) => error.includes("Deferred extension message was discarded")),
				"the rejected candidate message is disclosed once",
			).toHaveLength(1);
		} else {
			expect(reloadError, "the accepted replacement settles successfully").toBeUndefined();
			expect(owner.session.getToolDefinition("read"), "accepted replacement rebinds tools").not.toBe(originalRead);
			expect(errors, "the accepted generation discloses no extension failure").toEqual([]);
		}
		const branch = owner.sessionManager.getBranch();
		expect(
			prefixIds.every((id) => branch.some((entry) => entry.id === id)),
			"reload preserves every preexisting branch entry",
		).toBe(true);
		expect(
			branch.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(words),
			),
			"the waiting owner input is on the active durable branch exactly once",
		).toHaveLength(1);
		expect(
			branch.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					JSON.stringify(entry.message.content).includes(response),
			),
			"the owner receives exactly one durable final response",
		).toHaveLength(1);
		expect(
			branch.filter((entry) => entry.type === "custom_message" && entry.customType === "h2-runtime-candidate"),
			"only an accepted candidate appends its deferred message",
		).toHaveLength(outcome === "rolled-back" ? 0 : 1);
		expect(world.provider.reached.slice(requestsBefore), "one owner request follows generation settlement").toEqual([
			`root:${label}-answer`,
		]);
		expect(owner.session.getLastAssistantText(), "the returned answer belongs to this owner input").toBe(response);
		expect(inputWaits > 0, "only overlapping submission waits at the generation boundary").toBe(
			outcome !== "normal-order",
		);
		if (world.systemOne.enabled)
			expect(
				world.systemOne.decoded
					.filter((request) => request.phase === label && "carries_0" in request.questions)
					.map((request) => request.state),
				"the reached backlog screen classifies exactly this owner's baseline words",
			).toEqual([{ owner_messages: [baselineWords] }]);
		const sessionFile = owner.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error(`${label}: the completed owner turn has no persisted session file`);
		expect(
			world
				.openSessionManager(sessionFile)
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "user" &&
						JSON.stringify(entry.message.content).includes(words),
				),
			"reopening the persisted session retains the owner input on its selected branch",
		).toHaveLength(1);
		expect(
			owner.sessionManager.inspectSessionLifecycle().balanced,
			"reload and input leave lifecycle entries balanced",
		).toBe(true);
		if (outcome === "normal-order") {
			await withDeadline(world.trace, "H2 exact command lease reload", owner.session.prompt("/h2-reload"));
			expect(commandReloads, "a deliberate reload command retains its exact pre-turn upgrade").toBe(1);
			expect(errors, "the command handoff emits no extension refusal").toEqual([]);
		}
		unsubscribe();
		expect(
			await world.disposeSessionInBody(owner.session),
			"the reload interaction owner disposes cleanly",
		).toBeUndefined();
		world.trace.mark("root", `${label}.owner-delivered`);
	}
	await runRuntimeCallbackLifetimeInteraction(world);
	await runQueuedReloadInteraction(world);
	await runManagedReloadRecoveryInteraction(world);
}
