import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	type CiAttemptTerminalEvent,
	type CiCurrentObservation,
	type CiSubject,
	ciEventSubject,
	ciSubjectKey,
	type HostEventCatchUp,
	type HostEventConsumerCheckpoint,
	type HostEventEnvelope,
	type HostEventReceipt,
	type HostEventSourceRegistration,
	hostEventArray,
	hostEventInteger,
	hostEventRecord,
	hostEventString,
	MAX_HOST_EVENT_SUBJECTS,
	parseCiCurrentObservation,
	parseCiSubject,
	parseHostEventCatchUp,
	parseHostEventEnvelope,
	parseHostEventSourceRegistration,
} from "../../core/events/host-event-contract.ts";
import { isMissingFileError, withFileLockSync, writeFileAtomicSync } from "../../core/util/atomic-file.ts";
import {
	isProcessOwnerRecord,
	judgeOwner,
	ownProcessOwner,
	type ProcessOwner,
} from "../../kernel/reliability/owner-identity.ts";
import { readBoundedTextFileSync } from "../../kernel/storage/bounded-file.ts";
import type { CiRetiredRunRange } from "./ci-provider.ts";

export const CI_SOURCE_MAX_EVENTS = 2_048;
export const CI_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_CONSUMERS = 64;
const MAX_RUNS = 128;

interface ConsumerStart {
	registration: HostEventSourceRegistration;
	catchUp: HostEventCatchUp;
}

interface Consumer {
	id: string;
	startingSequence: number;
	acknowledged: number;
	generation: number;
	scopeVersion: number;
	subjects: CiSubject[];
	rootSubjects: CiSubject[];
	watchedSubjects: CiSubject[];
	observations: CiCurrentObservation[];
	/** Persisted before the sink call; exact replay bridges either side of a crash. */
	pendingStart?: ConsumerStart;
	replayFloor: number;
	activation?: { id: string; owner: ProcessOwner };
	pendingGap?: { afterSequence: number; throughSequence: number };
}

interface RetainedRun {
	key: string;
	headSha: string;
	runNumber: number;
	throughAttempt: number;
	latest: HostEventEnvelope;
}

interface SourceState {
	version: 1;
	sourceId: string;
	sourceEpoch: string;
	nextSequence: number;
	retiredThrough: number;
	events: HostEventEnvelope[];
	runs: RetainedRun[];
	subjects: CiSubject[];
	consumers: Consumer[];
	retiredRuns: { key: string; ranges: CiRetiredRunRange[] }[];
}

function workflowKey(subject: Pick<CiSubject, "host" | "repositoryId" | "workflowId">): string {
	return `${subject.host}/${subject.repositoryId}/${subject.workflowId}`;
}

function parseConsumer(value: unknown): Consumer {
	const entry = hostEventRecord(
		value,
		[
			"id",
			"startingSequence",
			"acknowledged",
			"generation",
			"scopeVersion",
			"subjects",
			"rootSubjects",
			"watchedSubjects",
			"observations",
			"pendingStart",
			"replayFloor",
			"activation",
			"pendingGap",
		],
		"CI consumer",
	);
	return {
		id: hostEventString(entry.id, "consumer id"),
		startingSequence: hostEventInteger(entry.startingSequence, "starting sequence"),
		acknowledged: hostEventInteger(entry.acknowledged, "acknowledged", 0),
		generation: hostEventInteger(entry.generation, "generation", 0),
		scopeVersion: hostEventInteger(entry.scopeVersion, "scopeVersion", 0),
		subjects: hostEventArray(entry.subjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "consumer subjects"),
		rootSubjects: hostEventArray(entry.rootSubjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "root subjects"),
		watchedSubjects: hostEventArray(
			entry.watchedSubjects,
			MAX_HOST_EVENT_SUBJECTS,
			parseCiSubject,
			"watched subjects",
		),
		observations: hostEventArray(
			entry.observations,
			MAX_HOST_EVENT_SUBJECTS,
			parseCiCurrentObservation,
			"consumer observations",
		),
		...(entry.pendingStart === undefined ? {} : { pendingStart: parseConsumerStart(entry.pendingStart) }),
		replayFloor: hostEventInteger(entry.replayFloor, "consumer replay floor"),
		...(entry.activation === undefined ? {} : { activation: parseConsumerActivation(entry.activation) }),
		...(entry.pendingGap === undefined ? {} : { pendingGap: parseConsumerGap(entry.pendingGap) }),
	};
}

function parseConsumerActivation(value: unknown): NonNullable<Consumer["activation"]> {
	const entry = hostEventRecord(value, ["id", "owner"], "CI consumer activation");
	const owner = hostEventRecord(entry.owner, ["pid", "startTime", "hostname", "machineId"], "CI consumer owner");
	if (!isProcessOwnerRecord(owner)) throw new Error("CI consumer owner is invalid.");
	return { id: hostEventString(entry.id, "activation id"), owner };
}

function parseConsumerGap(value: unknown): NonNullable<Consumer["pendingGap"]> {
	const entry = hostEventRecord(value, ["afterSequence", "throughSequence"], "CI consumer pending gap");
	const afterSequence = hostEventInteger(entry.afterSequence, "gap after sequence", 0);
	const throughSequence = hostEventInteger(entry.throughSequence, "gap through sequence", 0);
	if (afterSequence >= throughSequence) throw new Error("CI consumer replay gap is empty or reversed.");
	return { afterSequence, throughSequence };
}

function parseConsumerStart(value: unknown): ConsumerStart {
	const entry = hostEventRecord(value, ["registration", "catchUp"], "CI consumer pending start");
	const registration = parseHostEventSourceRegistration(entry.registration);
	const catchUp = parseHostEventCatchUp(entry.catchUp);
	if (
		registration.sourceId !== catchUp.sourceId ||
		registration.sourceEpoch !== catchUp.sourceEpoch ||
		registration.scopeVersion !== catchUp.scopeVersion
	)
		throw new Error("CI pending start has inconsistent source identity.");
	return { registration, catchUp };
}

function parseState(value: unknown): SourceState {
	const entry = hostEventRecord(
		value,
		[
			"version",
			"sourceId",
			"sourceEpoch",
			"nextSequence",
			"retiredThrough",
			"events",
			"runs",
			"subjects",
			"consumers",
			"retiredRuns",
		],
		"CI source",
	);
	if (entry.version !== 1) throw new Error("Unknown CI source version.");
	const state: SourceState = {
		version: 1,
		sourceId: hostEventString(entry.sourceId, "sourceId"),
		sourceEpoch: hostEventString(entry.sourceEpoch, "sourceEpoch"),
		nextSequence: hostEventInteger(entry.nextSequence, "nextSequence"),
		retiredThrough: hostEventInteger(entry.retiredThrough, "retiredThrough", 0),
		events: hostEventArray(entry.events, CI_SOURCE_MAX_EVENTS, parseHostEventEnvelope, "retained CI events"),
		runs: hostEventArray(
			entry.runs,
			MAX_RUNS,
			(value) => {
				const run = hostEventRecord(
					value,
					["key", "headSha", "runNumber", "throughAttempt", "latest"],
					"retained CI run",
				);
				return {
					key: hostEventString(run.key, "run key", 512),
					headSha: hostEventString(run.headSha, "run SHA", 64),
					runNumber: hostEventInteger(run.runNumber, "runNumber"),
					throughAttempt: hostEventInteger(run.throughAttempt, "throughAttempt"),
					latest: parseHostEventEnvelope(run.latest),
				};
			},
			"retained CI runs",
		),
		subjects: hostEventArray(entry.subjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "CI subjects"),
		consumers: hostEventArray(entry.consumers, MAX_CONSUMERS, parseConsumer, "CI consumers"),
		retiredRuns: hostEventArray(
			entry.retiredRuns,
			32,
			(value) => {
				const frontier = hostEventRecord(value, ["key", "ranges"], "retired CI run frontier");
				return {
					key: hostEventString(frontier.key, "workflow key", 512),
					ranges: hostEventArray(
						frontier.ranges,
						MAX_RUNS + 1,
						(value) => {
							const range = hostEventRecord(value, ["from", "through"], "retired run range");
							return {
								from: hostEventInteger(range.from, "from"),
								through: hostEventInteger(range.through, "through"),
							};
						},
						"retired run ranges",
					),
				};
			},
			"retired CI workflows",
		),
	};
	if (
		state.nextSequence !== state.retiredThrough + state.events.length + 1 ||
		state.events.some(
			(event, index) =>
				event.sourceId !== state.sourceId ||
				event.sourceEpoch !== state.sourceEpoch ||
				event.sourceSequence !== state.retiredThrough + index + 1,
		)
	)
		throw new Error("CI source sequence is not contiguous.");
	if (
		state.runs.some(
			(run) =>
				run.latest.sourceId !== state.sourceId ||
				run.latest.sourceEpoch !== state.sourceEpoch ||
				run.latest.sourceSequence >= state.nextSequence ||
				run.latest.event.headSha !== run.headSha ||
				run.latest.event.identity.runNumber !== run.runNumber ||
				run.latest.event.identity.runAttempt !== run.throughAttempt,
		)
	)
		throw new Error("CI retained current-attempt evidence is inconsistent.");
	if (
		new Set(state.consumers.map((consumer) => consumer.id)).size !== state.consumers.length ||
		new Set(state.runs.map((run) => run.key)).size !== state.runs.length ||
		new Set(state.subjects.map(ciSubjectKey)).size !== state.subjects.length ||
		state.consumers.some(
			(consumer) =>
				consumer.acknowledged < state.retiredThrough ||
				consumer.acknowledged >= state.nextSequence ||
				consumer.startingSequence > consumer.acknowledged + 1 ||
				consumer.replayFloor < consumer.startingSequence ||
				consumer.replayFloor > consumer.acknowledged + 1 ||
				(consumer.pendingGap !== undefined &&
					(consumer.pendingGap.throughSequence > consumer.acknowledged ||
						consumer.pendingGap.throughSequence >= consumer.replayFloor)),
		)
	)
		throw new Error("CI source registry is inconsistent.");
	return state;
}

function sameSubjects(left: readonly CiSubject[], right: readonly CiSubject[]): boolean {
	return JSON.stringify(left.map(ciSubjectKey).sort()) === JSON.stringify(right.map(ciSubjectKey).sort());
}

function activeConsumer(state: SourceState, consumerId: string, activationId: string): Consumer {
	const consumer = state.consumers.find((entry) => entry.id === consumerId);
	if (!consumer || consumer.activation?.id !== activationId)
		throw new Error("CI source consumer activation is absent or was replaced.");
	return consumer;
}

function parkConsumer(consumer: Consumer): void {
	delete consumer.activation;
	consumer.watchedSubjects = [];
	consumer.observations = [];
}

function reclaimDeadConsumers(state: SourceState): void {
	for (const consumer of state.consumers)
		if (consumer.activation && judgeOwner(consumer.activation.owner) === "dead") parkConsumer(consumer);
	state.consumers = state.consumers.filter(
		(consumer) => consumer.activation || consumer.pendingGap || consumer.acknowledged < state.nextSequence - 1,
	);
}

/** One locked, bounded source journal owns occurrence identity and every consumer's custody. */
export class CiSourceStore {
	readonly path: string;

	constructor(directory: string) {
		this.path = join(directory, "source-v1.json");
	}

	private read(): SourceState {
		try {
			return parseState(JSON.parse(readBoundedTextFileSync(this.path, CI_SOURCE_MAX_BYTES, "CI source")));
		} catch (error) {
			if (!isMissingFileError(error)) throw error;
			return {
				version: 1,
				sourceId: `ci-source-${randomUUID()}`,
				sourceEpoch: randomUUID(),
				nextSequence: 1,
				retiredThrough: 0,
				events: [],
				runs: [],
				subjects: [],
				consumers: [],
				retiredRuns: [],
			};
		}
	}

	private change<T>(operation: (state: SourceState) => T): T {
		return withFileLockSync(this.path, () => {
			const state = this.read();
			const result = operation(state);
			const encoded = JSON.stringify(state);
			if (Buffer.byteLength(encoded) > CI_SOURCE_MAX_BYTES)
				throw new Error("CI source is full; unacknowledged events remain retained.");
			parseState(state);
			writeFileAtomicSync(this.path, encoded, { mode: 0o600 });
			return result;
		});
	}

	identity(): { sourceId: string; sourceEpoch: string } {
		return this.change((state) => ({ sourceId: state.sourceId, sourceEpoch: state.sourceEpoch }));
	}

	claim(consumerId: string, activationId: string, checkpoint: HostEventConsumerCheckpoint | undefined): void {
		this.change((state) => {
			reclaimDeadConsumers(state);
			let consumer = state.consumers.find((entry) => entry.id === consumerId);
			if (consumer?.activation && consumer.activation.id !== activationId)
				throw new Error("CI source consumer is already active in another host resource.");
			if (!consumer) {
				if (state.consumers.length >= MAX_CONSUMERS)
					throw new Error("CI source consumer capacity reached; offline custody remains retained.");
				if (
					checkpoint &&
					(checkpoint.registration.sourceId !== state.sourceId ||
						checkpoint.registration.sourceEpoch !== state.sourceEpoch)
				)
					throw new Error("CI source checkpoint names a different retained source.");
				const acknowledged = checkpoint?.acceptedThrough ?? state.retiredThrough;
				if (acknowledged >= state.nextSequence)
					throw new Error("CI source checkpoint is ahead of retained history.");
				consumer = {
					id: hostEventString(consumerId, "consumerId"),
					startingSequence: checkpoint?.registration.startingSequence ?? state.retiredThrough + 1,
					acknowledged: Math.max(acknowledged, state.retiredThrough),
					generation: checkpoint?.catchUpGeneration ?? 0,
					scopeVersion: checkpoint?.registration.scopeVersion ?? 0,
					subjects: checkpoint ? [...checkpoint.registration.subjects] : [],
					rootSubjects: checkpoint ? [...checkpoint.registration.rootSubjects] : [],
					watchedSubjects: [],
					observations: [],
					replayFloor:
						checkpoint && acknowledged >= state.retiredThrough
							? checkpoint.replayFloor
							: state.retiredThrough + 1,
					...(acknowledged < state.retiredThrough
						? { pendingGap: { afterSequence: acknowledged, throughSequence: state.retiredThrough } }
						: {}),
				};
				state.consumers.push(consumer);
			}
			consumer.activation = { id: hostEventString(activationId, "activationId"), owner: ownProcessOwner() };
		});
	}

	release(consumerId: string, activationId: string): void {
		this.change((state) => {
			const consumer = state.consumers.find((entry) => entry.id === consumerId);
			if (consumer?.activation?.id !== activationId) return;
			parkConsumer(consumer);
			state.consumers = state.consumers.filter(
				(entry) => entry !== consumer || entry.pendingGap || entry.acknowledged < state.nextSequence - 1,
			);
		});
	}

	begin(
		consumerId: string,
		activationId: string,
		subjects: readonly CiSubject[],
		rootSubjects: readonly CiSubject[],
	): ConsumerStart {
		return this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			const pending = consumer.pendingStart;
			if (pending) return pending;
			for (const subject of [...subjects, ...rootSubjects])
				if (!state.subjects.some((existing) => ciSubjectKey(existing) === ciSubjectKey(subject)))
					state.subjects.push(parseCiSubject(subject));
			if (state.subjects.length > MAX_HOST_EVENT_SUBJECTS) throw new Error("CI source subject capacity reached.");
			consumer.watchedSubjects = subjects.map(parseCiSubject);
			if (!sameSubjects(consumer.subjects, state.subjects) || !sameSubjects(consumer.rootSubjects, rootSubjects)) {
				consumer.scopeVersion++;
				consumer.subjects = [...state.subjects];
				consumer.rootSubjects = rootSubjects.map(parseCiSubject);
			}
			consumer.generation++;
			const start: ConsumerStart = {
				registration: {
					sourceId: state.sourceId,
					sourceEpoch: state.sourceEpoch,
					scopeVersion: consumer.scopeVersion,
					subjects: consumer.subjects,
					rootSubjects: consumer.rootSubjects,
					startingSequence: consumer.startingSequence,
				},
				catchUp: {
					sourceId: state.sourceId,
					sourceEpoch: state.sourceEpoch,
					scopeVersion: consumer.scopeVersion,
					generation: consumer.generation,
				},
			};
			consumer.pendingStart = start;
			return start;
		});
	}

	confirmBegin(consumerId: string, activationId: string, start: ConsumerStart): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			if (JSON.stringify(consumer.pendingStart) !== JSON.stringify(start))
				throw new Error("CI consumer start acknowledgement differs from its pending handshake.");
			delete consumer.pendingStart;
		});
	}

	confirmGap(consumerId: string, activationId: string, gap: NonNullable<Consumer["pendingGap"]>): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			if (JSON.stringify(consumer.pendingGap) !== JSON.stringify(gap))
				throw new Error("CI replay gap acknowledgement differs from retained custody.");
			delete consumer.pendingGap;
		});
	}

	watchSubjects(consumerId: string, activationId: string, subjects: readonly CiSubject[]): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			const allowed = new Set(consumer.subjects.map(ciSubjectKey));
			const watched = hostEventArray(subjects, MAX_HOST_EVENT_SUBJECTS, parseCiSubject, "watched subjects");
			if (watched.some((subject) => !allowed.has(ciSubjectKey(subject))))
				throw new Error("CI watched subject is outside this consumer's registered scope.");
			consumer.watchedSubjects = watched;
		});
	}

	retain(events: readonly CiAttemptTerminalEvent[]): void {
		this.change((state) => {
			this.compact(state);
			for (const event of [...events].sort(
				(a, b) => a.identity.runNumber - b.identity.runNumber || a.identity.runAttempt - b.identity.runAttempt,
			)) {
				const known =
					state.events.find((entry) => entry.event.eventId === event.eventId)?.event ??
					state.runs.find((run) => run.latest.event.eventId === event.eventId)?.latest.event;
				if (known) {
					if (
						known.headSha !== event.headSha ||
						known.conclusion !== event.conclusion ||
						JSON.stringify(known.identity) !== JSON.stringify(event.identity)
					)
						throw new Error("CI attempt conflicts with its retained terminal outcome.");
					continue;
				}
				const identity = event.identity;
				const retired = state.retiredRuns.find((frontier) => frontier.key === workflowKey(identity));
				if (
					retired?.ranges.some((range) => identity.runNumber >= range.from && identity.runNumber <= range.through)
				)
					throw new Error(
						"CI run is outside the retained replay horizon; historical custody cannot be recreated.",
					);
				const key = `${identity.host}/${identity.repositoryId}/${identity.workflowId}/${identity.runId}`;
				let run = state.runs.find((entry) => entry.key === key);
				if (run && (run.headSha !== event.headSha || run.runNumber !== identity.runNumber))
					throw new Error("CI run identity changed.");
				if (run && identity.runAttempt <= run.throughAttempt) continue;
				if (identity.runAttempt !== (run?.throughAttempt ?? 0) + 1)
					throw new Error("CI terminal attempt history has a gap.");
				if (state.events.length >= CI_SOURCE_MAX_EVENTS || (!run && state.runs.length >= MAX_RUNS))
					throw new Error("CI source capacity reached; cursor was retained.");
				const envelope = parseHostEventEnvelope({
					sourceId: state.sourceId,
					sourceEpoch: state.sourceEpoch,
					sourceSequence: state.nextSequence++,
					event,
				});
				if (!run) {
					run = {
						key,
						headSha: event.headSha,
						runNumber: identity.runNumber,
						throughAttempt: identity.runAttempt,
						latest: envelope,
					};
					state.runs.push(run);
				}
				run.throughAttempt = identity.runAttempt;
				run.latest = envelope;
				const subject = ciEventSubject(event);
				if (!state.subjects.some((existing) => ciSubjectKey(existing) === ciSubjectKey(subject)))
					state.subjects.push(subject);
				state.events.push(envelope);
				this.compact(state);
			}
		});
	}

	snapshot(): Readonly<SourceState> {
		return this.read();
	}

	retainedAttempts(): ReadonlyMap<number, number> {
		return new Map(this.read().runs.map((run) => [Number(run.key.split("/").at(-1)), run.throughAttempt]));
	}

	retiredRunNumbers(subject: Pick<CiSubject, "host" | "repositoryId" | "workflowId">): readonly CiRetiredRunRange[] {
		return this.read().retiredRuns.find((frontier) => frontier.key === workflowKey(subject))?.ranges ?? [];
	}

	acknowledge(consumerId: string, activationId: string, receipt: HostEventReceipt, generation: number): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			const event = state.events.find((entry) => entry.sourceSequence === receipt.sourceSequence);
			if (
				consumer.generation !== generation ||
				!event ||
				receipt.consumerId !== consumerId ||
				receipt.sourceId !== state.sourceId ||
				receipt.sourceEpoch !== state.sourceEpoch ||
				receipt.eventId !== event.event.eventId ||
				receipt.payloadDigest !== event.event.payloadDigest ||
				!receipt.canonicalReceiptId
			)
				throw new Error("CI source acknowledgement does not match its retained event.");
			if (receipt.sourceSequence > consumer.acknowledged + 1)
				throw new Error("CI source acknowledgement skipped an event.");
			consumer.acknowledged = Math.max(consumer.acknowledged, receipt.sourceSequence);
		});
	}

	retireAcknowledged(): number {
		return this.change((state) => this.compact(state));
	}

	private compact(state: SourceState): number {
		reclaimDeadConsumers(state);
		state.retiredThrough = state.consumers.length
			? Math.min(...state.consumers.map((consumer) => consumer.acknowledged))
			: state.nextSequence - 1;
		state.events = state.events.filter((event) => event.sourceSequence > state.retiredThrough);
		for (const key of new Set(state.runs.map((run) => workflowKey(run.latest.event.identity)))) {
			// A registered push may not have its run number yet. Do not retire across an
			// unknown position until its complete provider observation establishes one.
			if (
				state.consumers.some((consumer) =>
					consumer.watchedSubjects.some(
						(subject) =>
							workflowKey(subject) === key &&
							!consumer.observations.some(
								(observation) => ciSubjectKey(observation.subject) === ciSubjectKey(subject),
							),
					),
				)
			)
				continue;
			const runs = state.runs.filter((run) => workflowKey(run.latest.event.identity) === key);
			const latestRunNumber = Math.max(...runs.map((run) => run.runNumber));
			const pinned = runs.filter(
				(run) =>
					run.runNumber === latestRunNumber ||
					state.events.some((entry) => entry.event.identity.runId === run.latest.event.identity.runId) ||
					state.consumers.some((consumer) =>
						consumer.watchedSubjects.some((subject) => {
							if (ciSubjectKey(subject) !== ciSubjectKey(ciEventSubject(run.latest.event))) return false;
							const current = consumer.observations.find(
								(entry) => ciSubjectKey(entry.subject) === ciSubjectKey(subject),
							);
							return !current || current.runNumber === run.runNumber;
						}),
					),
			);
			let frontier = state.retiredRuns.find((entry) => entry.key === key);
			if (!frontier) {
				frontier = { key, ranges: [] };
				state.retiredRuns.push(frontier);
			}
			const ceiling = Math.max(
				...runs.map((run) => run.runNumber),
				...frontier.ranges.map((range) => range.through),
			);
			const pins = [...new Set(pinned.map((run) => run.runNumber))].sort((a, b) => a - b);
			const ranges: CiRetiredRunRange[] = [];
			let from = 1;
			for (const pin of pins) {
				if (from < pin) ranges.push({ from, through: pin - 1 });
				from = pin + 1;
			}
			if (from <= ceiling) ranges.push({ from, through: ceiling });
			frontier.ranges = ranges;
			state.runs = state.runs.filter(
				(run) => workflowKey(run.latest.event.identity) !== key || pins.includes(run.runNumber),
			);
		}
		const retainedSubjects = [
			...state.consumers.flatMap((consumer) => consumer.watchedSubjects),
			...state.events.map((entry) => ciEventSubject(entry.event)),
			...state.runs.map((run) => ciEventSubject(run.latest.event)),
		];
		state.subjects = [...new Map(retainedSubjects.map((subject) => [ciSubjectKey(subject), subject])).values()];
		return state.retiredThrough;
	}

	recordSeal(
		consumerId: string,
		activationId: string,
		generation: number,
		observations: readonly CiCurrentObservation[],
	): void {
		this.change((state) => {
			const consumer = activeConsumer(state, consumerId, activationId);
			if (consumer.generation !== generation)
				throw new Error("CI source seal belongs to a superseded consumer generation.");
			consumer.observations = observations
				.filter((observation) =>
					consumer.watchedSubjects.some((subject) => ciSubjectKey(subject) === ciSubjectKey(observation.subject)),
				)
				.map(parseCiCurrentObservation);
		});
	}
}
