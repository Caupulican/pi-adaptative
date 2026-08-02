# Security scanner adapter

## Before running

- Confirm ownership or explicit authorization for the exact target.
- Prefer a local isolated server with disposable state and a dedicated port.
- Pin the scanner release and verify its published checksum when downloading a binary.
- Read tool descriptions and identify probes that change state.
- Start non-destructively. Enable destructive/active mode only when the user explicitly includes those effects.
- Bound concurrency, request count, per-request timeout, and whole-tool timeout.
- Use a distinctive authorized-test User-Agent when the protocol supports it.

## During and after running

- Keep server logs and scanner reports together as evidence.
- Treat connection failures, timeouts, skipped tools, missing dependencies, and report-render failures as an incomplete run.
- Inspect structured findings; do not equate exit code zero with no findings.
- Reproduce each material finding with a focused project-owned test and negative control.
- Check common false positives: generic application fallbacks, catch-all routes, static assets, authentication redirects, cache-busting parameters, proxy-generated errors, and local HTTP runs missing production transport policy.
- Rerun the focused scanner probe after the fix, then run the local regression suite.

## Tool-specific notes

Treat any tool-specific exit-code, authentication, or active-scan behavior as unstable external API. Verify it against the pinned tool’s first-party documentation before use. Never infer permission for state-changing probes from general filesystem or network access.
