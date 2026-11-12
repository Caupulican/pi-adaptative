/** Native UI ingress, canonical admission, and settled-task evidence for the live journeys. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";

const liveObserverSource = fileURLToPath(new URL("./live-session-observer.mjs", import.meta.url));

/** Execute only the synthetic journey's edited module in a context with no process, imports or string code generation. */
export function assertSlugifyEdit(source) {
	if (!/\/\*\*[^\r\n]*\*\/\s*(?:export\s+)?(?:function\s+slugify\b|const\s+slugify\b)/.test(source))
		throw new Error("the requested one-line JSDoc comment above slugify is missing");
	const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;
	const result = runInNewContext(
		`const module = { exports: {} }; const exports = module.exports;\n${compiled}\n["Hello, world!", "Pi's harness.", "Plain Text"].map(value => module.exports.slugify(value));`,
		Object.create(null),
		{ timeout: 1000, contextCodeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
	);
	if (JSON.stringify(result) !== JSON.stringify(["hello-world", "pis-harness", "plain-text"])) {
		throw new Error(
			`the edited slugify does not strip punctuation and preserve its prior behavior: ${JSON.stringify(result)}`,
		);
	}
}

export function createNativeInputDriver({ directory, herdr, waitFor, screen, jsonl }) {
	const observations = directory;
	mkdirSync(observations, { recursive: true });
	const paneObservers = new Map();
	const agentObservers = new Map();
	const register = (pane, agentDir) => {
		let extension = agentObservers.get(agentDir);
		if (!extension) {
			// The canonical state root survives startup migration and stays trusted without project instructions.
			const root = join(agentDir, "state", "live-acceptance");
			mkdirSync(root, { recursive: true });
			extension = join(root, "live-session-observer.mjs");
			writeFileSync(extension, readFileSync(liveObserverSource), { mode: 0o600 });
			agentObservers.set(agentDir, extension);
		}
		const file = join(observations, `${pane.replaceAll(/[^a-zA-Z0-9-]/g, "_")}-${Date.now()}.json`);
		paneObservers.set(pane, file);
		return { file, extension };
	};
	const observation = (pane) => {
		const file = paneObservers.get(pane);
		return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
	};
	const inputDiagnostic = (pane, label, text) => {
		const file = join(observations, `input-${Date.now()}.json`);
		writeFileSync(
			file,
			`${JSON.stringify({ label, text, observer: observation(pane), screen: screen(pane, 200) }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		return file;
	};
	const type = async (pane, text) => {
		try {
			// herdr keeps hidden panes at their split height. Activate the surface the owner is driving
			// before observing it, so status/roster evidence is not cropped to a hidden pane's few rows.
			herdr("pane", "zoom", pane, "--on");
			const activatedAt = Date.now();
			await waitFor(
				"a fresh native editor observer",
				() => {
					const current = observation(pane);
					return (
						current &&
						current.observedAt >= activatedAt &&
						Date.now() - current.observedAt < 2000 &&
						current.errors.length === 0
					);
				},
				30_000,
				250,
			);
			const submittedAt = Date.now();
			herdr("pane", "send-text", pane, text);
			// A fixed delay did not establish that bracketed paste had reached the editor before Enter.
			await waitFor(
				"the exact text in the native editor",
				() => {
					const current = observation(pane);
					return current?.observedAt >= submittedAt && current.editor === text && current.errors.length === 0;
				},
				15_000,
				250,
			);
			const enteredAt = Date.now();
			herdr("pane", "send-keys", pane, "enter");
			await waitFor(
				"the native editor to consume the submission",
				() => {
					const current = observation(pane);
					return current?.observedAt >= enteredAt && current.editor !== text && current.errors.length === 0;
				},
				15_000,
				250,
			);
		} catch (error) {
			throw new Error(
				`native input boundary: ${error.message}; evidence ${inputDiagnostic(pane, "editor submission", text)}`,
			);
		}
	};
	const userText = (message) =>
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("\n");
	/** UI ingress is unchanged. An extension input event is diagnostic only: admission is this exact persisted user row. */
	const submitRootPrompt = async (pane, text) => {
		const before = await waitFor(
			"the owning session observer",
			() => {
				const current = observation(pane);
				return current && Date.now() - current.observedAt < 2000 && current.errors.length === 0
					? current
					: undefined;
			},
			30_000,
			250,
		);
		const known = new Set(
			before?.sessionFile && existsSync(before.sessionFile) ? jsonl(before.sessionFile).map((row) => row.id) : [],
		);
		const submittedAt = Date.now();
		await type(pane, text);
		try {
			return await waitFor(
				"the exact owner input in its canonical session",
				() => {
					const current = observation(pane);
					if (
						!current ||
						current.observedAt < submittedAt ||
						Date.now() - current.observedAt > 2000 ||
						current.errors.length > 0
					)
						return undefined;
					if (current.sessionId !== before?.sessionId)
						throw new Error("the owning session changed during submission");
					if (!current.sessionFile || !existsSync(current.sessionFile)) return undefined;
					const rows = jsonl(current.sessionFile);
					if (rows[0]?.id !== current.sessionId)
						throw new Error("the observer and canonical session header disagree");
					const admitted = rows.find(
						(row) =>
							!known.has(row.id) &&
							row.type === "message" &&
							row.message?.role === "user" &&
							userText(row.message) === text,
					);
					return admitted
						? {
								pane,
								text,
								submittedAt,
								sessionId: current.sessionId,
								sessionFile: current.sessionFile,
								entryId: admitted.id,
							}
						: undefined;
				},
				120_000,
				500,
			);
		} catch (error) {
			throw new Error(
				`owner input was not admitted: ${error.message}; evidence ${inputDiagnostic(pane, "canonical admission", text)}`,
			);
		}
	};
	const deliveredNotifications = (agentDir) => {
		const root = join(agentDir, "state", "orchestration", "sessions");
		const delivered = new Set();
		if (!existsSync(root)) return delivered;
		for (const key of readdirSync(root))
			for (const sub of ["snapshots", "events"]) {
				const dir = join(root, key, "events", sub);
				if (!existsSync(dir)) continue;
				for (const name of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
					const record = JSON.parse(readFileSync(join(dir, name), "utf8"));
					if (sub === "snapshots")
						for (const notification of Object.values(record.projection?.notifications ?? {})) {
							if (notification.status === "delivered") delivered.add(notification.notificationId);
						}
					else if (record.type === "notification.delivered") delivered.add(record.payload?.notificationId);
				}
			}
		return delivered;
	};
	/** Prove blocked attempts were superseded by accepted attempts of the same task, not merely the same agent. */
	const recoveredWorkerTasks = (agentDir, sessionId, lanes, claims) => {
		const sessions = join(agentDir, "state", "orchestration", "sessions");
		if (!existsSync(sessions)) return undefined;
		const owners = readdirSync(sessions).filter((name) => name.startsWith(`${sessionId}-`));
		if (owners.length !== 1) return undefined;
		const eventsDir = join(sessions, owners[0], "events", "events");
		if (!existsSync(eventsDir)) return undefined;
		const events = readdirSync(eventsDir)
			.filter((name) => /^\d{16}\.json$/.test(name))
			.sort()
			.map((name) => {
				const event = JSON.parse(readFileSync(join(eventsDir, name), "utf8"));
				return event.ordinal === Number(name.slice(0, 16)) ? event : undefined;
			});
		if (events.some((event, index) => !event || !Number.isSafeInteger(event.ordinal) || event.ordinal < 1 || (index > 0 && event.ordinal <= events[index - 1].ordinal))) return undefined;
		const owned = (type, predicate) => events.filter((event) => event.type === type && predicate(event.payload, event));
		const starts = events.filter((event) => event.type === "task.attempt_prepared" || event.type === "attempt.queued");
		const taskForAttempt = (id) => {
			const matches = starts.filter((event) => event.payload?.attemptId === id);
			if (matches.length !== 1) return undefined;
			const event = matches[0];
			const taskId = event.payload?.taskId;
			return typeof taskId === "string" && event.aggregateId === taskId && event.payload?.dispatch?.taskId === taskId
				? taskId
				: undefined;
		};
		const recovered = [];
		for (const [attemptId, lane] of lanes) {
			if (/^(succeeded|completed)$/.test(lane.status)) continue;
			if (lane.status !== "blocked") return undefined;
			const taskId = taskForAttempt(attemptId);
			if (!taskId) return undefined;
			if (recovered.some((entry) => entry.taskId === taskId)) continue;
			const taskStarts = starts.filter((event) => event.payload?.taskId === taskId);
			const first = taskStarts[0];
			const objectiveId = first?.payload?.task?.objectiveId;
			if (
				first?.type !== "task.attempt_prepared" ||
				first.aggregateId !== taskId ||
				first.payload?.task?.taskId !== taskId ||
				objectiveId !== `session:${sessionId}` ||
				taskStarts.length < 2
			) return undefined;
			const ids = taskStarts.map((event) => event.payload?.attemptId);
			if (new Set(ids).size !== ids.length || ids.some((id) => !lanes.has(id) || taskForAttempt(id) !== taskId))
				return undefined;
			const outcomes = owned("task.outcome_recorded", (payload, event) => event.aggregateId === taskId && payload?.outcome?.taskId === taskId);
			if (outcomes.length !== ids.length) return undefined;
			const finishes = ids.map((id) => owned("attempt.finished", (payload, event) => event.aggregateId === id && payload?.result?.attemptId === id && payload.result.taskId === taskId));
			if (finishes.some((matches) => matches.length !== 1)) return undefined;
			for (let index = 0; index < ids.length; index++) {
				const id = ids[index];
				const currentLane = lanes.get(id);
				const claim = claims.get(id);
				const finished = finishes[index][0];
				const outcome = outcomes[index]?.payload?.outcome;
				const final = index === ids.length - 1;
				const enqueued = owned("notification.enqueued", (payload, event) => event.aggregateId === objectiveId && payload?.attemptId === id && payload.objectiveId === objectiveId && payload.notificationId === `worker-terminal:${id}`);
				const delivered = owned("notification.delivered", (payload, event) => event.aggregateId === objectiveId && payload?.notificationId === `worker-terminal:${id}`);
				if (
					taskStarts[index].ordinal >= finished.ordinal ||
					finished.ordinal >= outcomes[index].ordinal ||
					outcome?.objectiveId !== objectiveId ||
					outcome.generation !== index + 1 ||
					JSON.stringify(outcome.attempts?.map((entry) => entry.attemptId)) !== JSON.stringify(ids.slice(0, index + 1)) ||
					outcome.attempts.some((entry, position) => entry.resultId !== finishes[position][0].payload.result.resultId || entry.laneStatus !== (position === ids.length - 1 ? "succeeded" : "blocked")) ||
					claim?.requestId !== taskId ||
					enqueued.length !== 1 || delivered.length !== 1 || enqueued[0].ordinal <= finished.ordinal || delivered[0].ordinal <= enqueued[0].ordinal
				) return undefined;
				const result = finished.payload.result;
				if (final) {
					if (
						!/^(succeeded|completed)$/.test(currentLane.status) || claim.status !== "completed" ||
						claim.blockers?.length || claim.pending?.length || claim.parentReviewRequired || claim.hostVerdict?.verdict !== "accepted" ||
						result.status !== "completed" || result.receipts?.status !== "captured" || result.receipts?.acceptance?.disposition !== "accepted" ||
						outcome.status !== "succeeded" || outcome.nextAction?.kind !== "accept" ||
						typeof result.resultId !== "string" || !result.resultId || !/^[a-f0-9]{64}$/.test(result.receipts.factsDigest ?? "") ||
						!owned("attempt.receipts_delivered", (payload, event) => event.ordinal > finished.ordinal && event.aggregateId === id && payload?.attemptId === id && payload.acknowledgement?.resultId === result.resultId && payload.acknowledgement?.factsDigest === result.receipts.factsDigest).length
					) return undefined;
				} else {
					const next = ids[index + 1];
					const escalations = owned("task.escalation_scheduled", (payload, event) => event.aggregateId === taskId && payload?.record?.outcomeId === outcome.outcomeId && payload.record.rung === outcome.nextAction?.rung && payload.record.taskId === taskId && payload.record.attemptId === next && payload.record.supersedesTaskId === undefined);
					if (
						currentLane.status !== "blocked" || claim.status !== "blocked" || claim.hostVerdict?.verdict !== "rejected" || result.status !== "blocked" ||
						result.receipts?.status !== "captured" || result.receipts?.acceptance?.disposition !== "rejected" ||
						outcome.status !== "blocked" || outcome.nextAction?.kind !== "rerun_uncovered" ||
						taskStarts[index + 1].type !== "attempt.queued" || escalations.length !== 1 || outcomes[index].ordinal >= taskStarts[index + 1].ordinal || taskStarts[index + 1].ordinal >= escalations[0].ordinal || escalations[0].ordinal >= finishes[index + 1][0].ordinal
					) return undefined;
				}
			}
			recovered.push({
				taskId,
				objectiveId,
				attempts: ids.map((id, index) => ({
					attemptId: id,
					status: lanes.get(id).status,
					resultId: finishes[index][0].payload.result.resultId,
					outcomeId: outcomes[index].payload.outcome.outcomeId,
					generation: outcomes[index].payload.outcome.generation,
					receiptAcceptance: finishes[index][0].payload.result.receipts.acceptance.disposition,
				})),
			});
		}
		return recovered;
	};
	/** Freeze task counts only after owner answer, worker claims/outbox and canonical work state all settle. */
	const settleRootPrompt = async (input, agentDir, requireWorker = false) => {
		let prior;
		return await waitFor(
			"the admitted owner task and its worker handoff to settle",
			() => {
				const current = observation(input.pane);
				if (
					!current ||
					current.sessionId !== input.sessionId ||
					current.sessionFile !== input.sessionFile ||
					current.observedAt < input.submittedAt ||
					Date.now() - current.observedAt > 2000 ||
					current.errors.length ||
					!current.idle ||
					current.pending ||
					current.lastAgentEnd?.sessionId !== input.sessionId ||
					current.lastAgentEnd.at < input.submittedAt ||
					current.lastAgentEnd.willRetry
				) {
					prior = undefined;
					return undefined;
				}
				const rows = jsonl(input.sessionFile);
				const start = rows.findIndex((row) => row.id === input.entryId);
				if (start < 0) throw new Error("the admitted owner input disappeared from its session");
				const byId = new Map(rows.map((row) => [row.id, row]));
				const branch = [];
				for (let row = byId.get(current.leafId); row; row = byId.get(row.parentId)) {
					branch.push(row);
					if (row.id === input.entryId) break;
				}
				if (branch.at(-1)?.id !== input.entryId)
					throw new Error("the owning branch changed before task settlement");
				branch.reverse();
				const last = branch.findLast((row) => row.message?.role === "assistant");
				if (
					last?.message.stopReason !== "stop" ||
					!last.message.content.some((block) => block.type === "text" && block.text.trim())
				)
					return undefined;
				const taskRows = rows.slice(start);
				const lanes = new Map(
					taskRows
						.filter((row) => row.customType === "lane_record" && row.data?.record?.type === "worker")
						.map((row) => [row.data.record.attemptId, row.data.record]),
				);
				const claims = new Map(
					taskRows
						.filter((row) => row.customType === "worker_claim")
						.map((row) => [row.data.claim.terminalAttemptId, row.data.claim]),
				);
				if (requireWorker && lanes.size === 0) return undefined;
				const delivered = deliveredNotifications(agentDir);
				const recovered = [...lanes.values()].some((lane) => !/^(succeeded|completed)$/.test(lane.status))
					? recoveredWorkerTasks(agentDir, input.sessionId, lanes, claims)
					: [];
				if (!recovered) return undefined;
				const recoveredAttempts = new Set(recovered.flatMap((task) => task.attempts.map((attempt) => attempt.attemptId)));
				for (const [attempt, lane] of lanes) {
					const claim = claims.get(attempt);
					if (recoveredAttempts.has(attempt)) continue;
					if (
						!/^(succeeded|completed)$/.test(lane.status) ||
						claim?.status !== "completed" ||
						claim.blockers?.length ||
						claim.pending?.length ||
						claim.parentReviewRequired ||
						!delivered.has(`worker-terminal:${attempt}`)
					)
						return undefined;
				}
				// Two fresh observations of the same settled branch cross the observer's next event-loop turn.
				const stable = prior?.leafId === current.leafId && prior.sequence < current.sequence;
				prior = current;
				if (!stable) return undefined;
				const calls = taskRows.flatMap((row) =>
					row.message?.role === "assistant"
						? row.message.content.filter((block) => block.type === "toolCall")
						: [],
				);
				const bounced = taskRows.filter(
					(row) =>
						row.message?.role === "toolResult" &&
						row.message.isError &&
						/\[harness\]/.test(JSON.stringify(row.message.content)) &&
						!/"failure_code":"file_not_found"/.test(JSON.stringify(row.message.content)),
				).length;
				const settled = {
					calls: calls.map((call) => call.name),
					bounced,
					workerAttempts: [...lanes.keys()],
					workerHistory: recovered,
					finalEntryId: last.id,
				};
				writeFileSync(
					join(observations, `task-${input.entryId}.json`),
					`${JSON.stringify({ input, observer: current, settled }, null, 2)}\n`,
					{ mode: 0o600 },
				);
				return settled;
			},
			300_000,
			500,
			() => screen(input.pane, 30),
		);
	};
	return { register, type, submitRootPrompt, settleRootPrompt, deliveredNotifications, inspectRecoveredWorkerTasks: recoveredWorkerTasks };
}
