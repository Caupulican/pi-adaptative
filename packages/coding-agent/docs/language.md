# Interface language

The terminal interface is available in English and Brazilian Portuguese (`pt-BR`).

## Choosing the language

The interface follows the system locale by default: it reads `LANGUAGE` (its first entry), then `LC_ALL`, `LC_MESSAGES` and `LANG`, and the first one that is set decides. A value that starts with `pt` selects Portuguese; anything else selects English. On a system that sets none of them, such as Windows outside WSL, the default is English.

To choose it yourself, open `/settings` and change **Language**, or set it in `settings.json`:

```json
{ "language": "pt-BR" }
```

The values are `"auto"` (follow the system), `"en"` and `"pt-BR"`. A change applies at once, to the running interface.

## What is translated

The always-visible frame is translated: the footer, the working and waiting words, the activity lane, the operator bar, the input's hints, the key descriptions in the shortcuts window (`/hotkeys`), and the built-in slash commands' descriptions.

Dialogs, selectors, the output of commands, the panels and the help text are still English; they follow area by area.

## What stays English

Everything a model reads stays English in every language: the system prompt, tool names and descriptions, tool results, the briefs and reports of workers, plan updates and the goal's context. The interface language changes what the owner sees and nothing a model is told, so it has no effect on behaviour or on the prompt cache.

Command names, their arguments and identifiers such as model names, thinking levels and status codes are also the same in every language.

## Adding text

Interface text lives in `src/core/language/`: `text-en/` holds the English catalogue, the source every other language follows, and `text-pt-br/` holds the Portuguese one, in files of the same names. A new entry goes into both. The Portuguese catalogue is typed by the English one, so a missing entry, an extra one or a different argument list does not compile.

Code reads text at the moment it draws, through `interfaceText()`, and never keeps it in a constant: that is what lets a language change reach the next frame. An entry that carries a value or a plural is a function, so each language places the value and agrees with it in its own way.
