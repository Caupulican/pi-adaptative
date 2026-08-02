# Evidence model

Use confidence to prioritize verification, not to replace it.

| Confidence | Typical evidence | Gate treatment |
|---:|---|---|
| 1.00 | Deterministic unauthorized effect, sensitive extraction, corruption, or invariant violation with exact reproduction | Confirmed blocker; add regression immediately |
| 0.85–0.95 | Repeatable differential result with valid baseline, negative control, and expected response shape | Confirmed unless a documented environment effect explains it |
| 0.70–0.84 | Repeatable indirect signal, timing result with replay, or production log correlation | Needs focused verification before product changes |
| 0.40–0.69 | Single detector signal, heuristic static match, or scanner result without a stable control | Candidate; investigate, do not gate yet |
| 0.00–0.39 | Unverified hypothesis, malformed probe response, generic fallback, or incomplete tool run | Reject or rerun with corrected conditions |

## Verification checklist

- Reproduction is deterministic and bounded.
- Baseline uses the same endpoint/state except for the tested variable.
- Negative control does not trigger the signal.
- Response type/shape matches the target surface rather than a generic fallback.
- Authentication and tenant/session identity match the claim.
- Cache, retry, routing, and rate-limit behavior cannot explain the difference.
- Side effects are measured at the authoritative store or public boundary.
- Tool errors and skipped probes are counted separately from clean results.
- The regression test fails before the fix and passes after it.

## Severity is separate

Confidence answers “is it real?” Severity answers “how much can it hurt?” Do not inflate confidence because impact would be large, and do not dismiss a high-confidence defect because current impact appears small.
