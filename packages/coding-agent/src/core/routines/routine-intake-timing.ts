/**
 * Host-owned timing of routine intake. The extraction model only fills constrained timing slots; the host checks that
 * the owner's stated timing words carry every value it was given, fills the parts the owner left open with fixed
 * defaults it announces, and compiles the executable schedule. The model never chooses an hour, a cron rule, an
 * instant or a zone.
 */
import { StringEnum } from "@caupulican/pi-ai/typebox-helpers";
import { type Static, Type } from "typebox";
import { CI_TERMINAL_CONCLUSIONS, type CiTerminalConclusion } from "../events/host-event-contract.ts";
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
type Weekday = (typeof WEEKDAYS)[number];
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

export interface IntakeTimingContext {
	/** The owner's stated (not shown) timing words, as the quote locator returned them. */
	readonly stated: string;
	/** When the owner sent the message: relative dates are read from it. */
	readonly sentAt: number;
	readonly now: number;
	readonly hostTimeZone: string;
}

/**
 * Compiles the slots when the owner's stated timing words carry every value and the cadence itself; otherwise
 * undefined, and the request is dropped before any judgment. Numbers and day names are accepted as digits or through
 * the host's small English, Portuguese and Spanish tables only.
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

function compileTimingSlots(
	timing: IntakeTiming,
	context: IntakeTimingContext,
	nextTimeOnly: boolean,
): CompiledIntakeTiming | undefined {
	const words = timingWords(context.stated);
	if (timing.kind === "interval") {
		if (!hasAny(words, UNIT_WORDS[timing.unit])) return undefined;
		if (timing.every !== 1 && !numbersIn(words).has(timing.every)) return undefined;
		return compiled(
			{ kind: "interval", intervalMs: timing.every * INTERVAL_UNIT_MS[timing.unit] },
			timing.every === 1 ? `every ${timing.unit}` : `every ${timing.every} ${timing.unit}s`,
			[],
		);
	}
	if (timing.kind === "event") return compileEvent(timing, words, nextTimeOnly);
	const zone = intakeZone(timing.timeZone, words, context.hostTimeZone);
	const clock = zone === undefined ? undefined : intakeClock(timing.time, timing.partOfDay, words);
	if (zone === undefined || clock === undefined) return undefined;
	const at = `${pad(clock.hour)}:${pad(clock.minute)}`;
	const window = clock.defaulted ? { maxLatenessMs: INTAKE_DEFAULT_LATENESS_MS } : {};
	if (timing.kind === "monthly") {
		if (!hasAny(words, MONTHLY_WORDS) || !numbersIn(words).has(timing.day)) return undefined;
		return compiled(
			{ kind: "calendar", cron: `${clock.minute} ${clock.hour} ${timing.day} * *`, timeZone: zone, ...window },
			`on day ${timing.day} of every month at ${at} (${zone})`,
			clock.defaults,
		);
	}
	if (timing.kind === "daily") {
		const days = intakeDays(timing.days, words, clock.named);
		if (!days) return undefined;
		return compiled(
			{ kind: "calendar", cron: `${clock.minute} ${clock.hour} * * ${days.field}`, timeZone: zone, ...window },
			`${days.label} at ${at} (${zone})`,
			[...clock.defaults, ...days.defaults],
		);
	}
	const date = parseDate(timing.date);
	if (!date || !dateCarried(date, words, context.sentAt, zone, clock)) return undefined;
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
		{ kind: "once", at: instant, ...(clock.defaulted ? { notAfter: instant + INTAKE_DEFAULT_LATENESS_MS } : {}) },
		`once on ${timing.date} at ${at} (${zone})`,
		clock.defaults,
	);
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
	words: readonly string[],
	nextTimeOnly: boolean,
) {
	if (!hasAny(words, CI_WORDS)) return undefined;
	const conclusions: readonly CiTerminalConclusion[] = timing.conclusions ?? ["failure"];
	const every = CI_TERMINAL_CONCLUSIONS.every((conclusion) => conclusions.includes(conclusion));
	if (every ? !hasStem(words, FINISH_STEMS) : conclusions.some((conclusion) => !conclusionCarried(conclusion, words)))
		return undefined;
	const workflow = timing.workflowPath
		?.split("/")
		.at(-1)
		?.replace(/\.[^.]*$/u, "");
	const workflowName = workflow === undefined ? undefined : timingWords(workflow).join(" ");
	if (workflowName !== undefined && (workflowName.length === 0 || !hasAny(words, [workflowName]))) return undefined;
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

/** A stated zone must be canonical and named in the owner's words by its city or name; otherwise the host's zone. */
function intakeZone(stated: string | undefined, words: readonly string[], hostZone: string): string | undefined {
	if (stated === undefined) return hostZone;
	let zone: string;
	try {
		zone = canonicalCalendarTimeZone(stated);
	} catch {
		return undefined;
	}
	const names = [zone, zone.split("/").at(-1)!].map((name) => timingWords(name.replace(/_/gu, " ")).join(" "));
	return hasAny(words, names) ? zone : undefined;
}

interface IntakeClock {
	readonly hour: number;
	readonly minute: number;
	/** The owner named a time or a part of the day. */
	readonly named: boolean;
	/** The host chose the hour. */
	readonly defaulted: boolean;
	readonly defaults: readonly string[];
}

/** A stated time must be carried by the owner's numbers; a part of the day by its word; otherwise 09:00, announced. */
function intakeClock(
	time: string | undefined,
	partOfDay: PartOfDay | undefined,
	words: readonly string[],
): IntakeClock | undefined {
	if (time !== undefined) {
		const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/u.exec(time);
		if (!match) return undefined;
		const hour = Number(match[1]);
		const minute = Number(match[2]);
		const numbers = numbersIn(words);
		const twelveHour = hour % 12 === 0 ? 12 : hour % 12;
		if (!numbers.has(hour) && !numbers.has(twelveHour)) return undefined;
		if (minute !== 0 && !numbers.has(minute)) return undefined;
		return { hour, minute, named: true, defaulted: false, defaults: [] };
	}
	if (partOfDay !== undefined) {
		if (!hasAny(words, PART_OF_DAY_WORDS[partOfDay])) return undefined;
		const hour = PART_OF_DAY_HOUR[partOfDay];
		return { hour, minute: 0, named: true, defaulted: true, defaults: [`${pad(hour)}:00 for "${partOfDay}"`] };
	}
	return {
		hour: DEFAULT_HOUR,
		minute: 0,
		named: false,
		defaulted: true,
		defaults: [`${pad(DEFAULT_HOUR)}:00, as no time was stated`],
	};
}

/**
 * The cron day-of-week field of a daily request. Named days must be carried by their names (a range by its first and
 * last day); all seven need explicit words such as weekends or every single day. A plain daily request, including
 * all seven days without such words, runs on weekdays only, announced.
 */
function intakeDays(
	days: readonly Weekday[] | undefined,
	words: readonly string[],
	clockNamed: boolean,
): { field: string; label: string; defaults: readonly string[] } | undefined {
	const everyDay = { field: "*", label: "every day", defaults: [] };
	if (days === undefined || days.length === 7) {
		if (hasAny(words, ALL_WEEK_WORDS) || (days !== undefined && hasAny(words, WEEKEND_WORDS))) return everyDay;
		const loose = hasAny(words, DAILY_WORDS) || (clockNamed && hasAny(words, ALL_PART_OF_DAY_WORDS));
		return loose
			? { field: "1-5", label: "weekdays", defaults: ["weekdays only, as no days were stated"] }
			: undefined;
	}
	const indices = WEEKDAYS.map((day, index) => (days.includes(day) ? index : -1)).filter((index) => index >= 0);
	const named = (index: number) => hasAny(words, WEEKDAY_WORDS[WEEKDAYS[index]!]);
	const contiguous = indices.every((index, position) => position === 0 || index === indices[position - 1]! + 1);
	const isWeekdays = indices.join(",") === "1,2,3,4,5";
	const isWeekend = indices.join(",") === "0,6";
	const carried =
		indices.every(named) ||
		(contiguous && indices.length > 2 && named(indices[0]!) && named(indices.at(-1)!)) ||
		(isWeekdays && hasAny(words, WEEKDAY_GROUP_WORDS)) ||
		(isWeekend && hasAny(words, WEEKEND_WORDS));
	if (!carried) return undefined;
	if (isWeekdays) return { field: "1-5", label: "weekdays", defaults: [] };
	if (isWeekend) return { field: "0,6", label: "weekends", defaults: [] };
	return {
		field: indices.join(","),
		label: `every ${indices.map((index) => WEEKDAY_NAMES[index]).join(", ")}`,
		defaults: [],
	};
}

interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

function parseDate(value: string): CalendarDate | undefined {
	const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u.exec(value);
	if (!match) return undefined;
	const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
	const check = new Date(Date.UTC(date.year, date.month - 1, date.day));
	return check.getUTCFullYear() === date.year &&
		check.getUTCMonth() === date.month - 1 &&
		check.getUTCDate() === date.day
		? date
		: undefined;
}

/**
 * The owner's words carry a one-time date as today (or a stated time today), tomorrow, a weekday name within a week,
 * or the day number with its month (the month may be implied within a month).
 */
function dateCarried(
	date: CalendarDate,
	words: readonly string[],
	sentAt: number,
	zone: string,
	clock: IntakeClock,
): boolean {
	const sent = localDate(sentAt, zone);
	const offset = Math.round(
		(Date.UTC(date.year, date.month - 1, date.day) - Date.UTC(sent.year, sent.month - 1, sent.day)) / DAY_MS,
	);
	if (offset < 0) return false;
	if (offset === 0 && (clock.named || hasAny(words, TODAY_WORDS))) return true;
	if (offset === 1 && hasAny(words, TOMORROW_WORDS)) return true;
	const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
	if (offset <= 7 && hasAny(words, WEEKDAY_WORDS[WEEKDAYS[weekday]!])) return true;
	const numbers = numbersIn(words);
	return (
		numbers.has(date.day) && (offset <= 31 || hasAny(words, MONTH_WORDS[date.month - 1]!) || numbers.has(date.month))
	);
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

/** Lowercase words without accents; digits and letters are split apart ("9am" reads as "9 am"). */
function timingWords(text: string): string[] {
	return text
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/(?<=\p{N})(?=\p{L})|(?<=\p{L})(?=\p{N})/gu, " ")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 0);
}

/** Whether any phrase occurs as whole consecutive words. */
function hasAny(words: readonly string[], phrases: readonly string[]): boolean {
	const text = ` ${words.join(" ")} `;
	return phrases.some((phrase) => text.includes(` ${phrase} `));
}

function hasStem(words: readonly string[], stems: readonly string[]): boolean {
	return words.some((word) => stems.some((stem) => word.startsWith(stem)));
}

/** Every number the words state: digit runs, number words, and a tens word followed by a unit word. */
function numbersIn(words: readonly string[]): Set<number> {
	const numbers = new Set<number>();
	const numberOf = (word: string | undefined): number | undefined => {
		if (word === undefined) return undefined;
		if (/^[0-9]{1,4}$/u.test(word)) return Number(word);
		return Object.hasOwn(NUMBER_WORDS, word) ? NUMBER_WORDS[word] : undefined;
	};
	for (const [index, word] of words.entries()) {
		const value = numberOf(word);
		if (value === undefined) continue;
		numbers.add(value);
		if (value >= 20 && value % 10 === 0 && value < 60) {
			const next = CONJUNCTIONS.has(words[index + 1] ?? "") ? words[index + 2] : words[index + 1];
			const unit = numberOf(next);
			if (unit !== undefined && unit >= 1 && unit <= 9) numbers.add(value + unit);
		}
	}
	for (const [phrase, value] of NUMBER_PHRASES) if (hasAny(words, [phrase])) numbers.add(value);
	return numbers;
}

function conclusionCarried(conclusion: CiTerminalConclusion, words: readonly string[]): boolean {
	switch (conclusion) {
		case "failure":
		case "startup_failure":
			return hasStem(words, FAIL_STEMS) || hasAny(words, FAIL_WORDS);
		case "success":
			return hasStem(words, SUCCESS_STEMS) || hasAny(words, SUCCESS_WORDS);
		case "cancelled":
			return hasStem(words, ["cancel"]);
		case "timed_out":
			return (
				hasAny(words, ["time out", "timed out", "times out", "timeout", "timeouts"]) || hasStem(words, ["expir"])
			);
		case "skipped":
			return hasStem(words, ["skip"]);
		case "neutral":
			return hasStem(words, ["neutr"]);
		case "action_required":
			return hasAny(words, ["action required", "requires action", "needs action"]);
		case "stale":
			return hasAny(words, ["stale"]);
	}
}

const CONJUNCTIONS = new Set(["and", "e", "y"]);

/** Number words of the host table, accents removed. */
const NUMBER_WORDS: Readonly<Record<string, number>> = {
	zero: 0,
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
	first: 1,
	second: 2,
	third: 3,
	fourth: 4,
	fifth: 5,
	half: 30,
	quarter: 15,
	noon: 12,
	midday: 12,
	midnight: 0,
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
	dezessete: 17,
	dezoito: 18,
	dezenove: 19,
	vinte: 20,
	trinta: 30,
	quarenta: 40,
	cinquenta: 50,
	primeiro: 1,
	primeira: 1,
	meia: 30,
	uno: 1,
	una: 1,
	un: 1,
	dos: 2,
	cuatro: 4,
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
	treinta: 30,
	cuarenta: 40,
	cincuenta: 50,
	primer: 1,
	primero: 1,
	primera: 1,
	media: 30,
	mediodia: 12,
	medianoche: 0,
};
const NUMBER_PHRASES: ReadonlyArray<readonly [string, number]> = [
	["meio dia", 12],
	["meia noite", 0],
];

const UNIT_WORDS: Readonly<Record<IntervalUnit, readonly string[]>> = {
	minute: ["minute", "minutes", "min", "mins", "minuto", "minutos"],
	hour: ["hour", "hours", "hourly", "hr", "hrs", "h", "hora", "horas"],
	day: ["day", "days", "daily", "dia", "dias", "diario", "diaria", "diariamente"],
	week: ["week", "weeks", "weekly", "semana", "semanas", "semanal", "semanalmente"],
};
const MONTHLY_WORDS = [
	"month",
	"months",
	"monthly",
	"mes",
	"meses",
	"mensal",
	"mensalmente",
	"mensual",
	"mensualmente",
];
/** Words that state a daily cadence without naming days. */
const DAILY_WORDS = [
	"daily",
	"every day",
	"each day",
	"everyday",
	"diariamente",
	"diario",
	"diaria",
	"todo dia",
	"todos os dias",
	"cada dia",
	"a diario",
	"todos los dias",
];
const PART_OF_DAY_WORDS: Readonly<Record<PartOfDay, readonly string[]>> = {
	morning: ["morning", "mornings", "manha", "manhas", "manana", "mananas"],
	noon: ["noon", "midday", "lunchtime", "meio dia", "mediodia"],
	afternoon: ["afternoon", "afternoons", "tarde", "tardes"],
	evening: ["evening", "evenings", "fim de tarde", "fim da tarde"],
	night: ["night", "nights", "nightly", "tonight", "noite", "noites", "noche", "noches"],
};
const ALL_PART_OF_DAY_WORDS = Object.values(PART_OF_DAY_WORDS).flat();
const WEEKDAY_WORDS: Readonly<Record<Weekday, readonly string[]>> = {
	sun: ["sunday", "sundays", "sun", "domingo", "domingos"],
	mon: ["monday", "mondays", "mon", "segunda", "segundas", "lunes"],
	tue: ["tuesday", "tuesdays", "tue", "tues", "terca", "tercas", "martes"],
	wed: ["wednesday", "wednesdays", "wed", "quarta", "quartas", "miercoles"],
	thu: ["thursday", "thursdays", "thu", "thur", "thurs", "quinta", "quintas", "jueves"],
	fri: ["friday", "fridays", "fri", "sexta", "sextas", "viernes"],
	sat: ["saturday", "saturdays", "sat", "sabado", "sabados"],
};
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEKDAY_GROUP_WORDS = [
	"weekday",
	"weekdays",
	"workday",
	"workdays",
	"work day",
	"work days",
	"working day",
	"working days",
	"business day",
	"business days",
	"dia util",
	"dias uteis",
	"dias de semana",
	"dias laborables",
	"dias habiles",
	"entre semana",
];
const WEEKEND_WORDS = ["weekend", "weekends", "fim de semana", "fins de semana", "fin de semana", "fines de semana"];
/** Words that explicitly include every day of the week; with all seven days named, a weekend word does too. */
const ALL_WEEK_WORDS = [
	"every single day",
	"including weekends",
	"7 days",
	"seven days",
	"all week",
	"todo santo dia",
	"7 dias",
	"sete dias",
	"siete dias",
	"toda a semana",
	"a semana toda",
	"a semana inteira",
	"toda la semana",
];
const TODAY_WORDS = ["today", "tonight", "hoje", "hoy"];
const TOMORROW_WORDS = ["tomorrow", "amanha", "manana"];
const MONTH_WORDS: readonly (readonly string[])[] = [
	["january", "jan", "janeiro", "enero"],
	["february", "feb", "fevereiro", "febrero"],
	["march", "mar", "marco", "marzo"],
	["april", "apr", "abril"],
	["may", "maio", "mayo"],
	["june", "jun", "junho", "junio"],
	["july", "jul", "julho", "julio"],
	["august", "aug", "agosto"],
	["september", "sep", "sept", "setembro", "septiembre", "setiembre"],
	["october", "oct", "outubro", "octubre"],
	["november", "nov", "novembro", "noviembre"],
	["december", "dec", "dezembro", "diciembre"],
];
const CI_WORDS = [
	"ci",
	"build",
	"builds",
	"pipeline",
	"pipelines",
	"workflow",
	"workflows",
	"check",
	"checks",
	"action",
	"actions",
	"test",
	"tests",
	"testes",
	"pruebas",
	"job",
	"jobs",
];
const FAIL_STEMS = ["fail", "falh", "fall", "break", "broke", "quebr", "romp"];
const FAIL_WORDS = ["red", "vermelho", "vermelha", "rojo", "roja"];
const SUCCESS_STEMS = ["pass", "succe", "sucess", "exito", "aprov"];
const SUCCESS_WORDS = ["green", "verde"];
const FINISH_STEMS = ["finish", "complet", "conclu", "termin", "acab", "end", "done"];
