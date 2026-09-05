import { isAbsolute } from "node:path";
import { Value } from "typebox/value";
import {
	type CollaborationAgent,
	type CollaborationBackend,
	CollaborationBackendError,
	type CollaborationLocation,
	type CollaborationPane,
	type CollaborationPrompt,
	type CollaborationQuestionAnswer,
	type CollaborationRead,
	type CollaborationStart,
	type CollaborationWorkspace,
} from "./backend.ts";
import { type CollaborationCommandRunner, runCollaborationCommand } from "./command-runner.ts";
import { connectHerdrChannel, type HerdrEventChannel } from "./herdr-channel.ts";
import {
	parseHerdrAgent as agent,
	herdrHandle as handle,
	malformedHerdrResponse as malformed,
	parseHerdrPane as pane,
	herdrRecord as record,
	herdrSequence as sequence,
	herdrTarget as target,
} from "./herdr-codec.ts";
import { herdrCommand } from "./herdr-command.ts";
import { launchHerdrCommand } from "./herdr-custom-launch.ts";

function locationArgs(input: CollaborationLocation): string[] {
	if (!isAbsolute(input.cwd) || input.cwd.includes("\0"))
		throw new CollaborationBackendError(
			"invalid_cwd",
			"Collaboration requires an absolute working directory.",
			"not-submitted",
		);
	const args = ["--cwd", input.cwd, "--no-focus"];
	const entries = Object.entries(input.env ?? {});
	if (entries.length > 64) throw new Error("Collaboration environment exceeds 64 entries.");
	for (const [key, value] of entries) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0") || value.length > 16384)
			throw new Error("Invalid collaboration environment.");
		args.push("--env", `${key}=${value}`);
	}
	return args;
}

export interface HerdrBackendOptions {
	executable: string;
	session: string;
	configPath?: string;
	run?: CollaborationCommandRunner;
	socketPath?: string;
	connect?: (path: string, signal: AbortSignal) => Promise<HerdrEventChannel>;
}

/** All native I/O is isolated here; replacing Herdr does not replace the durable job ledger. */
export class HerdrBackend implements CollaborationBackend {
	readonly id = "herdr";
	readonly session: string;
	private readonly options: HerdrBackendOptions;
	private readonly run: CollaborationCommandRunner;

	constructor(options: HerdrBackendOptions) {
		if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.session))
			throw new Error("An explicit named Herdr session is required.");
		this.options = options;
		this.session = options.session;
		this.run = options.run ?? runCollaborationCommand;
	}

	private async request(
		args: string[],
		type: string | undefined,
		timeoutMs = 30000,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		if (signal?.aborted)
			throw new CollaborationBackendError(
				"aborted",
				"Collaboration command cancelled before submission.",
				"not-submitted",
			);
		const output = await this.run(this.options.executable, ["--session", this.session, ...args], {
			timeoutMs,
			signal,
			env: { ...process.env, ...(this.options.configPath ? { HERDR_CONFIG_PATH: this.options.configPath } : {}) },
		});
		if (output.reason !== "exited")
			throw new CollaborationBackendError(
				output.reason,
				`Herdr control command ${output.reason}; inspect the existing turn before continuing.`,
				output.reason === "not_found" ? "not-submitted" : "unknown",
			);
		// Herdr's void CLI wrappers intentionally suppress the raw API's success envelope.
		if (type === undefined && output.code === 0 && !output.stdout.trim()) return {};
		let decoded: unknown;
		try {
			decoded = JSON.parse(output.code === 0 ? output.stdout : output.stderr);
		} catch {
			return malformed();
		}
		const envelope = record(decoded);
		if (output.code !== 0 || envelope.error) {
			const error = record(envelope.error);
			const code =
				typeof error.code === "string" && /^[a-z_]{1,64}$/.test(error.code) ? error.code : "backend_error";
			// Only this server error has a documented pre-input guarantee. Do not guess for timeouts/stalls.
			throw new CollaborationBackendError(
				code,
				`Herdr rejected the control request (${code}).`,
				code === "agent_blocked" ? "not-submitted" : "unknown",
			);
		}
		const result = record(envelope.result);
		if (type !== undefined && result.type !== type) return malformed();
		return result;
	}

	async createWorkspace(input: CollaborationLocation & { label: string }): Promise<CollaborationWorkspace> {
		if (!input.label || input.label.length > 256 || input.label.includes("\0"))
			throw new Error("Invalid collaboration workspace label.");
		const result = await this.request(
			["workspace", "create", ...locationArgs(input), "--label", input.label],
			"workspace_created",
		);
		const rootPane = pane(result.root_pane);
		if (
			record(result.workspace).workspace_id !== rootPane.workspaceId ||
			record(result.tab).tab_id !== rootPane.tabId
		)
			return malformed();
		return { workspaceId: rootPane.workspaceId, tabId: rootPane.tabId, rootPane };
	}

	async splitPane(
		input: CollaborationLocation & { paneId: string; direction?: "right" | "down" },
	): Promise<CollaborationPane> {
		return pane(
			(
				await this.request(
					[
						"pane",
						"split",
						target(input.paneId),
						"--direction",
						input.direction ?? "right",
						...locationArgs(input),
					],
					"pane_info",
				)
			).pane,
		);
	}

	async startAgent(input: CollaborationStart): Promise<CollaborationAgent> {
		if (!/^[a-z][a-z0-9_-]{0,31}$/.test(input.name) || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.kind))
			throw new Error("Invalid collaboration agent name/kind.");
		const timeoutMs = input.timeoutMs ?? 30000;
		if (
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1000 ||
			timeoutMs > 300000 ||
			(input.args?.length ?? 0) > 128 ||
			input.args?.some((arg) => arg.includes("\0") || arg.length > 16384)
		)
			throw new Error("Invalid agent launch arguments or timeout.");
		if (input.command !== undefined || input.executable !== undefined) {
			// Native process titles and wrapper names need not equal Herdr's known agent label.
			// Scope its documented foreground-process hint to the command, never the parent shell.
			const command = input.executable
				? herdrCommand(
						input.executable,
						input.args ?? [],
						process.platform,
						process.platform === "win32" ? {} : { HERDR_AGENT: input.kind },
					)
				: input.command;
			if (
				!this.options.socketPath ||
				!command?.trim() ||
				command.length > 16384 ||
				command.includes("\0") ||
				(input.command !== undefined && (input.executable !== undefined || input.args?.length))
			)
				throw new CollaborationBackendError(
					"invalid_command",
					"Custom launch requires a bounded complete command and event-capable session.",
					"not-submitted",
				);
			const connection = await (this.options.connect ?? connectHerdrChannel)(
				this.options.socketPath,
				AbortSignal.timeout(timeoutMs),
			);
			try {
				return await launchHerdrCommand(connection, {
					...input,
					paneId: target(input.paneId),
					command,
				});
			} finally {
				connection.close();
			}
		}
		const result = agent(
			(
				await this.request(
					[
						"agent",
						"start",
						input.name,
						"--kind",
						input.kind,
						"--pane",
						target(input.paneId),
						"--timeout",
						String(timeoutMs),
						"--",
						...(input.args ?? []),
					],
					"agent_started",
					timeoutMs + 5000,
				)
			).agent,
		);
		if (result.name !== input.name || result.paneId !== input.paneId || result.kind !== input.kind)
			return malformed();
		return result;
	}

	async getAgent(value: string): Promise<CollaborationAgent> {
		const result = agent((await this.request(["agent", "get", target(value)], "agent_info")).agent);
		if (result.paneId !== value && result.name !== value) return malformed();
		return result;
	}

	async listAgents(): Promise<CollaborationAgent[]> {
		const result = await this.request(["agent", "list"], "agent_list");
		if (!Array.isArray(result.agents) || result.agents.length > 256) return malformed();
		return result.agents.map(agent);
	}

	async prompt(input: CollaborationPrompt, signal?: AbortSignal): Promise<CollaborationAgent> {
		if (
			!input.text.trim() ||
			Buffer.byteLength(input.text) > 65536 ||
			input.text.includes("\0") ||
			!Number.isSafeInteger(input.timeoutMs) ||
			input.timeoutMs < 1 ||
			input.timeoutMs > 86400000
		)
			throw new CollaborationBackendError(
				"invalid_prompt",
				"Invalid collaboration prompt or deadline.",
				"not-submitted",
			);
		const before = await this.getAgent(input.target);
		if (
			(input.terminalId && input.terminalId !== before.terminalId) ||
			!before.interactiveReady ||
			before.launchPending ||
			(before.status !== "idle" && before.status !== "done")
		)
			throw new CollaborationBackendError(
				"agent_not_ready",
				"Agent is not an idle, ready, matching pane occupant.",
				"not-submitted",
			);
		const result = agent(
			(
				await this.request(
					["agent", "prompt", before.paneId, input.text, "--wait", "--timeout", String(input.timeoutMs)],
					"agent_prompted",
					input.timeoutMs + 5000,
					signal,
				)
			).agent,
		);
		if (result.terminalId !== before.terminalId || result.paneId !== before.paneId)
			throw new CollaborationBackendError(
				"occupant_changed",
				"The collaboration pane occupant changed during the turn.",
			);
		if (result.status !== "idle" && result.status !== "done" && result.status !== "blocked")
			throw new CollaborationBackendError(
				"not_settled",
				"Herdr returned a nonterminal agent state; the turn remains unresolved.",
			);
		return result;
	}

	async answerQuestion(input: CollaborationQuestionAnswer, signal?: AbortSignal): Promise<CollaborationAgent> {
		if (!this.options.socketPath)
			throw new CollaborationBackendError(
				"event_channel_missing",
				"Question answers require an event-capable Herdr session.",
				"not-submitted",
			);
		if (
			!input.terminalId ||
			(!input.text && !input.keys?.length) ||
			(input.text?.length ?? 0) > 16384 ||
			input.text?.includes("\0") ||
			(input.keys?.length ?? 0) > 32 ||
			input.keys?.some((key) => !/^[a-zA-Z0-9+_-]{1,32}$/.test(key)) ||
			!Number.isSafeInteger(input.timeoutMs) ||
			input.timeoutMs < 1 ||
			input.timeoutMs > 86400000
		)
			throw new CollaborationBackendError(
				"invalid_answer",
				"Invalid collaboration question answer.",
				"not-submitted",
			);
		const deadline = AbortSignal.timeout(input.timeoutMs);
		const connection = await (this.options.connect ?? connectHerdrChannel)(
			this.options.socketPath,
			signal ? AbortSignal.any([deadline, signal]) : deadline,
		);
		try {
			const before = agent(record(await connection.request("agent.get", { target: target(input.target) })).agent);
			if (before.terminalId !== input.terminalId || before.status !== "blocked")
				throw new CollaborationBackendError(
					"question_changed",
					"The expected blocked agent is no longer present.",
					"not-submitted",
				);
			let submitted = false;
			let observedChange = false;
			let resolveSettled: (() => void) | undefined;
			let rejectSettled: ((error: Error) => void) | undefined;
			const settled = new Promise<void>((resolve, reject) => {
				resolveSettled = resolve;
				rejectSettled = reject;
			});
			// Install the listener before subscription acknowledgement and before the one input write.
			const unsubscribe = connection.onEvent((value) => {
				const event = record(value);
				if (event.error)
					return rejectSettled?.(
						new CollaborationBackendError(
							"connection_closed",
							"Question answer wait ended without terminal evidence.",
						),
					);
				if (!submitted) return;
				const data = record(event.data);
				if (data.pane_id !== before.paneId) return;
				if (event.event === "pane_exited" || event.event === "pane_closed" || event.event === "pane_agent_detected")
					return rejectSettled?.(
						new CollaborationBackendError("occupant_changed", "Question answer agent exited or changed."),
					);
				if (event.event !== "pane.agent_status_changed") return;
				observedChange ||= data.agent_status !== "blocked";
				if (
					observedChange &&
					(data.agent_status === "idle" || data.agent_status === "done" || data.agent_status === "blocked")
				)
					resolveSettled?.();
			});
			// Rejections before we await the settlement must still be consumed.
			void settled.catch(() => {});
			try {
				await connection.request("events.subscribe", {
					subscriptions: [
						{ type: "pane.agent_status_changed", pane_id: before.paneId },
						{ type: "pane.exited" },
						{ type: "pane.closed" },
						{ type: "pane.agent_detected" },
					],
				});
				const current = agent(record(await connection.request("agent.get", { target: before.paneId })).agent);
				if (
					current.terminalId !== before.terminalId ||
					current.status !== "blocked" ||
					current.stateChangeSequence !== before.stateChangeSequence
				)
					throw new CollaborationBackendError(
						"question_changed",
						"The question changed before answer submission.",
						"not-submitted",
					);
				submitted = true;
				await connection.request("pane.send_input", {
					pane_id: before.paneId,
					...(input.text ? { text: input.text } : {}),
					keys: input.keys ? [...input.keys] : ["enter"],
				});
				await settled;
				const after = agent(record(await connection.request("agent.get", { target: before.paneId })).agent);
				if (
					after.terminalId !== before.terminalId ||
					(after.status !== "idle" && after.status !== "done" && after.status !== "blocked")
				)
					throw new CollaborationBackendError(
						"occupant_changed",
						"Question answer did not settle on the expected agent.",
					);
				return after;
			} finally {
				unsubscribe();
			}
		} finally {
			connection.close();
		}
	}

	async readAgent(value: string, lines = 120): Promise<CollaborationRead> {
		if (!Number.isInteger(lines) || lines < 1 || lines > 2000)
			throw new Error("Collaboration read lines must be between 1 and 2000.");
		if (!this.options.socketPath)
			throw new CollaborationBackendError(
				"event_channel_missing",
				"Structured snapshot reads require a Herdr socket.",
				"not-submitted",
			);
		const connection = await (this.options.connect ?? connectHerdrChannel)(
			this.options.socketPath,
			AbortSignal.timeout(10000),
		);
		let result: Record<string, unknown>;
		try {
			const response = record(
				await connection.request("agent.read", {
					target: target(value),
					source: "recent_unwrapped",
					lines,
					format: "text",
					strip_ansi: true,
				}),
			);
			if (response.type !== "pane_read") return malformed();
			result = record(response.read);
		} finally {
			connection.close();
		}
		if (
			!Value.Check(handle, result.pane_id) ||
			!Value.Check(sequence, result.revision) ||
			typeof result.text !== "string" ||
			typeof result.truncated !== "boolean"
		)
			return malformed();
		const text = Buffer.from(result.text);
		return {
			paneId: result.pane_id,
			text: text.subarray(0, 65536).toString("utf8"),
			truncated: result.truncated || text.length > 65536,
			revision: result.revision,
		};
	}

	async closePane(paneId: string): Promise<void> {
		await this.request(["pane", "close", target(paneId)], undefined);
	}
	async closeWorkspace(workspaceId: string): Promise<void> {
		await this.request(["workspace", "close", target(workspaceId)], undefined);
	}
	async stopSession(): Promise<void> {
		await this.request(["server", "stop"], undefined);
	}

	async notify(title: string, body: string): Promise<void> {
		if (!title || title.length > 256 || body.length > 2000 || `${title}${body}`.includes("\0"))
			throw new Error("Invalid collaboration notification.");
		await this.request(["notification", "show", title, "--body", body, "--sound", "none"], "notification_show");
	}

	async reportMetadata(
		workspaceId: string,
		tokens: Readonly<Record<string, string | null>>,
		seq: number,
	): Promise<void> {
		if (!Value.Check(sequence, seq) || Object.keys(tokens).length > 32)
			throw new Error("Invalid collaboration metadata sequence or size.");
		const args = [
			"workspace",
			"report-metadata",
			target(workspaceId),
			"--source",
			"pi-collaboration",
			"--seq",
			String(seq),
		];
		for (const [key, value] of Object.entries(tokens)) {
			if (!/^[A-Za-z0-9_-]{1,32}$/.test(key) || (value !== null && (value.length > 256 || value.includes("\0"))))
				throw new Error("Invalid collaboration metadata token.");
			args.push(value === null ? "--clear-token" : "--token", value === null ? key : `${key}=${value}`);
		}
		await this.request(args, undefined);
	}
}
