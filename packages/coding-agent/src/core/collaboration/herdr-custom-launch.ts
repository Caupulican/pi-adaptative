import { type CollaborationAgent, CollaborationBackendError, type CollaborationStart } from "./backend.ts";
import type { HerdrEventChannel } from "./herdr-channel.ts";
import { herdrRecord, parseHerdrAgent, parseHerdrPane } from "./herdr-codec.ts";

/** Explicit trusted wrapper commands retain the same pane/occupant event fence as native launches. */
export async function launchHerdrCommand(
	connection: HerdrEventChannel,
	input: CollaborationStart & { command: string },
): Promise<CollaborationAgent> {
	const rawPane = herdrRecord(herdrRecord(await connection.request("pane.get", { pane_id: input.paneId })).pane);
	const before = parseHerdrPane(rawPane);
	const initialSequence = typeof rawPane.state_change_seq === "number" ? rawPane.state_change_seq : 0;
	const isStoppedCandidate = (agent: CollaborationAgent) =>
		agent.kind === input.kind &&
		!agent.launchPending &&
		(input.kind !== "pi" || agent.interactiveReady) &&
		agent.stateChangeSequence > initialSequence &&
		(agent.status === "blocked" || agent.status === "idle" || agent.status === "done");
	if (rawPane.agent)
		throw new CollaborationBackendError(
			"pane_busy",
			"Custom collaboration launch requires an unoccupied shell pane.",
			"not-submitted",
		);
	let submitted = false;
	let checking = false;
	let pendingEvent = false;
	let terminal = false;
	let resolveReady: ((agent: CollaborationAgent) => void) | undefined;
	let rejectReady: ((error: Error) => void) | undefined;
	const ready = new Promise<CollaborationAgent>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	void ready.catch(() => {});
	const check = () => {
		if (terminal || !submitted) return;
		if (checking) {
			pendingEvent = true;
			return;
		}
		checking = true;
		void connection
			.request("agent.get", { target: before.paneId })
			.then(
				async (reply) => {
					const current = parseHerdrAgent(herdrRecord(reply).agent);
					if (current.terminalId !== before.terminalId || (current.kind && current.kind !== input.kind))
						throw new CollaborationBackendError(
							"occupant_changed",
							"The custom command launched an unexpected agent.",
						);
					if (!isStoppedCandidate(current)) return;
					const named = parseHerdrAgent(
						herdrRecord(await connection.request("agent.rename", { target: before.paneId, name: input.name }))
							.agent,
					);
					if (named.terminalId !== before.terminalId || named.kind !== input.kind || named.name !== input.name)
						throw new CollaborationBackendError(
							"occupant_changed",
							"Custom agent identity changed during admission.",
						);
					if (!isStoppedCandidate(named)) return;
					terminal = true;
					if (named.status === "blocked")
						rejectReady?.(
							new CollaborationBackendError(
								"agent_not_ready",
								"Custom agent started but needs a question answered before dispatch.",
							),
						);
					else resolveReady?.(named);
				},
				(error) => {
					// A status event with no matching agent is not readiness evidence. Connection termination is terminal.
					if (error instanceof CollaborationBackendError && error.code === "connection_closed") throw error;
				},
			)
			.catch((error) => {
				terminal = true;
				rejectReady?.(error instanceof Error ? error : new Error("Custom collaboration launch failed."));
			})
			.finally(() => {
				checking = false;
				if (pendingEvent) {
					pendingEvent = false;
					check();
				}
			});
	};
	const unsubscribe = connection.onEvent((value) => {
		try {
			const event = herdrRecord(value);
			if (event.error) {
				terminal = true;
				rejectReady?.(
					new CollaborationBackendError(
						"connection_closed",
						"Custom launch connection ended; the command is not replayed.",
					),
				);
				return;
			}
			const data = herdrRecord(event.data);
			if (data.pane_id !== before.paneId) return;
			if (event.event === "pane_exited" || event.event === "pane_closed") {
				terminal = true;
				rejectReady?.(
					new CollaborationBackendError("occupant_changed", "Custom collaboration pane closed during startup."),
				);
				return;
			}
			check();
		} catch (error) {
			terminal = true;
			rejectReady?.(error instanceof Error ? error : new Error("Malformed launch event."));
		}
	});
	try {
		await connection.request("events.subscribe", {
			subscriptions: [
				{ type: "pane.agent_status_changed", pane_id: before.paneId },
				{ type: "pane.agent_detected" },
				{ type: "pane.exited" },
				{ type: "pane.closed" },
			],
		});
		const currentPane = herdrRecord(
			herdrRecord(await connection.request("pane.get", { pane_id: before.paneId })).pane,
		);
		if (parseHerdrPane(currentPane).terminalId !== before.terminalId || currentPane.agent)
			throw new CollaborationBackendError(
				"pane_busy",
				"The shell pane changed before custom launch.",
				"not-submitted",
			);
		submitted = true;
		await connection.request("pane.send_input", { pane_id: before.paneId, text: input.command, keys: ["enter"] });
		check();
		return await ready;
	} finally {
		terminal = true;
		unsubscribe();
	}
}
