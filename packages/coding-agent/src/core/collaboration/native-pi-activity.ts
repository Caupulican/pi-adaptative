import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import type { AgentSessionEventListener } from "../agent-session-contracts.ts";
import type { ForegroundRecoveryController } from "../foreground-recovery-controller.ts";
import type { HumanInputRequest } from "../human-input.ts";
import { subscribeHumanInputActivity } from "../human-input-activity.ts";
import { connectHerdrChannel, type HerdrEventChannel } from "./herdr-channel.ts";
import { herdrTarget } from "./herdr-codec.ts";
import { NATIVE_PI_SOURCE_PREFIX } from "./native-pi-protocol.ts";
import { createNativePiQuestionReporter, type NativePiQuestionReporter } from "./native-pi-question.ts";

export interface NativePiActivityPort {
	foreground: Pick<
		ForegroundRecoveryController,
		"isBusy" | "waitForIdle" | "subscribeActivity" | "getCurrentSubmissionEpoch"
	>;
	/** Delegates to the session settlement owner, including scheduled goal/research continuations. */
	isSettled(): boolean;
	subscribePendingContinuation(listener: () => void): () => void;
}
export interface NativePiActivityHost extends NativePiActivityPort {
	sessionManager: Pick<SessionManager, "getSessionId" | "getSessionFile">;
	subscribe(listener: AgentSessionEventListener): () => void;
}
export interface NativePiActivity {
	refresh(): void;
	flush(): Promise<void>;
	dispose(): Promise<void>;
}

/** Native status integration only. Transcripts, tool arguments, and reasoning never enter this channel. */
export async function attachNativePiActivity(
	host: NativePiActivityHost,
	options: {
		env?: NodeJS.ProcessEnv;
		connect?: (path: string, signal: AbortSignal) => Promise<HerdrEventChannel>;
		onError?: (error: Error) => void;
		questionReporter?: NativePiQuestionReporter;
	} = {},
): Promise<NativePiActivity | undefined> {
	const env = options.env ?? process.env;
	if (env.HERDR_ENV !== "1") return undefined;
	const questionReporter = options.questionReporter ?? createNativePiQuestionReporter(env, options.onError);
	const paneId = herdrTarget(env.HERDR_PANE_ID ?? "");
	const socketPath = env.HERDR_SOCKET_PATH;
	if (!socketPath || socketPath.includes("\0") || (!isAbsolute(socketPath) && !socketPath.startsWith("\\\\.\\pipe\\")))
		throw new Error("Native Pi requires its injected Herdr socket.");
	const lifetime = new AbortController();
	const connectTimeout = setTimeout(() => lifetime.abort(), 5000);
	let channel: HerdrEventChannel;
	try {
		channel = await (options.connect ?? connectHerdrChannel)(socketPath, lifetime.signal);
	} finally {
		clearTimeout(connectTimeout);
	}
	const source = `${NATIVE_PI_SOURCE_PREFIX}${randomUUID()}`;
	const questions = new Map<string, HumanInputRequest>();
	let sequence = 0;
	let generation = 0;
	let disposed = false;
	let failed: Error | undefined;
	let queued = 0;
	let lastState: string | undefined;
	let questionMetadata = false;
	let readyMetadata = false;
	let selectedQuestionId: string | undefined;
	let tail = Promise.resolve();
	const fail = () => {
		if (failed) return;
		failed = new Error("Native Pi collaboration status connection failed; no input was replayed.");
		lifetime.abort();
		channel.close();
		try {
			options.onError?.(failed);
		} catch {
			/* Status telemetry cannot abort the foreground run. */
		}
	};
	const request = async (method: string, params: Record<string, unknown>) => {
		const deadline = setTimeout(fail, 5000);
		try {
			await channel.request(method, params);
		} finally {
			clearTimeout(deadline);
		}
	};
	const offConnection = channel.onEvent((event) => {
		if (typeof event === "object" && event !== null && "error" in event) fail();
	});
	try {
		// Ordinary RPC sockets close after their reply; this dedicated subscription owns idle liveness.
		await request("events.subscribe", { subscriptions: [{ type: "pane.exited" }, { type: "pane.closed" }] });
	} catch (error) {
		offConnection();
		fail();
		throw error;
	}
	const publish = (state: "working" | "idle" | "blocked", message?: string) => {
		if (disposed || failed || lastState === `${state}:${message ?? ""}`) return;
		if (queued >= 32) {
			fail();
			return;
		}
		lastState = `${state}:${message ?? ""}`;
		queued++;
		tail = tail
			.then(async () => {
				if (failed || (state === "idle" && (host.foreground.isBusy || !host.isSettled() || questions.size > 0)))
					return;
				if (state === "blocked" || questionMetadata || (state === "idle" && !readyMetadata)) {
					// Initial idle follows runtime activation, after the TUI has bound input. Herdr
					// filters these labels by applies_to_source; a guessed screen idle has no proof.
					readyMetadata ||= state === "idle";
					const stateLabels = {
						...(readyMetadata ? { idle: source } : {}),
						...(state === "blocked" ? { blocked: message ?? "Question requires an answer." } : {}),
					};
					await request("pane.report_metadata", {
						pane_id: paneId,
						source,
						agent: "pi",
						applies_to_source: source,
						seq: ++sequence,
						state_labels: stateLabels,
						clear_state_labels: Object.keys(stateLabels).length === 0,
					});
					questionMetadata = state === "blocked";
				}
				await request("pane.report_agent", {
					pane_id: paneId,
					source,
					agent: "pi",
					state,
					seq: ++sequence,
					agent_session_id: host.sessionManager.getSessionId(),
					agent_session_path: host.sessionManager.getSessionFile() ?? null,
					message: message ?? null,
				});
			})
			.catch(fail)
			.finally(() => {
				queued--;
			});
	};
	const refresh = () => {
		if (disposed || failed) return;
		const revision = ++generation;
		const question = questions.values().next().value;
		if (question) {
			if (selectedQuestionId !== question.requestId) {
				questionReporter?.waiting(question);
				selectedQuestionId = question.requestId;
			}
			publish(
				"blocked",
				`Question ${question.requestId}: ${question.questions.map((item) => item.question).join("; ")}`.slice(
					0,
					2000,
				),
			);
			return;
		}
		selectedQuestionId = undefined;
		if (host.foreground.isBusy || !host.isSettled()) publish("working");
		const epoch = host.foreground.getCurrentSubmissionEpoch();
		void host.foreground
			.waitForIdle()
			.then(() => {
				if (
					disposed ||
					failed ||
					generation !== revision ||
					questions.size > 0 ||
					host.foreground.isBusy ||
					!host.isSettled()
				)
					return;
				// An acquire/release pair between scheduling and resolution invalidates this observation,
				// including when both final epoch reads are undefined.
				if (
					host.foreground.getCurrentSubmissionEpoch() !== undefined &&
					host.foreground.getCurrentSubmissionEpoch() !== epoch
				)
					return;
				publish("idle");
			})
			.catch(fail);
	};
	const offForeground = host.foreground.subscribeActivity(refresh);
	const offContinuation = host.subscribePendingContinuation(refresh);
	const offQuestions = subscribeHumanInputActivity(host.sessionManager, (activity) => {
		if (activity.phase === "waiting") {
			questions.set(activity.request.requestId, activity.request);
		} else {
			questionReporter?.settled(activity.request.requestId);
			questions.delete(activity.request.requestId);
		}
		refresh();
	});
	const offEvents = host.subscribe((event) => {
		if (
			[
				"agent_start",
				"agent_end",
				"queue_update",
				"compaction_start",
				"compaction_end",
				"auto_retry_end",
				"background_tools",
				"delegate_workers",
			].includes(event.type)
		)
			refresh();
	});
	const flush = async () => {
		let current: Promise<void>;
		do {
			await Promise.resolve();
			current = tail;
			await current;
		} while (current !== tail);
		if (failed) throw failed;
	};
	refresh();
	return {
		refresh,
		flush,
		async dispose() {
			if (disposed) return;
			disposed = true;
			generation++;
			offForeground();
			offContinuation();
			offQuestions();
			offEvents();
			offConnection();
			try {
				await flush();
				await request("pane.release_agent", { pane_id: paneId, source, agent: "pi", seq: ++sequence });
			} finally {
				lifetime.abort();
				channel.close();
			}
		},
	};
}
