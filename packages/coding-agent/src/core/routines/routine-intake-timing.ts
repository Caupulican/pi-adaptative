/**
 * Host-owned timing of routine intake. The extraction model only fills constrained timing slots; the host reads the
 * owner's own message with a fixed positional grammar (English, Portuguese and Spanish tables) over a closed
 * vocabulary, derives the schedule, its lifetime, its CI outcomes and its zone from the stated words alone, fills the
 * parts the owner left open with fixed defaults it announces, and compiles the executable schedule. Every slot must
 * equal what the words state. A word of the timing excerpt that no construct or filler of a language reads, a timing
 * construct or word of the excerpts' sentences outside both excerpts, and a sentence that only modifies the timing
 * refuse, with a reason the owner is told. The model never chooses an hour, a cron rule, an instant or a zone.
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
/** A refusal reason quotes at most this many characters of the owner's words at a time. */
const MAX_QUOTED_CHARS = 60;

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
		description: "IANA zone, only when the quoted timing words name a zone or a city for the time.",
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
						"Only the days the owner named. Leave it out when no day was named: daily wording and a recurring part of the day run on all seven days.",
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
					description:
						"Every outcome the owner named; finishing or ending names all of them. Leave it out when the owner named only failure.",
				}),
			),
			workflowPath: Type.Optional(
				Type.String({
					minLength: 1,
					maxLength: MAX_ROUTINE_WORKFLOW_PATH_CHARS,
					description:
						"Only when the owner named a workflow file (such as ci.yml): .github/workflows/ followed by that file name. Leave it out otherwise.",
				}),
			),
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
	/** For a request meant only until something happens: the end the owner stated, in their own words. */
	readonly endCondition?: string;
}

/**
 * Why the host did not compile a request, for the owner's notice: it names the owner's words the host could not place
 * or schedule, each quote whitespace-collapsed, without NUL and cut to a few words.
 */
export interface IntakeTimingRefusal {
	readonly refused: string;
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
	/**
	 * The workflow paths this session's CI source watches, as its attempts carry them. Absent when no reader reaches
	 * intake: then a request naming a workflow file is refused.
	 */
	readonly workflowPaths?: readonly string[];
}

/**
 * Compiles the slots when the owner's stated words, read by the host grammar, yield exactly the schedule, lifetime, CI
 * outcomes and zone the slots describe; otherwise the refusal the owner is told, and the request is dropped before any
 * judgment. Every language whose tables read the whole timing excerpt must compile the same schedule.
 */
export function compileIntakeTiming(
	timing: IntakeTiming,
	context: IntakeTimingContext,
	lifetime?: IntakeLifetime,
): CompiledIntakeTiming | IntakeTimingRefusal {
	const when = context.owner.text.slice(context.when.start, context.when.end);
	const tokens = tokenize(context.owner);
	const span = excerptSpan(tokens, context.when);
	if (!span) return { refused: placeReason(when) };
	let agreed: CompiledIntakeTiming | undefined;
	let closest: Unread | undefined;
	for (const language of LANGUAGES) {
		const result = compileIn({ language, tokens, span, timing, context, lasts: lifetime, when });
		if ("unread" in result) {
			if (!closest || result.unread.length < closest.unread.length) closest = result;
			continue;
		}
		if ("refused" in result) return result;
		if (agreed && JSON.stringify(agreed) !== JSON.stringify(result))
			return { refused: `the host reads ${quoted(when)} in more than one way` };
		agreed = result;
	}
	if (agreed) return agreed;
	if (closest?.refused !== undefined) return { refused: exactReason(closest.refused) };
	return { refused: placeReason(tokenWords(context.owner.text, closest?.unread ?? [])) };
}

/**
 * Whether the owner's stated (not shown) words carry timing the host grammar can compile: a construct of any of its
 * languages that a schedule derives from, or a CI subject together with an outcome word. Every compile derives from
 * such a construct or such words of the same parse, so a message for which it is false can never compile a request
 * and buys no extraction.
 */
export function statesIntakeTiming(owner: OwnerWords): boolean {
	const tokens = tokenize(owner);
	const everywhere = { first: 0, last: tokens.length };
	return LANGUAGES.some(
		(language) =>
			parseTokens(tokens, language).some(
				(construct) => SCHEDULE_TYPES.has(construct.type) || (construct.type === "part" && construct.recurring),
			) || readsCi(language, tokens, everywhere),
	);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading one language

interface Reading {
	readonly language: Language;
	readonly tokens: readonly Token[];
	readonly span: TokenSpan;
	readonly timing: IntakeTiming;
	readonly context: IntakeTimingContext;
	readonly lasts: IntakeLifetime | undefined;
	/** The timing excerpt as the owner wrote it. */
	readonly when: string;
}

/** How long a request runs, as its words state it. */
type Lifetime = "standing" | "until" | "next" | "once";

/** The timing excerpt's tokens a language leaves unread, with the words of a refusal construct it read there. */
interface Unread {
	readonly unread: readonly Token[];
	readonly refused?: string;
}

/** An until-construct of the excerpts' sentences and the end of the words it states. */
interface StatedUntil {
	readonly construct: Construct;
	readonly end: number;
}

/**
 * One language's compile, or the timing excerpt's words its tables leave unread. The excerpt reads only when each of
 * its tokens is a construct, a filler, the stated end after an until-word, instruction words, or, for a CI watch, a CI
 * subject, outcome, lifetime word or watch filler. Then every construct of the sentences of both excerpts must lie in
 * the timing excerpt or, as one that only describes the work, in the instruction; every timing word there must lie in
 * an excerpt; and another sentence made only of timing and fillers ("At 9pm.", "Except Fridays.") refuses.
 */
function compileIn(reading: Reading): CompiledIntakeTiming | IntakeTimingRefusal | Unread {
	const { language, tokens, span, timing, context } = reading;
	const text = context.owner.text;
	const event = timing.kind === "event";
	const constructs = parseTokens(tokens, language);
	const instruction = excerptSpan(tokens, context.instruction);
	const sentences = new Set<number>();
	for (const excerpt of [span, instruction])
		if (excerpt)
			for (let index = excerpt.first; index < excerpt.last; index++) sentences.add(tokens[index]!.sentence);
	const within = (index: number, excerpt: TokenSpan | undefined) =>
		excerpt !== undefined && index >= excerpt.first && index < excerpt.last;
	const holds = (construct: Construct, excerpt: TokenSpan | undefined) =>
		excerpt !== undefined && construct.start >= excerpt.first && construct.end <= excerpt.last;
	const covered = new Uint8Array(tokens.length);
	for (const construct of constructs) covered.fill(1, construct.start, construct.end);
	const untils: StatedUntil[] = [];
	const tail = new Uint8Array(tokens.length);
	for (const construct of constructs) {
		if (construct.type !== "until" || !sentences.has(tokens[construct.start]!.sentence)) continue;
		const end = untilEnd(tokens, construct, context.instruction.start);
		tail.fill(1, construct.end, end);
		untils.push({ construct, end });
	}

	// A workflow file a CI watch's timing excerpt names before any until-word is read as that name, never as timing.
	const workflows = event
		? workflowMentions(text, tokens).filter(
				(mention) => mention.first >= span.first && mention.last <= span.last && !tail[mention.first],
			)
		: [];
	const named = new Uint8Array(tokens.length);
	for (const mention of workflows) named.fill(1, mention.first, mention.last);

	const vocabulary = event ? eventVocabulary(language) : language.fillers;
	const unread: Token[] = [];
	for (let index = span.first; index < span.last; ) {
		if (covered[index] || tail[index] || named[index] || within(index, instruction)) {
			index++;
			continue;
		}
		const end = freePhrase(tokens, index, span.last, vocabulary, covered);
		if (end === undefined) unread.push(tokens[index]!);
		index = end ?? index + 1;
	}
	if (unread.length > 0) {
		// "twice a day": the wording this language cannot schedule names the reason better than the word it left unread.
		const refused = constructs.find((construct) => construct.type === "refusal" && holds(construct, span));
		return { unread, ...(refused ? { refused: constructWords(text, tokens, refused) } : {}) };
	}

	const stated: Construct[] = [];
	let refusal: Construct | undefined;
	let misplaced: Construct | undefined;
	for (const construct of constructs) {
		if (construct.type === "until" || !sentences.has(tokens[construct.start]!.sentence)) continue;
		// The stated end is words the host keeps, never timing it reads: a construct after an until-word refuses.
		const own = !tail[construct.start] && holds(construct, span);
		if (own && construct.type !== "refusal") stated.push(construct);
		else if (own || !holds(construct, instruction) || !describesWork(construct)) {
			if (construct.type === "refusal") refusal ??= construct;
			else misplaced ??= construct;
		}
	}
	if (refusal) return { refused: exactReason(constructWords(text, tokens, refusal)) };
	if (misplaced) return { refused: placeReason(constructWords(text, tokens, misplaced)) };
	const watchWords = event ? eventWords(language) : undefined;
	const stray: Token[] = [];
	for (const [index, token] of tokens.entries())
		if (
			sentences.has(token.sentence) &&
			!covered[index] &&
			!tail[index] &&
			!within(index, span) &&
			!within(index, instruction) &&
			(isAnchor(token) || watchWords?.has(token.text) === true)
		)
			stray.push(token);
	if (stray.length > 0) return { refused: placeReason(tokenWords(text, stray)) };
	const modifier = modifierSentence(language, tokens, constructs, covered, sentences, event);
	if (modifier) return { refused: placeReason(spanText(text, tokens, modifier)) };
	if (untils.length > 1) return { refused: exactReason(reading.when) };
	return timing.kind === "event"
		? compileEvent(reading, timing, stated, untils[0], workflows)
		: compileCalendar(reading, timing, stated, untils[0]);
}

/** A workflow file the owner named ("ci.yml", "release-please.yaml"): its tokens, end exclusive, and its name. */
interface WorkflowMention {
	readonly first: number;
	readonly last: number;
	/** The file name as written, lowercase. */
	readonly name: string;
}

/**
 * Workflow file names in the owner's stated words: a `yml`/`yaml` token after a period, with the letters and digits
 * joined to it by nothing, `-`, `_` or `.` before it, and nothing joined after it.
 */
function workflowMentions(text: string, tokens: readonly Token[]): WorkflowMention[] {
	const joined = (left: Token, right: Token) =>
		left.run === right.run && /^[-_.]?$/u.test(text.slice(left.end, right.start));
	const mentions: WorkflowMention[] = [];
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index]!;
		if ((token.text !== "yml" && token.text !== "yaml") || text.slice(tokens[index - 1]!.end, token.start) !== ".")
			continue;
		if (!joined(tokens[index - 1]!, token)) continue;
		const following = tokens[index + 1];
		if (following && joined(token, following)) continue;
		let first = index - 1;
		while (first > 0 && joined(tokens[first - 1]!, tokens[first]!)) first--;
		mentions.push({ first, last: index + 1, name: text.slice(tokens[first]!.start, token.end).toLowerCase() });
	}
	return mentions;
}

/** A workflow path's file name. */
function workflowFile(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * The workflow path a CI watch's timing excerpt derives: none when it names no workflow file, else the one watched
 * workflow whose file name it names. Refused when it names more than one, when no reader of the watched workflows
 * reaches intake, or when the name is not exactly one watched workflow's.
 */
function watchedWorkflow(
	mentions: readonly WorkflowMention[],
	watched: readonly string[] | undefined,
): { readonly path?: string } | IntakeTimingRefusal {
	const names = new Set(mentions.map((mention) => mention.name));
	if (names.size === 0) return {};
	if (names.size > 1)
		return { refused: `${[...names].map(quoted).join(" and ")} name more than one workflow; a CI watch follows one` };
	const name = [...names][0]!;
	if (watched === undefined)
		return { refused: `the host cannot check workflow names here, so it cannot watch ${quoted(name)}` };
	const files = [...new Set(watched.map(workflowFile))];
	const matches = watched.filter((path) => workflowFile(path).toLowerCase() === name);
	if (matches.length === 1) return { path: matches[0]! };
	if (matches.length > 1)
		return { refused: `${quoted(name)} names more than one watched workflow, so the host cannot tell which` };
	return {
		refused:
			files.length === 0
				? `the host has not yet seen a CI attempt of the workflow this session watches, so it cannot check ${quoted(name)}`
				: `the host watches ${files.map(quoted).join(", ")} for this session, not ${quoted(name)}`,
	};
}

/** Constructs inside the instruction that describe the work rather than schedule it ("summarize last week's PRs"). */
function describesWork(construct: Construct): boolean {
	switch (construct.type) {
		case "date":
		case "todayPart":
		case "refusal":
			return true;
		case "zone":
			return !construct.marked;
		case "part":
		case "days":
			return !construct.recurring;
		default:
			return false;
	}
}

/**
 * The end of the words an until-construct states: the rest of its run, cut where an instruction excerpt that begins
 * after it starts.
 */
function untilEnd(tokens: readonly Token[], until: Construct, instructionStart: number): number {
	const first = tokens[until.start]!;
	const cut = instructionStart > first.start ? instructionStart : Number.POSITIVE_INFINITY;
	let end = until.end;
	while (end < tokens.length && tokens[end]!.run === first.run && tokens[end]!.end <= cut) end++;
	return end;
}

/**
 * Another sentence of the message holding timing and nothing but fillers besides ("At 9pm.", "Not on Fridays.", "Also
 * when it passes."): it modifies a request whose excerpts leave it out.
 */
function modifierSentence(
	language: Language,
	tokens: readonly Token[],
	constructs: readonly Construct[],
	covered: Uint8Array,
	excerpts: ReadonlySet<number>,
	event: boolean,
): TokenSpan | undefined {
	const timed = new Set(constructs.map((construct) => tokens[construct.start]!.sentence));
	if (event) for (const token of tokens) if (eventWords(language).has(token.text)) timed.add(token.sentence);
	const vocabulary = event ? eventVocabulary(language) : language.fillers;
	for (const sentence of timed) {
		if (excerpts.has(sentence)) continue;
		const first = tokens.findIndex((token) => token.sentence === sentence);
		let last = first;
		while (last < tokens.length && tokens[last]!.sentence === sentence) last++;
		let index = first;
		while (index < last) {
			const end = covered[index] ? index + 1 : freePhrase(tokens, index, last, vocabulary, covered);
			if (end === undefined) break;
			index = end;
		}
		if (index === last) return { first, last };
	}
	return undefined;
}

function compileEvent(
	reading: Reading,
	timing: Extract<IntakeTiming, { kind: "event" }>,
	stated: readonly Construct[],
	until: StatedUntil | undefined,
	workflows: readonly WorkflowMention[],
): CompiledIntakeTiming | IntakeTimingRefusal {
	const { language, tokens, span, when } = reading;
	// A CI watch has no clock, day or zone: any other construct of its excerpt means the owner asked for something else.
	if (stated.some((construct) => construct.type !== "event")) return { refused: exactReason(when) };
	// The workflow is the host's reading of a named file against what it watches; the model's slot must equal it.
	const workflow = watchedWorkflow(workflows, reading.context.workflowPaths);
	if ("refused" in workflow) return workflow;
	if (timing.workflowPath !== workflow.path) return { refused: differsReason(when) };
	// Outcomes and lifetime words are read before an until-word; the words after it are the stated end.
	const untilAt = until?.construct.start ?? span.last;
	const head: TokenSpan = {
		first: span.first,
		last: untilAt > span.first && untilAt < span.last ? untilAt : span.last,
	};
	if (!readsCi(language, tokens, head)) return { refused: `${quoted(when)} names no CI result the host watches` };
	let standing = false;
	let next = language.nextWords.some((word) => spanHas(tokens, head, word));
	for (const construct of stated)
		if (construct.type === "event") {
			if (construct.lifetime === "standing") standing = true;
			else next = true;
		}
	if (!standing && !next) return { refused: `${quoted(when)} does not say whether every time or only the next time` };
	if (next && (standing || until)) return { refused: exactReason(when) };
	const lifetime: Lifetime = until ? "until" : standing ? "standing" : "next";
	const named = new Set<CiOutcome>();
	for (const outcome of Object.keys(language.outcomes) as CiOutcome[])
		if (language.outcomes[outcome].some((phrase) => spanHas(tokens, head, phrase))) named.add(outcome);
	const conclusions = CI_TERMINAL_CONCLUSIONS.filter(
		(conclusion) => named.has("finish") || (conclusion !== "startup_failure" && named.has(conclusion)),
	);
	const failureOnly = conclusions.length === 1 && conclusions[0] === "failure";
	if (
		(timing.conclusions === undefined ? !failureOnly : !sameMembers(timing.conclusions, conclusions)) ||
		!lifetimeMatches(lifetime, reading.lasts)
	)
		return { refused: differsReason(when) };
	const ending =
		conclusions.length === CI_TERMINAL_CONCLUSIONS.length ? "finishes" : `ends in ${conclusions.join(" or ")}`;
	const subject = `a CI attempt${workflow.path === undefined ? "" : ` of ${workflowFile(workflow.path)}`} of the checked-out revision ${ending}`;
	return withLifetime(
		reading,
		lifetime,
		until,
		{
			kind: "event",
			source: "ci",
			...(timing.conclusions === undefined ? {} : { conclusions: [...conclusions] }),
			...(workflow.path === undefined ? {} : { workflowPath: workflow.path }),
		},
		lifetime === "next" ? `once, the next time ${subject}, then it is removed` : `every time ${subject}`,
		[],
	);
}

function compileCalendar(
	reading: Reading,
	timing: Exclude<IntakeTiming, { kind: "event" }>,
	stated: readonly Construct[],
	until: StatedUntil | undefined,
): CompiledIntakeTiming | IntakeTimingRefusal {
	const { tokens, context, when } = reading;
	const differs = { refused: differsReason(when) };
	const zones = stated.filter((construct) => construct.type === "zone");
	const derived = derive(stated.filter((construct) => construct.type !== "zone"));
	if (!derived || (derived.kind === "once" && until)) return { refused: exactReason(when) };
	const lifetime: Lifetime = derived.kind === "once" ? "once" : until ? "until" : "standing";
	if (derived.kind !== timing.kind || !lifetimeMatches(lifetime, reading.lasts)) return differs;
	if (derived.kind === "interval" || timing.kind === "interval") {
		if (derived.kind !== "interval" || timing.kind !== "interval") return differs;
		if (zones.length > 0) return { refused: exactReason(when) };
		const intervalMs = derived.every * INTERVAL_UNIT_MS[derived.unit];
		if (timing.every * INTERVAL_UNIT_MS[timing.unit] !== intervalMs) return differs;
		return withLifetime(
			reading,
			lifetime,
			until,
			{ kind: "interval", intervalMs },
			derived.every === 1 ? `every ${derived.unit}` : `every ${derived.every} ${derived.unit}s`,
			[],
		);
	}
	const zone = intakeZone(timing.timeZone, zones, context.hostTimeZone, when);
	if (typeof zone !== "string") return zone;
	const clock = resolveClock(derived, tokens, context.owner.text);
	if (!clock) return { refused: exactReason(when) };
	if (
		(timing.time !== undefined && !clock.readings.includes(timing.time)) ||
		(timing.partOfDay !== undefined &&
			timing.partOfDay !== derived.part &&
			!(timing.partOfDay === "noon" && derived.clock?.noon))
	)
		return differs;
	const at = `${pad(clock.hour)}:${pad(clock.minute)}`;
	const window = clock.defaults.length > 0 ? { maxLatenessMs: INTAKE_DEFAULT_LATENESS_MS } : {};
	if (derived.kind === "monthly") {
		if (timing.kind !== "monthly" || timing.day !== derived.day) return differs;
		return withLifetime(
			reading,
			lifetime,
			until,
			{ kind: "calendar", cron: `${clock.minute} ${clock.hour} ${derived.day} * *`, timeZone: zone, ...window },
			`on day ${derived.day} of every month at ${at} (${zone})${SHORT_MONTHS[derived.day] ?? ""}`,
			clock.defaults,
		);
	}
	if (derived.kind === "daily") {
		const days = timing.kind === "daily" ? intakeDays(derived.days, timing.days) : undefined;
		if (!days) return differs;
		return withLifetime(
			reading,
			lifetime,
			until,
			{ kind: "calendar", cron: `${clock.minute} ${clock.hour} * * ${days.field}`, timeZone: zone, ...window },
			`${days.label} at ${at} (${zone})`,
			clock.defaults,
		);
	}
	if (timing.kind !== "once") return differs;
	const none = { refused: `${quoted(when)} names no time between now and a year ahead` };
	const date = onceDate(derived.date, localDate(context.sentAt, zone));
	if (!date) return none;
	if (isoDate(date) !== timing.date) return differs;
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
		return none;
	return compiled(
		{
			kind: "once",
			at: instant,
			...(clock.defaults.length > 0 ? { notAfter: instant + INTAKE_DEFAULT_LATENESS_MS } : {}),
		},
		`once on ${timing.date} at ${at} (${zone})`,
		clock.defaults,
		when,
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

/**
 * A request meant only until something happens gets the owner's words for that end and a 14-day bound; a one-time CI
 * watch stops after its run or after 14 days. The host cannot watch an end stated in words: the routine keeps them and
 * tells each run.
 */
function withLifetime(
	reading: Reading,
	lifetime: Lifetime,
	until: StatedUntil | undefined,
	schedule: Exclude<RoutineScheduleInput, { kind: "once" }>,
	cadence: string,
	defaults: readonly string[],
): CompiledIntakeTiming | IntakeTimingRefusal {
	const { context, tokens, when } = reading;
	if (lifetime === "standing" || lifetime === "once") return compiled(schedule, cadence, defaults, when);
	const expiresAt = context.now + INTAKE_WATCH_LIFETIME_MS;
	const zone = (schedule.kind === "calendar" ? schedule.timeZone : undefined) ?? context.hostTimeZone;
	const end = `${localStamp(expiresAt, zone)} (${zone})`;
	if (lifetime === "next")
		return schedule.kind !== "event"
			? { refused: exactReason(when) }
			: compiled(
					{ ...schedule, stopAfterFirstRun: true, expiresAt },
					cadence,
					[
						...defaults,
						`stops watching on ${end}, 14 days after the request, if that has not happened, as no end was stated`,
					],
					when,
				);
	if (!until || until.end === until.construct.end) return { refused: exactReason(when) };
	const endCondition = context.owner.text.slice(tokens[until.construct.start]!.start, tokens[until.end - 1]!.end);
	if (endCondition.length > MAX_ROUTINE_INTAKE_TEXT_CHARS) return { refused: LENGTH_REASON };
	const watch = compiled(
		{ ...schedule, expiresAt },
		`${cadence}, for at most 14 days`,
		[
			...defaults,
			`ends on ${end} at the latest, 14 days after the request, since the host cannot watch the end the owner stated; each run is told that end, and the routine ends once a run reports it reached`,
		],
		when,
	);
	return "refused" in watch ? watch : { ...watch, endCondition };
}

/** A standing request omits `lasts`; a one-time calendar request may also say next_time_only. */
function lifetimeMatches(lifetime: Lifetime, lasts: IntakeLifetime | undefined): boolean {
	switch (lifetime) {
		case "standing":
			return lasts === undefined;
		case "until":
			return lasts === "until_condition";
		case "next":
			return lasts === "next_time_only";
		case "once":
			return lasts !== "until_condition";
	}
}

function compiled(
	schedule: RoutineScheduleInput,
	cadence: string,
	defaults: readonly string[],
	when: string,
): CompiledIntakeTiming | IntakeTimingRefusal {
	// The retained request bounds every description.
	if ([cadence, ...defaults].some((text) => text.length > MAX_ROUTINE_INTAKE_TEXT_CHARS))
		return { refused: LENGTH_REASON };
	try {
		return { schedule: parseRoutineScheduleInput(schedule), cadence, defaults };
	} catch {
		return { refused: exactReason(when) };
	}
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
	return new Set(left).size === right.length && left.every((item) => right.includes(item));
}

// ---------------------------------------------------------------------------------------------------------------
// Refusal reasons: the owner's notice reads "Could not schedule what reads as a request: <reason> - <instruction>".

const LENGTH_REASON = "its schedule cannot be described within the kept length";

/** The owner's words, whitespace-collapsed, without NUL and cut to {@link MAX_QUOTED_CHARS}, in quotes. */
function quoted(words: string): string {
	const plain = words.replace(/\0/gu, "").replace(/\s+/gu, " ").trim();
	return `"${plain.length <= MAX_QUOTED_CHARS ? plain : `${plain.slice(0, MAX_QUOTED_CHARS - 1).trimEnd()}…`}"`;
}

function placeReason(words: string): string {
	return `the host cannot place ${quoted(words)} in a schedule`;
}

function exactReason(words: string): string {
	return `the host cannot schedule ${quoted(words)} exactly`;
}

function differsReason(when: string): string {
	return `the host reads ${quoted(when)} differently from the proposed timing`;
}

function tokenWords(text: string, tokens: readonly Token[]): string {
	return tokens.map((token) => text.slice(token.start, token.end)).join(" ");
}

function spanText(text: string, tokens: readonly Token[], span: TokenSpan): string {
	return text.slice(tokens[span.first]!.start, tokens[span.last - 1]!.end);
}

function constructWords(text: string, tokens: readonly Token[], construct: Construct): string {
	return spanText(text, tokens, { first: construct.start, last: construct.end });
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens

type TokenKind = "word" | "number" | "clock" | "hclock" | "decimal" | "foreign";

interface Token {
	readonly kind: TokenKind;
	/** Folded text: accents removed and lowercase; `a.m` and `p.m` read as `am` and `pm`. */
	readonly text: string;
	/** Original offsets, end exclusive. */
	readonly start: number;
	readonly end: number;
	/** Trimmed stated text between the previous token and this one. */
	readonly gap: string;
	/** A construct never crosses a run: a sentence end or a shown region ends one. */
	readonly run: number;
	readonly sentence: number;
	/** The original word starts with a capital letter. */
	readonly capital: boolean;
	/** The original word is two or more capital letters ("EST"). */
	readonly upper: boolean;
}

/** Token indices, end exclusive. */
interface TokenSpan {
	readonly first: number;
	readonly last: number;
}

/**
 * `9:30` clock, `9h`/`9h30` clock (an interval after an interval marker), decimals, ASCII digit runs, other digit runs
 * (never read, always timing), `a.m`/`p.m` (ending at the `m`: the period after it is the meridiem's), and letter
 * runs. Digits and letters split ("9am" is "9" "am").
 */
const TOKEN_PATTERN =
	/(\d{1,2}:\d{2})(?!\d)|(\d{1,2}h(?:\d{2})?)(?![\p{L}\p{N}])|(\d+(?:[.,]\d+)+)|(\d+)|(\p{Nd}+)|([ap])\.m\b|(\p{L}+)/gu;
const TOKEN_KINDS: readonly (TokenKind | undefined)[] = [
	undefined,
	"clock",
	"hclock",
	"decimal",
	"number",
	"foreign",
	"word",
	"word",
];
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
	let meridiem = false;
	for (const match of folded.text.matchAll(TOKEN_PATTERN)) {
		const at = match.index ?? 0;
		const start = folded.starts[at]!;
		const end = folded.ends[at + match[0].length - 1]!;
		const between = folded.text.slice(previousFolded, at);
		// "p.m.": the period right after a dotted meridiem is its own, not a sentence end.
		const gap = meridiem && between.startsWith(".") ? between.slice(1) : between;
		if (tokens.length > 0) {
			const ended = SENTENCE_END.test(gap);
			if (ended) sentence++;
			if (ended || shown.subarray(previousEnd, start).includes(1)) run++;
		}
		const kind = TOKEN_KINDS[match.findIndex((group, index) => index > 0 && group !== undefined)] ?? "word";
		const original = text.slice(start, end);
		tokens.push({
			kind,
			text: match[6] ? `${match[6]}m` : match[0],
			start,
			end,
			gap: gap.trim(),
			run,
			sentence,
			capital: /^\p{Lu}/u.test(original),
			upper: kind === "word" && original.length >= 2 && /^\p{Lu}+$/u.test(original),
		});
		meridiem = match[6] !== undefined;
		previousEnd = end;
		previousFolded = at + match[0].length;
	}
	return tokens;
}

function foldedWords(text: string): string[] {
	return [...fold(text).text.matchAll(TOKEN_PATTERN)].map((match) => (match[6] ? `${match[6]}m` : match[0]));
}

/** The tokens wholly inside the excerpt; an excerpt edge that cuts a token ("9 hours" inside "19 hours") refuses. */
function excerptSpan(tokens: readonly Token[], excerpt: IntakeTextSpan): TokenSpan | undefined {
	let first = -1;
	let last = -1;
	for (const [index, token] of tokens.entries()) {
		if (
			(token.start < excerpt.start && token.end > excerpt.start) ||
			(token.start < excerpt.end && token.end > excerpt.end)
		)
			return undefined;
		if (token.start >= excerpt.start && token.end <= excerpt.end) {
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

/** The end of the longest listed phrase at `index` whose tokens lie before `end` and in no construct. */
function freePhrase(
	tokens: readonly Token[],
	index: number,
	end: number,
	phrases: readonly string[],
	covered: Uint8Array,
): number | undefined {
	let best: number | undefined;
	for (const phrase of phrases) {
		const parts = phrase.split(" ");
		if (index + parts.length > end) continue;
		if (parts.every((part, offset) => !covered[index + offset] && tokens[index + offset]!.text === part))
			best = Math.max(best ?? 0, index + parts.length);
	}
	return best;
}

/** A CI subject and an outcome word of one language, within the span. */
function readsCi(language: Language, tokens: readonly Token[], span: TokenSpan): boolean {
	return (
		language.ciSubjects.some((subject) => spanHas(tokens, span, subject)) &&
		Object.values(language.outcomes).some((phrases) => phrases.some((phrase) => spanHas(tokens, span, phrase)))
	);
}

const eventVocabularies = new Map<Language, readonly string[]>();

/** Everything a CI watch's excerpt may hold besides constructs: fillers, subjects, outcomes and lifetime words. */
function eventVocabulary(language: Language): readonly string[] {
	let vocabulary = eventVocabularies.get(language);
	if (!vocabulary) {
		vocabulary = [
			...language.fillers,
			...language.eventFillers,
			...language.ciSubjects,
			...Object.values(language.outcomes).flat(),
			...language.nextWords,
			...language.ifWords,
		];
		eventVocabularies.set(language, vocabulary);
	}
	return vocabulary;
}

const eventWordSets = new Map<Language, ReadonlySet<string>>();

/** Single words that carry a CI watch: its subjects, outcomes and lifetime words. */
function eventWords(language: Language): ReadonlySet<string> {
	let words = eventWordSets.get(language);
	if (!words) {
		words = new Set(
			[...language.ciSubjects, ...Object.values(language.outcomes).flat(), ...language.nextWords].filter(
				(phrase) => !phrase.includes(" "),
			),
		);
		eventWordSets.set(language, words);
	}
	return words;
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
	/** `8h`: exact on the 24-hour clock alone, yet read through a stated part of the day ("8h da noite"). */
	readonly hForm: boolean;
	/** First token of the stated time itself, after any marker such as "at". */
	readonly core: number;
}

type ConstructValue =
	| { readonly type: "refusal" }
	/** `marked`: named as a zone ("UTC", "Lisbon time", "hora de Lisboa"), not a bare city. */
	| { readonly type: "zone"; readonly zone: string; readonly marked: boolean }
	| { readonly type: "event"; readonly lifetime: "standing" | "next" }
	/** An until-word with words after it: those words are the stated end. */
	| { readonly type: "until" }
	| { readonly type: "allWeek" }
	| { readonly type: "monthDay"; readonly day: number }
	| { readonly type: "days"; readonly days: readonly number[]; readonly recurring: boolean }
	| { readonly type: "partCadence"; readonly part: PartOfDay }
	| { readonly type: "daily" }
	| { readonly type: "weekly" }
	| { readonly type: "monthly" }
	| { readonly type: "interval"; readonly every: number; readonly unit: IntervalUnit }
	| { readonly type: "todayPart"; readonly part: PartOfDay }
	| { readonly type: "part"; readonly part: PartOfDay; readonly recurring: boolean }
	| ClockValue
	| { readonly type: "date"; readonly date: DateRef };

/** A recognized construct over token indices `[start, end)`. */
type Construct = ConstructValue & { readonly start: number; readonly end: number };

type Hit = readonly [end: number, value: ConstructValue];
type ConstructReader = (reader: TokenReader, index: number) => Hit | undefined;

const REFUSAL: ConstructValue = { type: "refusal" };

/** Construct types that state a schedule on their own or with others; each successful compile derives from one. */
const SCHEDULE_TYPES: ReadonlySet<ConstructValue["type"]> = new Set([
	"interval",
	"weekly",
	"daily",
	"allWeek",
	"partCadence",
	"monthDay",
	"days",
	"clock",
	"todayPart",
	"date",
]);

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

	/** Skips up to two listed phrases. */
	skipPhrases(index: number, phrases: readonly string[]): number {
		let at = index;
		for (let step = 0; step < 2; step++) {
			const end = this.phrase(at, phrases);
			if (end === undefined) break;
			at = end;
		}
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

/**
 * UTC/GMT, "<city> time", "hora de <city>", or a bare city: the zone must then be the model's. A city that is also an
 * ordinary word ("Christmas", "Lima") counts only capitalized and marked as a zone. A UTC offset, a zone abbreviation
 * ("EST") and a zone name the runtime has no city for ("Pacific time", "horário de Brasília") refuse.
 */
function readZone(reader: TokenReader, index: number): Hit | undefined {
	const token = reader.token(index);
	const word = reader.word(index);
	if (!token || word === undefined) return undefined;
	if (word === "utc" || word === "gmt") {
		const offset = reader.token(index + 1);
		if (offset && offset.kind !== "word" && /^[+\-−±]$/u.test(offset.gap)) return [index + 2, REFUSAL];
		return [index + 1, { type: "zone", zone: canonicalCalendarTimeZone(word.toUpperCase()), marked: true }];
	}
	if (token.upper && ZONE_ABBREVIATIONS.has(word)) return [index + 1, REFUSAL];
	const language = reader.language;
	const before = reader.phrase(index, language.zoneBefore);
	if (before !== undefined) {
		const at = reader.skip(before, language.connectors);
		const city = readCity(reader, at);
		if (city && (!city.ordinary || reader.token(at)?.capital))
			return [city.end, { type: "zone", zone: city.zone, marked: true }];
		return reader.word(at) !== undefined && reader.token(at)?.capital ? [at + 1, REFUSAL] : undefined;
	}
	const city = readCity(reader, index);
	if (city) {
		const after = reader.phrase(city.end, language.zoneAfter);
		if (after !== undefined && (!city.ordinary || token.capital))
			return [after, { type: "zone", zone: city.zone, marked: true }];
		if (!city.ordinary) return [city.end, { type: "zone", zone: city.zone, marked: false }];
	}
	const after = language.zoneWords.includes(word) ? reader.phrase(index + 1, language.zoneAfter) : undefined;
	return after === undefined ? undefined : [after, REFUSAL];
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

function readCity(
	reader: TokenReader,
	index: number,
): { readonly end: number; readonly zone: string; readonly ordinary: boolean } | undefined {
	for (let length = 4; length >= 1; length--) {
		const words: string[] = [];
		for (let offset = 0; offset < length; offset++) words.push(reader.word(index + offset) ?? "\0");
		const name = words.join(" ");
		const zone = cityZones().get(name);
		if (zone !== undefined) return { end: index + length, zone, ordinary: ORDINARY_CITIES.has(name) };
	}
	return undefined;
}

/** Portuguese "de 2 em 2 horas": an interval when both numbers agree, else a refusal. */
function readStepInterval(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	if (!language.step || reader.word(index) !== language.step[0]) return undefined;
	const first = reader.number(index + 1);
	if (!first || reader.word(first[0]) !== language.step[1]) return undefined;
	const second = reader.number(first[0] + 1);
	if (!second) return undefined;
	const unit = language.units.get(reader.word(second[0]) ?? "");
	if (unit === undefined) return [second[0], REFUSAL];
	const every = first[1];
	return [
		second[0] + 1,
		unit === null || every !== second[1] || every < 1 || every > 10_000 ? REFUSAL : { type: "interval", every, unit },
	];
}

/** "every time", "whenever" (standing) or "the next time" (one-time) before a CI condition. */
function readEvent(reader: TokenReader, index: number): Hit | undefined {
	const standing = reader.phrase(index, reader.language.eventStanding);
	const next = reader.phrase(index, reader.language.eventNext);
	if (next !== undefined && (standing === undefined || next > standing))
		return [next, { type: "event", lifetime: "next" }];
	return standing === undefined ? undefined : [standing, { type: "event", lifetime: "standing" }];
}

const listedRefusals = new Map<Language, readonly string[]>();

/** Listed wordings the host cannot schedule exactly: exceptions, rare cadences, working hours, meal and day events. */
function readListedRefusal(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	let phrases = listedRefusals.get(language);
	if (!phrases) {
		phrases = [
			...language.refusalWords,
			...language.everyOther,
			...language.businessHours,
			...language.eventWords,
			...language.whileWords,
		];
		listedRefusals.set(language, phrases);
	}
	const end = reader.phrase(index, phrases);
	return end === undefined ? undefined : [end, REFUSAL];
}

/** The end of a time stated in digits or a named time at `index`, with its meridiem and hour word. */
function timeEnd(reader: TokenReader, index: number): number | undefined {
	const language = reader.language;
	const kind = reader.token(index)?.kind;
	let end =
		reader.entry(index, language.namedClocks)?.[0] ??
		(kind === "number" || kind === "clock" || kind === "hclock" || kind === "decimal" ? index + 1 : undefined);
	if (end === undefined) return undefined;
	const meridiem = reader.word(end);
	if (meridiem === "am" || meridiem === "pm") end++;
	return reader.phrase(end, language.hourWords) ?? end;
}

/** A window or range of times: "between 9 and 5", "from 9 to 17", "9-17", "9am to 5pm", "das 9 às 18". */
function readWindow(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const markers = [...language.connectors, ...language.clockMarkers, ...language.weakClockMarkers];
	const from = reader.phrase(index, language.windowFrom);
	if (from !== undefined) {
		const first = timeEnd(reader, reader.skipPhrases(from, markers));
		if (first === undefined) return undefined;
		const to = reader.phrase(first, [...language.windowTo, ...language.windowAnd]);
		const second = to === undefined ? undefined : timeEnd(reader, reader.skipPhrases(to, markers));
		return [second ?? first, REFUSAL];
	}
	const at = reader.phrase(index, language.clockMarkers) ?? reader.phrase(index, language.weakClockMarkers) ?? index;
	const first = timeEnd(reader, at);
	if (first === undefined) return undefined;
	const dashed = /^[-–—]$/u.test(reader.token(first)?.gap ?? "") ? timeEnd(reader, first) : undefined;
	if (dashed !== undefined) return [dashed, REFUSAL];
	const to = reader.phrase(first, language.windowTo);
	const second = to === undefined ? undefined : timeEnd(reader, reader.skipPhrases(to, markers));
	return second === undefined ? undefined : [second, REFUSAL];
}

/**
 * A duration or relative start: "for 2 weeks", "during the next hour", "in 10 minutes", "daqui a 5 minutos", "en los
 * próximos 3 días". A weak opener ("in", "nos", "en") needs a count or an upcoming-word before its unit.
 */
function readDuration(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const strong = reader.phrase(index, language.durations);
	const start = strong ?? reader.phrase(index, language.countedDurations);
	if (start === undefined) return undefined;
	let at = start;
	let upcoming = false;
	for (let step = 0; step < 4; step++) {
		const word = reader.word(at) ?? "";
		if (language.upcoming.includes(word)) upcoming = true;
		else if (!language.fillers.includes(word)) break;
		at++;
	}
	const count = reader.number(at);
	const unitAt = count ? count[0] : at;
	if (!language.units.has(reader.word(unitAt) ?? "")) return undefined;
	return strong !== undefined || count || upcoming ? [unitAt + 1, REFUSAL] : undefined;
}

/** A stated start: "starting Monday", "a partir de amanhã", "a partir del 5". */
function readStart(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const start = reader.phrase(index, language.starts);
	if (start === undefined) return undefined;
	const at = reader.skip(start, language.connectors);
	const timing = readConstruct(reader, at, TIMING_READERS);
	if (timing) return [timing[0], REFUSAL];
	const token = reader.token(at);
	const word = reader.word(at) ?? "";
	return token && (token.kind !== "word" || language.months.has(word) || language.ordinals.includes(word))
		? [at + 1, REFUSAL]
		: undefined;
}

/** A negation directly before timing, up to two fillers apart: "not on Fridays", "nunca à noite". */
function readNegation(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	let at = reader.phrase(index, language.negations);
	for (let step = 0; at !== undefined && step <= 2; step++) {
		const hit = readConstruct(reader, at, NEGATED_READERS);
		if (hit) return [hit[0], REFUSAL];
		at = reader.phrase(at, language.fillers);
	}
	return undefined;
}

/** "5/11", "5/11/2026": the day and month order is not stated. */
function readNumericDate(reader: TokenReader, index: number): Hit | undefined {
	if (reader.token(index)?.kind !== "number") return undefined;
	const second = reader.token(index + 1);
	if (second?.kind !== "number" || second.gap !== "/") return undefined;
	const third = reader.token(index + 2);
	return [third?.kind === "number" && third.gap === "/" ? index + 3 : index + 2, REFUSAL];
}

/** Wordings the host cannot compile faithfully; each refuses wherever the excerpts' sentences hold it. */
function readRefusal(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
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
		// "this week", "next month": a relative period, never a schedule. "the first day" is a date.
		const unit = reader.word(index + 1) ?? "";
		if (language.units.has(unit) && !language.dayWords.includes(unit)) return [index + 2, REFUSAL];
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
		const timing = language.within.includes(word)
			? undefined
			: (readConstruct(reader, at, TIMING_READERS)?.[0] ?? readListedRefusal(reader, at)?.[0]);
		if (month !== undefined || timing !== undefined) return [Math.max(month ?? 0, timing ?? 0), REFUSAL];
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

/** An until-word with words after it; an until-word before timing ("until Friday") is a refusal instead. */
function readUntil(reader: TokenReader, index: number): Hit | undefined {
	const end = reader.phrase(index, reader.language.until);
	return end !== undefined && reader.token(end) ? [end, { type: "until" }] : undefined;
}

const readAllWeek = phraseReader((language) => language.allWeek, { type: "allWeek" });
const readDaily = phraseReader((language) => language.daily, { type: "daily" });
const readWeekly = phraseReader((language) => language.weekly, { type: "weekly" });
const readMonthly = phraseReader((language) => language.monthly, { type: "monthly" });

/** "every 15th", "todo dia 15", "cada día 15": a day of every month; "todo dia 9 da manhã" is an hour instead. */
function readMonthDay(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const marker = reader.phrase(index, language.monthDayMarkers);
	if (marker === undefined) return undefined;
	const ordinal = reader.ordinalDay(marker);
	if (ordinal) return [ordinal[0], { type: "monthDay", day: ordinal[1] }];
	if (!language.bareMonthDay) return undefined;
	const number = reader.number(marker);
	if (number) {
		if (reader.phrase(number[0], language.hourWords) !== undefined || partFollows(reader, number[0]))
			return undefined;
		return number[1] >= 1 && number[1] <= 31 ? [number[0], { type: "monthDay", day: number[1] }] : undefined;
	}
	const first = reader.phrase(marker, language.first);
	return first === undefined ? undefined : [first, { type: "monthDay", day: 1 }];
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
	return hit && [hit[0], { type: "part", part: hit[1][0], recurring: hit[1][1] }];
}

/** A part of the day right after a number: "9 in the morning", "8 da noite", "9 de la mañana", "9 tonight". */
function partFollows(reader: TokenReader, index: number): boolean {
	if (readTodayPart(reader, index)) return true;
	return reader.language.partSuffixes.some((suffix) => {
		const at = reader.phrase(index, [suffix]);
		return at !== undefined && readPart(reader, at) !== undefined;
	});
}

function namedClock(reader: TokenReader, named: readonly [number, readonly [number, boolean]], core: number): Hit {
	const minutes = reader.entry(named[0], reader.language.namedMinutes);
	const minute = minutes?.[1] ?? 0;
	return [
		minutes?.[0] ?? named[0],
		{ type: "clock", hour: named[1][0], minute, exact: true, noon: named[1][1] && minute === 0, hForm: false, core },
	];
}

/**
 * A stated clock: `9:30`, `9h` and the noon and midnight words ("12 noon", "meio-dia e meia") stand alone. A plain
 * number needs a strong marker ("at", "às", "a las"), a meridiem, "o'clock" or a following part of the day; after a
 * weak marker (Portuguese "a", Spanish "la"/"las") it also takes an hour word or minutes. A decimal ("9.30") needs a
 * strong marker or a meridiem. Hours past 23, minutes past 59, another number before a named time and Spanish
 * "menos" refuse.
 */
function readClock(reader: TokenReader, index: number): Hit | undefined {
	const language = reader.language;
	const strong = reader.phrase(index, language.clockMarkers);
	const weak = strong === undefined ? reader.phrase(index, language.weakClockMarkers) : undefined;
	const marked = strong ?? weak;
	const core = marked ?? index;
	const token = reader.token(core);
	if (!token) return undefined;
	const twelve = token.kind === "number" ? reader.entry(core + 1, language.namedClocks) : undefined;
	if (twelve) return Number(token.text) === 12 ? namedClock(reader, twelve, core) : [twelve[0], REFUSAL];
	const named = reader.entry(core, language.namedClocks);
	if (named) return namedClock(reader, named, core);
	let hour: number;
	let minute = 0;
	let end = core + 1;
	let exact = false;
	let hForm = false;
	let plain = false;
	let decimal = false;
	let confirmed = false;
	if (token.kind === "clock" || token.kind === "hclock") {
		const [hours = "", minutes = ""] = token.text.split(/[:h]/u);
		hour = Number(hours);
		minute = minutes === "" ? 0 : Number(minutes);
		exact = token.kind === "hclock" || hours.startsWith("0");
		hForm = token.kind === "hclock" && !hours.startsWith("0") && hour >= 1 && hour <= 12;
	} else if (token.kind === "decimal") {
		const parts = /^(\d{1,2})[.,](\d{2})$/u.exec(token.text);
		if (!parts) return undefined;
		hour = Number(parts[1]);
		minute = Number(parts[2]);
		exact = parts[1]!.startsWith("0");
		decimal = true;
	} else {
		const count = reader.number(core);
		if (!count) return undefined;
		[end, hour] = count;
		plain = true;
		exact = token.kind === "number" && token.text.length === 2 && token.text.startsWith("0");
		const namedMinute = reader.entry(end, language.namedMinutes);
		const joined = language.minuteJoin.includes(reader.word(end) ?? "") ? reader.number(end + 1) : undefined;
		if (namedMinute) [end, minute] = namedMinute;
		else if (joined) [end, minute] = joined;
		confirmed = namedMinute !== undefined || joined !== undefined;
		const hours = reader.phrase(end, language.hourWords);
		if (hours !== undefined && marked !== undefined) {
			end = hours;
			confirmed = true;
		}
	}
	const suffix = reader.phrase(end, language.clockSuffixes);
	if (suffix !== undefined) end = suffix;
	const meridiem = reader.word(end);
	const stated = meridiem === "am" || meridiem === "pm";
	if (stated) end++;
	if (decimal && strong === undefined && !stated) return undefined;
	if (
		plain &&
		strong === undefined &&
		!stated &&
		suffix === undefined &&
		!partFollows(reader, end) &&
		!(weak !== undefined && confirmed)
	)
		return undefined;
	if (language.clockMinus.includes(reader.word(end) ?? ""))
		return [end + 2 <= reader.end ? end + 2 : end + 1, REFUSAL];
	if (minute > 59) return [end, REFUSAL];
	if (stated) {
		if (hour < 1 || hour > 12) return [end, REFUSAL];
		return [
			end,
			{
				type: "clock",
				hour: (hour % 12) + (meridiem === "pm" ? 12 : 0),
				minute,
				exact: true,
				noon: false,
				hForm: false,
				core,
			},
		];
	}
	if (hour > 23) return [end, REFUSAL];
	exact ||= hour === 0 || hour >= 13;
	return [end, { type: "clock", hour, minute, exact, noon: false, hForm, core }];
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
/** What a negation refuses when it stands right before it. */
const NEGATED_READERS: readonly ConstructReader[] = [readEvent, readListedRefusal, ...TIMING_READERS];
const CONSTRUCT_READERS: readonly ConstructReader[] = [
	readZone,
	readStepInterval,
	readEvent,
	readListedRefusal,
	readWindow,
	readDuration,
	readStart,
	readNegation,
	readNumericDate,
	readRefusal,
	readUntil,
	...TIMING_READERS,
];

// ---------------------------------------------------------------------------------------------------------------
// Derivation

interface Timed {
	readonly clock?: ClockValue & { readonly end: number };
	readonly part?: PartOfDay;
}

type Derived =
	| { readonly kind: "interval"; readonly every: number; readonly unit: IntervalUnit }
	| (Timed & { readonly kind: "monthly"; readonly day: number })
	| (Timed & { readonly kind: "daily"; readonly days: readonly number[] })
	| (Timed & { readonly kind: "once"; readonly date: DateRef });

const EVERY_DAY: readonly number[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * The schedule the excerpt's constructs state, each slot from exactly one construct; any conflict refuses. Daily
 * wording, a recurring part of the day and the whole week run on all seven days; named recurring days narrow daily
 * wording to them.
 */
function derive(constructs: readonly Construct[]): Derived | undefined {
	let interval: Extract<Construct, { type: "interval" }> | undefined;
	let clock: Extract<Construct, { type: "clock" }> | undefined;
	let part: PartOfDay | undefined;
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
			case "until":
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
	const timed: Timed = { ...(clock ? { clock } : {}), ...(part === undefined ? {} : { part }) };
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
		if (date || (weekly && !days) || (allWeek && days) || (days && !days.recurring && !weekly)) return undefined;
		return { ...timed, kind: "daily", days: days?.days ?? EVERY_DAY };
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
 * The hour: an exact clock as stated (a part of the day that contradicts it refuses); an hour without am or pm, or an
 * `8h` hour with a part of the day, read through the stated part, else on a 24-hour clock with the choice announced
 * (an `8h` hour alone is already 24-hour); a part of the day alone at its fixed hour; nothing at 09:00, announced.
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
		if (clock.exact && !(clock.hForm && part !== undefined)) {
			if (part !== undefined && !partHolds(part, hour)) return undefined;
			return { hour, minute, readings: [stamp(hour, minute)], defaults: [] };
		}
		if (part !== undefined) {
			const read = partReading(part, hour);
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

/** The cron day-of-week field of a daily request: the stated days, which the model's days must match when given. */
function intakeDays(
	stated: readonly number[],
	model: readonly (typeof WEEKDAYS)[number][] | undefined,
): { field: string; label: string } | undefined {
	const indices = model?.map((day) => WEEKDAYS.indexOf(day)).sort((left, right) => left - right);
	const key = stated.join(",");
	if (indices !== undefined && indices.join(",") !== key) return undefined;
	if (key === "0,1,2,3,4,5,6") return { field: "*", label: "every day" };
	if (key === "1,2,3,4,5") return { field: "1-5", label: "weekdays" };
	if (key === "0,6") return { field: "0,6", label: "weekends" };
	return { field: key, label: `every ${stated.map((day) => WEEKDAY_NAMES[day]).join(", ")}` };
}

/**
 * The routine's zone: the zone the excerpt states ("UTC", "Lisbon time", a city) must be exactly the model's, and the
 * model names none when the excerpt states none; then it is the host's zone.
 */
function intakeZone(
	stated: string | undefined,
	zones: readonly Construct[],
	hostZone: string,
	when: string,
): string | IntakeTimingRefusal {
	const named = new Set(zones.flatMap((construct) => (construct.type === "zone" ? [construct.zone] : [])));
	if (named.size > 1) return { refused: exactReason(when) };
	const [word] = named;
	if (stated === undefined) return word === undefined ? hostZone : { refused: differsReason(when) };
	let zone: string;
	try {
		zone = canonicalCalendarTimeZone(stated);
	} catch {
		return { refused: `the host cannot use the time zone of ${quoted(when)}` };
	}
	return zone === word ? zone : { refused: differsReason(when) };
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
// Language tables (accents removed, lowercase): the closed vocabulary. Each construct is read with one language's
// table only; digits, clock forms, am/pm, zones and zone abbreviations are shared.

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
	readonly partCadence: readonly (readonly [string, PartOfDay])[];
	readonly todayParts: readonly (readonly [string, PartOfDay])[];
	/** Words between a number and a part of the day that make the number an hour ("9 in the morning"). */
	readonly partSuffixes: readonly string[];
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
	/** "de N em N <unit>": the step interval's two words. */
	readonly step?: readonly [from: string, by: string];
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
	/** Markers that make any number an hour ("at", "às", "a las"). */
	readonly clockMarkers: readonly string[];
	/** Markers that are also ordinary words (Portuguese "a", Spanish "la"): an hour needs more words after the number. */
	readonly weakClockMarkers: readonly string[];
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
	/** Working hours: no fixed hour the host can schedule. */
	readonly businessHours: readonly string[];
	/** Meals, ends of day, meetings and the sun: events, not hours. */
	readonly eventWords: readonly string[];
	readonly whileWords: readonly string[];
	readonly negations: readonly string[];
	/** Openers of a time window ("between", "from", "das"); "to"-words and "and"-words close it. */
	readonly windowFrom: readonly string[];
	readonly windowTo: readonly string[];
	readonly windowAnd: readonly string[];
	/** Openers of a duration before a unit ("for", "durante"). */
	readonly durations: readonly string[];
	/** Openers that are a duration only with a count or an upcoming-word ("in 10 minutes", "nos próximos dias"). */
	readonly countedDurations: readonly string[];
	readonly upcoming: readonly string[];
	/** Openers of a stated start ("starting", "a partir de"). */
	readonly starts: readonly string[];
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
	readonly eventStanding: readonly string[];
	readonly eventNext: readonly string[];
	/** Bare words that make a CI watch one-time ("when", "quando", "cuando"). */
	readonly nextWords: readonly string[];
	/** Conditions that state no lifetime ("if", "se", "si"). */
	readonly ifWords: readonly string[];
	/** Words a CI watch's excerpt may hold around its subject and outcome ("is", "the", "der", "se"). */
	readonly eventFillers: readonly string[];
	/** Closed fillers a timing excerpt may hold around its constructs. */
	readonly fillers: readonly string[];
	readonly zoneBefore: readonly string[];
	readonly zoneAfter: readonly string[];
	/** Zone names without a city the runtime knows ("Pacific time"), which refuse. */
	readonly zoneWords: readonly string[];
	/** Timing words beyond the number, weekday, unit, month and date tables. */
	readonly anchors: readonly string[];
	/** Weekday and month abbreviations: never read, always timing. */
	readonly abbreviations: readonly string[];
	readonly ciSubjects: readonly string[];
	readonly outcomes: Readonly<Record<CiOutcome, readonly string[]>>;
}

const list = (phrases: string): readonly string[] => phrases.split("|");
const WORKWEEK = [1, 2, 3, 4, 5] as const;
const WEEKEND = [0, 6] as const;

/** Zone abbreviations a zone name could stand for in several ways; written in capitals, each refuses. */
const ZONE_ABBREVIATIONS: ReadonlySet<string> = new Set(
	list(
		"est|edt|cst|cdt|mst|mdt|pst|pdt|et|ct|mt|pt|akst|akdt|hst|cet|cest|eet|eest|wet|west|bst|ist|jst|kst|aest|aedt|acst|acdt|awst|nzst|nzdt|brt|brst|art|clt|clst|cot|pet|msk|sgt|hkt|pht|wib|ict",
	),
);

/** Zone cities whose names are also ordinary words or names: a zone only when capitalized and marked as one. */
const ORDINARY_CITIES: ReadonlySet<string> = new Set(
	list(
		"christmas|easter|wake|midway|center|resolute|oral|nome|lima|fortaleza|bahia|boa vista|phoenix|regina|stanley|casey|davis|palmer|troll|darwin|sydney|adelaide|sofia|santiago|jersey|guernsey|canary|madeira|reunion|cayenne|chihuahua|salta|cordoba|asuncion|antigua|cocos|lagos|anchorage|whitehorse|buenos aires|la paz|la rioja|el salvador|costa rica|puerto rico|santo domingo|los angeles|san juan|san luis|casablanca|recife|campo grande|porto velho|rio branco|porto novo|punta arenas|belem|grand turk|glace bay|goose bay|swift current|rankin inlet|cambridge bay|coral harbour|tell city|new salem|broken hill|lord howe|lower princes|beulah|creston|knox|marengo|monticello|vevay|winamac|petersburg|vincennes|chita|kirov|samara|mendoza|merida|norfolk|dawson|wallis|bermuda|bougainville|monaco|malta|truk",
	),
);

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
	partSuffixes: list("in the|at"),
	allWeek: list(
		"every single day|including weekends|including the weekend|7 days a week|seven days a week|all week|every day of the week|each day of the week",
	),
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
	weakClockMarkers: [],
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
	businessHours: list("business hours|working hours|work hours|office hours|opening hours|core hours|after hours"),
	eventWords: list(
		"lunch|lunchtime|lunch time|lunch break|breakfast|brunch|dinner|supper|eod|eob|cob|end of day|end of the day|end of business|close of business|end of the month|end of month|end of the week|end of week|start of the week|start of the month|beginning of the week|beginning of the month|standup|stand up|sunrise|sunset|dawn|dusk|bedtime",
	),
	whileWords: list("while|whilst|as long as|so long as"),
	negations: list("not|never|no|don t|dont|do not|doesn t|does not|won t|without"),
	windowFrom: list("between|from"),
	windowTo: list("to|through|thru|till|until"),
	windowAnd: list("and"),
	durations: list("for|during|over|within|throughout"),
	countedDurations: list("in"),
	upcoming: list("next|following|coming|few|couple|rest"),
	starts: list("starting|beginning|effective|as of|commencing|starting from|beginning from|starting on|beginning on"),
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
	eventStanding: list("every time|each time|whenever|any time|anytime|every single time"),
	eventNext: list("next time|the next time"),
	nextWords: list("when|once|as soon as"),
	ifWords: list("if|in case"),
	eventFillers: list(
		"is|are|was|were|be|gets|get|got|goes|go|went|turns|turn|turned|has|have|had|comes|come|back|run|runs|running|attempt|attempts|any|my|our|its|it|ever|again|whether|either|for|status|result|results",
	),
	fillers: list("a|an|the|at|on|in|of|and|or|please|pls|also|too|then|but|though|only|just|me|us|sharp"),
	zoneBefore: [],
	zoneAfter: list("time|timezone|time zone|standard time|daylight time"),
	zoneWords: list(
		"pacific|eastern|central|mountain|atlantic|alaska|alaskan|hawaii|hawaiian|arizona|brasilia|brazil|brazilian|british|european|india|indian|china|chinese|japan|japanese|korea|korean|australian|israel|greenwich|universal|zulu|coordinated|standard|daylight|summer|winter",
	),
	anchors: list(
		"every|each|daily|everyday|hourly|weekly|monthly|nightly|tonight|noon|midday|midnight|lunchtime|am|pm|clock|past|half|quarter|other|first|second|third|fourth|fifth|last|next|except|excluding|twice|thrice|yearly|annually|quarterly|biweekly|fortnightly|weekday|weekdays|weekend|weekends|workday|workdays|business|working|morning|mornings|afternoon|afternoons|evening|evenings|night|nights|utc|gmt",
	),
	abbreviations: list("mon|tue|tues|wed|weds|thu|thur|thurs|fri|jan|feb|apr|jun|jul|aug|sep|sept|oct|nov"),
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
	partSuffixes: list("da|de|pela|a"),
	allWeek: list(
		"todo santo dia|7 dias por semana|sete dias por semana|7 dias na semana|sete dias na semana|toda a semana|a semana toda|a semana inteira|inclusive fins de semana|inclusive nos fins de semana|incluindo fins de semana|incluindo os fins de semana|inclusive fim de semana|incluindo o fim de semana|todos os dias da semana|todo dia da semana|cada dia da semana",
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
	step: ["de", "em"],
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
	clockMarkers: list("as|pelas|ao"),
	weakClockMarkers: list("a"),
	clockSuffixes: [],
	hourWords: list("horas|hora|h"),
	namedClocks: [
		["meio dia", [12, true]],
		["meia noite", [0, false]],
	],
	minuteJoin: list("e"),
	namedMinutes: [
		["e meia", 30],
		["e um quarto", 15],
		["e quarto", 15],
	],
	clockMinus: [],
	refusalWords: list(
		"exceto|excluindo|salvo|menos|anual|anualmente|quinzenal|quinzenalmente|bimestral|trimestral|semestral|depois de amanha",
	),
	everyOther: list("dia sim dia nao|dia sim e dia nao|semana sim semana nao"),
	businessHours: list(
		"horario comercial|horario de trabalho|horario de expediente|horario de servico|horario util|horas uteis|expediente",
	),
	eventWords: list(
		"almoco|hora do almoco|cafe da manha|jantar|janta|fim do dia|final do dia|fim do expediente|final do expediente|fim do mes|final do mes|inicio do mes|comeco do mes|fim da semana|final da semana|inicio da semana|reuniao|nascer do sol|por do sol|amanhecer|anoitecer",
	),
	whileWords: list("enquanto|contanto que"),
	negations: list("nao|nunca|nem|jamais|sem"),
	windowFrom: list("entre|de|da|das|desde"),
	windowTo: list("a|as|ate"),
	windowAnd: list("e"),
	durations: list("durante|por|daqui a|dentro de|ao longo de"),
	countedDurations: list("em|nos|nas|pelos|pelas"),
	upcoming: list("proximos|proximas|seguintes"),
	starts: list("a partir de|a partir do|a partir da|a partir das|a partir dos|comecando|iniciando"),
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
	eventStanding: list(
		"toda vez|toda vez que|sempre que|cada vez|cada vez que|todas as vezes|todas as vezes que|qualquer vez que",
	),
	eventNext: list(
		"proxima vez|proxima vez que|a proxima vez|a proxima vez que|na proxima vez|na proxima vez que|da proxima vez|da proxima vez que",
	),
	nextWords: list("quando|assim que|logo que"),
	ifWords: list("se|caso"),
	eventFillers: list(
		"der|derem|fica|ficar|ficou|ficarem|estiver|estiverem|esta|estao|for|forem|seja|meu|minha|nosso|nossa|algum|alguma|que|execucao|execucoes|rodada|resultado|rodar|rodarem|voltar|novamente|de novo",
	),
	fillers: list(
		"o|a|os|as|de|da|do|das|dos|em|no|na|nos|nas|e|ou|ao|aos|pela|pelo|pelas|pelos|por favor|favor|tambem|me|so|somente|apenas|entao|mas",
	),
	zoneBefore: list("hora|horario|fuso|fuso horario|hora oficial"),
	zoneAfter: [],
	zoneWords: [],
	anchors: list(
		"todo|toda|todos|todas|cada|diariamente|diario|diaria|semanal|semanalmente|mensal|mensalmente|anual|anualmente|quinzenal|quinzenalmente|bimestral|trimestral|semestral|meio|meia|quarto|util|uteis|fim|fins|final|finais|exceto|excluindo|salvo|menos|vez|vezes|primeiro|primeira|ultimo|ultima|proximo|proxima|feira|feiras|manha|manhas|tarde|tardes|noite|noites|utc|gmt",
	),
	abbreviations: list("seg|qua|qui|sab|jan|fev|abr|mai|jun|jul|dez"),
	ciSubjects: list("ci|build|builds|pipeline|pipelines|workflow|workflows|job|jobs|teste|testes|checks|actions"),
	outcomes: {
		failure: list(
			"falha|falhas|falhar|falhou|falharem|falhando|falho|falhe|falhem|der erro|deu erro|der falha|derem erro|quebra|quebrar|quebrou|quebrado|quebrada|vermelho|vermelha",
		),
		success: list("passa|passar|passou|passarem|passando|passe|passem|sucesso|aprovado|aprovada|aprovar|verde"),
		cancelled: list("cancelado|cancelada|cancelar|cancelou|cancele|cancelamento"),
		timed_out: list("expira|expirar|expirou|tempo esgotado|timeout"),
		skipped: list("pulado|pulada|pular|pulou|ignorado|ignorada"),
		neutral: list("neutro|neutra"),
		action_required: list("requer acao|exige acao|acao necessaria"),
		stale: [],
		finish: list(
			"termina|terminar|terminou|terminarem|termine|terminem|conclui|concluir|concluiu|conclua|acaba|acabar|acabou|acabe|acabem|finaliza|finalizar|finalizou|finalize",
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
	partCadence: partList({
		morning: "cada manana|todas las mananas",
		afternoon: "cada tarde|todas las tardes",
		night: "cada noche|todas las noches",
	}),
	todayParts: partList({ morning: "esta manana", afternoon: "esta tarde", night: "esta noche" }),
	partSuffixes: list("de|de la|por|por la"),
	allWeek: list(
		"toda la semana|7 dias a la semana|siete dias a la semana|incluidos los fines de semana|incluidos fines de semana|incluyendo los fines de semana|incluyendo fines de semana|todos los dias de la semana|cada dia de la semana",
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
	clockMarkers: list("a las|a la"),
	weakClockMarkers: list("las|la"),
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
	businessHours: list(
		"horario laboral|horario de oficina|horario comercial|horario de trabajo|horas de oficina|horas laborales|horas habiles|jornada laboral",
	),
	eventWords: list(
		"almuerzo|hora del almuerzo|hora de comer|comida|comer|desayuno|cena|fin del dia|final del dia|fin de la jornada|final de la jornada|fin de mes|fin del mes|final del mes|inicio del mes|principio de mes|reunion|amanecer|atardecer|anochecer",
	),
	whileWords: list("mientras|mientras que"),
	negations: list("no|nunca|jamas|ni|sin"),
	windowFrom: list("entre|de|del|desde"),
	windowTo: list("a|al|hasta|a las"),
	windowAnd: list("y"),
	durations: list("durante|por|dentro de|a lo largo de"),
	countedDurations: list("en|los|las"),
	upcoming: list("proximos|proximas|siguientes"),
	starts: list("a partir de|a partir del|empezando|comenzando|iniciando"),
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
	eventStanding: list("cada vez|cada vez que|siempre que|todas las veces|todas las veces que"),
	eventNext: list("proxima vez|proxima vez que|la proxima vez|la proxima vez que"),
	nextWords: list("cuando|en cuanto|apenas|tan pronto como"),
	ifWords: list("si|en caso de que"),
	eventFillers: list(
		"se|este|esten|quede|queda|quedan|ponga|pone|ponen|mi|mis|nuestro|nuestra|algun|alguna|que|ejecucion|ejecuciones|resultado|sea|esta|estan|vuelva|de nuevo|otra vez",
	),
	fillers: list("el|la|los|las|de|del|a|al|en|y|e|o|u|por|por favor|favor|tambien|me|solo|solamente|pero|entonces"),
	zoneBefore: list("hora|horario|huso horario|hora oficial"),
	zoneAfter: [],
	zoneWords: [],
	anchors: list(
		"todos|todas|cada|diario|diaria|diariamente|semanal|semanalmente|mensual|mensualmente|anual|anualmente|quincenal|quincenalmente|bimestral|trimestral|semestral|mediodia|medianoche|media|cuarto|laborables|laborable|habiles|habil|fin|fines|excepto|salvo|excluyendo|menos|vez|veces|primer|primero|primera|ultimo|ultima|proximo|proxima|manana|mananas|tarde|tardes|noche|noches|utc|gmt",
	),
	abbreviations: list("lun|mie|jue|vie|ene|abr|dic"),
	ciSubjects: list(
		"ci|build|builds|pipeline|pipelines|workflow|workflows|job|jobs|prueba|pruebas|test|tests|checks|actions",
	),
	outcomes: {
		failure: list(
			"falla|fallas|fallar|fallo|fallan|falle|fallen|fallido|fallida|fallando|rompe|romper|rompio|rompa|rompan|roto|rota|rojo|roja",
		),
		success: list("pasa|pasar|paso|pasan|pase|pasen|exito|exitoso|exitosa|verde"),
		cancelled: list("cancelado|cancelada|cancelar|cancelo|cancele|cancelen"),
		timed_out: list("expira|expirar|expiro|tiempo agotado|timeout"),
		skipped: list("omitido|omitida|saltado|saltada"),
		neutral: list("neutro|neutra"),
		action_required: list("requiere accion|accion requerida"),
		stale: [],
		finish: list(
			"termina|terminar|termino|terminen|termine|concluye|concluir|concluyo|concluya|acaba|acabar|acabo|acabe|acaben|finaliza|finalizar|finalizo|finalice",
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
		...language.abbreviations,
	]).filter((word) => !NOT_ANCHORS.has(word)),
);

/** Digits, clock forms and other digits always carry timing; words do when any table lists them as timing words. */
function isAnchor(token: Token): boolean {
	return token.kind !== "word" || ANCHORS.has(token.text);
}
