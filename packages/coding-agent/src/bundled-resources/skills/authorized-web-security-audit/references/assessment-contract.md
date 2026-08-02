# Assessment contract

Use this contract before active web or API testing. A missing required field
keeps the work in Review or Plan mode.

## Scope manifest

```text
Engagement id:
Approving owner:
Written authorization pointer:
Allowed hosts/CIDRs:
Allowed schemes/ports:
Environment:
Allowed test accounts/roles:
Explicit exclusions:
Allowed techniques:
State-changing probes allowed: no | exact list
Start/end window:
Requests/second:
Concurrency:
Per-request timeout:
Per-tool timeout:
Maximum redirects/body/response/crawl depth:
Credential source and redaction rule:
Evidence directory and retention:
Emergency stop contact:
Cleanup obligation:
```

## Admission gate

All answers must be yes before active execution:

- Is authorization explicit, current, attributable, and applicable to this
  exact target and technique?
- Does canonical parsing produce an allowed scheme, host, port, and address?
- Are redirect hops and DNS results revalidated against the same rules?
- Are private, loopback, link-local, multicast, and metadata destinations
  denied unless individually approved?
- Are request rate, concurrency, count, size, depth, and elapsed time bounded?
- Is the selected tool unable to exceed the manifest through custom input?
- Are credentials kept outside model context, logs, argv, and reports?
- Is cancellation wired to sockets, processes, browsers, and child tasks?
- Will completion or failure emit one terminal event to the owning session?
- Is a baseline or negative control available for the claimed signal?

## Evidence record

```text
Candidate id:
Scope manifest id:
Hypothesis:
Security invariant and owner:
Sanitized request identity:
Control request identity:
Observed differential:
Raw artifact pointer and digest:
Tool/version/environment:
Reproduction count:
Confidence:
Severity:
Disposition: confirmed | rejected | incomplete | needs_review
Reason:
Regression test:
Cleanup status:
```

Never put credentials, session cookies, authorization headers, personal data,
database contents, private keys, or full sensitive response bodies in this
record. Store protected raw evidence separately with least-privilege access and
a retention deadline.

## Safe controls by finding type

| Candidate | Minimum useful control |
|---|---|
| Missing endpoint authorization | Distinct low-privilege identity plus nonexistent-object control |
| Sensitive file exposure | Random path baseline plus expected file-shape validation |
| Injection | Untainted value plus unique inert marker; require a semantic differential |
| Timing behavior | Repeated interleaved control/test trials within a strict budget |
| Open redirect | Same-origin benign destination plus redirect-hop scope validation |
| SSRF | Approved local fixture or correlated callback; never probe unrelated internal ranges |
| Rate limiting | Explicit load allowance, low initial rate, recovery observation, hard stop |

## Provenance boundary

FrameSeven commit `2c711dc3a080707daa94d5954e9f4c0e4a726f53` was reviewed
as an untrusted design input for staged tools, budgets, engagement records, and
false-positive reduction. This contract is independently written for Pi and
adds fail-closed authorization, redirect/DNS scope enforcement, tenant-bound
background lifecycle, secret handling, and stronger evidence requirements.
