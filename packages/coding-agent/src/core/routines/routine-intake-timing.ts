/**
 * Host-owned timing of routine intake. The extraction model only fills constrained timing slots; the host reads the
 * owner's own message with a fixed positional grammar (English, Portuguese and Spanish tables), derives the schedule
 * from the stated words alone, fills the parts the owner left open with fixed defaults it announces, and compiles the
 * executable schedule. A model slot can only refuse a compile, never change it, and anything the grammar does not read
 * refuses. The model never chooses an hour, a cron rule, an instant or a zone.
 */
import { StringEnum } from "@caupulican/pi-ai/typebox-helpers";
import { type Static, Type } from "typebox";
import { CI_TERMINAL_CONCLUSIONS, type CiTerminalConclusion } from "../events/host-event-contract.ts";
import { type OwnerWords, ownerShownRegions } from "../learning/owner-evidence-ledger.ts";
import { canonicalCalendarTimeZone, MAX_CALENDAR_TIME_ZONE_CHARS, nextCalendarSlotAfter } from "./calendar-schedule.ts";
import {
	MAX_ROUTINE_INTAKE_TEXT_CHARS,
	MAX_ROUTINE_WORKFLOW_PATH_CHARS,
	parseRoutineScheduleInput,
	type RoutineScheduleInput,
} from "./routine-contract.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
/** Start window of a slot whose hour the host chose: a run that cannot start within it is skipped, not run late. */
export const INTAKE_DEFAULT_LATENESS_MS = 30 * MINUTE_MS;
/** A one-time request must lie at least this far ahead when it is compiled, and at most a year ahead. */
const MIN_ONCE_LEAD_MS = MINUTE_MS;
const MAX_ONCE_LEAD_MS = 366 * DAY_MS;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const PARTS_OF_DAY = ["morning", "noon", "afternoon", "evening", "night"] as const;
type PartOfDay = (typeof PARTS_OF_DAY)[number];
/** Fixed hours for a named part of the day; the notice states which one was used. */
const PART_OF_DAY_HOUR: Readonly<Record<PartOfDay, number>> = {
	morning: 9,
	noon: 12,
	afternoon: 15,
	evening: 18,
	night: 21,
};
/** The hour of a recurring or one-time request that names no time and no part of the day. */
const DEFAULT_HOUR = 9;
const INTERVAL_UNITS = ["minute", "hour", "day", "week"] as const;
type IntervalUnit = (typeof INTERVAL_UNITS)[number];
const INTERVAL_UNIT_MS: Readonly<Record<IntervalUnit, number>> = {
	minute: MINUTE_MS,
	hour: 60 * MINUTE_MS,
	day: DAY_MS,
	week: 7 * DAY_MS,
};

const timeField = Type.Optional(
	Type.String({
		pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
		description: "HH:MM on a 24-hour clock, only when the owner stated the time of day.",
	}),
);
const partOfDayField = Type.Optional(
	StringEnum(PARTS_OF_DAY, {
		description: "Only when the owner named a part of the day and no time.",
	}),
);
const timeZoneField = Type.Optional(
	Type.String({
		minLength: 1,
		maxLength: MAX_CALENDAR_TIME_ZONE_CHARS,
		description: "IANA zone, only when the owner named a zone or a city for the time.",
	}),
);

/** The constrained timing slots the extraction model may fill; never a cron rule or an instant. */
export const intakeTimingSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("interval"),
			every: Type.Integer({ minimum: 1, maximum: 10_000 }),
			unit: StringEnum(INTERVAL_UNITS),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("daily"),
			time: timeField,
			partOfDay: partOfDayField,
			days: Type.Optional(
				Type.Array(StringEnum(WEEKDAYS), {
					minItems: 1,
					maxItems: 7,
					uniqueItems: true,
					description:
						"Only the days the owner named. Omit it for a plain daily request; list all seven only when the owner explicitly included weekends or every single day.",
				}),
			),
			timeZone: timeZoneField,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("monthly"),
			day: Type.Integer({ minimum: 1, maximum: 31 }),
			time: timeField,
			partOfDay: partOfDayField,
			timeZone: timeZoneField,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("once"),
			date: Type.String({
				pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
				description: "YYYY-MM-DD in the owner's zone, from the message's sentAt.",
			}),
			time: timeField,
			partOfDay: partOfDayField,
			timeZone: timeZoneField,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			kind: Type.Literal("event"),
			conclusions: Type.Optional(
				Type.Array(StringEnum(CI_TERMINAL_CONCLUSIONS), {
					minItems: 1,
					maxItems: CI_TERMINAL_CONCLUSIONS.length,
					uniqueItems: true,
					description: "Only the outcomes the owner named; omitted means failed attempts.",
				}),
			),
			workflowPath: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ROUTINE_WORKFLOW_PATH_CHARS })),
		},
		{ additionalProperties: false },
	),
]);

export type IntakeTiming = Static<typeof intakeTimingSchema>;

/** How long the owner wants a request to keep running, as the extraction model read it; omitted means standing. */
export const INTAKE_LIFETIMES = ["until_condition", "next_time_only"] as const;
export type IntakeLifetime = (typeof INTAKE_LIFETIMES)[number];
/** The end the host gives a conditional or one-time watch that names none, stated to the owner. */
export const INTAKE_WATCH_LIFETIME_MS = 14 * DAY_MS;

/** A compiled intake schedule: what runs, how the owner reads it, and which parts the host chose. */
export interface CompiledIntakeTiming {
	readonly schedule: RoutineScheduleInput;
	/** Plain cadence in the routine's own zone, never a cron rule or a UTC instant. */
	readonly cadence: string;
	/** Parts the owner left open that the host filled with its fixed defaults, in plain words. */
	readonly defaults: readonly string[];
}

/** Original offsets of a grounded excerpt, end exclusive. */
export interface IntakeTextSpan {
	readonly start: number;
	readonly end: number;
}

export interface IntakeTimingContext {
	/**
	 * The owner's complete original message with its pasted ranges: the host reads the timing from its stated words,
	 * never from the excerpt alone.
	 */
	readonly owner: OwnerWords;
	/** Where the grounded timing excerpt lies in the owner's text. */
	readonly when: IntakeTextSpan;
	/** Where the grounded instruction excerpt lies in the owner's text. */
	readonly instruction: IntakeTextSpan;
	/** When the owner sent the message: relative dates are read from it. */
	readonly sentAt: number;
	readonly now: number;
	readonly hostTimeZone: string;
}

/**
 * Compiles the slots when the owner's stated timing words, read by the host grammar, yield exactly the schedule the
 * slots describe; otherwise undefined, and the request is dropped before any judgment.
 */
export function compileIntakeTiming(
	timing: IntakeTiming,
	context: IntakeTimingContext,
	lifetime?: IntakeLifetime,
): CompiledIntakeTiming | undefined {
	// A one-time watch exists only for CI results; a clock request that should happen once is a `once` timing.
	if (lifetime === "next_time_only" && timing.kind !== "event" && timing.kind !== "once") return undefined;
	const base = compileTimingSlots(timing, context, lifetime === "next_time_only");
	if (!base || base.schedule.kind === "once" || lifetime === undefined) return base;
	const expiresAt = context.now + INTAKE_WATCH_LIFETIME_MS;
	const zone = (base.schedule.kind === "calendar" ? base.schedule.timeZone : undefined) ?? context.hostTimeZone;
	const end = `${localStamp(expiresAt, zone)} (${zone})`;
	if (lifetime === "next_time_only")
		return base.schedule.kind !== "event"
			? undefined
			: compiled({ ...base.schedule, stopAfterFirstRun: true, expiresAt }, base.cadence, [
					...base.defaults,
					`stops watching on ${end}, 14 days after the request, if that has not happened, as no end was stated`,
				]);
	return compiled({ ...base.schedule, expiresAt }, `${base.cadence}, until ${end}`, [
		...base.defaults,
		`ends on ${end}, 14 days after the request, as no end was stated`,
	]);
}

/**
 * Whether the owner's stated (not shown) words carry any timing the host grammar reads: a schedule construct in any
 * of its languages, or a CI subject together with an outcome word. It is the compile precondition evaluated over the
 * whole message, so a message for which it is false can never compile a request and buys no extraction.
 */
export function statesIntakeTiming(owner: OwnerWords): boolean {
	const tokens = tokenize(owner);
	const everywhere = { first: 0, last: tokens.length };
	return LANGUAGES.some(
		(language) =>
			parseTokens(tokens, language).some(
				(construct) => construct.type !== "refusal" && construct.type !== "zone" && construct.type !== "event",
			) || readsCi(language, tokens, everywhere),
	);
}

/** One compile per language; every language that reads the whole excerpt must compile the same schedule. */
function compileTimingSlots(
	timing: IntakeTiming,
	context: IntakeTimingContext,
	nextTimeOnly: boolean,
): CompiledIntakeTiming | undefined {
	const tokens = tokenize(context.owner);
	const span = excerptSpan(tokens, context.when);
	if (!span) return undefined;
	let agreed: { readonly result: CompiledIntakeTiming } | undefined;
	for (const language of LANGUAGES) {
		const result = compileIn(language, tokens, span, timing, context, nextTimeOnly);
		if (result === "unread") continue;
		if (result === undefined) return undefined;
		if (agreed && JSON.stringify(agreed.result) !== JSON.stringify(result)) return undefined;
		agreed = { result };
	}
	return agreed?.result;
}

/**
 * "unread" when a timing word of the excerpt is left over by this language's constructs. Otherwise the language's
 * compile: every construct of the excerpt's sentences must lie inside the excerpt (or wholly inside a separate
 * instruction excerpt), so the model cannot cut a meridiem, an ordinal, an exception or a clock off the timing.
 */
function compileIn(
	language: Language,
	tokens: readonly Token[],
	span: TokenSpan,
	timing: IntakeTiming,
	context: IntakeTimingContext,
	nextTimeOnly: boolean,
): CompiledIntakeTiming | undefined | "unread" {
	const constructs = parseTokens(tokens, language);
	const workflow = timing.kind === "event" ? workflowSpan(timing.workflowPath, tokens, span) : undefined;
	if (workflow === null) return undefined;
	const named = (first: number, last: number) =>
		workflow !== undefined && first >= workflow.first && last <= workflow.last;
	const consumed = new Uint8Array(tokens.length);
	for (const construct of constructs) consumed.fill(1, construct.start, construct.end);
	for (let index = span.first; index < span.last; index++)
		if (!consumed[index] && !named(index, index + 1) && isAnchor(tokens[index]!)) return "unread";
	if (timing.kind === "event" && !readsCi(language, tokens, span)) return "unread";
	const sentences = new Set(tokens.slice(span.first, span.last).map((token) => token.sentence));
	const { instruction, when } = context;
	const apart = instruction.end <= when.start || instruction.start >= when.end;
	const stated: Construct[] = [];
	for (const construct of constructs) {
		if (!sentences.has(tokens[construct.start]!.sentence) || named(construct.start, construct.end)) continue;
		if (timing.kind === "event") {
			// A CI watch has no clock: any other timing in its sentence means the owner asked for something else.
			if (construct.type !== "event") return undefined;
			continue;
		}
		if (construct.start >= span.first && construct.end <= span.last) stated.push(construct);
		else if (
			!apart ||
			tokens[construct.start]!.start < instruction.start ||
			tokens[construct.end - 1]!.end > instruction.end
		)
			return undefined;
	}
	if (timing.kind === "event") return compileEvent(timing, language, tokens, span, nextTimeOnly);
	return compileCalendar(timing, stated, tokens, span, context);
}

function compiled(
	schedule: RoutineScheduleInput,
	cadence: string,
	defaults: readonly string[],
): CompiledIntakeTiming | undefined {
	// The retained request bounds every description; a cadence that would not fit (a long workflow path) is dropped.
	if ([cadence, ...defaults].some((text) => text.length > MAX_ROUTINE_INTAKE_TEXT_CHARS)) return undefined;
	try {
		return { schedule: parseRoutineScheduleInput(schedule), cadence, defaults };
	} catch {
		return undefined;
	}
}

function compileEvent(
	timing: Extract<IntakeTiming, { kind: "event" }>,
	language: Language,
	tokens: readonly Token[],
	span: TokenSpan,
	nextTimeOnly: boolean,
): CompiledIntakeTiming | undefined {
	const conclusions: readonly CiTerminalConclusion[] = timing.conclusions ?? ["failure"];
	const every = CI_TERMINAL_CONCLUSIONS.every((conclusion) => conclusions.includes(conclusion));
	const carried = (outcome: CiOutcome) => language.outcomes[outcome].some((phrase) => spanHas(tokens, span, phrase));
	if (
		every
			? !carried("finish")
			: conclusions.some((conclusion) => !carried(conclusion === "startup_failure" ? "failure" : conclusion))
	)
		return undefined;
	return compiled(
		{
			kind: "event",
			source: "ci",
			...(timing.conclusions === undefined ? {} : { conclusions: [...timing.conclusions] }),
			...(timing.workflowPath === undefined ? {} : { workflowPath: timing.workflowPath }),
		},
		`${nextTimeOnly ? "once, the next time" : "every time"} a CI attempt of the checked-out revision ${every ? "finishes" : `ends in ${conclusions.join(" or ")}`}${timing.workflowPath === undefined ? "" : ` (${timing.workflowPath})`}${nextTimeOnly ? ", then it is removed" : ""}`,
		[],
	);
}

function compileCalendar(
	timing: Exclude<IntakeTiming, { kind: "event" }>,
	stated: readonly Construct[],
	tokens: readonly Token[],
	span: TokenSpan,
	context: IntakeTimingContext,
): CompiledIntakeTiming | undefined {
	const zones = stated.filter((construct) => construct.type === "zone");
	const derived = derive(stated.filter((construct) => construct.type !== "zone"));
	if (!derived || derived.kind !== timing.kind) return undefined;
	if (derived.kind === "interval" || timing.kind === "interval") {
		if (derived.kind !== "interval" || timing.kind !== "interval" || zones.length > 0) return undefined;
		const intervalMs = derived.every * INTERVAL_UNIT_MS[derived.unit];
		if (timing.every * INTERVAL_UNIT_MS[timing.unit] !== intervalMs) return undefined;
		return compiled(
			{ kind: "interval", intervalMs },
			derived.every === 1 ? `every ${derived.unit}` : `every ${derived.every} ${derived.unit}s`,
			[],
		);
	}
	const zone = intakeZone(timing.timeZone, zones, tokens, span, context.hostTimeZone);
	const clock = resolveClock(derived, tokens, context.owner.text);
	if (zone === undefined || clock === undefined) return undefined;
	if (timing.time !== undefined && !clock.readings.includes(timing.time)) return undefined;
	if (
		timing.partOfDay !== undefined &&
		timing.partOfDay !== derived.part &&
		!(timing.partOfDay === "noon" && derived.clock?.noon)
	)
		return undefined;
	const at = `${pad(clock.hour)}:${pad(clock.minute)}`;
	const window = clock.defaults.length > 0 ? { maxLatenessMs: INTAKE_DEFAULT_LATENESS_MS } : {};
	if (derived.kind === "monthly") {
		if (timing.kind !== "monthly" || timing.day !== derived.day) return undefined;
		return compiled(
			{ kind: "calendar", cron: `${clock.minute} ${clock.hour} ${derived.day} * *`, timeZone: zone, ...window },
			`on day ${derived.day} of every month at ${at} (${zone})${SHORT_MONTHS[derived.day] ?? ""}`,
			clock.defaults,
		);
	}
	if (derived.kind === "daily") {
		if (timing.kind !== "daily") return undefined;
		const days = intakeDays(derived.days, timing.days);
		if (!days) return undefined;
		return compiled(
			{ kind: "calendar", cron: `${clock.minute} ${clock.hour} * * ${days.field}`, timeZone: zone, ...window },
			`${days.label} at ${at} (${zone})`,
			[...clock.defaults, ...days.defaults],
		);
	}
	if (timing.kind !== "once") return undefined;
	const date = onceDate(derived.date, localDate(context.sentAt, zone));
	if (!date || isoDate(date) !== timing.date) return undefined;
	const instant = nextCalendarSlotAfter(
		{ cron: `${clock.minute} ${clock.hour} ${date.day} ${date.month} *`, timeZone: zone },
		context.now,
	);
	if (
		instant === undefined ||
		!sameDate(localDate(instant, zone), date) ||
		instant < context.now + MIN_ONCE_LEAD_MS ||
		instant > context.now + MAX_ONCE_LEAD_MS
	)
		return undefined;
	return compiled(
		{
			kind: "once",
			at: instant,
			...(clock.defaults.length > 0 ? { notAfter: instant + INTAKE_DEFAULT_LATENESS_MS } : {}),
		},
		`once on ${timing.date} at ${at} (${zone})`,
		clock.defaults,
	);
}

/**
 * Cron has no last-day rule, so a day the month may lack is compiled as stated and the months without a run are said
 * in the cadence; "the last day of the month" refuses.
 */
const SHORT_MONTHS: Readonly<Record<number, string>> = {
	29: ", with no run in February outside leap years",
	30: ", with no run in February",
	31: ", with no run in February, April, June, September and November",
};

// ---------------------------------------------------------------------------------------------------------------
// Tokens

type TokenKind = "word" | "number" | "clock" | "hclock" | "decimal";

interface Token {
	readonly kind: TokenKind;
	/** Folded text: accents removed and lowercase; `a.m.` and `p.m.` read as `am` and `pm`. */
	readonly text: string;
	/** Original offsets, end exclusive. */
	readonly start: number;
	readonly end: number;
	/** Trimmed stated text between the previous token and this one. */
	readonly gap: string;
	/** A construct never crosses a run: a sentence end or a shown region ends one. */
	readonly run: number;
	readonly sentence: number;
}

/** Token indices, end exclusive. */
interface TokenSpan {
	readonly first: number;
	readonly last: number;
}

/**
 * `9:30` clock, `9h`/`9h30` clock (an interval after an interval marker), decimals (never part of a construct), digit
 * runs, `a.m.`/`p.m.`, and letter runs. Digits and letters split ("9am" is "9" "am").
 */
const TOKEN_PATTERN =
	/(\d{1,2}:\d{2})(?!\d)|(\d{1,2}h(?:\d{2})?)(?![\p{L}\p{N}])|(\d+(?:[.,]\d+)+)|(\d+)|([ap])\.m\b\.?|(\p{L}+)/gu;
const SENTENCE_END = /[.!?;\n]/u;

/** Folds per code point (NFD, marks removed, lowercase) and keeps each folded character's original offsets. */
function fold(text: string, shown?: Uint8Array): { text: string; starts: number[]; ends: number[] } {
	let folded = "";
	const starts: number[] = [];
	const ends: number[] = [];
	for (let index = 0; index < text.length; ) {
		const char = String.fromCodePoint(text.codePointAt(index)!);
		const piece = shown?.[index] ? " " : char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
		for (let position = 0; position < piece.length; position++) {
			starts.push(index);
			ends.push(index + char.length);
		}
		folded += piece;
		index += char.length;
	}
	return { text: folded, starts, ends };
}

/** The owner's stated words as tokens; shown text (pasted, quoted, code) is removed and ends a run. */
function tokenize(owner: OwnerWords): Token[] {
	const text = owner.text;
	const shown = new Uint8Array(text.length);
	for (const region of ownerShownRegions(owner)) shown.fill(1, region.start, region.end);
	const folded = fold(text, shown);
	const tokens: Token[] = [];
	let run = 0;
	let sentence = 0;
	let previousEnd = 0;
	let previousFolded = 0;
	for (const match of folded.text.matchAll(TOKEN_PATTERN)) {
		const at = match.index ?? 0;
		const start = folded.starts[at]!;
		const end = folded.ends[at + match[0].length - 1]!;
		const gap = folded.text.slice(previousFolded, at);
		if (tokens.length > 0) {
			const ended = SENTENCE_END.test(gap);
			if (ended) sentence++;
			if (ended || shown.subarray(previousEnd, start).includes(1)) run++;
		}
		tokens.push({
			kind: match[1] ? "clock" : match[2] ? "hclock" : match[3] ? "decimal" : match[4] ? "number" : "word",
			text: match[5] ? `${match[5]}m` : match[0],
			start,
			end,
			gap: gap.trim(),
			run,
			sentence,
		});
		previousEnd = end;
		previousFolded = at + match[0].length;
	}
	return tokens;
}

function foldedWords(text: string): string[] {
	return [...fold(text).text.matchAll(TOKEN_PATTERN)].map((match) => (match[5] ? `${match[5]}m` : match[0]));
}

/** The tokens wholly inside the excerpt; an excerpt edge that cuts a token ("9 hours" inside "19 hours") refuses. */
function excerptSpan(tokens: readonly Token[], when: IntakeTextSpan): TokenSpan | undefined {
	let first = -1;
	let last = -1;
	for (const [index, token] of tokens.entries()) {
		if ((token.start < when.start && token.end > when.start) || (token.start < when.end && token.end > when.end))
			return undefined;
		if (token.start >= when.start && token.end <= when.end) {
			if (first < 0) first = index;
			last = index + 1;
		}
	}
	return first < 0 ? undefined : { first, last };
}

function spanHas(tokens: readonly Token[], span: TokenSpan, phrase: string): boolean {
	const parts = phrase.split(" ");
	for (let index = span.first; index + parts.length <= span.last; index++)
		if (parts.every((part, offset) => tokens[index + offset]!.text === part)) return true;
	return false;
}

/** A CI subject and an outcome word of one language, within the span. */
function readsCi(language: Language, tokens: readonly Token[], span: TokenSpan): boolean {
	return (
		language.ciSubjects.some((subject) => spanHas(tokens, span, subject)) &&
		Object.values(language.outcomes).some((phrases) => phrases.some((phrase) => spanHas(tokens, span, phrase)))
	);
}

/** The named workflow's file name, as words of the excerpt; null when the excerpt does not carry it. */
function workflowSpan(
	path: string | undefined,
	tokens: readonly Token[],
	span: TokenSpan,
): TokenSpan | null | undefined {
	if (path === undefined) return undefined;
	const words = foldedWords(
		path
			.split("/")
			.at(-1)!
			.replace(/\.[^.]*$/u, ""),
	);
	if (words.length === 0) return null;
	for (let index = span.first; index + words.length <= span.last; index++)
		if (words.every((word, offset) => tokens[index + offset]!.text === word))
			return { first: index, last: index + words.length };
	return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Constructs

type DateRef =
	| { readonly kind: "today" }
	| { readonly kind: "tomorrow" }
	| { readonly kind: "weekday"; readonly day: number }
	| { readonly kind: "day"; readonly day: number; readonly month?: number };

interface ClockValue {
	readonly type: "clock";
	readonly hour: number;
	readonly minute: number;
	/** The meridiem is known: am/pm, a 24-hour form, a leading zero, or noon/midnight words. */
	readonly exact: boolean;
	readonly noon: boolean;
	/** First token of the stated time itself, after any marker such as "at". */
	readonly core: number;
}

type ConstructValue =
	| { readonly type: "refusal" }
	| { readonly type: "zone"; readonly zone: string }
	| { readonly type: "event" }
	| { readonly type: "allWeek" }
	| { readonly type: "monthDay"; readonly day: number }
	| { readonly type: "days"; readonly days: readonly number[]; readonly recurring: boolean }
	| { readonly type: "partCadence"; readonly part: PartOfDay }
	| { readonly type: "daily" }
	| { readonly type: "weekly" }
	| { readonly type: "monthly" }
	| { readonly type: "interval"; readonly every: number; readonly unit: IntervalUnit }
	| { readonly type: "todayPart"; readonly part: PartOfDay }
	| { readonly type: "part"; readonly part: PartOfDay; readonly recurring: boolean; readonly lunch: boolean }
	| ClockValue
	| { readonly type: "date"; readonly date: DateRef };

/** A recognized construct over token indices `[start, end)`. */
type Construct = ConstructValue & { readonly start: number; readonly end: number };

type Hit = readonly [end: number, value: ConstructValue];
type ConstructReader = (reader: TokenReader, index: number) => Hit | undefined;

const REFUSAL: ConstructValue = { type: "refusal" };

/** Reads one run of tokens with one language's tables. */
class TokenReader {
	readonly tokens: readonly Token[];
	readonly end: number;
	readonly language: Language;

	constructor(tokens: readonly Token[], end: number, language: Language) {
		this.tokens = tokens;
		this.end = end;
		this.language = language;
	}

	token(index: number): Token | undefined {
		return index < this.end ? this.tokens[index] : undefined;
	}

	word(index: number): string | undefined {
		const token = this.token(index);
		return token?.kind === "word" ? token.text : undefined;
	}

	/** End of the longest listed phrase starting at `index`. */
	phrase(index: number, phrases: readonly string[]): number | undefined {
		let best: number | undefined;
		for (const phrase of phrases) {
			const parts = phrase.split(" ");
			if (parts.every((part, offset) => this.token(index + offset)?.text === part))
				best = Math.max(best ?? 0, index + parts.length);
		}
		return best;
	}

	/** The longest listed phrase starting at `index`, with its value. */
	entry<T>(index: number, entries: readonly (readonly [string, T])[]): readonly [number, T] | undefined {
		let best: readonly [number, T] | undefined;
		for (const [phrase, value] of entries) {
			const end = this.phrase(index, [phrase]);
			if (end !== undefined && (best === undefined || end > best[0])) best = [end, value];
		}
		return best;
	}

	/** Skips up to two listed connector words. */
	skip(index: number, words: readonly string[]): number {
		let at = index;
		while (at < index + 2 && words.includes(this.word(at) ?? "")) at++;
		return at;
	}

	/** Digits, or this language's number words, with a tens word joined to a unit word ("twenty five", "vinte e um"). */
	number(index: number): readonly [number, number] | undefined {
		const token = this.token(index);
		if (token?.kind === "number") return token.text.length <= 5 ? [index + 1, Number(token.text)] : undefined;
		const value = token?.kind === "word" ? this.language.numbers.get(token.text) : undefined;
		if (value === undefined) return undefined;
		if (value >= 20 && value % 10 === 0) {
			const next = this.language.conjunctions.includes(this.word(index + 1) ?? "") ? index + 2 : index + 1;
			const unit = this.language.numbers.get(this.word(next) ?? "");
			if (unit !== undefined && unit >= 1 && unit <= 9) return [next + 1, value + unit];
		}
		return [index + 1, value];
	}

	/** A day number written as an ordinal: "15th", "1º". */
	ordinalDay(index: number): readonly [number, number] | undefined {
		const token = this.token(index);
		const suffix = this.token(index + 1);
		if (
			token?.kind !== "number" ||
			!suffix ||
			suffix.gap !== "" ||
			!this.language.ordinalSuffixes.includes(suffix.text)
		)
			return undefined;
		const day = Number(token.text);
		return day >= 1 && day <= 31 ? [index + 2, day] : undefined;
	}
}

function parseTokens(tokens: readonly Token[], language: Language): Construct[] {
	const constructs: Construct[] = [];
	for (let runStart = 0; runStart < tokens.length; ) {
		let runEnd = runStart;
		while (runEnd < tokens.length && tokens[runEnd]!.run === tokens[runStart]!.run) runEnd++;
		const reader = new TokenReader(tokens, runEnd, language);
		for (let index = runStart; index < runEnd; ) {
			const hit = readConstruct(reader, index, CONSTRUCT_READERS);
			if (!hit) {
				index++;
				continue;
			}
			constructs.push({ ...hit[1], start: index, end: hit[0] });
			index = hit[0];
		}
		runStart = runEnd;
	}
	return constructs;
}

function readConstruct(reader: TokenReader, index: number, readers: readonly ConstructReader[]): Hit | undefined {
	for (const read of readers) {
		const hit = read(reader, index);
		if (hit) return hit;
	}
	return undefined;
}

function phraseReader(pick: (language: Language) => readonly string[], value: ConstructValue): ConstructReader {
	return (reader, index) => {
		const end = reader.phrase(index, pick(reader.language));
		return end === undefined ? undefined : [end, value];
	};
}

function intervalOf(minutes: number): ConstructValue {
	return minutes % 60 === 0
		? { type: "interval", every: minutes / 60, unit: "hour" }
		: { type: "interval", every: minutes, unit: "minute" };
}

/** UTC/GMT, "<city> time", or "hora de <city>": the zone must then match the model's. */
function readZone(reader: TokenReader, index: number): Hit | undefined {
	const word = reader.word(index);
	if (word === "utc" || word === "gmt")
		return [index + 1, { type: "zone", zone: canonicalCalendarTimeZone(word.toUpperCase()) }];
	const before = reader.phrase(index, reader.language.zoneBefore);
	if (before !== undefined) {
		const city = readCity(reader, reader.skip(before, reader.language.connectors));
		return city && [city[0], { type: "zone", zone: city[1] }];
	}
	const city = readCity(reader, index);
	const after = city && reader.phrase(city[0], reader.language.zoneAfter);
	return city && after !== undefined ? [after, { type: "zone", zone: city[1] }] : undefined;
}

let cityZoneTable: ReadonlyMap<string, string> | undefined;

function cityZones(): ReadonlyMap<string, string> {
	if (!cityZoneTable) {
		const table = new Map<string, string>();
		for (const zone of Intl.supportedValuesOf("timeZone")) {
			if (zone.startsWith("Etc/")) continue;
			const name = foldedWords(zone.split("/").at(-1)!.replace(/_/gu, " ")).join(" ");
			if (name.length > 0 && !table.has(name)) table.set(name, canonicalCalendarTimeZone(zone));
		}
		cityZoneTable = table;
	}
	return cityZoneTable;
}

function readCity(reader: TokenReader, index: number): readonly [number, string] | undefined {
	for (let length = 4; length >= 1; length--) {
		const words: string[] = [];
		for (let offset = 0; offset < length; offset++) words.push(reader.word(index + offset) ?? "\0");
		const zone = cityZones().get(words.join(" "));
		if (zone !== undefined) return [index + length, zone];
	}
	return undefined;
}

/** Wordings the host cannot compile faithfully; each refuses wherever the excerpt's sentence holds it. */
function readRefusal(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const listed = reader.phrase(index, language.refusalWords) ?? reader.phrase(index, language.everyOther);
	if (listed !== undefined) return [listed, REFUSAL];
	const marker = reader.phrase(index, language.intervalMarkers);
	const marked = marker === undefined ? undefined : reader.token(marker);
	if (
		marker !== undefined &&
		(marked?.kind === "clock" ||
			(marked?.kind === "hclock" && !marked.text.endsWith("h")) ||
			(marked?.kind === "number" && (reader.word(marker + 1) === "am" || reader.word(marker + 1) === "pm")))
	)
		return [marker + 1, REFUSAL];
	const word = reader.word(index) ?? "";
	if (language.ordinals.includes(word)) {
		const day = readDayItem(reader, index + 1);
		if (day) return [day === "refuse" ? index + 2 : day.end, REFUSAL];
	}
	if (language.nth.includes(word) && language.nthNouns.includes(reader.word(index + 1) ?? ""))
		return [index + 2, REFUSAL];
	if (language.last.includes(word)) {
		const after = reader.phrase(index + 1, language.dayWords) ?? readDayItem(reader, index + 1);
		if (after !== undefined && after !== "refuse") return [typeof after === "number" ? after : after.end, REFUSAL];
	}
	if (language.until.includes(word) || language.bounds.includes(word) || language.within.includes(word)) {
		const at = reader.skip(index + 1, language.connectors);
		const month = language.months.has(reader.word(at) ?? "") ? at + 1 : undefined;
		const timing = language.within.includes(word) ? undefined : readConstruct(reader, at, TIMING_READERS);
		if (month !== undefined || timing) return [Math.max(month ?? 0, timing?.[0] ?? 0), REFUSAL];
	}
	const count = reader.number(index);
	if (count && language.times.includes(reader.word(count[0]) ?? "")) return [count[0] + 1, REFUSAL];
	const before = language.fractionWords.includes(word) ? index + 1 : count?.[0];
	if (before !== undefined && language.pastTo.includes(reader.word(before) ?? "")) {
		const after = reader.number(reader.skip(before + 1, language.connectors));
		if (after) return [after[0], REFUSAL];
	}
	return undefined;
}

const readEvent = phraseReader((language) => language.eventMarkers, { type: "event" });
const readAllWeek = phraseReader((language) => language.allWeek, { type: "allWeek" });
const readDaily = phraseReader((language) => language.daily, { type: "daily" });
const readWeekly = phraseReader((language) => language.weekly, { type: "weekly" });
const readMonthly = phraseReader((language) => language.monthly, { type: "monthly" });

/** "every 15th", "todo dia 15", "cada día 15": a day of every month. */
function readMonthDay(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const marker = reader.phrase(index, language.monthDayMarkers);
	if (marker === undefined) return undefined;
	const first = reader.phrase(marker, language.first);
	const day =
		reader.ordinalDay(marker) ??
		(language.bareMonthDay ? (reader.number(marker) ?? (first === undefined ? undefined : [first, 1])) : undefined);
	return day && day[1] >= 1 && day[1] <= 31 ? [day[0], { type: "monthDay", day: day[1] }] : undefined;
}

function readMarkedDays(reader: TokenReader, index: number): Hit | undefined {
	const marker = reader.phrase(index, reader.language.dayMarkers);
	const days = marker === undefined ? undefined : readDayList(reader, marker);
	if (!days || marker === undefined) return undefined;
	return days === "refuse" ? [marker + 1, REFUSAL] : [days.end, { type: "days", days: days.days, recurring: true }];
}

function readDays(reader: TokenReader, index: number): Hit | undefined {
	const days = readDayList(reader, index);
	if (!days) return undefined;
	return days === "refuse"
		? [index + 1, REFUSAL]
		: [days.end, { type: "days", days: days.days, recurring: days.recurring }];
}

interface DayItem {
	readonly end: number;
	readonly days: readonly number[];
	/** Plural names, plural groups and ranges recur on their own; a single name needs a recurrence marker. */
	readonly recurring: boolean;
}

/** Day items joined by "and", "e", "y", commas or ampersands. */
function readDayList(reader: TokenReader, index: number): DayItem | "refuse" | undefined {
	const first = readDayItem(reader, index);
	if (!first || first === "refuse") return first;
	const days = new Set(first.days);
	let recurring = first.recurring;
	let end = first.end;
	for (;;) {
		const next = reader.token(end);
		if (!next) break;
		const joined = reader.language.listJoin.includes(next.text);
		if (!joined && !/^[,&/]$/u.test(next.gap)) break;
		const item = readDayItem(reader, joined ? end + 1 : end);
		if (item === "refuse") return item;
		if (!item) break;
		for (const day of item.days) days.add(day);
		recurring ||= item.recurring;
		end = item.end;
	}
	return { end, days: [...days].sort((left, right) => left - right), recurring };
}

function readDayItem(reader: TokenReader, index: number): DayItem | "refuse" | undefined {
	const language = reader.language;
	const group = reader.entry(index, language.dayGroups);
	if (group) return { end: group[0], days: group[1][0], recurring: group[1][1] };
	const from = reader.phrase(index, language.rangeFrom);
	const start = readWeekday(reader, from ?? index);
	if (!start || start === "refuse") return from === undefined ? start : undefined;
	const to =
		reader.phrase(start.end, language.rangeTo) ??
		(/^[-–—]$/u.test(reader.token(start.end)?.gap ?? "") ? start.end : undefined);
	const stop = to === undefined ? undefined : readWeekday(reader, to);
	if (stop === "refuse") return stop;
	if (stop) {
		const days: number[] = [];
		for (let day = start.day; ; day = (day + 1) % 7) {
			days.push(day);
			if (day === stop.day) break;
		}
		return { end: stop.end, days, recurring: true };
	}
	return from === undefined ? { end: start.end, days: [start.day], recurring: start.plural } : undefined;
}

function readWeekday(
	reader: TokenReader,
	index: number,
): { readonly end: number; readonly day: number; readonly plural: boolean } | "refuse" | undefined {
	const language = reader.language;
	const word = reader.word(index) ?? "";
	const entry = language.weekdays.get(word);
	if (!entry) return undefined;
	let end = index + 1;
	let plural = entry[1];
	const suffix = reader.word(end);
	if (suffix !== undefined && language.weekdaySuffixes.includes(suffix)) {
		end++;
		plural ||= suffix.endsWith("s");
	}
	// Portuguese "segunda vez", "quinta semana": an ordinal, not a weekday.
	if (language.nth.includes(word) && language.nthNouns.includes(reader.word(end) ?? "")) return "refuse";
	return { end, day: entry[0], plural };
}

const readPartCadence: ConstructReader = (reader, index) => {
	const hit = reader.entry(index, reader.language.partCadence);
	return hit && [hit[0], { type: "partCadence", part: hit[1] }];
};

function readInterval(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const marker = reader.phrase(index, language.intervalMarkers);
	if (marker === undefined) return undefined;
	const fraction = reader.entry(marker, language.fractions);
	if (fraction) return [fraction[0], intervalOf(fraction[1])];
	const token = reader.token(marker);
	if (token?.kind === "hclock" && token.text.endsWith("h")) {
		const hours = Number(token.text.slice(0, -1));
		return [marker + 1, hours >= 1 ? { type: "interval", every: hours, unit: "hour" } : REFUSAL];
	}
	const count = reader.number(marker);
	const at = count ? count[0] : marker;
	const word = reader.word(at);
	if (word === undefined || !language.units.has(word)) return undefined;
	const unit = language.units.get(word);
	const every = count ? count[1] : 1;
	if (!unit || every < 1 || every > 10_000) return [at + 1, REFUSAL];
	return [at + 1, { type: "interval", every, unit }];
}

const readBareInterval: ConstructReader = (reader, index) => {
	const hit = reader.entry(index, reader.language.bareIntervals);
	return hit && [hit[0], intervalOf(hit[1])];
};

const readTodayPart: ConstructReader = (reader, index) => {
	const hit = reader.entry(index, reader.language.todayParts);
	return hit && [hit[0], { type: "todayPart", part: hit[1] }];
};

function readPart(reader: TokenReader, index: number): Hit | undefined {
	const hit = reader.entry(index, reader.language.parts);
	if (hit) return [hit[0], { type: "part", part: hit[1][0], recurring: hit[1][1], lunch: false }];
	const lunch = reader.phrase(index, reader.language.lunch);
	return lunch === undefined ? undefined : [lunch, { type: "part", part: "noon", recurring: false, lunch: true }];
}

/**
 * A stated clock: a marker ("at", "às", "a las") or a meridiem is needed for a plain number; `9:30`, `9h` and the
 * noon and midnight words stand alone. Hours past 23, minutes past 59 and Spanish "menos" refuse.
 */
function readClock(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const marked = reader.phrase(index, language.clockMarkers);
	const core = marked ?? index;
	const named = reader.entry(core, language.namedClocks);
	if (named) return [named[0], { type: "clock", hour: named[1][0], minute: 0, exact: true, noon: named[1][1], core }];
	const token = reader.token(core);
	if (!token) return undefined;
	let hour: number;
	let minute = 0;
	let end = core + 1;
	let exact = false;
	let needsMarker = false;
	if (token.kind === "clock" || token.kind === "hclock") {
		const [hours = "", minutes = ""] = token.text.split(/[:h]/u);
		hour = Number(hours);
		minute = minutes === "" ? 0 : Number(minutes);
		exact = token.kind === "hclock" || hours.startsWith("0");
	} else {
		const count = reader.number(core);
		if (!count) return undefined;
		[end, hour] = count;
		needsMarker = true;
		exact = token.kind === "number" && token.text.length === 2 && token.text.startsWith("0");
		const namedMinute = reader.entry(end, language.namedMinutes);
		const joined = language.minuteJoin.includes(reader.word(end) ?? "") ? reader.number(end + 1) : undefined;
		if (namedMinute) [end, minute] = namedMinute;
		else if (joined) [end, minute] = joined;
		const hours = reader.phrase(end, language.hourWords);
		if (hours !== undefined && marked !== undefined) end = hours;
	}
	const suffix = reader.phrase(end, language.clockSuffixes);
	if (suffix !== undefined) end = suffix;
	const meridiem = reader.word(end);
	const stated = meridiem === "am" || meridiem === "pm";
	if (stated) end++;
	if (needsMarker && marked === undefined && !stated && suffix === undefined) return undefined;
	if (language.clockMinus.includes(reader.word(end) ?? ""))
		return [end + 2 <= reader.end ? end + 2 : end + 1, REFUSAL];
	if (minute > 59) return [end, REFUSAL];
	if (stated) {
		if (hour < 1 || hour > 12) return [end, REFUSAL];
		return [
			end,
			{ type: "clock", hour: (hour % 12) + (meridiem === "pm" ? 12 : 0), minute, exact: true, noon: false, core },
		];
	}
	if (hour > 23) return [end, REFUSAL];
	exact ||= hour === 0 || hour >= 13;
	return [end, { type: "clock", hour, minute, exact, noon: false, core }];
}

/** today, tomorrow, a day of the month with or without its month. */
function readDate(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const today = reader.phrase(index, language.today);
	if (today !== undefined) return [today, { type: "date", date: { kind: "today" } }];
	const tomorrow = reader.phrase(index, language.tomorrow);
	if (tomorrow !== undefined) return [tomorrow, { type: "date", date: { kind: "tomorrow" } }];
	const day = readDayNumber(reader, index);
	if (day) {
		const month = readMonthAfter(reader, day[0]);
		return dateHit(month?.[0] ?? day[0], day[1], month?.[1]);
	}
	const month = language.months.get(reader.word(index) ?? "");
	if (month === undefined) return undefined;
	const at = reader.skip(index + 1, language.connectors);
	const number = reader.ordinalDay(at) ?? reader.number(at);
	return number && dateHit(number[0], number[1], month);
}

function readDayNumber(reader: TokenReader, index: number): readonly [number, number] | undefined {
	const language = reader.language;
	const firstAt = (at: number) => {
		const end = reader.phrase(at, language.first);
		return end === undefined ? undefined : ([end, 1] as const);
	};
	const dayWord = reader.phrase(index, language.dayWords);
	if (dayWord !== undefined) return reader.number(dayWord) ?? firstAt(dayWord);
	const first = firstAt(index);
	if (first) {
		const dayAfter = reader.phrase(first[0], language.dayWords);
		if (dayAfter !== undefined) return [dayAfter, 1];
		return language.ofWords.includes(reader.word(first[0]) ?? "") ? first : undefined;
	}
	const the = reader.phrase(index, language.theWords);
	if (the !== undefined) return reader.ordinalDay(the) ?? reader.number(the) ?? firstAt(the);
	const ordinal = reader.ordinalDay(index);
	if (ordinal) return ordinal;
	const number = reader.number(index);
	return number && readMonthAfter(reader, number[0]) ? number : undefined;
}

function readMonthAfter(reader: TokenReader, index: number): readonly [number, number] | undefined {
	const at = reader.skip(index, reader.language.ofWords);
	const month = reader.language.months.get(reader.word(at) ?? "");
	return month === undefined ? undefined : [at + 1, month];
}

function dateHit(end: number, day: number, month: number | undefined): Hit | undefined {
	if (day < 1 || day > 31) return undefined;
	if (month !== undefined && day > new Date(Date.UTC(2024, month, 0)).getUTCDate()) return [end, REFUSAL];
	return [end, { type: "date", date: month === undefined ? { kind: "day", day } : { kind: "day", day, month } }];
}

/** Every reader that yields timing, in the order tried at each position. */
const TIMING_READERS: readonly ConstructReader[] = [
	readAllWeek,
	readMonthDay,
	readMarkedDays,
	readPartCadence,
	readDaily,
	readWeekly,
	readMonthly,
	readInterval,
	readBareInterval,
	readDays,
	readTodayPart,
	readPart,
	readClock,
	readDate,
];
const CONSTRUCT_READERS: readonly ConstructReader[] = [readZone, readEvent, readRefusal, ...TIMING_READERS];

// ---------------------------------------------------------------------------------------------------------------
// Derivation

interface Timed {
	readonly clock?: ClockValue & { readonly end: number };
	readonly part?: PartOfDay;
	readonly lunch: boolean;
}

type Derived =
	| { readonly kind: "interval"; readonly every: number; readonly unit: IntervalUnit }
	| (Timed & { readonly kind: "monthly"; readonly day: number })
	| (Timed & { readonly kind: "daily"; readonly days: readonly number[] | "loose" })
	| (Timed & { readonly kind: "once"; readonly date: DateRef });

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const;

/** The schedule the excerpt's constructs state, each slot from exactly one construct; any conflict refuses. */
function derive(constructs: readonly Construct[]): Derived | undefined {
	let interval: Extract<Construct, { type: "interval" }> | undefined;
	let clock: Extract<Construct, { type: "clock" }> | undefined;
	let part: PartOfDay | undefined;
	let lunch = false;
	let days: Extract<Construct, { type: "days" }> | undefined;
	let date: DateRef | undefined;
	let monthDay: number | undefined;
	let daily = false;
	let allWeek = false;
	let weekly = false;
	let monthly = false;
	let recurring = false;
	for (const construct of constructs) {
		switch (construct.type) {
			case "refusal":
			case "event":
			case "zone":
				return undefined;
			case "interval":
				if (interval) return undefined;
				interval = construct;
				break;
			case "clock":
				if (clock) return undefined;
				clock = construct;
				break;
			case "part":
			case "partCadence":
			case "todayPart":
				if (part !== undefined && part !== construct.part) return undefined;
				part = construct.part;
				recurring ||= construct.type === "partCadence" || (construct.type === "part" && construct.recurring);
				lunch ||= construct.type === "part" && construct.lunch;
				if (construct.type === "todayPart") {
					if (date) return undefined;
					date = { kind: "today" };
				}
				break;
			case "days":
				if (days) return undefined;
				days = construct;
				break;
			case "date":
				if (date) return undefined;
				date = construct.date;
				break;
			case "monthDay":
				if (monthDay !== undefined) return undefined;
				monthDay = construct.day;
				break;
			case "daily":
				daily = true;
				break;
			case "allWeek":
				allWeek = true;
				break;
			case "weekly":
				weekly = true;
				break;
			case "monthly":
				monthly = true;
				break;
		}
	}
	const timed: Timed = { ...(clock ? { clock } : {}), ...(part === undefined ? {} : { part }), lunch };
	if (interval)
		return constructs.length === 1 ? { kind: "interval", every: interval.every, unit: interval.unit } : undefined;
	if (monthly || monthDay !== undefined) {
		if (days || daily || allWeek || weekly || recurring) return undefined;
		if (monthDay !== undefined) return date ? undefined : { ...timed, kind: "monthly", day: monthDay };
		return date?.kind === "day" && date.month === undefined
			? { ...timed, kind: "monthly", day: date.day }
			: undefined;
	}
	if (daily || allWeek || recurring || days?.recurring || (weekly && days)) {
		if (date || (days && (daily || allWeek)) || (weekly && !days)) return undefined;
		return { ...timed, kind: "daily", days: allWeek ? EVERY_DAY : (days?.days ?? "loose") };
	}
	if (weekly) return constructs.length === 1 ? { kind: "interval", every: 1, unit: "week" } : undefined;
	if (days)
		return date || days.days.length !== 1
			? undefined
			: { ...timed, kind: "once", date: { kind: "weekday", day: days.days[0]! } };
	if (date) return { ...timed, kind: "once", date };
	return clock ? { ...timed, kind: "once", date: { kind: "today" } } : undefined;
}

interface ResolvedClock {
	readonly hour: number;
	readonly minute: number;
	/** The `HH:MM` values a model `time` slot may carry for this clock; empty when no clock was stated. */
	readonly readings: readonly string[];
	readonly defaults: readonly string[];
}

/**
 * The hour: an exact clock as stated (a part of the day that contradicts it refuses); an hour without am or pm read
 * through a stated part of the day, else on a 24-hour clock with the choice announced; a part of the day alone at its
 * fixed hour; nothing at 09:00, announced.
 */
function resolveClock(
	derived: Exclude<Derived, { kind: "interval" }>,
	tokens: readonly Token[],
	text: string,
): ResolvedClock | undefined {
	const { clock, part } = derived;
	const stamp = (hour: number, minute: number) => `${pad(hour)}:${pad(minute)}`;
	if (clock) {
		const { hour, minute } = clock;
		if (clock.exact) {
			if (part !== undefined && !partHolds(part, hour)) return undefined;
			return { hour, minute, readings: [stamp(hour, minute)], defaults: [] };
		}
		if (part !== undefined) {
			const read = derived.lunch ? undefined : partReading(part, hour);
			return read === undefined ? undefined : { hour: read, minute, readings: [stamp(read, minute)], defaults: [] };
		}
		const words = text.slice(tokens[clock.core]!.start, tokens[clock.end - 1]!.end);
		return {
			hour,
			minute,
			readings: [stamp(hour, minute), stamp(hour === 12 ? 0 : hour + 12, minute)],
			defaults: [`${stamp(hour, minute)} for "${words}", as no am or pm was stated`],
		};
	}
	if (part !== undefined) {
		const hour = PART_OF_DAY_HOUR[part];
		return { hour, minute: 0, readings: [], defaults: [`${pad(hour)}:00 for "${part}"`] };
	}
	return { hour: DEFAULT_HOUR, minute: 0, readings: [], defaults: [`${pad(DEFAULT_HOUR)}:00, as no time was stated`] };
}

/** An hour from 1 to 12 read through a stated part of the day; undefined when the pair does not name one hour. */
function partReading(part: PartOfDay, hour: number): number | undefined {
	switch (part) {
		case "morning":
			return hour === 12 ? undefined : hour;
		case "afternoon":
			return hour === 12 ? 12 : hour <= 6 ? hour + 12 : undefined;
		case "evening":
			return hour >= 4 && hour <= 11 ? hour + 12 : undefined;
		case "night":
			return hour >= 6 && hour <= 11 ? hour + 12 : hour <= 5 ? hour : undefined;
		case "noon":
			return undefined;
	}
}

function partHolds(part: PartOfDay, hour: number): boolean {
	switch (part) {
		case "morning":
			return hour < 12;
		case "noon":
			return hour >= 11 && hour <= 13;
		case "afternoon":
			return hour >= 12 && hour <= 18;
		case "evening":
			return hour >= 16;
		case "night":
			return hour >= 18 || hour <= 5;
	}
}

/**
 * The cron day-of-week field of a daily request: the stated days (the model's days must match them), every day when
 * the words include the whole week, and weekdays only, announced, for a plain daily request.
 */
function intakeDays(
	stated: readonly number[] | "loose",
	model: readonly (typeof WEEKDAYS)[number][] | undefined,
): { field: string; label: string; defaults: readonly string[] } | undefined {
	const indices = model?.map((day) => WEEKDAYS.indexOf(day)).sort((left, right) => left - right);
	if (stated === "loose") {
		if (indices !== undefined && indices.length !== 7) return undefined;
		return { field: "1-5", label: "weekdays", defaults: ["weekdays only, as no days were stated"] };
	}
	if (indices !== undefined && indices.join(",") !== stated.join(",")) return undefined;
	const key = stated.join(",");
	if (key === "0,1,2,3,4,5,6") return { field: "*", label: "every day", defaults: [] };
	if (key === "1,2,3,4,5") return { field: "1-5", label: "weekdays", defaults: [] };
	if (key === "0,6") return { field: "0,6", label: "weekends", defaults: [] };
	return { field: key, label: `every ${stated.map((day) => WEEKDAY_NAMES[day]).join(", ")}`, defaults: [] };
}

/**
 * The routine's zone: a zone the words state ("UTC", "Lisbon time") must be the model's, which may also name a zone
 * whose city the excerpt carries; otherwise the host's zone.
 */
function intakeZone(
	stated: string | undefined,
	zones: readonly Construct[],
	tokens: readonly Token[],
	span: TokenSpan,
	hostZone: string,
): string | undefined {
	const named = new Set(zones.flatMap((construct) => (construct.type === "zone" ? [construct.zone] : [])));
	if (named.size > 1) return undefined;
	const [word] = named;
	if (stated === undefined) return word ?? hostZone;
	let zone: string;
	try {
		zone = canonicalCalendarTimeZone(stated);
	} catch {
		return undefined;
	}
	if (word !== undefined) return zone === word ? zone : undefined;
	const names = [zone, zone.split("/").at(-1)!].map((name) => foldedWords(name.replace(/_/gu, " ")).join(" "));
	return names.some((name) => name.length > 0 && spanHas(tokens, span, name)) ? zone : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// Dates

interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

/**
 * The date of a one-time request, read from the day the owner sent it: today, tomorrow, the next named weekday one to
 * six days ahead (the sent weekday itself is ambiguous and refuses), the next day of that number within 31 days, or a
 * day of a named month this year or, once passed, next year.
 */
function onceDate(ref: DateRef, sent: CalendarDate): CalendarDate | undefined {
	switch (ref.kind) {
		case "today":
			return sent;
		case "tomorrow":
			return shiftDate(sent, 1);
		case "weekday": {
			const ahead = (ref.day - new Date(Date.UTC(sent.year, sent.month - 1, sent.day)).getUTCDay() + 7) % 7;
			return ahead === 0 ? undefined : shiftDate(sent, ahead);
		}
		case "day": {
			if (ref.month === undefined) {
				for (let ahead = 0; ahead <= 31; ahead++) {
					const date = shiftDate(sent, ahead);
					if (date.day === ref.day) return date;
				}
				return undefined;
			}
			const thisYear = validDate(sent.year, ref.month, ref.day);
			if (thisYear && isoDate(thisYear) >= isoDate(sent)) return thisYear;
			return validDate(sent.year + 1, ref.month, ref.day);
		}
	}
}

function shiftDate(date: CalendarDate, days: number): CalendarDate {
	const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
	return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function validDate(year: number, month: number, day: number): CalendarDate | undefined {
	const check = new Date(Date.UTC(year, month - 1, day));
	return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
		? { year, month, day }
		: undefined;
}

function isoDate(date: CalendarDate): string {
	return `${String(date.year).padStart(4, "0")}-${pad(date.month)}-${pad(date.day)}`;
}

/** `YYYY-MM-DD HH:MM` on a 24-hour clock in the zone. */
function localStamp(instant: number, zone: string): string {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(instant);
	const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

function localDate(instant: number, zone: string): CalendarDate {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: zone,
		year: "numeric",
		month: "numeric",
		day: "numeric",
	}).formatToParts(instant);
	const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value);
	return { year: part("year"), month: part("month"), day: part("day") };
}

function sameDate(left: CalendarDate, right: CalendarDate): boolean {
	return left.year === right.year && left.month === right.month && left.day === right.day;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

// ---------------------------------------------------------------------------------------------------------------
// Language tables (accents removed, lowercase). Each construct is read with one language's table only; digits, clock
// forms, am/pm and zones are shared.

type CiOutcome = Exclude<CiTerminalConclusion, "startup_failure"> | "finish";

interface Language {
	readonly numbers: ReadonlyMap<string, number>;
	readonly conjunctions: readonly string[];
	readonly weekdays: ReadonlyMap<string, readonly [day: number, plural: boolean]>;
	readonly weekdaySuffixes: readonly string[];
	readonly dayGroups: readonly (readonly [string, readonly [days: readonly number[], plural: boolean]])[];
	readonly rangeFrom: readonly string[];
	readonly rangeTo: readonly string[];
	readonly listJoin: readonly string[];
	readonly dayMarkers: readonly string[];
	readonly parts: readonly (readonly [string, readonly [PartOfDay, plural: boolean]])[];
	readonly lunch: readonly string[];
	readonly partCadence: readonly (readonly [string, PartOfDay])[];
	readonly todayParts: readonly (readonly [string, PartOfDay])[];
	readonly allWeek: readonly string[];
	readonly daily: readonly string[];
	readonly weekly: readonly string[];
	readonly monthly: readonly string[];
	readonly intervalMarkers: readonly string[];
	/** Interval units; null marks a unit the host cannot schedule, which refuses. */
	readonly units: ReadonlyMap<string, IntervalUnit | null>;
	/** Interval fractions after a marker, in minutes ("half an hour"). */
	readonly fractions: readonly (readonly [string, number])[];
	/** Intervals without a marker, in minutes ("hourly"). */
	readonly bareIntervals: readonly (readonly [string, number])[];
	readonly monthDayMarkers: readonly string[];
	/** Whether a month-day marker takes a plain number ("todo dia 15"), not only an ordinal ("every 15th"). */
	readonly bareMonthDay: boolean;
	readonly ordinalSuffixes: readonly string[];
	readonly first: readonly string[];
	readonly dayWords: readonly string[];
	readonly ofWords: readonly string[];
	readonly theWords: readonly string[];
	readonly months: ReadonlyMap<string, number>;
	readonly today: readonly string[];
	readonly tomorrow: readonly string[];
	readonly clockMarkers: readonly string[];
	/** Words that make a plain number a clock without a marker ("o'clock"). */
	readonly clockSuffixes: readonly string[];
	/** Hour words after a marked number ("às 9 horas"). */
	readonly hourWords: readonly string[];
	readonly namedClocks: readonly (readonly [string, readonly [hour: number, noon: boolean]])[];
	readonly minuteJoin: readonly string[];
	readonly namedMinutes: readonly (readonly [string, number])[];
	readonly clockMinus: readonly string[];
	readonly refusalWords: readonly string[];
	readonly everyOther: readonly string[];
	/** Before a weekday: an ordinal or relative week ("first Monday", "next Friday"), which refuses. */
	readonly ordinals: readonly string[];
	readonly nth: readonly string[];
	readonly nthNouns: readonly string[];
	readonly last: readonly string[];
	readonly until: readonly string[];
	readonly bounds: readonly string[];
	readonly within: readonly string[];
	readonly times: readonly string[];
	readonly fractionWords: readonly string[];
	readonly pastTo: readonly string[];
	readonly connectors: readonly string[];
	readonly eventMarkers: readonly string[];
	readonly zoneBefore: readonly string[];
	readonly zoneAfter: readonly string[];
	/** Timing words beyond the number, weekday, unit, month and date tables. */
	readonly anchors: readonly string[];
	readonly ciSubjects: readonly string[];
	readonly outcomes: Readonly<Record<CiOutcome, readonly string[]>>;
}

const list = (phrases: string): readonly string[] => phrases.split("|");
const WORKWEEK = [1, 2, 3, 4, 5] as const;
const WEEKEND = [0, 6] as const;

function weekdayTable(...days: readonly string[]): ReadonlyMap<string, readonly [number, boolean]> {
	const table = new Map<string, readonly [number, boolean]>();
	for (const [day, names] of days.entries()) {
		const [singular = "", plural = ""] = names.split(" ");
		for (const name of list(singular)) table.set(name, [day, false]);
		if (plural) for (const name of list(plural)) table.set(name, [day, true]);
	}
	return table;
}

function groupTable(
	workweek: string,
	workweekPlural: string,
	weekend: string,
	weekendPlural: string,
): readonly (readonly [string, readonly [readonly number[], boolean]])[] {
	return [
		...list(workweek).map((phrase) => [phrase, [WORKWEEK, false]] as const),
		...list(workweekPlural).map((phrase) => [phrase, [WORKWEEK, true]] as const),
		...list(weekend).map((phrase) => [phrase, [WEEKEND, false]] as const),
		...list(weekendPlural).map((phrase) => [phrase, [WEEKEND, true]] as const),
	];
}

function partTable(entries: Readonly<Partial<Record<PartOfDay, string>>>, plural: boolean) {
	return Object.entries(entries).flatMap(([part, phrases]) =>
		list(phrases ?? "").map((phrase) => [phrase, [part as PartOfDay, plural]] as const),
	);
}

function partList(entries: Readonly<Partial<Record<PartOfDay, string>>>): readonly (readonly [string, PartOfDay])[] {
	return Object.entries(entries).flatMap(([part, phrases]) =>
		list(phrases ?? "").map((phrase) => [phrase, part as PartOfDay] as const),
	);
}

function monthTable(...months: readonly string[]): ReadonlyMap<string, number> {
	return new Map(months.flatMap((names, index) => list(names).map((name) => [name, index + 1] as const)));
}

function unitTable(units: Readonly<Record<IntervalUnit | "refuse", string>>): ReadonlyMap<string, IntervalUnit | null> {
	return new Map(
		Object.entries(units).flatMap(([unit, words]) =>
			list(words).map((word) => [word, unit === "refuse" ? null : (unit as IntervalUnit)] as const),
		),
	);
}

const ENGLISH: Language = {
	numbers: new Map(
		Object.entries({
			one: 1,
			two: 2,
			three: 3,
			four: 4,
			five: 5,
			six: 6,
			seven: 7,
			eight: 8,
			nine: 9,
			ten: 10,
			eleven: 11,
			twelve: 12,
			thirteen: 13,
			fourteen: 14,
			fifteen: 15,
			sixteen: 16,
			seventeen: 17,
			eighteen: 18,
			nineteen: 19,
			twenty: 20,
			thirty: 30,
			forty: 40,
			fifty: 50,
			sixty: 60,
		}),
	),
	conjunctions: list("and"),
	weekdays: weekdayTable(
		"sunday sundays",
		"monday mondays",
		"tuesday tuesdays",
		"wednesday wednesdays",
		"thursday thursdays",
		"friday fridays",
		"saturday saturdays",
	),
	weekdaySuffixes: [],
	dayGroups: groupTable(
		"weekday|workday|work day|working day|business day",
		"weekdays|workdays|work days|working days|business days",
		"weekend",
		"weekends",
	),
	rangeFrom: list("from"),
	rangeTo: list("to|through|thru"),
	listJoin: list("and"),
	dayMarkers: list("every|each"),
	parts: [
		...partTable({ morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }, false),
		...partTable(
			{ morning: "mornings", afternoon: "afternoons", evening: "evenings", night: "nights|nightly" },
			true,
		),
	],
	lunch: list("lunchtime|lunch time"),
	partCadence: partList({
		morning: "every morning|each morning",
		afternoon: "every afternoon|each afternoon",
		evening: "every evening|each evening",
		night: "every night|each night",
	}),
	todayParts: partList({
		morning: "this morning",
		afternoon: "this afternoon",
		evening: "this evening",
		night: "tonight",
	}),
	allWeek: list("every single day|including weekends|including the weekend|7 days a week|seven days a week|all week"),
	daily: list("every day|each day|daily|everyday|once a day|once per day|once daily"),
	weekly: list("every week|each week|weekly|once a week|once per week"),
	monthly: list(
		"of every month|of each month|of the month|every month|each month|monthly|once a month|once per month",
	),
	intervalMarkers: list("every|each"),
	units: unitTable({
		minute: "minute|minutes|min|mins",
		hour: "hour|hours|hr|hrs",
		day: "day|days",
		week: "week|weeks",
		refuse: "second|seconds|sec|secs|month|months|year|years",
	}),
	fractions: [
		["half hour", 30],
		["half an hour", 30],
		["quarter hour", 15],
		["quarter of an hour", 15],
	],
	bareIntervals: [
		["hourly", 60],
		["half hourly", 30],
		["once an hour", 60],
		["once per hour", 60],
	],
	monthDayMarkers: list("every|each"),
	bareMonthDay: false,
	ordinalSuffixes: list("st|nd|rd|th"),
	first: list("first"),
	dayWords: list("day"),
	ofWords: list("of"),
	// "the 2" is ordinary English ("the 2 open PRs"); an English day number needs an ordinal suffix or "day".
	theWords: [],
	months: monthTable(
		"january",
		"february",
		"march",
		"april",
		"may",
		"june",
		"july",
		"august",
		"september",
		"october",
		"november",
		"december",
	),
	today: list("today"),
	tomorrow: list("tomorrow"),
	clockMarkers: list("at"),
	clockSuffixes: list("o clock"),
	hourWords: [],
	namedClocks: [
		["noon", [12, true]],
		["midday", [12, true]],
		["midnight", [0, false]],
	],
	minuteJoin: [],
	namedMinutes: [],
	clockMinus: [],
	refusalWords: list(
		"except|excluding|twice|thrice|yearly|annually|quarterly|biweekly|fortnightly|bimonthly|semiannually|semimonthly|day after tomorrow",
	),
	everyOther: list("every other|each other"),
	ordinals: list("first|second|third|fourth|fifth|last|next|this|coming|following"),
	nth: list("first|second|third|fourth|fifth"),
	nthNouns: list("week|month"),
	last: list("last"),
	until: list("until|till|til"),
	bounds: list("before|after|by"),
	within: list("in|during|throughout"),
	times: list("times"),
	fractionWords: list("half|quarter"),
	pastTo: list("past|to"),
	connectors: list("the|of|on"),
	eventMarkers: list("every time|each time|whenever|next time"),
	zoneBefore: [],
	zoneAfter: list("time|timezone"),
	anchors: list(
		"every|each|daily|everyday|hourly|weekly|monthly|nightly|tonight|noon|midday|midnight|lunchtime|am|pm|clock|past|half|quarter|other|first|second|third|fourth|fifth|last|next|except|excluding|twice|thrice|yearly|annually|quarterly|biweekly|fortnightly|weekday|weekdays|weekend|weekends|workday|workdays|business|working|morning|mornings|afternoon|afternoons|evening|evenings|night|nights|utc|gmt",
	),
	ciSubjects: list("ci|build|builds|pipeline|pipelines|workflow|workflows|job|jobs|checks|actions|test|tests"),
	outcomes: {
		failure: list("fail|fails|failed|failing|failure|failures|break|breaks|broke|broken|red"),
		success: list("pass|passes|passed|passing|succeed|succeeds|succeeded|success|successful|successfully|green"),
		cancelled: list("cancel|cancels|cancelled|canceled|cancelling|canceling|cancellation"),
		timed_out: list("time out|timed out|times out|timeout|timeouts|expire|expires|expired"),
		skipped: list("skip|skips|skipped"),
		neutral: list("neutral"),
		action_required: list("action required|requires action|needs action"),
		stale: list("stale"),
		finish: list(
			"finish|finishes|finished|finishing|complete|completes|completed|completing|end|ends|ended|done|conclude|concludes|concluded",
		),
	},
};

const PORTUGUESE: Language = {
	numbers: new Map(
		Object.entries({
			um: 1,
			uma: 1,
			dois: 2,
			duas: 2,
			tres: 3,
			quatro: 4,
			cinco: 5,
			seis: 6,
			sete: 7,
			oito: 8,
			nove: 9,
			dez: 10,
			onze: 11,
			doze: 12,
			treze: 13,
			catorze: 14,
			quatorze: 14,
			quinze: 15,
			dezesseis: 16,
			dezasseis: 16,
			dezessete: 17,
			dezassete: 17,
			dezoito: 18,
			dezenove: 19,
			dezanove: 19,
			vinte: 20,
			trinta: 30,
			quarenta: 40,
			cinquenta: 50,
			sessenta: 60,
		}),
	),
	conjunctions: list("e"),
	weekdays: weekdayTable(
		"domingo domingos",
		"segunda segundas",
		"terca tercas",
		"quarta quartas",
		"quinta quintas",
		"sexta sextas",
		"sabado sabados",
	),
	weekdaySuffixes: list("feira|feiras"),
	dayGroups: groupTable(
		"dia util|dia de semana",
		"dias uteis|dias de semana",
		"fim de semana|final de semana",
		"fins de semana|finais de semana",
	),
	rangeFrom: list("de|da|desde"),
	rangeTo: list("a|ate"),
	listJoin: list("e"),
	dayMarkers: list("todas as|todos os|toda|todo|a cada|cada"),
	parts: [
		...partTable(
			{ morning: "manha", afternoon: "tarde", evening: "fim de tarde|fim da tarde", night: "noite" },
			false,
		),
		...partTable({ morning: "manhas", afternoon: "tardes", night: "noites" }, true),
	],
	lunch: list("hora do almoco"),
	partCadence: partList({
		morning: "toda manha|todas as manhas|cada manha|a cada manha",
		afternoon: "toda tarde|todas as tardes|cada tarde|a cada tarde",
		evening: "todo fim de tarde|todo fim da tarde",
		night: "toda noite|todas as noites|cada noite|a cada noite",
	}),
	todayParts: partList({
		morning: "esta manha|hoje de manha|hoje pela manha",
		afternoon: "esta tarde|hoje a tarde|hoje de tarde",
		night: "esta noite|hoje a noite|hoje de noite",
	}),
	allWeek: list(
		"todo santo dia|7 dias por semana|sete dias por semana|7 dias na semana|sete dias na semana|toda a semana|a semana toda|a semana inteira|inclusive fins de semana|inclusive nos fins de semana|incluindo fins de semana|incluindo os fins de semana|inclusive fim de semana|incluindo o fim de semana",
	),
	daily: list("todo dia|todos os dias|a cada dia|cada dia|diariamente|diario|diaria|uma vez por dia|uma vez ao dia"),
	weekly: list("toda semana|todas as semanas|a cada semana|cada semana|semanal|semanalmente|uma vez por semana"),
	monthly: list(
		"de cada mes|de todo mes|de todos os meses|do mes|todo mes|todos os meses|a cada mes|cada mes|mensal|mensalmente|uma vez por mes",
	),
	intervalMarkers: list("a cada|cada"),
	units: unitTable({
		minute: "minuto|minutos|min",
		hour: "hora|horas",
		day: "dia|dias",
		week: "semana|semanas",
		refuse: "segundo|segundos|mes|meses|ano|anos",
	}),
	fractions: [
		["meia hora", 30],
		["quarto de hora", 15],
		["um quarto de hora", 15],
	],
	bareIntervals: [
		["de hora em hora", 60],
		["de meia em meia hora", 30],
	],
	monthDayMarkers: list("todo dia|todos os dias"),
	bareMonthDay: true,
	ordinalSuffixes: list("º|ª"),
	first: list("primeiro"),
	dayWords: list("dia"),
	ofWords: list("de"),
	theWords: [],
	months: monthTable(
		"janeiro",
		"fevereiro",
		"marco",
		"abril",
		"maio",
		"junho",
		"julho",
		"agosto",
		"setembro",
		"outubro",
		"novembro",
		"dezembro",
	),
	today: list("hoje"),
	tomorrow: list("amanha"),
	clockMarkers: list("as|a|pelas|ao"),
	clockSuffixes: [],
	hourWords: list("horas|hora|h"),
	namedClocks: [
		["meio dia", [12, true]],
		["meia noite", [0, false]],
	],
	minuteJoin: list("e"),
	namedMinutes: [["e meia", 30]],
	clockMinus: [],
	refusalWords: list(
		"exceto|excluindo|salvo|menos|anual|anualmente|quinzenal|quinzenalmente|bimestral|trimestral|semestral|depois de amanha",
	),
	everyOther: list("dia sim dia nao|dia sim e dia nao|semana sim semana nao"),
	ordinals: list(
		"primeira|primeiro|terceira|ultima|ultimo|proxima|proximo|esta|este|nesta|neste|essa|esse|nessa|nesse",
	),
	nth: list("primeira|primeiro|segunda|segundo|terceira|terceiro|quarta|quarto|quinta|quinto|sexta|ultima|ultimo"),
	nthNouns: list("semana|vez|parte|quinzena|hora|mes"),
	last: list("ultimo|ultima"),
	until: list("ate"),
	bounds: list("antes|depois"),
	within: list("em|durante"),
	times: list("vezes"),
	fractionWords: [],
	pastTo: list("para"),
	connectors: list("o|a|os|as|de|da|do|das|dos|ao|aos|no|na|nos|nas|pela|pelas"),
	eventMarkers: list("toda vez|sempre que|a proxima vez|proxima vez|cada vez"),
	zoneBefore: list("hora|horario"),
	zoneAfter: [],
	anchors: list(
		"todo|toda|todos|todas|cada|diariamente|diario|diaria|semanal|semanalmente|mensal|mensalmente|anual|anualmente|quinzenal|quinzenalmente|bimestral|trimestral|semestral|meio|meia|util|uteis|fim|fins|final|finais|exceto|excluindo|salvo|menos|vez|vezes|primeiro|primeira|ultimo|ultima|proximo|proxima|feira|feiras|manha|manhas|tarde|tardes|noite|noites|utc|gmt",
	),
	ciSubjects: list("ci|build|builds|pipeline|pipelines|workflow|workflows|job|jobs|teste|testes|checks|actions"),
	outcomes: {
		failure: list(
			"falha|falhas|falhar|falhou|falharem|falhando|falho|quebra|quebrar|quebrou|quebrado|quebrada|vermelho|vermelha",
		),
		success: list("passa|passar|passou|passarem|passando|sucesso|aprovado|aprovada|aprovar|verde"),
		cancelled: list("cancelado|cancelada|cancelar|cancelou|cancelamento"),
		timed_out: list("expira|expirar|expirou|tempo esgotado|timeout"),
		skipped: list("pulado|pulada|pular|pulou|ignorado|ignorada"),
		neutral: list("neutro|neutra"),
		action_required: list("requer acao|exige acao|acao necessaria"),
		stale: [],
		finish: list(
			"termina|terminar|terminou|terminarem|conclui|concluir|concluiu|acaba|acabar|acabou|finaliza|finalizar|finalizou",
		),
	},
};

const SPANISH: Language = {
	numbers: new Map(
		Object.entries({
			un: 1,
			uno: 1,
			una: 1,
			dos: 2,
			tres: 3,
			cuatro: 4,
			cinco: 5,
			seis: 6,
			siete: 7,
			ocho: 8,
			nueve: 9,
			diez: 10,
			once: 11,
			doce: 12,
			trece: 13,
			catorce: 14,
			quince: 15,
			dieciseis: 16,
			diecisiete: 17,
			dieciocho: 18,
			diecinueve: 19,
			veinte: 20,
			veintiuno: 21,
			veintidos: 22,
			veintitres: 23,
			veinticuatro: 24,
			veinticinco: 25,
			veintiseis: 26,
			veintisiete: 27,
			veintiocho: 28,
			veintinueve: 29,
			treinta: 30,
			cuarenta: 40,
			cincuenta: 50,
			sesenta: 60,
		}),
	),
	conjunctions: list("y"),
	weekdays: weekdayTable("domingo domingos", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado sabados"),
	weekdaySuffixes: [],
	dayGroups: groupTable(
		"dia laborable|dia habil",
		"dias laborables|dias habiles|entre semana",
		"fin de semana",
		"fines de semana",
	),
	rangeFrom: list("de|del|desde"),
	rangeTo: list("a|al|hasta"),
	listJoin: list("y|e"),
	dayMarkers: list("todos los|todas las|cada|los"),
	parts: [
		...partTable({ morning: "la manana", afternoon: "tarde", night: "noche" }, false),
		...partTable({ morning: "mananas", afternoon: "tardes", night: "noches" }, true),
	],
	lunch: [],
	partCadence: partList({
		morning: "cada manana|todas las mananas",
		afternoon: "cada tarde|todas las tardes",
		night: "cada noche|todas las noches",
	}),
	todayParts: partList({ morning: "esta manana", afternoon: "esta tarde", night: "esta noche" }),
	allWeek: list(
		"toda la semana|7 dias a la semana|siete dias a la semana|incluidos los fines de semana|incluidos fines de semana|incluyendo los fines de semana|incluyendo fines de semana",
	),
	daily: list("todos los dias|cada dia|diariamente|a diario|diario|diaria|una vez al dia|una vez por dia"),
	weekly: list("cada semana|todas las semanas|semanal|semanalmente|una vez por semana|una vez a la semana"),
	monthly: list("de cada mes|del mes|cada mes|todos los meses|mensual|mensualmente|una vez al mes|una vez por mes"),
	intervalMarkers: list("cada"),
	units: unitTable({
		minute: "minuto|minutos|min",
		hour: "hora|horas",
		day: "dia|dias",
		week: "semana|semanas",
		refuse: "segundo|segundos|mes|meses|ano|anos",
	}),
	fractions: [
		["media hora", 30],
		["cuarto de hora", 15],
		["un cuarto de hora", 15],
	],
	bareIntervals: [],
	monthDayMarkers: list("cada dia|todos los dias"),
	bareMonthDay: true,
	ordinalSuffixes: list("º|ª"),
	first: list("primero|primer"),
	dayWords: list("dia"),
	ofWords: list("de|del"),
	theWords: list("el"),
	months: monthTable(
		"enero",
		"febrero",
		"marzo",
		"abril",
		"mayo",
		"junio",
		"julio",
		"agosto",
		"septiembre|setiembre",
		"octubre",
		"noviembre",
		"diciembre",
	),
	today: list("hoy"),
	tomorrow: list("manana"),
	clockMarkers: list("a las|a la|las|la"),
	clockSuffixes: list("en punto"),
	hourWords: list("horas|hora|h"),
	namedClocks: [
		["mediodia", [12, true]],
		["medianoche", [0, false]],
	],
	minuteJoin: list("y"),
	namedMinutes: [
		["y media", 30],
		["y cuarto", 15],
	],
	clockMinus: list("menos"),
	refusalWords: list(
		"excepto|salvo|excluyendo|menos|anual|anualmente|quincenal|quincenalmente|bimestral|trimestral|semestral|pasado manana",
	),
	everyOther: list("dia por medio|dia si dia no|dia si y dia no"),
	ordinals: list("primer|primero|primera|segundo|tercer|ultimo|ultima|proximo|proxima|este|esta"),
	nth: list("primera|segunda|tercera|cuarta|quinta|ultima|primer|segundo|tercer|cuarto|quinto|ultimo"),
	nthNouns: list("semana|mes"),
	last: list("ultimo|ultima"),
	until: list("hasta"),
	bounds: list("antes|despues"),
	within: list("en|durante"),
	times: list("veces"),
	fractionWords: [],
	pastTo: [],
	connectors: list("el|la|los|las|de|del|al|a"),
	eventMarkers: list("cada vez|siempre que|la proxima vez|proxima vez"),
	zoneBefore: list("hora|horario"),
	zoneAfter: [],
	anchors: list(
		"todos|todas|cada|diario|diaria|diariamente|semanal|semanalmente|mensual|mensualmente|anual|anualmente|quincenal|quincenalmente|bimestral|trimestral|semestral|mediodia|medianoche|media|cuarto|laborables|laborable|habiles|habil|fin|fines|excepto|salvo|excluyendo|menos|vez|veces|primer|primero|primera|ultimo|ultima|proximo|proxima|manana|mananas|tarde|tardes|noche|noches|utc|gmt",
	),
	ciSubjects: list("ci|build|builds|pipeline|pipelines|workflow|workflows|job|jobs|prueba|pruebas|checks|actions"),
	outcomes: {
		failure: list(
			"falla|fallas|fallar|fallo|fallan|fallido|fallida|fallando|rompe|romper|rompio|roto|rota|rojo|roja",
		),
		success: list("pasa|pasar|paso|pasan|exito|exitoso|exitosa|verde"),
		cancelled: list("cancelado|cancelada|cancelar|cancelo"),
		timed_out: list("expira|expirar|expiro|tiempo agotado|timeout"),
		skipped: list("omitido|omitida|saltado|saltada"),
		neutral: list("neutro|neutra"),
		action_required: list("requiere accion|accion requerida"),
		stale: [],
		finish: list(
			"termina|terminar|termino|terminen|concluye|concluir|concluyo|acaba|acabar|acabo|finaliza|finalizar|finalizo",
		),
	},
};

const LANGUAGES: readonly Language[] = [ENGLISH, PORTUGUESE, SPANISH];

/**
 * Words that collide with ordinary words of another table (articles, "once", "dos", "may", "marco") are read only
 * inside a construct and never demand one.
 */
const NOT_ANCHORS = new Set(["a", "an", "um", "uma", "un", "una", "once", "dos", "doce", "may", "marco"]);
const ANCHORS: ReadonlySet<string> = new Set(
	LANGUAGES.flatMap((language) => [
		...language.numbers.keys(),
		...language.weekdays.keys(),
		...language.units.keys(),
		...language.months.keys(),
		...language.today,
		...language.tomorrow,
		...language.anchors,
	]).filter((word) => !NOT_ANCHORS.has(word)),
);

/** Digits and clock forms always carry timing; words do when any table lists them as timing words. */
function isAnchor(token: Token): boolean {
	return token.kind !== "word" || ANCHORS.has(token.text);
}
