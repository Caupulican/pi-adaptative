/**
 * Watch conditions: what a `watch` routine asks the host to observe in code, with no model call while it waits.
 * This module is the one description of a condition (its authored schema, its canonical stored form, its plain words)
 * and of the bounded fact record a firing carries into the routine's run. Evaluation lives in `watch-evaluators.ts`,
 * the edge decision in the routine store, and arming in `routine-watch-monitor.ts`.
 */

import { isIP } from "node:net";
import { join, parse } from "node:path";
import { StringEnum } from "@caupulican/pi-ai/typebox-helpers";
import { Type } from "typebox";
import type { InterfaceText } from "../language/interface-text.ts";
import { hasOnlyKeys, isPlainRecord } from "../util/value-guards.ts";

/** Shortest cadence of a timer-based condition, and the one an omitted `everyMs` takes. */
export const WATCH_MIN_EVERY_MS = 1_000;
export const WATCH_DEFAULT_EVERY_MS = 30_000;
export const WATCH_MAX_EVERY_MS = 86_400_000;
/** How long one run of a command check may take: the default of an omitted `timeoutMs`, and its bounds. */
export const WATCH_DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
export const WATCH_MIN_COMMAND_TIMEOUT_MS = 1_000;
export const WATCH_MAX_COMMAND_TIMEOUT_MS = 600_000;
export const MAX_WATCH_PATH_CHARS = 2_048;
export const MAX_WATCH_HOST_CHARS = 253;
/** The largest process id any supported platform assigns. */
export const MAX_WATCH_PID = 2_147_483_647;
export const MAX_WATCH_COMMAND_CHARS = 1_000;
export const MAX_WATCH_URL_CHARS = 2_048;
export const MAX_WATCH_MATCH_CHARS = 200;
export const MAX_WATCH_STATUS_CODES = 8;
/** Bound of the untrusted excerpt a firing may carry (a command's or a page's words). */
export const MAX_WATCH_EXCERPT_CHARS = 300;
export const MAX_WATCH_LABEL_CHARS = 80;
const MAX_WATCH_FACTS = 8;
const MAX_WATCH_FACT_TEXT_CHARS = 200;

/** Characters that make a watched path a glob pattern instead of one path. */
const WATCH_GLOB_CHARACTERS = /[*?[\]{}]/u;
/** A host name (letters, digits, hyphen, underscore, dots) or an IP address; never a URL or a path. */
const HOST_NAME_PATTERN =
	/^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?)*\.?$/u;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

export const WATCH_FILE_EVENTS = ["changed", "created", "deleted"] as const;
export const WATCH_PORT_STATES = ["open", "closed"] as const;
export const WATCH_CONDITION_TYPES = ["file", "process", "pid", "port", "command", "http"] as const;
export type WatchConditionType = (typeof WATCH_CONDITION_TYPES)[number];

/** A process-matrix entry id: the role and session of a process the harness manages. Never a path. */
const PROCESS_ID_PATTERN = /^(?:master|worker)-[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

export type WatchCondition =
	| { readonly type: "file"; readonly path: string; readonly on: (typeof WATCH_FILE_EVENTS)[number] }
	| { readonly type: "process"; readonly processId: string; readonly on: "exited" }
	| { readonly type: "pid"; readonly pid: number; readonly on: "exited"; readonly everyMs: number }
	| {
			readonly type: "port";
			readonly host: string;
			readonly port: number;
			readonly on: (typeof WATCH_PORT_STATES)[number];
			readonly everyMs: number;
	  }
	| {
			readonly type: "command";
			readonly command: string;
			readonly everyMs: number;
			/** Longest one run may take; absent means {@link WATCH_DEFAULT_COMMAND_TIMEOUT_MS}. */
			readonly timeoutMs?: number;
			readonly expect: { readonly exitCode?: number; readonly outputContains?: string };
	  }
	| {
			readonly type: "http";
			readonly url: string;
			readonly statusIs?: number[];
			readonly bodyContains?: string;
			readonly everyMs: number;
	  };

const everyMsField = Type.Optional(
	Type.Integer({
		minimum: WATCH_MIN_EVERY_MS,
		maximum: WATCH_MAX_EVERY_MS,
		description: `Check cadence in ms, at least ${WATCH_MIN_EVERY_MS}; default ${WATCH_DEFAULT_EVERY_MS}. Each check costs no model call.`,
	}),
);

/** The authored condition: a discriminated union on `type`. */
export const watchConditionSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("file"),
			path: Type.String({
				minLength: 1,
				maxLength: MAX_WATCH_PATH_CHARS,
				description:
					"A file, a folder (any direct entry created, changed or deleted) or a glob pattern such as logs/**/*.log. Relative paths resolve against the working directory. Only the path's metadata is observed (existence, size, modification time, and a content digest where this session may read the file); no contents are carried.",
			}),
			on: StringEnum(WATCH_FILE_EVENTS),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("process"),
			processId: Type.String({
				minLength: 1,
				maxLength: 210,
				description:
					"The id of a process the harness manages (a process-matrix entry such as worker-<session id>); its recorded terminal state fires the watch.",
			}),
			on: Type.Literal("exited"),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("pid"),
			pid: Type.Integer({
				minimum: 1,
				maximum: MAX_WATCH_PID,
				description: "The id of an operating-system process; the watch fires when it is no longer running.",
			}),
			on: Type.Literal("exited"),
			everyMs: everyMsField,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("port"),
			host: Type.String({
				minLength: 1,
				maxLength: MAX_WATCH_HOST_CHARS,
				description:
					"A host name or IP address: localhost, a LAN host or a remote one. A connection sends nothing.",
			}),
			port: Type.Integer({ minimum: 1, maximum: 65_535 }),
			on: StringEnum(WATCH_PORT_STATES),
			everyMs: everyMsField,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("command"),
			command: Type.String({
				minLength: 1,
				maxLength: MAX_WATCH_COMMAND_CHARS,
				description:
					"A shell command, admitted at every run by the same rules as the owner's own shell calls (edge classes, credential protection, the session's capability envelope). It runs on the cadence with a timeout and a capped output; one that is refused is skipped and fires nothing.",
			}),
			everyMs: everyMsField,
			timeoutMs: Type.Optional(
				Type.Integer({
					minimum: WATCH_MIN_COMMAND_TIMEOUT_MS,
					maximum: WATCH_MAX_COMMAND_TIMEOUT_MS,
					description: `Longest one run may take, in ms; default ${WATCH_DEFAULT_COMMAND_TIMEOUT_MS}, at most ${WATCH_MAX_COMMAND_TIMEOUT_MS}.`,
				}),
			),
			expect: Type.Optional(
				Type.Object(
					{
						exitCode: Type.Optional(Type.Integer({ minimum: 0, maximum: 255, description: "Default 0." })),
						outputContains: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_WATCH_MATCH_CHARS })),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("http"),
			url: Type.String({
				minLength: 1,
				maxLength: MAX_WATCH_URL_CHARS,
				description:
					"An http or https URL on any host, loopback and private networks included. One GET per check, no credentials or cookies; a redirect to another scheme, host or port is not followed and is reported as the observed status.",
			}),
			statusIs: Type.Optional(
				Type.Array(Type.Integer({ minimum: 100, maximum: 599 }), {
					minItems: 1,
					maxItems: MAX_WATCH_STATUS_CODES,
					uniqueItems: true,
					description: "Status codes that count. Default: any 2xx.",
				}),
			),
			bodyContains: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_WATCH_MATCH_CHARS })),
			everyMs: everyMsField,
		},
		{ additionalProperties: false },
	),
]);

function invalid(reason: string): TypeError {
	return new TypeError(`Routine watch condition ${reason}.`);
}

function boundedText(value: unknown, maximum: number, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		value.trim() !== value ||
		value.includes("\0")
	)
		throw invalid(`needs a bounded ${label}`);
	return value;
}

function everyMsOf(value: unknown): number {
	if (value === undefined) return WATCH_DEFAULT_EVERY_MS;
	if (!Number.isSafeInteger(value) || (value as number) < WATCH_MIN_EVERY_MS || (value as number) > WATCH_MAX_EVERY_MS)
		throw invalid(`needs everyMs between ${WATCH_MIN_EVERY_MS} and ${WATCH_MAX_EVERY_MS}`);
	return value as number;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
	if (!allowed.some((entry) => entry === value)) throw invalid(`needs ${label} to be one of ${allowed.join(", ")}`);
	return value as T;
}

/** An http or https address on any host: the owner watches their own services too. Credentials never travel in it. */
function watchUrl(value: unknown): string {
	const text = boundedText(value, MAX_WATCH_URL_CHARS, "url");
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw invalid("needs a valid url");
	}
	if (
		(url.protocol !== "http:" && url.protocol !== "https:") ||
		url.username ||
		url.password ||
		url.hostname.length === 0
	)
		throw invalid("needs an http or https url on a host, without credentials");
	url.hash = "";
	return url.href;
}

/** A host name or address in canonical form: lowercase, without the brackets of an IPv6 literal. */
function watchHost(value: unknown): string {
	const host = boundedText(value, MAX_WATCH_HOST_CHARS, "host")
		.replace(/^\[|\]$/gu, "")
		.toLowerCase();
	if (isIP(host) === 0 && !HOST_NAME_PATTERN.test(host)) throw invalid("needs a host name or an address");
	return host;
}

/** Whether a watched path is a glob pattern (a set of paths) rather than one path. */
export function isWatchGlob(path: string): boolean {
	return WATCH_GLOB_CHARACTERS.test(path);
}

/** A glob pattern's fixed folder (everything before its first wildcard segment) and whether it reaches below one level of it. */
export function splitWatchPattern(pattern: string): { readonly base: string; readonly deeper: boolean } {
	const { root } = parse(pattern);
	const parts = pattern.slice(root.length).split(/[\\/]+/u);
	const firstGlob = Math.max(
		0,
		parts.findIndex((part) => WATCH_GLOB_CHARACTERS.test(part)),
	);
	return { base: join(root, ...parts.slice(0, firstGlob)), deeper: parts.length - firstGlob > 1 };
}

/**
 * The canonical condition of authored or stored input, filling defaults (a cadence) and refusing everything the
 * schema forbids. Path authority, command admission and address checks that need the session are the host's.
 */
export function parseWatchCondition(value: unknown): WatchCondition {
	if (!isPlainRecord(value)) throw invalid("must be an object");
	if (value.type === "file" && hasOnlyKeys(value, ["type", "path", "on"]))
		return {
			type: "file",
			path: boundedText(value.path, MAX_WATCH_PATH_CHARS, "path"),
			on: oneOf(value.on, WATCH_FILE_EVENTS, "on"),
		};
	if (value.type === "process" && hasOnlyKeys(value, ["type", "processId", "on"])) {
		const processId = boundedText(value.processId, 210, "process id");
		if (!PROCESS_ID_PATTERN.test(processId) || processId.includes("..")) throw invalid("names an invalid process id");
		return { type: "process", processId, on: oneOf(value.on, ["exited"], "on") };
	}
	if (value.type === "pid" && hasOnlyKeys(value, ["type", "pid", "on", "everyMs"])) {
		if (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1 || (value.pid as number) > MAX_WATCH_PID)
			throw invalid(`needs a process id between 1 and ${MAX_WATCH_PID}`);
		return {
			type: "pid",
			pid: value.pid as number,
			on: oneOf(value.on, ["exited"], "on"),
			everyMs: everyMsOf(value.everyMs),
		};
	}
	if (value.type === "port" && hasOnlyKeys(value, ["type", "host", "port", "on", "everyMs"])) {
		if (!Number.isSafeInteger(value.port) || (value.port as number) < 1 || (value.port as number) > 65_535)
			throw invalid("needs a port between 1 and 65535");
		return {
			type: "port",
			host: watchHost(value.host),
			port: value.port as number,
			on: oneOf(value.on, WATCH_PORT_STATES, "on"),
			everyMs: everyMsOf(value.everyMs),
		};
	}
	if (value.type === "command" && hasOnlyKeys(value, ["type", "command", "everyMs", "timeoutMs", "expect"])) {
		const expect = value.expect === undefined ? {} : value.expect;
		if (!isPlainRecord(expect) || !hasOnlyKeys(expect, ["exitCode", "outputContains"]))
			throw invalid("has an invalid expect");
		if (
			expect.exitCode !== undefined &&
			(!Number.isSafeInteger(expect.exitCode) ||
				(expect.exitCode as number) < 0 ||
				(expect.exitCode as number) > 255)
		)
			throw invalid("needs expect.exitCode between 0 and 255");
		if (
			value.timeoutMs !== undefined &&
			(!Number.isSafeInteger(value.timeoutMs) ||
				(value.timeoutMs as number) < WATCH_MIN_COMMAND_TIMEOUT_MS ||
				(value.timeoutMs as number) > WATCH_MAX_COMMAND_TIMEOUT_MS)
		)
			throw invalid(`needs timeoutMs between ${WATCH_MIN_COMMAND_TIMEOUT_MS} and ${WATCH_MAX_COMMAND_TIMEOUT_MS}`);
		return {
			type: "command",
			command: boundedText(value.command, MAX_WATCH_COMMAND_CHARS, "command"),
			everyMs: everyMsOf(value.everyMs),
			...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
			expect: {
				...(expect.exitCode === undefined ? {} : { exitCode: expect.exitCode as number }),
				...(expect.outputContains === undefined
					? {}
					: { outputContains: boundedText(expect.outputContains, MAX_WATCH_MATCH_CHARS, "outputContains") }),
			},
		};
	}
	if (value.type === "http" && hasOnlyKeys(value, ["type", "url", "statusIs", "bodyContains", "everyMs"])) {
		let statusIs: number[] | undefined;
		if (value.statusIs !== undefined) {
			const codes = value.statusIs;
			if (
				!Array.isArray(codes) ||
				codes.length === 0 ||
				codes.length > MAX_WATCH_STATUS_CODES ||
				codes.some((code) => !Number.isSafeInteger(code) || code < 100 || code > 599)
			)
				throw invalid("needs statusIs to be 1 to 8 status codes");
			statusIs = [...new Set(codes as number[])].sort((left, right) => left - right);
		}
		return {
			type: "http",
			url: watchUrl(value.url),
			...(statusIs === undefined ? {} : { statusIs }),
			...(value.bodyContains === undefined
				? {}
				: { bodyContains: boundedText(value.bodyContains, MAX_WATCH_MATCH_CHARS, "bodyContains") }),
			everyMs: everyMsOf(value.everyMs),
		};
	}
	throw invalid("is not a supported file, process, pid, port, command or http condition");
}

/** The cadence of a timer-based condition; undefined for the event-driven ones. */
export function watchCadenceMs(condition: WatchCondition): number | undefined {
	return condition.type === "file" || condition.type === "process" ? undefined : condition.everyMs;
}

/** How the owner reads a cadence: seconds, minutes or hours. */
function plainEvery(ms: number): string {
	if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
	if (ms % 60_000 === 0) return `${ms / 60_000} min`;
	return `${Math.round(ms / 1000)} s`;
}

/** The last path component, however the path is spelled. */
export function watchShortName(path: string): string {
	const parts = path.split(/[\\/]+/u).filter((part) => part.length > 0);
	return parts.at(-1) ?? path;
}

function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "a web page";
	}
}

/**
 * What a watch does, in plain words: no identifiers, codes or command text. The caller passes the words: the English
 * ones for the routine tool's result, which a model reads, and the interface's for a line drawn on screen.
 */
export function describeWatchCondition(condition: WatchCondition, words: InterfaceText["chat"]["watch"]): string {
	const every = condition.type === "file" || condition.type === "process" ? "" : plainEvery(condition.everyMs);
	switch (condition.type) {
		case "file": {
			const name = watchShortName(condition.path);
			const glob = isWatchGlob(condition.path);
			if (condition.on === "changed") return glob ? words.globChanged(name) : words.fileChanged(name);
			if (condition.on === "created") return glob ? words.globCreated(name) : words.fileCreated(name);
			return glob ? words.globRemoved(name) : words.fileRemoved(name);
		}
		case "process":
			return words.processExit;
		case "pid":
			return words.pidExit(every, condition.pid);
		case "port": {
			const host = LOOPBACK_HOSTS.has(condition.host) ? undefined : condition.host;
			return words.port(condition.port, host, every, condition.on === "open");
		}
		case "command":
			return words.commandCheck(every);
		case "http":
			return words.http(hostOf(condition.url), every);
	}
}

/** What changed, as a closed vocabulary. */
export const WATCH_CHANGES = ["changed", "created", "deleted", "exited", "open", "closed", "matched"] as const;
export type WatchChange = (typeof WATCH_CHANGES)[number];

export type WatchFactValue = string | number | boolean;

/**
 * What one firing carries into the routine's run: bounded facts only. `facts` hold sizes, codes and times, never file
 * contents; `excerpt` is the one place third-party words (a command's output, a page's text) can appear, so the run's
 * brief fences it as untrusted data.
 */
export interface WatchFiredEvent {
	readonly version: 1;
	readonly kind: "watch-fired";
	readonly condition: WatchConditionType;
	readonly change: WatchChange;
	/** A short name for the owner: a file's name, a port, a host. */
	readonly label: string;
	readonly observedAt: string;
	readonly facts: Readonly<Record<string, WatchFactValue>>;
	readonly excerpt?: string;
}

const FACT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,23}$/u;

export function parseWatchFiredEvent(value: unknown): WatchFiredEvent {
	if (
		!isPlainRecord(value) ||
		!hasOnlyKeys(value, ["version", "kind", "condition", "change", "label", "observedAt", "facts", "excerpt"]) ||
		value.version !== 1 ||
		value.kind !== "watch-fired" ||
		!isPlainRecord(value.facts)
	)
		throw new TypeError("Routine watch event is invalid.");
	const entries = Object.entries(value.facts);
	if (entries.length > MAX_WATCH_FACTS) throw new TypeError("Routine watch event carries too many facts.");
	const facts: Record<string, WatchFactValue> = {};
	for (const [key, fact] of entries) {
		const valid =
			typeof fact === "boolean" ||
			(typeof fact === "number" && Number.isFinite(fact)) ||
			(typeof fact === "string" && fact.length <= MAX_WATCH_FACT_TEXT_CHARS && !fact.includes("\0"));
		if (!FACT_KEY_PATTERN.test(key) || !valid) throw new TypeError("Routine watch event carries an invalid fact.");
		facts[key] = fact;
	}
	const observedAt = value.observedAt;
	if (
		typeof observedAt !== "string" ||
		!Number.isFinite(Date.parse(observedAt)) ||
		new Date(observedAt).toISOString() !== observedAt ||
		typeof value.label !== "string" ||
		value.label.length > MAX_WATCH_LABEL_CHARS ||
		value.label.includes("\0") ||
		(value.excerpt !== undefined &&
			(typeof value.excerpt !== "string" ||
				value.excerpt.length === 0 ||
				value.excerpt.length > MAX_WATCH_EXCERPT_CHARS))
	)
		throw new TypeError("Routine watch event is invalid.");
	return {
		version: 1,
		kind: "watch-fired",
		condition: oneOf(value.condition, WATCH_CONDITION_TYPES, "condition"),
		change: oneOf(value.change, WATCH_CHANGES, "change"),
		label: value.label,
		observedAt,
		facts,
		...(value.excerpt === undefined ? {} : { excerpt: value.excerpt }),
	};
}

/** The owner-facing line of a firing: 'A watched file changed: notes.txt'. */
export function describeWatchFired(event: WatchFiredEvent): string {
	const label = event.label.length > 0 ? `: ${event.label}` : "";
	switch (event.condition) {
		case "file":
			return event.change === "created"
				? `A watched file appeared${label}`
				: event.change === "deleted"
					? `A watched file was removed${label}`
					: event.facts.entries === undefined
						? `A watched file changed${label}`
						: `A watched folder or file pattern changed${label}`;
		case "process":
		case "pid":
			return "A watched process exited";
		case "port":
			return `A watched port is now ${event.change === "open" ? "open" : "closed"}${label}`;
		case "command":
			return "A watched command check now passes";
		case "http":
			return `A watched page now matches${label}`;
	}
}
