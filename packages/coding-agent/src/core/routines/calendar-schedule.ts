/**
 * Calendar schedules: a five-field cron rule evaluated in one IANA time zone.
 *
 * Pure and dependency-free. Wall-clock iteration runs on UTC day numbers; only matching
 * slots consult the zone through Intl. Every wall slot maps to at most one instant and the
 * mapping is monotonic: a repeated wall time (the offset falls back) runs once at its earliest
 * instant, a skipped wall time (the offset springs forward) runs at the transition instant, and
 * slots that collapse onto one instant run once.
 */

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** ECMAScript time value bound; the zone formatter rejects instants beyond it. */
const MAX_TIME_VALUE_MS = 8_640_000_000_000_000;
/**
 * Bracket for repeated wall hours. Backward offset changes since 1970 are at most three hours (Antarctica/Casey went
 * from +11 to +08); a larger one leaves the backward walk at its known slot, which stays correct.
 */
const OVERLAP_MARGIN_MS = 3 * HOUR_MS;
const MAX_CACHED_RULES = 128;

export const MAX_CALENDAR_CRON_CHARS = 128;
export const MAX_CALENDAR_TIME_ZONE_CHARS = 64;
/**
 * One Gregorian cycle: dates and weekdays repeat every 146,097 days, so a rule matching no date
 * within it matches none ever, and a satisfiable rule (29 February on a given weekday can recur
 * decades apart) always finds its next slot.
 */
export const CALENDAR_SEARCH_HORIZON_DAYS = 146_097 + 1;
/** Saturation bound for the missed-slot count recorded on a coalesced occurrence. */
export const MAX_CALENDAR_MISSED_COUNT = 1_000;

export interface CalendarRule {
	readonly cron: string;
	readonly timeZone: string;
}

interface CompiledCron {
	readonly minutes: readonly number[];
	readonly hours: readonly number[];
	readonly days: ReadonlySet<number>;
	readonly months: ReadonlySet<number>;
	readonly weekdays: ReadonlySet<number>;
	// Traditional cron: a day field whose text starts with `*` is unrestricted, so a stepped `*/2` is unrestricted
	// too. Only when neither starts with `*` does a day match either field (`0 0 1-31/2 * 1`: odd days or Mondays);
	// otherwise both must match (`0 0 */2 * 1`: odd days that are Mondays).
	readonly eitherDay: boolean;
}

const compiledRules = new Map<string, CompiledCron>();
const zoneFormats = new Map<string, Intl.DateTimeFormat>();

function remember<T>(cache: Map<string, T>, key: string, value: T): T {
	const oldest = cache.keys().next();
	if (cache.size >= MAX_CACHED_RULES && !oldest.done) cache.delete(oldest.value);
	cache.set(key, value);
	return value;
}

/** Returns the whitespace-normalized rule, or throws a TypeError naming the invalid part. */
export function canonicalCalendarCron(value: unknown): string {
	if (typeof value !== "string" || value.length > MAX_CALENDAR_CRON_CHARS)
		throw new TypeError(`Calendar rule must be a string of at most ${MAX_CALENDAR_CRON_CHARS} characters.`);
	const canonical = value.trim().split(/\s+/u).join(" ");
	compileCron(canonical);
	return canonical;
}

/** Returns the zone's canonical identifier, or throws a TypeError for an unsupported zone. */
export function canonicalCalendarTimeZone(value: unknown): string {
	return zoneFormat(value).resolvedOptions().timeZone;
}

/** Whether `value` has the shape of a zone name, whatever this runtime supports. */
export function isCalendarTimeZoneName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_CALENDAR_TIME_ZONE_CHARS &&
		value.trim() === value
	);
}

export function isCalendarTimeZone(value: unknown): value is string {
	try {
		zoneFormat(value);
		return true;
	} catch {
		return false;
	}
}

/** The zone this host resolves for local wall time; Intl reports UTC when the host has none. */
export function hostTimeZone(): string {
	return new Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** First slot strictly after `afterMs` within the search horizon. */
export function nextCalendarSlotAfter(rule: CalendarRule, afterMs: number): number | undefined {
	const cron = compileCron(rule.cron);
	const zone = zoneFormat(rule.timeZone);
	for (const wall of wallSlots(cron, localWall(zone, afterMs) - OVERLAP_MARGIN_MS, 1, CALENDAR_SEARCH_HORIZON_DAYS)) {
		const instant = wallInstant(zone, wall);
		if (instant !== undefined && instant > afterMs) return instant;
	}
	return undefined;
}

/**
 * Latest slot at or before `atMs`. `knownSlot` is a slot already due at or before `atMs`; it
 * bounds the backward walk and is returned when current zone rules place no later slot.
 */
export function latestCalendarSlotAtOrBefore(rule: CalendarRule, atMs: number, knownSlot: number): number {
	const cron = compileCron(rule.cron);
	const zone = zoneFormat(rule.timeZone);
	const days = Math.ceil((atMs - knownSlot) / DAY_MS) + 2;
	for (const wall of wallSlots(cron, localWall(zone, atMs) + OVERLAP_MARGIN_MS, -1, days)) {
		const instant = wallInstant(zone, wall);
		if (instant !== undefined && instant <= atMs) return Math.max(instant, knownSlot);
	}
	return knownSlot;
}

/** Distinct slots in `[fromMs, toMs)`, saturating at `cap`. */
export function countCalendarSlots(rule: CalendarRule, fromMs: number, toMs: number, cap: number): number {
	if (toMs <= fromMs || cap <= 0) return 0;
	const cron = compileCron(rule.cron);
	const zone = zoneFormat(rule.timeZone);
	const firstWall = localWall(zone, fromMs) - OVERLAP_MARGIN_MS;
	const lastWall = localWall(zone, toMs) + OVERLAP_MARGIN_MS;
	let count = 0;
	let previous = Number.NEGATIVE_INFINITY;
	for (const wall of wallSlots(cron, firstWall, 1, Math.ceil((lastWall - firstWall) / DAY_MS) + 1)) {
		if (wall > lastWall) break;
		const instant = wallInstant(zone, wall);
		if (instant === undefined || instant < fromMs || instant <= previous) continue;
		if (instant >= toMs) break;
		previous = instant;
		if (++count >= cap) break;
	}
	return count;
}

function compileCron(text: string): CompiledCron {
	const cached = compiledRules.get(text);
	if (cached) return cached;
	const fields = text.split(" ");
	if (fields.length !== 5)
		throw new TypeError("Calendar rule needs five fields: minute hour day-of-month month day-of-week.");
	const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
	const weekdays = new Set(parseField(weekday, 0, 7, "day-of-week").map((value) => value % 7));
	return remember(compiledRules, text, {
		minutes: parseField(minute, 0, 59, "minute"),
		hours: parseField(hour, 0, 23, "hour"),
		days: new Set(parseField(day, 1, 31, "day-of-month")),
		months: new Set(parseField(month, 1, 12, "month")),
		weekdays,
		eitherDay: !day.startsWith("*") && !weekday.startsWith("*"),
	});
}

/** Numbers, `*`, ranges, steps and comma lists. Names and nonstandard extensions are rejected. */
function parseField(text: string, min: number, max: number, label: string): number[] {
	const values = new Set<number>();
	for (const part of text.split(",")) {
		const match = /^(?:\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/u.exec(part);
		if (!match) throw new TypeError(`Calendar ${label} field "${text}" is invalid.`);
		const step = match[3] === undefined ? 1 : Number(match[3]);
		const low = match[1] === undefined ? min : Number(match[1]);
		const high =
			match[1] === undefined ? max : match[2] !== undefined ? Number(match[2]) : match[3] !== undefined ? max : low;
		if (step < 1 || low < min || high > max || low > high)
			throw new TypeError(`Calendar ${label} field "${text}" is outside ${min}-${max}.`);
		for (let value = low; value <= high; value += step) values.add(value);
	}
	return [...values].sort((left, right) => left - right);
}

function zoneFormat(value: unknown): Intl.DateTimeFormat {
	if (!isCalendarTimeZoneName(value))
		throw new TypeError("Calendar time zone must be an IANA zone name such as Europe/Lisbon.");
	const cached = zoneFormats.get(value);
	if (cached) return cached;
	let format: Intl.DateTimeFormat;
	try {
		format = new Intl.DateTimeFormat("en-US", {
			timeZone: value,
			calendar: "gregory",
			numberingSystem: "latn",
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		});
	} catch {
		throw new TypeError(`Calendar time zone "${value}" is not supported by this runtime.`);
	}
	return remember(zoneFormats, value, format);
}

/** Zone offset in effect at `instant`, in milliseconds (local wall minus UTC). */
function offsetAt(zone: Intl.DateTimeFormat, instant: number): number {
	let year = 0;
	let month = 0;
	let day = 0;
	let hour = 0;
	let minute = 0;
	let second = 0;
	for (const part of zone.formatToParts(instant)) {
		if (part.type === "year") year = Number(part.value);
		else if (part.type === "month") month = Number(part.value);
		else if (part.type === "day") day = Number(part.value);
		else if (part.type === "hour") hour = Number(part.value);
		else if (part.type === "minute") minute = Number(part.value);
		else if (part.type === "second") second = Number(part.value);
	}
	const wholeSecond = instant - (((instant % SECOND_MS) + SECOND_MS) % SECOND_MS);
	return Date.UTC(year, month - 1, day, hour, minute, second) - wholeSecond;
}

function localWall(zone: Intl.DateTimeFormat, instant: number): number {
	return instant + offsetAt(zone, instant);
}

/** Earliest instant showing `wall`, or the transition instant when the zone skips it. */
function wallInstant(zone: Intl.DateTimeFormat, wall: number): number | undefined {
	const before = offsetAt(zone, wall - DAY_MS);
	const after = offsetAt(zone, wall + DAY_MS);
	let earliest: number | undefined;
	for (const offset of before === after ? [before] : [before, after]) {
		const candidate = wall - offset;
		if (offsetAt(zone, candidate) === offset && (earliest === undefined || candidate < earliest))
			earliest = candidate;
	}
	if (earliest !== undefined || before >= after) return earliest;
	// Skipped wall time: the offset changes between the two candidate instants.
	let low = wall - after;
	let high = wall - before;
	const lowOffset = offsetAt(zone, low);
	if (lowOffset === offsetAt(zone, high)) return undefined;
	while (high - low > SECOND_MS) {
		const middle = low + Math.floor((high - low) / (2 * SECOND_MS)) * SECOND_MS;
		if (offsetAt(zone, middle) === lowOffset) low = middle;
		else high = middle;
	}
	return high;
}

/** Matching wall slots from `fromWall`, ascending (1) or descending (-1), across `days` local days. */
function* wallSlots(cron: CompiledCron, fromWall: number, direction: 1 | -1, days: number): Generator<number> {
	const firstDay = Math.floor(fromWall / DAY_MS);
	for (let step = 0; step <= days; step++) {
		const day = firstDay + direction * step;
		const dayStart = day * DAY_MS;
		if (dayStart < -MAX_TIME_VALUE_MS + 2 * DAY_MS || dayStart > MAX_TIME_VALUE_MS - 2 * DAY_MS) return;
		if (!dayMatches(cron, day)) continue;
		const hours = direction === 1 ? cron.hours : [...cron.hours].reverse();
		const minutes = direction === 1 ? cron.minutes : [...cron.minutes].reverse();
		for (const hour of hours)
			for (const minute of minutes) {
				const wall = dayStart + hour * HOUR_MS + minute * MINUTE_MS;
				if (direction === 1 ? wall >= fromWall : wall <= fromWall) yield wall;
			}
	}
}

function dayMatches(cron: CompiledCron, day: number): boolean {
	const date = new Date(day * DAY_MS);
	if (!cron.months.has(date.getUTCMonth() + 1)) return false;
	const dayOfMonth = cron.days.has(date.getUTCDate());
	const dayOfWeek = cron.weekdays.has(date.getUTCDay());
	return cron.eitherDay ? dayOfMonth || dayOfWeek : dayOfMonth && dayOfWeek;
}
