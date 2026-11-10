# Interface language

The terminal interface is available in English and Brazilian Portuguese (`pt-BR`).

## Choosing the language

The interface follows the system locale by default: it reads `LANGUAGE` (its first entry), then `LC_ALL`, `LC_MESSAGES` and `LANG`, and the first one that is set decides. A value that starts with `pt` selects Portuguese; anything else selects English. On a system that sets none of them, such as Windows outside WSL, the default is English.

To choose it yourself, open `/settings` and change **Language**, or set it in `settings.json`:

```json
{ "language": "pt-BR" }
```

The values are `"auto"` (follow the system), `"en"` and `"pt-BR"`. A change applies at once, to the running interface.

The setting is followed wherever pi draws a screen for you: the interactive interface, and the screens shown before a session starts (the `--resume` picker, a startup question, `pi config`).

## What is translated

The whole terminal interface: the frame around the conversation (the footer, the working and waiting words, the activity lane, the operator bar, the input's hints), the work panel and its panes, the settings screens, the selectors and dialogs, the chrome and the notices of the conversation, the output of the slash commands (the `/bot` and `/team` family and the status reports included), the dialogs a tool opens to ask you something, the key descriptions in the shortcuts window (`/hotkeys`), and the few words the terminal library draws itself (an empty list, the loader, the titles of markdown alerts). In Portuguese the root conversation is **Mente** and a team of bots is an **equipe**.

Numbers, amounts of money and dates in reports are written the language's way: `$0,1234` in Portuguese.

## What stays English

Everything a model reads stays English in every language: the system prompt, tool names and descriptions, tool results and refusals, the briefs and reports of workers, plan updates and the goal's context. The interface language changes what the owner sees and nothing a model is told, so it has no effect on behaviour or on the prompt cache. A text that reaches both the screen and a model, such as the reason a refused call is given, is English for both.

Command names, their arguments and identifiers such as model names, thinking levels, setting keys and status codes are the same in every language. So is a value you type or that `settings.json` holds: a model setting's `active`, for example, is written `active` in Portuguese too.

A state or a cause that a report shows is worded in the interface language: whether a routine is paused and why it ended, how its last run went, who serves a channel, why the knowledge collection is inactive, what state a machine is in.

Text written by you or by a model (a goal's words, a plan step, a bot's name, a session's title) is shown as it was written.

A few values on screen are records or free text someone else wrote, and so are shown as they were written in every language: the notes a routine's runs stored about its progress, its refusal reasons, a daemon's stored reports, and the text of an error. A line that a model also reads keeps its English in the transcript and is drawn in the interface language: the line an aborted request leaves in the conversation is one.

The command line outside the interface is English: `pi --help`, print mode (`pi -p`), JSON mode, RPC mode, and the records the harness writes to disk. Those modes, and the workers they run, never follow the language setting.

## Adding text

Interface text lives in `src/core/language/`: `text-en/` holds the English catalogue, the source every other language follows, and `text-pt-br/` holds the Portuguese one, in files of the same names, one file per area of the interface. A new entry goes into both. `catalogue.ts` joins the two, area by area; a new area is one line there and one field of `InterfaceText`. The Portuguese catalogue is typed by the English one, so a missing entry, an extra one or a different argument list does not compile.

Code reads text at the moment it draws, through `interfaceText()`, and never keeps it in a constant: that is what lets a language change reach the next frame. An entry that carries a value or a plural is a function, so each language places the value and agrees with it in its own way.

A sentence that goes both to the screen and to a model, a record or a diagnostic is written once. Its formatter takes the words as an argument, and the caller chooses them: `interfaceText()` for the screen, `englishText()` for everything else. Do not write the English a second time in code.

Core code that the screen and a model both hear from returns facts, not a sentence: a typed value that says what happened (`GoalActionRefusal`, `BotDaemonLaunchOutcome`). One formatter words the fact, and each reader passes its words.

A value that is an identifier the domain declares (a state, a status, a cause) is worded where it is drawn. Its English entry is a function that returns the identifier, or the description the domain already gives it, so no English is written twice; the Portuguese entry is a table keyed by the identifier. Data that leaves the process, such as the status snapshot RPC mode returns, keeps the identifier and its English.

Only a process that draws a screen sets the language: the interactive mode binds it (`bindInterfaceLanguage`) and a screen drawn before a session applies it once (`prepareStandaloneScreen`). Print and RPC modes set English when they start.
