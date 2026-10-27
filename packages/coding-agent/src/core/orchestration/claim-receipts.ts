import { readWireRecord } from "../../kernel/wire-record.ts";

/** Counts of host-observed delivery operations, independent of a worker's claim text. */
export interface DeliveryReceipt {
	readonly succeeded: number;
	readonly failed: number;
}

export interface VerificationReceipt {
	readonly passed: number;
	readonly failed: number;
	readonly lastPassed?: boolean | undefined;
}

export interface ClaimReceipts {
	/** `lastPassed` is absent, never `undefined`, when no check ran: receipt facts are persisted as JSON. */
	readonly tests: VerificationReceipt;
	/** Non-test verification; absence in a retained receipt supplies no check evidence. */
	readonly checks?: VerificationReceipt;
	readonly commits: DeliveryReceipt;
	readonly pushes: DeliveryReceipt;
	readonly publishes: DeliveryReceipt;
	readonly filesChanged: readonly string[];
	readonly toolCalls: number;
	readonly succeededToolCalls: number;
}

const RECEIPT_KEYS = new Set([
	"tests",
	"checks",
	"commits",
	"pushes",
	"publishes",
	"filesChanged",
	"toolCalls",
	"succeededToolCalls",
]);
const VERIFICATION_KEYS = new Set(["passed", "failed", "lastPassed"]);
const DELIVERY_KEYS = new Set(["succeeded", "failed"]);

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function delivery(value: unknown): DeliveryReceipt | undefined {
	const record = readWireRecord(value, DELIVERY_KEYS);
	if (!record || !count(record.succeeded) || !count(record.failed)) return undefined;
	return { succeeded: record.succeeded, failed: record.failed };
}

function verification(value: unknown): VerificationReceipt | undefined {
	const record = readWireRecord(value, VERIFICATION_KEYS);
	if (
		!record ||
		!count(record.passed) ||
		!count(record.failed) ||
		(record.lastPassed !== undefined && typeof record.lastPassed !== "boolean") ||
		(record.lastPassed === true && record.passed === 0) ||
		(record.lastPassed === false && record.failed === 0) ||
		(record.lastPassed === undefined && record.passed + record.failed > 0)
	)
		return undefined;
	return {
		passed: record.passed,
		failed: record.failed,
		...(record.lastPassed === undefined ? {} : { lastPassed: record.lastPassed }),
	};
}

/** Decode persisted aggregates without invoking accessors or inventing missing evidence. */
export function decodeClaimReceipts(
	value: unknown,
	maxSourceCharacters = Number.POSITIVE_INFINITY,
): ClaimReceipts | undefined {
	const record = readWireRecord(value, RECEIPT_KEYS);
	if (!record) return undefined;
	const tests = verification(record.tests);
	const checks = record.checks === undefined ? undefined : verification(record.checks);
	const commits = delivery(record.commits);
	const pushes = delivery(record.pushes);
	const publishes = delivery(record.publishes);
	if (
		!tests ||
		(record.checks !== undefined && !checks) ||
		!commits ||
		!pushes ||
		!publishes ||
		!count(record.toolCalls) ||
		!count(record.succeededToolCalls) ||
		record.succeededToolCalls > record.toolCalls ||
		!Array.isArray(record.filesChanged) ||
		record.filesChanged.length > maxSourceCharacters / 2 ||
		Reflect.ownKeys(record.filesChanged).length !== record.filesChanged.length + 1
	)
		return undefined;
	const filesChanged: string[] = [];
	let sourceCharacters = 0;
	for (let index = 0; index < record.filesChanged.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(record.filesChanged, index);
		if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string") return undefined;
		sourceCharacters += descriptor.value.length + 3;
		if (sourceCharacters > maxSourceCharacters) return undefined;
		filesChanged.push(descriptor.value);
	}
	return {
		tests,
		...(checks ? { checks } : {}),
		commits,
		pushes,
		publishes,
		filesChanged,
		toolCalls: record.toolCalls,
		succeededToolCalls: record.succeededToolCalls,
	};
}
