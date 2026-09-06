# Synthetic session failure fixtures

`session-failures.ts` contains constructed examples, not anonymized copies of a real transcript.
It contains no user messages, machine paths, provider payloads, credentials, session identifiers,
timestamps, or hashes from a real session. File reads are mocked in memory; verification results
are synthetic host records. No shell command in these fixtures is executed.

The focused tests cover:

- Alias expansion on first activation, reuse of an already wrapped tool, and reactivation of the
  original registry descriptor. An unwrapped in-memory reader supplies the negative control.
- Different-directory verification identities, an ordinary failure that cannot be erased by a
  different check, explicit setup-repair evidence, and a same-identity passing rerun. The Node
  shell-boundary regression now proves that only a classified setup failure can use that repair.
- The existing workbench distinction between cycle-local actions and retained failure receipts.
  Their quotient is not a session failure rate. This is a characterization, not approval of the label.

Run the focused tests from `packages/coding-agent`:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/session-failure-fixtures.test.ts test/workbench-controller.test.ts
```

Keep future additions synthetic. Do not paste session JSONL, provider traces, recovery logs, or
absolute paths from an operator's machine into this fixture directory.

`node-runner.fixture.mjs` is a separate, executable synthetic fixture for the local Node reporter
adapter. Its passing assertion, skipped assertion, and todo verify TAP/spec parsing against the
installed runtime without a provider or a recorded session.
