# WebFetch

`webfetch` is a native tool, enabled by the default tool surface when the model and active profile permit it. It requires `network.http`; local read access or MCP access alone does not authorize it.

```json
{"url":"https://example.com/docs","format":"markdown","timeout":30}
```

`format` is `markdown` (default), `text`, or `html`. The total deadline defaults to 30 seconds and accepts positive values up to 120 seconds. It covers DNS, all redirects, the challenge retry, and response-body consumption. The Effect runtime owns this deadline, parent cancellation, and resource release; completion waits for the HTTP reader and dispatcher to close.

Requests initially send a browser-style User-Agent. A response with both HTTP 403 and `cf-mitigated: challenge` permits exactly one retry using Pi's own User-Agent. Ordinary 403 responses and repeated challenges are returned as errors. The retry revalidates DNS and shares the original deadline, redirect budget, and body limits. This is a compatibility fallback, not a CAPTCHA solver or authenticated browser; it cannot guarantee access through Cloudflare.

## Network boundary

Only public HTTP(S) destinations are admitted. Every DNS answer must be public, and the connection is pinned to a validated address while retaining the hostname for TLS verification and the Host header. Redirect destinations undergo the same checks; loops, more than five redirects, and HTTPS-to-HTTP downgrades are rejected. Credentials embedded in URLs are rejected. No cookies, authorization headers, browser state, or page subresource requests are carried along.

WebFetch uses a dedicated direct dispatcher: environment proxies and the provider transport's global dispatcher cannot bypass destination checks. Networks requiring an outbound proxy are not supported by this tool. Local development endpoints, private networks, metadata endpoints, non-global address ranges, and authenticated browsing are intentionally outside its contract. HTTP URLs remain HTTP; the tool does not silently upgrade or downgrade their scheme.

## Content and retention

The response is bounded to 5 MiB while streaming, including decompressed response bytes. Declared oversized responses fail before reading; absent or misleading Content-Length headers do not disable the streaming limit. Unsupported binary MIME types are rejected. Text decoding honors an HTTP charset declaration, defaulting to UTF-8. HTML conversion does not execute scripts. Markdown resolves links against the final URL; text conversion omits active/hidden-container content and preserves block boundaries. Raw HTML is returned as data.

HTML preflight rejects more than 50,000 parser nodes/events or 128 nesting levels before recursive conversion. Markdown also has a conservative 20 MiB depth-weighted text/attribute work budget and a 1 MiB budget for added link-expansion characters. These checks prevent a small response with repeated relative links or nested text from causing disproportionate conversion work. They are complexity estimates, not a wall-clock CPU guarantee. Raw HTML remains available without DOM conversion, subject to the response and output bounds.

Large converted output goes through the existing tool-output packer: a bounded head/tail preview plus a session artifact reference when artifact retrieval is available. Otherwise truncation is explicit. `details` contains bounded metadata, not a duplicate body. There is no independent web-response cache or durable store. Artifact lifetime follows existing session/context retention; this is not a permanent page archive.

The session's standard untrusted-content fence applies to the result. Artifact retrieval re-applies the original source's trust classification rather than promoting saved web content into trusted instructions. Fencing is a model instruction boundary, not a guarantee against every prompt injection.

## Verification

Focused coverage lives in `test/webfetch.test.ts`, `test/webfetch-registration.test.ts`, `test/artifact-retrieve-tool.test.ts`, and `test/suite/agent-session-artifact-lifecycle.test.ts`. Tests use controlled transports and faux model responses, not paid provider calls.
