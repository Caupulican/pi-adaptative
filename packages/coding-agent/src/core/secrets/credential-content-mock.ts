import { redactKnownSecrets } from "../security/secret-text.ts";

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
const LINE_PREFIX_RE = /^(\s*(?:\d+[:\t]\s?)?)/u;
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

/** Named secrets in ordinary consumer output, including partial compact JSON snapshots. */
export function mockCredentialFields(text: string): string {
	const fields = text.replace(
		/"([A-Za-z_][A-Za-z0-9_.-]*)"(\s*:\s*)"(?:\\.|[^"\\\r\n])*(?:"|$)/gu,
		(match, key: string, separator: string) =>
			isCredentialSecretKey(key) ? `"${key}"${separator}"${mockedValue(key)}"` : match,
	);
	const lines = fields.split("\n");
	if (lines.length > MAX_MOCKED_LINES) return mockedValue("credential output exceeds line limit");
	return lines.map((line) => mockLine(line, false)).join("\n");
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
	const lines = text.split("\n");
	if (lines.length > MAX_MOCKED_LINES) return mockedValue("credential content exceeds line limit");
	let inPem = false;
	const out: string[] = [];
	for (const line of lines) {
		if (inPem) {
			if (PEM_END_RE.test(line)) inPem = false;
			continue;
		}
		const pem = PEM_BEGIN_RE.exec(line);
		if (pem) {
			inPem = true;
			out.push(mockedValue(`PEM ${pem[1]}`));
			continue;
		}
		out.push(mockLine(line, true));
	}
	return out.join("\n");
}

function splitSearchLine(line: string): { path: string; position: string; content: string } | undefined {
	const colon = SEARCH_LINE_COLON_RE.exec(line);
	if (colon) return { path: colon[1], position: colon[2] ?? "", content: colon[3] };
	const context = SEARCH_LINE_CONTEXT_RE.exec(line);
	if (context) return { path: context[1], position: `${context[2]}-`, content: context[3] };
	return undefined;
}

/**
 * Search-output mock: only lines attributed to a protected file (`path:line:content`,
 * `path-line-content` context lines, or `path:content`) lose their values; everything else is
 * untouched apart from secret-shaped text and known values.
 */
export function mockProtectedSearchLines(text: string, isProtectedPath: (path: string) => boolean): string {
	if (!text) return text;
	const lines = text.split("\n");
	if (lines.length > MAX_MOCKED_LINES) return redactKnownSecrets(text);
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
	const out = lines.map((line) => {
		const split = splitSearchLine(line);
		if (!split || !protectedPath(split.path)) return redactKnownSecrets(line);
		const separator = split.position.endsWith("-") ? "-" : ":";
		const mocked = mockCredentialContent(split.content);
		const content = mocked === split.content && split.content.trim() ? mockedValue("credential line") : mocked;
		return `${split.path}${separator}${split.position}${content}`;
	});
	return out.join("\n");
}
