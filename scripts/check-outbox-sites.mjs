#!/usr/bin/env node
/**
 * Outbox call-site ratchet: every call of an outward transport in the coding-agent source is declared in
 * scripts/outbox-sites.json by its file, transport token and enclosing function. An undeclared call fails, and a declared
 * function that no longer makes the call fails too, so the list pins the present set. Each entry also pins how many calls
 * its function may make (`count`). A declared site without a `reason` is an adopter of kernel/outbox.ts: its function must
 * run `claimThenEffect(` with a literal object whose `effect:` callback holds every one of those calls (`effectCount`
 * equals `count`), so a call added anywhere else in the function fails. A declared site with a `reason` is an exception,
 * and the reason states why its record comes before its effect.
 *
 *   node scripts/check-outbox-sites.mjs          check (exit 1 on any failure)
 *   node scripts/check-outbox-sites.mjs --list   print every resolved call site
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRelative, walkTypeScriptFiles } from "./lib/ratchet-files.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const scopeDirectory = join(root, "packages/coding-agent/src");
const sitesPath = join(root, "scripts/outbox-sites.json");
const adopterCall = "claimThenEffect(";

/** The transport tokens. `function appendOutwardDraftReleased(` is a declaration, not a call, and is skipped. */
const TRANSPORT_TOKENS = ["this.sendParts(", "deps.deliver(", "appendOutwardDraftReleased(", "options.notify("];

/** A class method (at most one tab of indent) or a top-level function: `name(` opens the line. */
const FUNCTION_LINE =
	/^(\t?)(?:export\s+)?(?:(?:public|private|protected|static|async|readonly|override)\s+)*(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
/** An arrow bound to a name at the same indentation: `const name = (…) =>` or a class property `name = (…) =>`. */
const ARROW_LINE = /^(\t?)(?:export\s+)?(?:(?:public|private|protected|static|readonly)\s+)*(?:const\s+|let\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?\(/;
const NOT_DECLARATIONS = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"await",
	"new",
	"else",
	"do",
	"try",
	"throw",
	"typeof",
	"super",
]);

/** The name a line declares, when it opens a method, a top-level function or an arrow bound to a name. */
function declaredName(line) {
	if (!line.trimEnd().endsWith(";")) {
		const fn = FUNCTION_LINE.exec(line);
		if (fn && !NOT_DECLARATIONS.has(fn[2])) return fn[2];
	}
	const arrow = ARROW_LINE.exec(line);
	if (arrow && line.includes("=>") && !NOT_DECLARATIONS.has(arrow[2])) return arrow[2];
	return undefined;
}

/** A line that closes a method or a top-level block. Scanning upward past it leaves the enclosing function. */
const closesBlock = (line) => /^\t?\}/.test(line);
const isCommentLine = (line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/** The line index of the declaration enclosing `index`, or -1 for module-level code. */
function enclosingDeclaration(lines, index) {
	for (let line = index; line >= 0; line--) {
		if (line < index && closesBlock(lines[line])) return -1;
		if (declaredName(lines[line]) !== undefined) return line;
	}
	return -1;
}

/** The line index that closes a declaration's block, or `lines.length` when the block never closes. */
function closingLine(lines, declarationIndex) {
	for (let line = declarationIndex + 1; line < lines.length; line++) {
		if (closesBlock(lines[line])) return line;
	}
	return lines.length;
}

/** The offset in `lines.join("\n")` where each line starts. */
function lineStartsOf(lines) {
	const starts = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}
	return starts;
}

/** Comments and the text of string and template literals, blanked to spaces. Offsets and line breaks are kept. */
const NON_CODE = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\[\s\S])*'|"(?:[^"\\\n]|\\[\s\S])*"|`(?:[^`\\]|\\[\s\S])*`/g;
const maskNonCode = (text) => text.replace(NON_CODE, (match) => match.replace(/[^\n]/g, " "));

/** The masked source of a file, built once when a function of the file is first resolved. */
function maskedSource(source) {
	source.masked ??= maskNonCode(source.lines.join("\n"));
	return source.masked;
}

const BRACKET_CLOSER = { "(": ")", "{": "}", "[": "]" };
const isCloser = (ch) => ch === ")" || ch === "}" || ch === "]";

/** The offset of the bracket that closes the one opened at `open`, or -1 when the brackets do not balance. */
function closingBracket(masked, open) {
	const expected = [];
	for (let at = open; at < masked.length; at++) {
		const ch = masked[at];
		if (BRACKET_CLOSER[ch] !== undefined) expected.push(BRACKET_CLOSER[ch]);
		else if (isCloser(ch)) {
			if (expected.pop() !== ch) return -1;
			if (expected.length === 0) return at;
		}
	}
	return -1;
}

/** The comma-separated members of a masked object body between `from` and `to`, as [start, end) offsets. */
function members(masked, from, to) {
	const spans = [];
	let depth = 0;
	let start = from;
	for (let at = from; at < to; at++) {
		const ch = masked[at];
		if (BRACKET_CLOSER[ch] !== undefined) depth++;
		else if (isCloser(ch)) depth--;
		else if (ch === "," && depth === 0) {
			spans.push({ start, end: at });
			start = at + 1;
		}
	}
	spans.push({ start, end: to });
	return spans;
}

const memberKey = (text) => /^\s*([A-Za-z_$][\w$]*)/.exec(text)?.[1];

/**
 * The [start, end) offsets of the `effect:` callback of every `claimThenEffect(` call that starts in [from, to) of masked
 * source. A call resolves only when its argument is a literal object with exactly one `effect:` member. Anything else (a
 * variable argument, a shorthand or method `effect`, unbalanced brackets) returns undefined, which fails the check.
 */
function effectCallbacks(masked, from, to) {
	const callbacks = [];
	for (
		let at = masked.indexOf(adopterCall, from);
		at !== -1 && at < to;
		at = masked.indexOf(adopterCall, at + adopterCall.length)
	) {
		const open = at + adopterCall.length - 1;
		const close = closingBracket(masked, open);
		if (close === -1 || close >= to) return undefined;
		let objectOpen = open + 1;
		while (objectOpen < close && /\s/.test(masked[objectOpen])) objectOpen++;
		const objectClose = masked[objectOpen] === "{" ? closingBracket(masked, objectOpen) : -1;
		if (objectClose === -1 || objectClose > close) return undefined;
		const effects = members(masked, objectOpen + 1, objectClose)
			.map((member) => ({ ...member, text: masked.slice(member.start, member.end) }))
			.filter((member) => memberKey(member.text) === "effect");
		const valueStart = effects.length === 1 ? /^\s*effect\s*:/.exec(effects[0].text) : null;
		if (valueStart === null) return undefined;
		callbacks.push({ start: effects[0].start + valueStart[0].length, end: effects[0].end });
	}
	return callbacks;
}

/** The effect callbacks of the function a site sits in, cached per function. [] when none; undefined when unresolvable. */
const callbackCache = new Map();
function callbacksOf(site) {
	if (site.declarationIndex === -1) return [];
	const cacheKey = `${site.file}\u0000${site.declarationIndex}`;
	if (!callbackCache.has(cacheKey)) {
		const { source, declarationIndex } = site;
		const closing = closingLine(source.lines, declarationIndex);
		const masked = maskedSource(source);
		const end = closing === source.lines.length ? masked.length : source.lineStarts[closing];
		callbackCache.set(cacheKey, effectCallbacks(masked, source.lineStarts[declarationIndex], end));
	}
	return callbackCache.get(cacheKey);
}

const isInside = (site, callbacks) => callbacks.some((span) => site.offset >= span.start && site.offset < span.end);

const key = (file, transport, enclosing) => `${file}\u0000${transport}\u0000${enclosing}`;

const failures = [];
const declared = new Map();
const sitesDocument = JSON.parse(readFileSync(sitesPath, "utf8"));
for (const [index, site] of sitesDocument.sites.entries()) {
	const where = `scripts/outbox-sites.json sites[${index}]`;
	if (typeof site.file !== "string" || site.file.length === 0) failures.push(`${where}: file must be a path string`);
	if (!TRANSPORT_TOKENS.includes(site.transport)) failures.push(`${where}: transport "${site.transport}" is not a known token`);
	if (!Array.isArray(site.enclosing) || site.enclosing.length === 0 || site.enclosing.some((name) => typeof name !== "string"))
		failures.push(`${where}: enclosing must be a non-empty list of function names`);
	if (site.reason !== undefined && (typeof site.reason !== "string" || site.reason.trim().length === 0))
		failures.push(`${where}: reason, when present, must be a non-empty string`);
	if (!Number.isInteger(site.count) || site.count < 1)
		failures.push(`${where}: count must be a positive integer, the number of ${site.transport} calls its function may contain`);
	if (site.reason === undefined) {
		if (!Number.isInteger(site.effectCount) || site.effectCount !== site.count)
			failures.push(
				`${where}: an adopter needs effectCount equal to count: every call of an adopter sits inside its ${adopterCall} effect callback`,
			);
	} else if (site.effectCount !== undefined)
		failures.push(`${where}: effectCount applies to adopters only; an exception has no effect callback`);
	if (typeof site.file !== "string" || !Array.isArray(site.enclosing)) continue;
	for (const name of site.enclosing) {
		const entryKey = key(site.file, site.transport, name);
		if (declared.has(entryKey)) failures.push(`${where}: ${site.transport} in ${name} is declared twice`);
		declared.set(entryKey, {
			adopter: site.reason === undefined,
			reason: site.reason,
			where,
			count: site.count,
			effectCount: site.effectCount,
		});
	}
}

const resolved = [];
const filesScanned = walkTypeScriptFiles(scopeDirectory);
for (const path of filesScanned) {
	const file = repoRelative(root, path);
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const source = { file, lines, lineStarts: lineStartsOf(lines), masked: undefined };
	lines.forEach((line, index) => {
		if (isCommentLine(line)) return;
		for (const transport of TRANSPORT_TOKENS) {
			for (let at = line.indexOf(transport); at !== -1; at = line.indexOf(transport, at + transport.length)) {
				if (/\bfunction\s+$/.test(line.slice(0, at))) continue;
				const declarationIndex = enclosingDeclaration(lines, index);
				const enclosing = declarationIndex === -1 ? "<module>" : declaredName(lines[declarationIndex]);
				resolved.push({
					file,
					line: index + 1,
					transport,
					enclosing,
					source,
					declarationIndex,
					offset: source.lineStarts[index] + at,
				});
			}
		}
	});
}

/** Per entry: the calls found, how many sit in the effect callback, and the lines they are on. */
const tally = new Map();
for (const site of resolved) {
	const entryKey = key(site.file, site.transport, site.enclosing);
	const entry = declared.get(entryKey);
	if (!entry) {
		failures.push(
			`${site.file}:${site.line}: ${site.transport.replace(/\($/, "")} is called in ${site.enclosing} and is not declared in scripts/outbox-sites.json. Route it through kernel/outbox.ts, or declare it with the reason its record comes before the effect.`,
		);
		continue;
	}
	const counted = tally.get(entryKey) ?? { total: 0, inEffect: 0, lines: [], unresolved: false };
	tally.set(entryKey, counted);
	counted.total++;
	counted.lines.push(site.line);
	if (!entry.adopter) continue;
	const callbacks = callbacksOf(site);
	if (callbacks === undefined) {
		counted.unresolved = true;
		failures.push(
			`${site.file}:${site.line}: ${site.enclosing} is declared as an adopter of kernel/outbox.ts, but its ${adopterCall} effect callback cannot be resolved; the effect must be the \`effect:\` member of a literal object.`,
		);
	} else if (callbacks.length === 0) {
		counted.unresolved = true;
		failures.push(
			`${site.file}:${site.line}: ${site.enclosing} is declared as an adopter of kernel/outbox.ts but does not run ${adopterCall}`,
		);
	} else if (isInside(site, callbacks)) counted.inEffect++;
}
for (const [entryKey, entry] of declared) {
	const [file, transport, enclosing] = entryKey.split("\u0000");
	const name = transport.replace(/\($/, "");
	const counted = tally.get(entryKey);
	if (!counted) {
		failures.push(`scripts/outbox-sites.json: ${name} in ${enclosing} (${file}) has no call; remove it.`);
		continue;
	}
	const subject = `${entry.where}: ${name} in ${enclosing} (${file})`;
	if (counted.total !== entry.count)
		failures.push(
			`${subject}: found ${counted.total} call(s), at line(s) ${counted.lines.join(", ")}; expected count ${entry.count}. Set count to the calls the function may contain.`,
		);
	if (entry.adopter && !counted.unresolved && counted.inEffect !== entry.effectCount)
		failures.push(
			`${subject}: found ${counted.inEffect} call(s) inside its ${adopterCall} effect callback; expected effectCount ${entry.effectCount}.`,
		);
}

if (process.argv.includes("--list")) {
	for (const site of resolved) {
		const entry = declared.get(key(site.file, site.transport, site.enclosing));
		let kind = entry ? `exception: ${entry.reason}` : "UNDECLARED";
		if (entry?.adopter) {
			const callbacks = callbacksOf(site);
			const placement =
				callbacks === undefined ? "effect unresolved" : isInside(site, callbacks) ? "inside effect" : "outside effect";
			kind = `adopter, ${placement}`;
		}
		console.log(`${site.file}:${site.line}  ${site.transport.replace(/\($/, "")} in ${site.enclosing}  [${kind}]`);
	}
}

if (failures.length > 0) {
	console.error("check-outbox-sites: the outward call-site ratchet failed:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
const adopters = [...declared.values()].filter((entry) => entry.adopter).length;
console.log(
	`check-outbox-sites: ${resolved.length} outward call site(s) found in ${filesScanned.length} scanned file(s), all declared; ${adopters} adopt kernel/outbox.ts, ${declared.size - adopters} are declared exceptions.`,
);
