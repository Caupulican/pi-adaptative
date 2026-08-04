import { randomUUID } from "node:crypto";
import type { SessionEntry, SessionManager } from "@caupulican/pi-agent-core/node";
import type { ImageContent } from "@caupulican/pi-ai";
import type { ArtifactStore } from "./context/context-artifacts.ts";
import type { ContextArtifactRef } from "./context/context-item.ts";
import type { SessionImageStore } from "./session-image-store.ts";
import { getActiveSessionBranchEntries, type SessionBranchEntrySource } from "./session-snapshot.ts";
import { isPlainRecord } from "./util/value-guards.ts";

export const HUMAN_INPUT_CUSTOM_TYPE = "human_input_request";
export const HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE = "worker-owner-response";
export const HUMAN_INPUT_INLINE_BYTES = 16 * 1024;
const HUMAN_INPUT_PREVIEW_CHARS = 4_000;

export interface HumanInputOption {
	label: string;
	description: string;
}

export interface HumanInputQuestion {
	id: string;
	header: string;
	question: string;
	options: readonly HumanInputOption[];
	multiSelect?: boolean;
}

export interface HumanInputAnswerImage {
	label: string;
	mimeType: string;
}

export interface HumanInputAnswer {
	id: string;
	header: string;
	question: string;
	selected: readonly string[];
	/** Inline answer, or a bounded preview when customArtifact is present. */
	custom?: string;
	/** Exact full answer retained out of prompt context when it exceeds the inline bound. */
	customArtifact?: ContextArtifactRef;
	images?: readonly HumanInputAnswerImage[];
	skipped: boolean;
}

export type HumanInputStopReason = "user_cancelled" | "ui_unavailable" | "interrupted" | "invalid_questions";

export interface HumanInputPresentationRequest {
	requestId: string;
	questions: readonly HumanInputQuestion[];
	acceptsImages: boolean;
}

export interface HumanInputPresentationResult {
	answers: readonly HumanInputAnswer[];
	cancelled: boolean;
	reason?: HumanInputStopReason;
	imageContents: readonly ImageContent[];
}

export type HumanInputSource = "tool" | "worker";

export interface HumanInputRequest {
	requestId: string;
	source: HumanInputSource;
	toolCallId?: string;
	toolName?: string;
	workerRequestId?: string;
	questions: readonly HumanInputQuestion[];
	acceptsImages: boolean;
	createdAt: string;
}

export type HumanInputStatus = "pending" | "answered" | "cancelled";

export interface HumanInputSnapshot {
	request: HumanInputRequest;
	status: HumanInputStatus;
	answers: readonly HumanInputAnswer[];
	reason?: HumanInputStopReason;
	updatedAt: string;
}

interface HumanInputSnapshotPayload {
	version: 1;
	snapshot: HumanInputSnapshot;
}

export interface HumanInputRequestOptions {
	source: HumanInputSource;
	toolCallId?: string;
	toolName?: string;
	workerRequestId?: string;
	questions: readonly HumanInputQuestion[];
	acceptsImages: boolean;
	now?: () => string;
}

export interface ResolveHumanInputOptions {
	sessionManager: Pick<SessionManager, "appendCustomEntry">;
	request: HumanInputRequest;
	present: (
		request: HumanInputPresentationRequest,
		options?: { signal?: AbortSignal },
	) => Promise<HumanInputPresentationResult>;
	artifactStore?: ArtifactStore;
	getImageStore?: () => Pick<SessionImageStore, "retainContent"> | undefined;
	signal?: AbortSignal;
	now?: () => string;
}

function cloneQuestion(question: HumanInputQuestion): HumanInputQuestion {
	return {
		...question,
		options: question.options.map((option) => ({ ...option })),
	};
}

function cloneAnswer(answer: HumanInputAnswer): HumanInputAnswer {
	return {
		...answer,
		selected: [...answer.selected],
		customArtifact: answer.customArtifact ? { ...answer.customArtifact } : undefined,
		images: answer.images?.map((image) => ({ ...image })),
	};
}

function cloneRequest(request: HumanInputRequest): HumanInputRequest {
	return {
		...request,
		questions: request.questions.map(cloneQuestion),
	};
}

function cloneSnapshot(snapshot: HumanInputSnapshot): HumanInputSnapshot {
	return {
		...snapshot,
		request: cloneRequest(snapshot.request),
		answers: snapshot.answers.map(cloneAnswer),
	};
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isQuestion(value: unknown): value is HumanInputQuestion {
	if (!isPlainRecord(value) || !Array.isArray(value.options)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.header === "string" &&
		typeof value.question === "string" &&
		(value.multiSelect === undefined || typeof value.multiSelect === "boolean") &&
		value.options.every(
			(option) =>
				isPlainRecord(option) && typeof option.label === "string" && typeof option.description === "string",
		)
	);
}

function isArtifactRef(value: unknown): value is ContextArtifactRef {
	return (
		isPlainRecord(value) &&
		typeof value.id === "string" &&
		typeof value.kind === "string" &&
		typeof value.byteLength === "number" &&
		typeof value.createdAtTurn === "number" &&
		typeof value.reproducible === "boolean"
	);
}

function isAnswer(value: unknown): value is HumanInputAnswer {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.header === "string" &&
		typeof value.question === "string" &&
		isStringArray(value.selected) &&
		(value.custom === undefined || typeof value.custom === "string") &&
		(value.customArtifact === undefined || isArtifactRef(value.customArtifact)) &&
		(value.images === undefined ||
			(Array.isArray(value.images) &&
				value.images.every(
					(image) => isPlainRecord(image) && typeof image.label === "string" && typeof image.mimeType === "string",
				))) &&
		typeof value.skipped === "boolean"
	);
}

function isImageContent(value: unknown): value is ImageContent {
	return (
		isPlainRecord(value) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string"
	);
}

function normalizePresentationResult(request: HumanInputRequest, value: unknown): HumanInputPresentationResult {
	if (!isPlainRecord(value) || typeof value.cancelled !== "boolean") {
		throw new Error("Invalid human-input response: expected a typed presentation result");
	}
	if (value.cancelled) {
		const reason = value.reason;
		if (
			reason !== undefined &&
			reason !== "user_cancelled" &&
			reason !== "ui_unavailable" &&
			reason !== "interrupted" &&
			reason !== "invalid_questions"
		) {
			throw new Error("Invalid human-input response: unknown cancellation reason");
		}
		return {
			answers: [],
			cancelled: true,
			...(reason ? { reason } : {}),
			imageContents: [],
		};
	}
	if (!Array.isArray(value.answers) || !Array.isArray(value.imageContents)) {
		throw new Error("Invalid human-input response: answers and imageContents must be arrays");
	}
	const answersById = new Map<string, HumanInputAnswer>();
	for (const candidate of value.answers) {
		if (!isAnswer(candidate)) throw new Error("Invalid human-input response: malformed answer");
		if (candidate.customArtifact !== undefined) {
			throw new Error("Invalid human-input response: artifact references are harness-owned");
		}
		if (answersById.has(candidate.id)) {
			throw new Error(`Invalid human-input response: duplicate answer '${candidate.id}'`);
		}
		answersById.set(candidate.id, candidate);
	}
	if (answersById.size !== request.questions.length) {
		throw new Error("Invalid human-input response: every question must have exactly one answer");
	}

	const answers = request.questions.map((question) => {
		const answer = answersById.get(question.id);
		if (!answer) throw new Error(`Invalid human-input response: missing answer '${question.id}'`);
		const optionLabels = new Set(question.options.map((option) => option.label));
		if (new Set(answer.selected).size !== answer.selected.length) {
			throw new Error(`Invalid human-input response: duplicate option for '${question.id}'`);
		}
		if (answer.selected.some((selection) => !optionLabels.has(selection))) {
			throw new Error(`Invalid human-input response: unknown option for '${question.id}'`);
		}
		if (!question.multiSelect && answer.selected.length > 1) {
			throw new Error(`Invalid human-input response: '${question.id}' is single-select`);
		}
		if (
			answer.skipped &&
			(answer.selected.length > 0 || Boolean(answer.custom) || (answer.images?.length ?? 0) > 0)
		) {
			throw new Error(`Invalid human-input response: skipped answer '${question.id}' contains a value`);
		}
		return {
			...cloneAnswer(answer),
			header: question.header,
			question: question.question,
		};
	});
	if (!value.imageContents.every(isImageContent)) {
		throw new Error("Invalid human-input response: malformed image content");
	}
	const answerImages = answers.flatMap((answer) => answer.images ?? []);
	if (answerImages.length !== value.imageContents.length) {
		throw new Error("Invalid human-input response: image metadata does not match image content");
	}
	if (!request.acceptsImages && value.imageContents.length > 0) {
		throw new Error("Invalid human-input response: the selected model does not accept images");
	}
	for (let index = 0; index < answerImages.length; index++) {
		if (answerImages[index]?.mimeType !== value.imageContents[index]?.mimeType) {
			throw new Error("Invalid human-input response: image MIME metadata does not match image content");
		}
	}
	return {
		answers,
		cancelled: false,
		imageContents: value.imageContents.map((image) => ({ ...image })),
	};
}

function persistPresentationImages(
	result: HumanInputPresentationResult,
	imageStore: Pick<SessionImageStore, "retainContent"> | undefined,
): HumanInputPresentationResult {
	if (!imageStore || result.cancelled || result.imageContents.length === 0) return result;
	let imageIndex = 0;
	const durableContents: ImageContent[] = [];
	const answers = result.answers.map((answer) => {
		let custom = answer.custom;
		const images = answer.images?.map((image) => {
			const content = result.imageContents[imageIndex++];
			if (!content) throw new Error("Human-input image metadata exceeds supplied image content");
			const sequenceMatch = /^\[Image #(\d{1,6})\]$/iu.exec(image.label);
			const stored = imageStore.retainContent(content, sequenceMatch ? Number(sequenceMatch[1]) : undefined);
			const durableLabel = `[Image #${stored.sequence}]`;
			if (custom?.includes(image.label)) custom = custom.split(image.label).join(durableLabel);
			durableContents.push({
				type: "image",
				data: Buffer.from(stored.bytes).toString("base64"),
				mimeType: stored.mimeType,
			});
			return { label: durableLabel, mimeType: stored.mimeType };
		});
		return {
			...cloneAnswer(answer),
			...(custom !== undefined ? { custom } : {}),
			...(images && images.length > 0 ? { images } : {}),
		};
	});
	return { ...result, answers, imageContents: durableContents };
}

function isRequest(value: unknown): value is HumanInputRequest {
	if (!isPlainRecord(value) || !Array.isArray(value.questions)) return false;
	return (
		typeof value.requestId === "string" &&
		(value.source === "tool" || value.source === "worker") &&
		(value.toolCallId === undefined || typeof value.toolCallId === "string") &&
		(value.toolName === undefined || typeof value.toolName === "string") &&
		(value.workerRequestId === undefined || typeof value.workerRequestId === "string") &&
		value.questions.every(isQuestion) &&
		typeof value.acceptsImages === "boolean" &&
		typeof value.createdAt === "string"
	);
}

function decodeSnapshot(data: unknown): HumanInputSnapshot | undefined {
	if (!isPlainRecord(data) || data.version !== 1 || !isPlainRecord(data.snapshot)) return undefined;
	const snapshot = data.snapshot;
	if (
		!isRequest(snapshot.request) ||
		(snapshot.status !== "pending" && snapshot.status !== "answered" && snapshot.status !== "cancelled") ||
		!Array.isArray(snapshot.answers) ||
		!snapshot.answers.every(isAnswer) ||
		(snapshot.reason !== undefined &&
			snapshot.reason !== "user_cancelled" &&
			snapshot.reason !== "ui_unavailable" &&
			snapshot.reason !== "interrupted" &&
			snapshot.reason !== "invalid_questions") ||
		typeof snapshot.updatedAt !== "string"
	) {
		return undefined;
	}
	return cloneSnapshot(snapshot as unknown as HumanInputSnapshot);
}

export function createHumanInputRequest(options: HumanInputRequestOptions): HumanInputRequest {
	const now = options.now?.() ?? new Date().toISOString();
	return {
		requestId: `human-input:${options.toolCallId ?? options.workerRequestId ?? randomUUID()}`,
		source: options.source,
		...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
		...(options.toolName ? { toolName: options.toolName } : {}),
		...(options.workerRequestId ? { workerRequestId: options.workerRequestId } : {}),
		questions: options.questions.map(cloneQuestion),
		acceptsImages: options.acceptsImages,
		createdAt: now,
	};
}

export function appendHumanInputSnapshot(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	snapshot: HumanInputSnapshot,
): string {
	const payload: HumanInputSnapshotPayload = { version: 1, snapshot: cloneSnapshot(snapshot) };
	return sessionManager.appendCustomEntry(HUMAN_INPUT_CUSTOM_TYPE, payload);
}

export function beginHumanInputRequest(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	request: HumanInputRequest,
): HumanInputSnapshot {
	const snapshot: HumanInputSnapshot = {
		request: cloneRequest(request),
		status: "pending",
		answers: [],
		updatedAt: request.createdAt,
	};
	appendHumanInputSnapshot(sessionManager, snapshot);
	return snapshot;
}

function decodeHumanInputSnapshotEntry(entry: SessionEntry): HumanInputSnapshot | undefined {
	if (entry.type !== "custom" || entry.customType !== HUMAN_INPUT_CUSTOM_TYPE) return undefined;
	return decodeSnapshot(entry.data);
}

export function getHumanInputSnapshots(entries: readonly SessionEntry[]): HumanInputSnapshot[] {
	const snapshots: HumanInputSnapshot[] = [];
	for (const entry of entries) {
		const snapshot = decodeHumanInputSnapshotEntry(entry);
		if (snapshot) snapshots.push(snapshot);
	}
	return snapshots;
}

export function getLatestHumanInputSnapshots(source: SessionBranchEntrySource): HumanInputSnapshot[] {
	const latest = new Map<string, HumanInputSnapshot>();
	for (const snapshot of getHumanInputSnapshots(getActiveSessionBranchEntries(source))) {
		latest.set(snapshot.request.requestId, snapshot);
	}
	return [...latest.values()];
}

/** Incremental active-branch projection for worker questions that still need context-visible delivery. */
export class WorkerHumanInputProjection {
	private readonly knownWorkerRequestIds = new Set<string>();
	private readonly deliveredInputRequestIds = new Set<string>();
	private readonly workerRequestIdByInputRequestId = new Map<string, string>();
	private readonly requiringDelivery = new Map<string, HumanInputSnapshot>();

	reset(entries: readonly SessionEntry[]): void {
		this.knownWorkerRequestIds.clear();
		this.deliveredInputRequestIds.clear();
		this.workerRequestIdByInputRequestId.clear();
		this.requiringDelivery.clear();
		for (const entry of entries) this.apply(entry);
	}

	apply(entry: SessionEntry): void {
		const snapshot = decodeHumanInputSnapshotEntry(entry);
		if (snapshot) {
			const workerRequestId = snapshot.request.workerRequestId;
			if (snapshot.request.source === "worker" && workerRequestId !== undefined) {
				const inputRequestId = snapshot.request.requestId;
				this.knownWorkerRequestIds.add(workerRequestId);
				if (!this.deliveredInputRequestIds.has(inputRequestId)) {
					this.workerRequestIdByInputRequestId.set(inputRequestId, workerRequestId);
					this.requiringDelivery.set(workerRequestId, snapshot);
				}
			}
		}
		if (
			entry.type !== "custom_message" ||
			entry.customType !== HUMAN_INPUT_WORKER_RESPONSE_CUSTOM_TYPE ||
			!isPlainRecord(entry.details) ||
			typeof entry.details.requestId !== "string"
		) {
			return;
		}
		const inputRequestId = entry.details.requestId;
		this.deliveredInputRequestIds.add(inputRequestId);
		const workerRequestId = this.workerRequestIdByInputRequestId.get(inputRequestId);
		if (
			workerRequestId !== undefined &&
			this.requiringDelivery.get(workerRequestId)?.request.requestId === inputRequestId
		) {
			this.requiringDelivery.delete(workerRequestId);
		}
		this.workerRequestIdByInputRequestId.delete(inputRequestId);
	}

	hasKnownWorkerRequest(workerRequestId: string): boolean {
		return this.knownWorkerRequestIds.has(workerRequestId);
	}

	requiresDelivery(workerRequestId: string): boolean {
		return this.requiringDelivery.has(workerRequestId);
	}

	getRequiringDelivery(): HumanInputSnapshot[] {
		return [...this.requiringDelivery.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
	}
}

export function getWorkerHumanInputsRequiringDelivery(source: SessionBranchEntrySource): HumanInputSnapshot[] {
	const projection = new WorkerHumanInputProjection();
	projection.reset(getActiveSessionBranchEntries(source));
	return projection.getRequiringDelivery();
}

export function getResumableHumanInputSnapshot(source: SessionBranchEntrySource): HumanInputSnapshot | undefined {
	const entries = getActiveSessionBranchEntries(source);
	const requestedToolCalls = new Set(
		entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.content.flatMap((part) => (part.type === "toolCall" ? [part.id] : []))
				: [],
		),
	);
	const answeredToolCalls = new Set(
		entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
		),
	);
	return getLatestHumanInputSnapshots(source)
		.filter(
			(snapshot) =>
				snapshot.request.source === "tool" &&
				snapshot.request.toolCallId !== undefined &&
				requestedToolCalls.has(snapshot.request.toolCallId) &&
				!answeredToolCalls.has(snapshot.request.toolCallId),
		)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function preview(value: string): string {
	if (value.length <= HUMAN_INPUT_PREVIEW_CHARS) return value;
	return `${value.slice(0, HUMAN_INPUT_PREVIEW_CHARS)}…`;
}

function externalizeAnswer(
	request: HumanInputRequest,
	answer: HumanInputAnswer,
	artifactStore: ArtifactStore | undefined,
): HumanInputAnswer {
	if (!answer.custom || Buffer.byteLength(answer.custom, "utf8") <= HUMAN_INPUT_INLINE_BYTES || !artifactStore) {
		return cloneAnswer(answer);
	}
	const record = artifactStore.write({
		kind: "transcript_slice",
		content: answer.custom,
		toolName: request.toolName ?? "human_input",
		sessionEntryId: request.requestId,
		createdAtTurn: 0,
		reproducible: false,
	});
	if (!artifactStore.addReference(record.ref.id, request.requestId)) {
		throw new Error(`Failed to retain human-input artifact ${record.ref.id}`);
	}
	return {
		...cloneAnswer(answer),
		custom: preview(answer.custom),
		customArtifact: record.ref,
	};
}

export async function resolveHumanInput(options: ResolveHumanInputOptions): Promise<{
	snapshot: HumanInputSnapshot;
	imageContents: readonly ImageContent[];
}> {
	const now = options.now ?? (() => new Date().toISOString());
	let result: HumanInputPresentationResult;
	if (options.signal?.aborted) {
		result = { answers: [], cancelled: true, reason: "interrupted", imageContents: [] };
	} else {
		result = persistPresentationImages(
			normalizePresentationResult(
				options.request,
				await options.present(
					{
						requestId: options.request.requestId,
						questions: options.request.questions,
						acceptsImages: options.request.acceptsImages,
					},
					{ signal: options.signal },
				),
			),
			options.getImageStore?.(),
		);
	}
	const answers = result.answers.map((answer) => externalizeAnswer(options.request, answer, options.artifactStore));
	const snapshot: HumanInputSnapshot = {
		request: cloneRequest(options.request),
		status: result.cancelled ? "cancelled" : "answered",
		answers,
		...(result.reason ? { reason: result.reason } : {}),
		updatedAt: now(),
	};
	appendHumanInputSnapshot(options.sessionManager, snapshot);
	return { snapshot, imageContents: result.cancelled ? [] : result.imageContents };
}

export function formatHumanInputAnswerText(snapshot: HumanInputSnapshot): string {
	if (snapshot.status === "cancelled") {
		return snapshot.reason === "interrupted"
			? "User question was interrupted."
			: snapshot.reason === "ui_unavailable"
				? "User input is unavailable in this host."
				: "User cancelled the question without submitting answers.";
	}
	return snapshot.answers
		.map((answer) => {
			if (answer.skipped) return `${answer.header}: user skipped this question`;
			const values = [...answer.selected, ...(answer.custom ? [answer.custom] : [])];
			const artifact = answer.customArtifact
				? `\nFull answer: artifact tool-output:${answer.customArtifact.id} (${answer.customArtifact.byteLength} bytes)`
				: "";
			return `${answer.header}: ${values.length > 1 ? "user selected" : "user answered"}: ${values.join(", ")}${artifact}`;
		})
		.join("\n");
}
