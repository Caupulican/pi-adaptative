---
name: typescript-discipline
description: "TypeScript type rules: discriminated unions instead of optional-field bags, branded ids, unknown instead of any, parse external data once at the boundary, no casts that lie to the compiler, exhaustive switches with a never check, derive types from schemas. Use when reading, writing or reviewing .ts or .tsx files, designing a type or function signature, removing any or as casts, or fixing a type error."
---

# TypeScript Discipline

## How to use the skill

Load this skill when you edit TypeScript. The repository's own TypeScript rules come first. Read its config and contributor rules before you apply anything here.

Freedom Dial: Low Freedom for the rules. High Freedom for naming.

## North Star

Use the type checker to remove impossible states, mixed-up values and unhandled variants at compile time.

## Core Sections

### Model the states

1. Model variants as a union with a literal `kind` field. Do not use a bag of optional fields.
2. If you can write a comment that says when a field combination is valid, the type is too loose. Split it.
3. Build the type from the values you want. A non-empty list is `[T, ...T[]]`. A range is a start and a length.
4. Keep the plain type while every operation on it is total. Strengthen a type only where a cast, a non-null assertion or a "cannot happen" throw appears.

### Brand and parse

1. Brand values that share a primitive but mean different things, such as user ids and order ids. Validate once when you create the value.
2. External data is `unknown` until a parse function turns it into a named type. Parse at the boundary. Use the repository's schema library when it has one.
3. Derive a type from the authoritative schema. Use `Pick`, `Omit`, `Parameters`, `ReturnType` and `typeof` before you declare a new interface.

### Do not lie to the compiler

1. Do not use `any`. Use `unknown` and narrow.
2. Do not use `as` to force a type. Cast only after validation. Use `satisfies` to check a value without widening it.
3. Prefer narrowing in this order: discriminant switch, `in`, `typeof` or `instanceof`, a user-defined guard, then a cast.
4. A type guard must verify its claim. A guard that always returns true is worse than a cast.

### Be exhaustive

1. End every switch over a union with `const _exhaustive: never = value;` so a new variant fails the build.
2. Pass an object when a function has several arguments of one type.
3. Use the logger of the repository. Do not leave `console.log` in shipped code.

## Anti-Patterns

- `{ done: boolean; doneAt?: Date }` that allows `done: true` with no date.
- `JSON.parse(text) as Config`.
- A catch block that types the error as `any`.
- A hand-written guard that repeats a schema.

## Examples

- Replace `{ loading: boolean; data?: T; error?: Error }` with `{ kind: "loading" } | { kind: "ready"; data: T } | { kind: "failed"; error: Error }`.
- Replace `function send(from: string, to: string)` with branded `UserId` values.

## Self-Check

- Does the diff add `any`, `as` or `!`? If yes, why can the compiler not prove the fact?
- Does every switch over a union end in a `never` check?
- Is each external value parsed once?

## Known Gaps

- The skill does not cover runtime performance of types.
- The rules assume a strict compiler configuration.
