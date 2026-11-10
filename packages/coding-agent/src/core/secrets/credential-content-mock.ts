import { redactKnownSecrets } from "../security/secret-text.ts";
import type { SourceDialect } from "../security/source-scanner.ts";
import { createSourceBlockMask } from "./source-mask.ts";

/**
 * Credential content mock stream.
 *
 * The model keeps every capability (search, read, inspect) and loses only the secret values: a
 * dotenv assignment keeps its key, a JSON/YAML secret keeps its key, key material becomes one
 * placeholder, and known or secret-shaped values are replaced. Values are mocked in place so the
 * output keeps its shape (line numbers, `path:line:` prefixes, structure) and stays useful.
 */

const MOCK_PREFIX = "<mocked:";
const MOCK_SUFFIX = ">";
const MAX_MOCKED_LINES = 200_000;

/** Optional read-tool `N: ` / grep `path:N:` style prefixes precede a line's own content. */
/** The line-number prefix a numbered output puts before a line: none, `N: ` or `N` and a tab. */
export const LINE_PREFIX_RE = /^(\s*(?:\d+[:\t]\s?)?)/u;
const DOTENV_ASSIGNMENT_RE = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.-]*)(\s*[=:]\s*)(\S.*)$/u;
const SECRET_KEY_WORDS = new Set([
	"password",
	"passwd",
	"passphrase",
	"pwd",
	"secret",
	"secrets",
	"token",
	"tokens",
	"key",
	"keys",
	"apikey",
	"credential",
	"credentials",
	"auth",
	"authorization",
	"bearer",
	"signature",
	"cookie",
	"cookies",
	"session",
	"sessionid",
	"dsn",
	"connectionstring",
]);
const STRUCTURED_PAIR_RE =
	/^(\s*["']?)([A-Za-z_][A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^"',}\]]*)(["']?)(\s*,?\s*)$/u;
const PEM_BEGIN_RE = /^\s*-----BEGIN ([A-Z ]*(?:PRIVATE KEY|CERTIFICATE|KEY))-----/u;
const PEM_END_RE = /^\s*-----END [A-Z ]*(?:PRIVATE KEY|CERTIFICATE|KEY)-----/u;
/** A Windows drive letter carries its own colon; the attribution colon is the next one. */
const SEARCH_LINE_COLON_RE = /^((?:[A-Za-z]:(?=[\\/]))?[^:\r\n]{1,1024}?):(\d+[:-])?(.*)$/u;
const SEARCH_LINE_CONTEXT_RE = /^([^\r\n]{1,1024}?)-(\d+)-(.*)$/u;

export function mockedValue(name: string): string {
	return `${MOCK_PREFIX}${name}${MOCK_SUFFIX}`;
}

/** `refreshToken`, `api_key`, `DB-PASSWORD` all name a secret; `author` does not. */
export function isCredentialSecretKey(key: string): boolean {
	const words = key
		.replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter((word) => word.length > 0);
	// A worktree lane key is a public operation selector, carried verbatim between tool results and calls.
	// Values still pass through the independent known/secret-shaped value redactor.
	if (words.join("") === "lanekey") return false;
	if (["source", "path", "name", "names", "count", "type"].includes(words.at(-1) ?? "")) return false;
	return words.some((word) => SECRET_KEY_WORDS.has(word)) || SECRET_KEY_WORDS.has(words.join(""));
}

function mockAssignment(line: string): string | undefined {
	const prefix = LINE_PREFIX_RE.exec(line)?.[1] ?? "";
	const body = line.slice(prefix.length);
	// Base64 padding is not a dotenv separator; retaining its left side exposes a raw session key.
	if (/^[A-Za-z0-9+/_-]{32,}={0,2}\s*$/u.test(body)) return `${prefix}${mockedValue("credential content")}`;
	if (/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*$/u.test(body)) return line;
	const assignment = DOTENV_ASSIGNMENT_RE.exec(body);
	if (!assignment) return undefined;
	const [, lead, key, separator, value] = assignment;
	if (value.startsWith("#")) return undefined;
	return `${prefix}${lead}${key}${separator}${mockedValue(key)}`;
}

function mockStructuredSecret(line: string): string | undefined {
	const prefix = LINE_PREFIX_RE.exec(line)?.[1] ?? "";
	const body = line.slice(prefix.length);
	const pair = STRUCTURED_PAIR_RE.exec(body);
	if (!pair) return undefined;
	const [, lead, key, separator, openQuote, value, closeQuote, tail] = pair;
	if (!value || !isCredentialSecretKey(key)) return undefined;
	return `${prefix}${lead}${key}${separator}${openQuote}${mockedValue(key)}${closeQuote}${tail}`;
}

/** A line that kept its key and lost its value needs no further redaction; other lines still do. */
function mockLine(line: string, whole: boolean): string {
	const mocked = whole ? (mockAssignment(line) ?? mockStructuredSecret(line)) : mockStructuredSecret(line);
	if (mocked !== undefined) return mocked;
	if (whole) {
		const prefix = LINE_PREFIX_RE.exec(line)?.[1] ?? "";
		const body = line.slice(prefix.length).trim();
		// Raw key/session files and partial compact JSON must not pass through merely because
		// their values have no recognized provider prefix or the closing quote has not arrived.
		if (body && !body.startsWith("#") && !/^[{}[\],]+$/u.test(body) && (/^\S+$/u.test(body) || /^[{[]/u.test(body))) {
			return `${prefix}${mockedValue("credential content")}`;
		}
	}
	return redactKnownSecrets(line);
}

function mockJsonCredentials(value: unknown, sensitive = false, depth = 0): unknown {
	if (depth >= 32) return mockedValue("nested credential content");
	if (Array.isArray(value)) return value.map((entry) => mockJsonCredentials(entry, sensitive, depth + 1));
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return Object.fromEntries(
			Object.entries(record).map(([key, entry]) => [
				key,
				mockJsonCredentials(
					entry,
					sensitive || isCredentialSecretKey(key) || (key === "value" && typeof record.name === "string"),
					depth + 1,
				),
			]),
		);
	}
	return sensitive ? mockedValue("credential value") : typeof value === "string" ? redactKnownSecrets(value) : value;
}

/**
 * A mask over the lines of one output, applied in order: it keeps what earlier lines opened (a PEM block, a search
 * group). Undefined drops the line.
 */
type LineMask = (line: string) => string | undefined;

function maskLines(text: string, mask: LineMask): string {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const masked = mask(line);
		if (masked !== undefined) out.push(masked);
	}
	return out.join("\n");
}

/** A quoted pair, `"key": "value"`: its value runs to its closing quote, or to the end of the text when none closes it. */
const QUOTED_PAIR_RE = /"([A-Za-z_][A-Za-z0-9_.-]*)"(\s*:\s*)"(?:\\.|[^"\\\r\n])*(?:"|$)/gu;

/** Quoted JSON pairs whose key names a secret, anywhere in the text (a pair may span a line break before its value). */
function mockQuotedSecretFields(text: string): string {
	return text.replace(QUOTED_PAIR_RE, (match, key: string, separator: string) =>
		isCredentialSecretKey(key) ? `"${key}"${separator}"${mockedValue(key)}"` : match,
	);
}

/**
 * `line` as the quoted-pair rule leaves it when it is read after `before`, a line break apart, and a secret pair spans
 * that break: its key ends `before` and its value starts `line`. Undefined when no secret pair spans the break. `line`
 * holds no line break of its own.
 */
export function mockQuotedSecretPairAcrossBreak(before: string, line: string): string | undefined {
	const breakAt = before.length;
	let spans = false;
	const mocked = `${before}\n${line}`.replace(
		QUOTED_PAIR_RE,
		(match, key: string, separator: string, offset: number) => {
			if (!isCredentialSecretKey(key)) return match;
			if (offset < breakAt && offset + match.length > breakAt + 1) spans = true;
			return `"${key}"${separator}"${mockedValue(key)}"`;
		},
	);
	return spans ? mocked.slice(mocked.lastIndexOf("\n") + 1) : undefined;
}

const fieldLineMask: LineMask = (line) => mockLine(line, false);

/** Named secrets in ordinary consumer output, including partial compact JSON snapshots. */
export function mockCredentialFields(text: string): string {
	const fields = mockQuotedSecretFields(text);
	if (fields.split("\n").length > MAX_MOCKED_LINES) return mockedValue("credential output exceeds line limit");
	return maskLines(fields, fieldLineMask);
}

/** Every line of credential content: a PEM block becomes one placeholder, every other line its mock. */
function createContentLineMask(): LineMask {
	let inPem = false;
	return (line) => {
		if (inPem) {
			if (PEM_END_RE.test(line)) inPem = false;
			return undefined;
		}
		const pem = PEM_BEGIN_RE.exec(line);
		if (pem) {
			inPem = true;
			return mockedValue(`PEM ${pem[1]}`);
		}
		return mockLine(line, true);
	};
}

/**
 * Whole-content mock for output known to come from a credential source (dotenv, auth stores,
 * process environments, key files). Every assignment keeps its key and loses its value.
 */
export function mockCredentialContent(text: string): string {
	if (!text) return text;
	if (/^\s*[{[]/u.test(text)) {
		try {
			return JSON.stringify(mockJsonCredentials(JSON.parse(text)));
		} catch {
			// Read tools also return numbered or mixed text; each incomplete JSON line is masked below.
		}
	}
	if (text.split("\n").length > MAX_MOCKED_LINES) return mockedValue("credential content exceeds line limit");
	return maskLines(text, createContentLineMask());
}

function splitSearchLine(line: string): { path: string; position: string; content: string } | undefined {
	const colon = SEARCH_LINE_COLON_RE.exec(line);
	if (colon) return { path: colon[1], position: colon[2] ?? "", content: colon[3] };
	const context = SEARCH_LINE_CONTEXT_RE.exec(line);
	if (context) return { path: context[1], position: `${context[2]}-`, content: context[3] };
	return undefined;
}

/** A grouped-output file header (`path:` alone on its line) and the indented `  N: text` / `  N- text` lines under it. */
const SEARCH_GROUP_HEADER_RE = /^((?:[A-Za-z]:(?=[\\/]))?[^:\s][^:\r\n]{0,1023}):$/u;
const SEARCH_GROUP_LINE_RE = /^( +\d+)([:-]) (.*)$/u;

/**
 * Search-output mock: only lines attributed to a protected file (`path:line:content`,
 * `path-line-content` context lines, `path:content`, or the indented `N: content` lines the grep tool groups under a
 * `path:` header) lose their values; everything else is untouched apart from secret-shaped text and known values.
 */
export function mockProtectedSearchLines(text: string, isProtectedPath: (path: string) => boolean): string {
	if (!text) return text;
	if (text.split("\n").length > MAX_MOCKED_LINES) return redactKnownSecrets(text);
	return maskLines(text, createSearchLineMask(isProtectedPath));
}

function createSearchLineMask(isProtectedPath: (path: string) => boolean): LineMask {
	const verdicts = new Map<string, boolean>();
	const protectedPath = (path: string): boolean => {
		const known = verdicts.get(path);
		if (known !== undefined) return known;
		let verdict = false;
		try {
			verdict = isProtectedPath(path);
		} catch {
			verdict = false;
		}
		verdicts.set(path, verdict);
		return verdict;
	};
	const mockLineContent = (content: string): string => {
		const mocked = mockCredentialContent(content);
		return mocked === content && content.trim() ? mockedValue("credential line") : mocked;
	};
	let groupPath: string | undefined;
	return (line) => {
		const grouped = groupPath === undefined ? null : SEARCH_GROUP_LINE_RE.exec(line);
		if (grouped && groupPath !== undefined) {
			if (!protectedPath(groupPath)) return redactKnownSecrets(line);
			return `${grouped[1]}${grouped[2]} ${mockLineContent(grouped[3]!)}`;
		}
		const header = SEARCH_GROUP_HEADER_RE.exec(line);
		if (header) groupPath = header[1];
		const split = splitSearchLine(line);
		if (!split || !protectedPath(split.path)) return redactKnownSecrets(line);
		const separator = split.position.endsWith("-") ? "-" : ":";
		return `${split.path}${separator}${split.position}${mockLineContent(split.content)}`;
	};
}

/** Which mask a saved output gets: the one the credential guard picks for the tool call's result. */
export type CredentialBlockMaskKind =
	| { readonly kind: "fields" }
	| { readonly kind: "content" }
	/** Known program source: the source mask, which needs the dialect of the file it prints. */
	| { readonly kind: "source"; readonly dialect: SourceDialect; readonly numbered: boolean }
	/** Only known values and secret-shaped tokens: text whose sections were each masked by their own call. */
	| { readonly kind: "shapes" }
	| { readonly kind: "search"; readonly isProtectedPath: (path: string) => boolean };

/**
 * The same masks for output that arrives in blocks of complete lines (a saved shell output): every block's lines pass
 * in order through one line mask, so a PEM block or a search group opened in one block is still open in the next. A
 * line's `\r\n` or `\n` ending is kept and not shown to the mask. Two rules of the whole-text forms apply within a
 * block only: a quoted secret pair split over a line break, and whole-content JSON, which is masked line by line.
 */
export function createCredentialBlockMask(kind: CredentialBlockMaskKind): (block: string) => string {
	if (kind.kind === "source") return createSourceBlockMask(kind.dialect, kind.numbered);
	const mask =
		kind.kind === "content"
			? createContentLineMask()
			: kind.kind === "search"
				? createSearchLineMask(kind.isProtectedPath)
				: kind.kind === "shapes"
					? redactKnownSecrets
					: fieldLineMask;
	return (block) => {
		let out = "";
		for (const line of (kind.kind === "fields" ? mockQuotedSecretFields(block) : block).split(/(?<=\n)/u)) {
			const ending = /\r?\n$/u.exec(line)?.[0] ?? "";
			const masked = mask(line.slice(0, line.length - ending.length));
			if (masked !== undefined) out += `${masked}${ending}`;
		}
		return out;
	};
}
