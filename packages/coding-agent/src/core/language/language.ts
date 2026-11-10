/**
 * The interface languages this build carries and how the system locale names them. The functions here are pure: they
 * read the environment the caller passes and hold no state, so the same answer comes from the same input everywhere.
 */

export const LANGUAGES = ["en", "pt-BR"] as const;

export type Language = (typeof LANGUAGES)[number];

/** What the settings file holds: an explicit language, or `auto` to follow the system locale. */
export type LanguageSetting = "auto" | Language;

/** The variable that holds a priority list; the others hold one locale each. */
const LANGUAGE_VARIABLE = "LANGUAGE";

/**
 * The locale variables, in the order that decides. `LANGUAGE` wins over `LC_ALL`, which wins over `LC_MESSAGES`, which
 * wins over `LANG`, because that is the precedence the C library and the shell give them.
 */
const LOCALE_VARIABLES = [LANGUAGE_VARIABLE, "LC_ALL", "LC_MESSAGES", "LANG"] as const;

/** Portuguese is the only language this build translates besides English, so every Portuguese locale reads as pt-BR. */
const PORTUGUESE_PREFIX = "pt";

/**
 * The tag that decides for one locale variable, or an empty string when the variable says nothing. `LANGUAGE` holds a
 * colon-separated preference list, and only its first entry matters here.
 */
function preferredTag(name: string, value: string): string {
	return (name === LANGUAGE_VARIABLE ? (value.split(":")[0] ?? "") : value).trim();
}

/**
 * The language the system asks for. `Intl` is not consulted: under the shipped runtime it reports `en-US` whatever the
 * system says, so the locale variables are read directly.
 */
export function languageOfEnvironment(env: Readonly<Record<string, string | undefined>>): Language {
	for (const name of LOCALE_VARIABLES) {
		const value = env[name];
		if (value === undefined) continue;
		const tag = preferredTag(name, value);
		if (tag === "") continue;
		return tag.toLowerCase().startsWith(PORTUGUESE_PREFIX) ? "pt-BR" : "en";
	}
	return "en";
}

/** The language to use: an explicit setting wins, and `auto` or no setting at all follows the environment. */
export function resolveLanguage(
	setting: LanguageSetting | undefined,
	env: Readonly<Record<string, string | undefined>>,
): Language {
	if (setting === undefined || setting === "auto") return languageOfEnvironment(env);
	return setting;
}
