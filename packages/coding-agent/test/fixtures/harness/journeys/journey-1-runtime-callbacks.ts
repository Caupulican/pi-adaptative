import { expect } from "vitest";
import { createBarrier } from "../scripted-provider.ts";
import { type HarnessWorld, withDeadline } from "../session-fixture.ts";

/** Lifecycle-created callbacks use their settled originating runtime, including terminal delivery verdicts. */
export async function runRuntimeCallbackLifetimeInteraction(world: HarnessWorld): Promise<void> {
	for (const outcome of ["startup", "committed", "rolled-back"] as const) {
		const label = `h2-callback-${outcome}`;
		const words = `Answer the callback input from ${label}.`;
		const response = `The ${label} callback input was answered.`;
		const created = createBarrier();
		const releaseLifecycle = createBarrier();
		const trigger = createBarrier();
		const customSettled = createBarrier();
		const acceptanceSettled = createBarrier();
		const refusalObserved = createBarrier();
		const reloadTrigger = createBarrier();
		const secondLifecycleEntered = createBarrier();
		const releaseSecondLifecycle = createBarrier();
		const ownerInputWaiting = createBarrier();
		const errors: { event: string; error: string }[] = [];
		const resourceErrors: unknown[] = [];
		const verdicts: boolean[] = [];
		let armed = false;
		let lifecycleEntered = false;
		let lifecycleExited = false;
		let runtimeSettled = false;
		let callbackEntered = false;
		let callbackRanDuringLifecycle = false;
		let callbackDone: Promise<unknown> = Promise.resolve();
		let callbackReloadDone: Promise<unknown> = Promise.resolve();
		let secondReloadArmed = false;
		let secondLifecycleExited = false;
		let observingOwnerInput = false;
		const owner = await world.createRootSession("root", {
			sessionManager: world.createSessionManager(),
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async (event, ctx) => {
						if (event.reason === "reload" && secondReloadArmed) {
							secondReloadArmed = false;
							secondLifecycleEntered.release();
							await releaseSecondLifecycle.promise;
							secondLifecycleExited = true;
							return;
						}
						if (outcome === "startup") {
							if (event.reason !== "startup" || lifecycleEntered) return;
						} else {
							if (event.reason !== "reload" || !armed) return;
							armed = false;
						}
						lifecycleEntered = true;
						if (outcome === "committed")
							callbackReloadDone = reloadTrigger.promise
								.then(() => ctx.reload())
								.then(
									() => undefined,
									(error: unknown) => error,
								);
						// Register the continuation inside the real lifecycle callback. Resolving its
						// trigger elsewhere retains the async context in which .then was registered.
						callbackDone = trigger.promise
							.then(async () => {
								callbackEntered = true;
								callbackRanDuringLifecycle = !lifecycleExited;
								try {
									pi.appendEntry("h2-callback-resource", { label });
								} catch (error) {
									resourceErrors.push(error);
								}
								pi.sendMessage({ customType: "h2-callback-message", content: label, display: false });
								await customSettled.promise;
								pi.sendUserMessage(words, {
									onAccepted: (accepted) => {
										verdicts.push(accepted);
										acceptanceSettled.release();
									},
								});
								await acceptanceSettled.promise;
							})
							.then(
								() => undefined,
								(error: unknown) => error,
							);
						created.release();
						try {
							if (outcome !== "startup") await releaseLifecycle.promise;
							if (outcome === "rolled-back") throw new Error(`${label}: scripted lifecycle rollback`);
						} finally {
							lifecycleExited = true;
						}
					});
				},
			],
		});
		await owner.session.bindExtensions({
			uiContext: world.humanInput.ui,
			onError: (error) => {
				errors.push({ event: error.event, error: error.error });
				if (error.event === "send_message") customSettled.release();
				if (error.event === "send_user_message") refusalObserved.release();
			},
		});
		const unsubscribe = owner.session.subscribe((event) => {
			if (
				observingOwnerInput &&
				event.type === "wait" &&
				event.id === "runtime_generation.admission" &&
				event.phase === "start"
			)
				ownerInputWaiting.release();
			if (
				event.type === "message_end" &&
				event.message.role === "custom" &&
				event.message.customType === "h2-callback-message" &&
				event.message.content === label
			)
				customSettled.release();
		});
		world.systemOne.enterPhase(`${label}-baseline`, {});
		world.provider.enqueue("root", {
			name: `${label}-baseline`,
			reply: { content: [{ type: "text", text: `The ${label} baseline is ready.` }] },
		});
		await withDeadline(world.trace, `${label} durable baseline`, owner.session.prompt(`Hello from ${label}.`));
		const originalRead = owner.session.getToolDefinition("read");
		let reloadError: unknown;
		if (outcome !== "startup") {
			armed = true;
			const replacing = owner.session.reload().then(
				() => {
					runtimeSettled = true;
					return undefined;
				},
				(error: unknown) => {
					runtimeSettled = true;
					return error;
				},
			);
			try {
				await withDeadline(world.trace, `${label} callback registered in real reload lifecycle`, created.promise);
				expect(lifecycleEntered, "the actual candidate session_start reached the callback registration").toBe(true);
				expect(lifecycleExited, "the candidate callback registration is still inside the held lifecycle").toBe(
					false,
				);
				expect(runtimeSettled, "the callback was created before runtime settlement").toBe(false);
				expect(callbackEntered, "the deferred callback has not run inside the lifecycle").toBe(false);
			} finally {
				releaseLifecycle.release();
				reloadError = await withDeadline(world.trace, `${label} reload disposition joined`, replacing);
			}
		} else {
			await withDeadline(world.trace, `${label} ordinary startup callback registered`, created.promise);
			runtimeSettled = true;
		}
		if (outcome === "rolled-back") {
			expect(
				reloadError instanceof Error ? reloadError.message : undefined,
				"rollback remains a reload failure",
			).toContain(`${label}: scripted lifecycle rollback`);
			expect(owner.session.getToolDefinition("read"), "rollback retains the old live runtime").toBe(originalRead);
		} else {
			expect(reloadError, "the callback's originating runtime settles successfully").toBeUndefined();
			if (outcome === "committed")
				expect(owner.session.getToolDefinition("read"), "the callback belongs to the committed runtime").not.toBe(
					originalRead,
				);
		}
		expect(lifecycleExited, "the lifecycle finishes before the callback is triggered").toBe(true);
		expect(runtimeSettled, "the runtime is settled before callback invocation").toBe(true);
		expect(callbackEntered, "callback invocation is explicitly delayed until settlement").toBe(false);
		const requestsBefore = world.provider.reached.length;
		if (outcome !== "rolled-back") {
			world.provider.enqueue("root", {
				name: `${label}-answer`,
				check: (request) => {
					if (!runtimeSettled || !lifecycleExited || !callbackEntered)
						throw new Error(`${label}: input escaped the settled callback boundary`);
					const inputs = request.context.messages.filter(
						(message) => message.role === "user" && JSON.stringify(message.content).includes(words),
					);
					if (inputs.length !== 1)
						throw new Error(`${label}: callback input reached provider ${inputs.length} times`);
				},
				reply: { content: [{ type: "text", text: response }] },
			});
		}
		world.systemOne.enterPhase(
			label,
			outcome === "rolled-back"
				? {}
				: {
						// The prior text-only owner greeting is screened aside at this turn's backlog boundary.
						carries_0: { kind: "noul", probability: 0.97 },
						// Extension input asks owner-policy questions without optional-tool intent.
						changes_model_pools: { kind: "noul", probability: 0.02 },
						local_commits_only: { kind: "noul", probability: 0.02 },
						lifts_delivery_block: { kind: "noul", probability: 0.02 },
						full_handoff: { kind: "noul", probability: 0.02 },
						capabilities_authorized: { kind: "noul", probability: 0.02 },
					},
		);
		trigger.release();
		expect(await withDeadline(world.trace, `${label} callback terminal verdict`, callbackDone)).toBeUndefined();
		if (outcome === "rolled-back")
			await withDeadline(world.trace, `${label} pre-delivery refusal reaches current host`, refusalObserved.promise);
		await withDeadline(world.trace, `${label} callback foreground settled`, owner.session.waitForForegroundIdle());
		expect(callbackEntered, "the callback really ran after lifecycle completion").toBe(true);
		expect(callbackRanDuringLifecycle, "the witness exercises a later callback, not the lifecycle handler").toBe(
			false,
		);
		expect(verdicts, "the sender receives exactly one terminal acceptance or refusal").toEqual([
			outcome !== "rolled-back",
		]);
		expect(resourceErrors, "only the discarded runtime loses resource mutation authority").toHaveLength(
			outcome === "rolled-back" ? 1 : 0,
		);
		const entries = owner.sessionManager.getEntries();
		expect(
			entries.filter((entry) => entry.type === "custom" && entry.customType === "h2-callback-resource"),
			"only a live originating callback persists its resource entry",
		).toHaveLength(outcome === "rolled-back" ? 0 : 1);
		expect(
			entries.filter((entry) => entry.type === "custom_message" && entry.customType === "h2-callback-message"),
			"only a live originating callback persists its custom message",
		).toHaveLength(outcome === "rolled-back" ? 0 : 1);
		expect(
			entries.filter(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes(words),
			),
			"accepted callback input persists once; refused candidate input never enters the branch",
		).toHaveLength(outcome === "rolled-back" ? 0 : 1);
		if (outcome === "rolled-back") {
			expect(
				errors.filter((error) => error.event === "send_message"),
				"custom refusal reaches current host once",
			).toHaveLength(1);
			expect(
				errors.filter((error) => error.event === "send_user_message"),
				"user refusal reaches current host once",
			).toHaveLength(1);
			expect(
				errors.filter((error) => error.error.includes("scripted lifecycle rollback")),
				"lifecycle rollback is disclosed once",
			).toHaveLength(1);
			expect(world.provider.reached.slice(requestsBefore), "no refused candidate input reaches a provider").toEqual(
				[],
			);
		} else {
			expect(errors, "ordinary startup and accepted-runtime callbacks emit no refusal").toEqual([]);
			expect(
				world.provider.reached.slice(requestsBefore),
				"accepted callback makes exactly one provider request",
			).toEqual([`root:${label}-answer`]);
			expect(owner.session.getLastAssistantText(), "accepted callback receives its final response").toBe(response);
		}
		if (outcome === "committed") {
			const ownerWords = `${label}: answer the owner waiting through callback reload.`;
			const ownerResponse = `${label}: the waiting owner received a response.`;
			const readBeforeSecondReload = owner.session.getToolDefinition("read");
			const requestsBeforeSecondReload = world.provider.reached.length;
			world.systemOne.enterPhase(`${label}-second-reload`, {});
			world.provider.enqueue("root", {
				name: `${label}-second-reload-answer`,
				check: (request) => {
					if (!secondLifecycleExited || owner.session.getToolDefinition("read") === readBeforeSecondReload)
						throw new Error(`${label}: owner input escaped the second committed generation`);
					if (
						request.context.messages.filter(
							(message) => message.role === "user" && JSON.stringify(message.content).includes(ownerWords),
						).length !== 1
					)
						throw new Error(`${label}: waiting owner input was not delivered exactly once`);
				},
				reply: { content: [{ type: "text", text: ownerResponse }] },
			});
			secondReloadArmed = true;
			reloadTrigger.release();
			let waitingInput: Promise<void> | undefined;
			try {
				await withDeadline(
					world.trace,
					`${label} committed callback starts second reload`,
					secondLifecycleEntered.promise,
				);
				expect(secondLifecycleExited, "the second actual reload is held").toBe(false);
				observingOwnerInput = true;
				waitingInput = owner.session.prompt(ownerWords);
				await withDeadline(
					world.trace,
					`${label} ordinary owner reached generation admission`,
					ownerInputWaiting.promise,
				);
				expect(
					world.provider.reached.slice(requestsBeforeSecondReload),
					"held reload admits no provider work",
				).toEqual([]);
				expect(
					owner.sessionManager
						.getEntries()
						.some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "user" &&
								JSON.stringify(entry.message.content).includes(ownerWords),
						),
					"waiting owner input has not persisted during replacement",
				).toBe(false);
			} finally {
				releaseSecondLifecycle.release();
				expect(
					await withDeadline(world.trace, `${label} callback reload joined`, callbackReloadDone),
				).toBeUndefined();
				if (waitingInput) await withDeadline(world.trace, `${label} waiting owner completed`, waitingInput);
				observingOwnerInput = false;
			}
			expect(
				world.provider.reached.slice(requestsBeforeSecondReload),
				"publication wakes ordinary owner input once",
			).toEqual([`root:${label}-second-reload-answer`]);
			expect(
				owner.session.getLastAssistantText(),
				"owner receives its final answer after callback origin retires",
			).toBe(ownerResponse);
			expect(errors, "retiring callback origin does not poison host admission").toEqual([]);
			expect(
				owner.sessionManager
					.getEntries()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(ownerWords),
					),
				"waiting owner input persists exactly once after publication",
			).toHaveLength(1);
		}
		const sessionFile = owner.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error(`${label}: the callback owner has no persisted session`);
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
			"reopening the selected durable branch retains accepted callback input and excludes refused candidate input",
		).toHaveLength(outcome === "rolled-back" ? 0 : 1);
		if (outcome === "committed")
			expect(
				world
					.openSessionManager(sessionFile)
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "user" &&
							JSON.stringify(entry.message.content).includes(
								`${label}: answer the owner waiting through callback reload.`,
							),
					),
				"reopening retains the ordinary owner input delivered after callback-origin retirement",
			).toHaveLength(1);
		expect(owner.session.getSteeringMessages(), "callback delivery leaves no held steering input").toEqual([]);
		expect(
			owner.sessionManager.inspectSessionLifecycle().balanced,
			"callback delivery leaves lifecycle balanced",
		).toBe(true);
		unsubscribe();
		expect(
			await world.disposeSessionInBody(owner.session),
			"the callback interaction owner disposes cleanly",
		).toBeUndefined();
		world.trace.mark("root", `${label}.settled`);
	}
}
