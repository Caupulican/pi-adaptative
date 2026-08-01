import type { RecallHit } from "../transcript-index.ts";

export const TRANSCRIPT_RECALL_MAX_QUERY_CHARS = 4_000;
export const TRANSCRIPT_RECALL_MAX_HITS = 3;
export const TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS = 600;
export const TRANSCRIPT_RECALL_MAX_ERROR_CHARS = 500;

export interface TranscriptRecallInitializeRequest {
	type: "initialize";
	generation: number;
	sessionId: string;
	agentDir: string;
	cwd: string;
}

export interface TranscriptRecallQueryRequest {
	type: "query";
	generation: number;
	requestId: number;
	query: string;
}

export interface TranscriptRecallShutdownRequest {
	type: "shutdown";
	generation: number;
}

export type TranscriptRecallWorkerRequest =
	| TranscriptRecallInitializeRequest
	| TranscriptRecallQueryRequest
	| TranscriptRecallShutdownRequest;

export interface TranscriptRecallReadyResponse {
	type: "ready";
	generation: number;
	size: number;
}

export interface TranscriptRecallResultResponse {
	type: "result";
	generation: number;
	requestId: number;
	hits: RecallHit[];
}

export interface TranscriptRecallFailedResponse {
	type: "failed";
	generation: number;
	error: string;
}

export interface TranscriptRecallStoppedResponse {
	type: "stopped";
	generation: number;
}

export type TranscriptRecallWorkerResponse =
	| TranscriptRecallReadyResponse
	| TranscriptRecallResultResponse
	| TranscriptRecallFailedResponse
	| TranscriptRecallStoppedResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

export function isTranscriptRecallWorkerRequest(value: unknown): value is TranscriptRecallWorkerRequest {
	if (!isRecord(value) || !Number.isInteger(value.generation)) return false;
	if (value.type === "shutdown") return true;
	if (value.type === "query") {
		return (
			Number.isInteger(value.requestId) &&
			typeof value.query === "string" &&
			value.query.length <= TRANSCRIPT_RECALL_MAX_QUERY_CHARS
		);
	}
	return (
		value.type === "initialize" &&
		typeof value.sessionId === "string" &&
		typeof value.agentDir === "string" &&
		typeof value.cwd === "string"
	);
}

function isRecallHit(value: unknown): value is RecallHit {
	return (
		isRecord(value) &&
		typeof value.sessionId === "string" &&
		value.sessionId.length <= 256 &&
		typeof value.score === "number" &&
		Number.isFinite(value.score) &&
		typeof value.snippet === "string" &&
		value.snippet.length <= TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS + 6 &&
		(value.timestamp === undefined || (typeof value.timestamp === "string" && value.timestamp.length <= 128))
	);
}

export function isTranscriptRecallWorkerResponse(value: unknown): value is TranscriptRecallWorkerResponse {
	if (!isRecord(value) || !Number.isInteger(value.generation)) return false;
	if (value.type === "ready") {
		return typeof value.size === "number" && Number.isInteger(value.size) && value.size >= 0;
	}
	if (value.type === "failed") {
		return typeof value.error === "string" && value.error.length <= TRANSCRIPT_RECALL_MAX_ERROR_CHARS;
	}
	if (value.type === "stopped") return true;
	return (
		value.type === "result" &&
		Number.isInteger(value.requestId) &&
		Array.isArray(value.hits) &&
		value.hits.length <= TRANSCRIPT_RECALL_MAX_HITS &&
		value.hits.every(isRecallHit)
	);
}
