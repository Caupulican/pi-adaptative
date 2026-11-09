---
name: write-discoverable-code
description: "Rules for writing code that agents and people can find through plain-text search: names that grep to one definition, domain filenames, branded ids and discriminated unions, one-line doc comments with the plain-words phrase, whole string literals, unique error prefixes, thin orchestrators, @deprecated on dead ends. Use whenever writing, renaming, moving or reviewing code: functions, types, constants, files, error messages, doc comments, module splits, or when a search for something returns many unrelated hits."
---

# Write discoverable code

## How to use the skill

Load this skill before writing or renaming code, and when reviewing a change for how findable it is. Agents reach code by searching for strings and reading a small window around each hit: no hover text, no jump to definition, no memory between sessions. Every identifier is a search query, and every miss costs reads that crowd out the task. These rules make code resolvable in one search instead of five.

Freedom: low freedom for the naming, literal-string and doc-comment rules (apply them exactly); high freedom for module shape (split until each question-sized concept has one home, then stop). Match the vocabulary and conventions of the code you are editing before adding any rule here.

## North Star

A reader who searches for a name, a phrase or an error message lands on the one definition, and that line says the sharpest thing the code cannot say itself. Prefer the shortest name that greps uniquely; put the rest in the doc comment. Build only what the task needs: do not rename or restructure code the task does not touch.

## Core Sections

### Names are search queries

- **Exported symbols get two to four words, one of them a domain word.** `diffUserObjects`, not `diff`; `queueEventForDispatch`, not `queue`. One-word exported names resolve to a single definition far less often than three-word names (measured on a large monorepo by the skill's source: about 61% against 96%), so three words is where a name becomes an address.
- **Give a generic verb its object.** `sanitizeEmailHtml`, not `sanitize`; `validateSmtpConfig`, not `validateConfig`. Qualify only as far as uniqueness needs, then stop.
- **One definition site per symbol.** Never copy a function between files: move it, delete the original in the same change, and import it everywhere else.
- **Do not let the module path carry a generic name.** The import that tells `users/diff.ts` from `orders/diff.ts` is at the top of the file; the search hit is at line 300. Put the context in the symbol. Exception: a rigid convention where the path is the meaning.
- **One concept, one spelling.** Choose `organizationId` or `orgId` and use it everywhere; reuse the vocabulary already in the code instead of adding a near-synonym.
- **Rename in the same change as the behavior.** A stale name is misinformation read every time. A helper that other modules now import is no longer `_private`.
- **Filenames are names.** Never use a bare role (`config.ts`, `types.ts`, `utils.ts`, `helpers.ts`, `handlers.ts`): they say nothing in a result list and collide with every other module's. Prefix the domain, `billing-plan-config.ts`. `index.ts` is acceptable only as a thin entry that re-exports named symbols.

### Types are the documentation an agent cannot skip

- **Brand primitive ids.** `transferOwnership(userId: string, orgId: string)` hides a swapped argument; branded or newtype ids turn it into a compile error that names the concepts.
- **Require capability types for privileged operations** (an `OrgScopedDb`, not a raw connection). A comment is a request; a required type is a rule.
- **Model state with discriminated unions,** not a cluster of nullable fields with implicit rules.
- **Name types as they will be quoted in a compiler error.** `OrgScopedDb` explains itself; `Ctx2` does not. Avoid `any`: it silences the compiler and sends the reader back to guessing.

### Say it where the search lands

- **One line of doc comment on every export,** stating the sharpest constraint the code cannot show: units, time zone, "source time, not insert time", ownership.
- **Write the plain-words phrase in the doc comment.** Searches arrive as ordinary words ("rate limit", "session expired"); camelCase identifiers do not match a phrase grep. `SessionExpiryChecker` should say "Checks whether the user session has expired."
- **A module should read with its imports unread.** If the reader has to open the source of an import to understand it, the import's name is failing.
- **Keep strings whole.** Never build an event name, flag or error code with interpolation (`` `github.${entity}.${action}` `` makes `github.pr.merged` unsearchable); write the full literal even when a loop feels shorter.
- **Start every error message with a unique literal prefix,** so a message seen in a log greps to the throw site: `Webhook signature mismatch for ${id}`, never `${prefix}: mismatch`.
- **One searchable concept per file; keep orchestrators thin.** The code that answers "where is X done?" lives in a module named after X, not inline in a coordinator. An orchestrator reads as a sequence of calls into well-named modules. Split until each question-sized concept has one home, then stop: a helper meaningful inside one concept stays inline, and a file per tiny function fragments one answer across reads. The test runs both ways: a module that answers many unrelated questions holds more than one concept.
- **Name a test after the source it covers** (`foo.test.ts` beside `foo.ts`) when tests are written at all. Tests are written only when the owner asked for them.
- **Mark dead ends.** `@deprecated` on the old path, with a pointer to the new one; better, delete it.
- **Write down what the code deliberately does not do** where a reader would look for it: search finds code, never its absence.

## Anti-Patterns

- A one-word exported name (`create`, `run`, `handle`, `init`) with the meaning in the folder name.
- Two spellings of one concept, or a new synonym next to an existing term.
- A bare-role filename, or a barrel that hides names behind `export *`.
- Template-built event names, flags or error codes; an error message with no literal prefix.
- A function copied to a second file; a renamed behavior that kept its old name.
- A large coordinator that holds the implementation of several concepts.
- Renaming code the task does not touch, or names so long they read as sentences.

## Examples

Before: `export function create(apiKey: string)` in `api.ts`, called as `create(config)`. A search for `create` returns hundreds of hits. After: `createStripeClient(apiKey: StripeApiKey)` in `stripe-client.ts`, with "Creates the HTTP client for the Stripe API." above it; one search finds the definition and its callers.

Before: ``throw new Error(`${scope}: mismatch`)``. After: ``throw new Error(`Webhook signature mismatch for ${deliveryId}`)``; the log line greps straight to the throw.

Before: a 5,000-line service class holding email folder logic among 80 other handlers. After: `email-folder-fallback.ts` holds that concept and the service calls it; a search for "folder fallback" lands there.

## Self-Check

1. Would one search for each new exported name be enough to find its implementation?
2. Would swapping two arguments of the new function fail the build?
3. Is the one thing a caller must know and the signature cannot say written at the definition?
4. Does every log and error string exist verbatim in the source?
5. Did anything change behavior without changing its name?
6. When code moved, is it gone from where it came from?

## Known Gaps

- The measurements come from one TypeScript monorepo and a small set of agents; treat the numbers as direction, not a threshold for your codebase.
- Naming advice cannot fix a missing concept: a search for code that does not exist still returns nothing useful, so document deliberate absences.
- In a language with qualified calls the package name counts as one of the words.
