# Subscription client compatibility

Pi packages these reviewed installed client identities:

| Client | Version | SHA-256 |
| --- | --- | --- |
| Claude Code | 2.1.331 | `4c00839cf46beb2b38ec310105f2d538f7f9321fe46c636299b74bcab94626b1` |
| Antigravity CLI | 1.5.15 | `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` |
| Grok CLI | 1.0.92 | `add4d201dbf2c0bd6077a36feb55a76939de30bae48dbb06f16b2307d38ceacb` |
| Command Code | 1.93.4 | `bd03a707b7e1c694288921236e3a21b7ecdf5a7ff5878a25dcd075fd3983648e` |

The November 24 installed-binary review compared selected OAuth paths with the
corresponding Pi adapters. BinaryAnalysis holds each digest and its REA or bounded-source evidence
under the case listed below.

| BinaryAnalysis case | Result for Pi |
| --- | --- |
| `claude-code/2.1.331` | The refresh request, invalid-scope handling, refresh coordinator, subscription-token predicate, SDK headers and nested model OAuth check retain their normalized 2.1.329 structure. Authorization-code exchange adds one client-option spread without changing its request properties. The coordinator retains its conditional credential-store preflight and carries lock loss into the request. Once rotation completes, its token-keyed CAS still saves over metadata-only changes or adopts a sibling rotation even after lock compromise. Production endpoints, client ID and OAuth scopes are unchanged. |
| `claude-code/2.1.328` | The inspected production endpoints, scope strings, PKCE exchange and refresh request fields still match the previous review. |
| `antigravity/1.5.15` | The interactive consumer callback, S256 challenge and scope selection retain their normalized instruction shapes. The saved token source has the same normalized shape as 1.5.12; only the package-qualified name of its `IsNetworkError` callee changed. Token acquisition/persistence remains separate from account/project/model discovery. |
| `grok-cli/1.0.92` | Pi follows the binary's default browser flow: discovery, an ephemeral `127.0.0.1` `/callback`, PKCE S256, state, nonce, a ten-minute timeout, code exchange and ID-token validation. `GROK_LOGIN_DEVICE_FLOW` selects device authorization and an HTTP 404 falls back to browser login. Scope ownership matches native configuration rather than transport: built-in/non-Team OAuth2 uses the ten-scope consumer profile, exact `Team` uses the nine-scope Team profile, and paired customer OIDC uses its five-scope profile. Paired issuer/client overrides, independent principal fields, their login-to-refresh persistence, local-auth truthiness, the recovered client ID, 30-day missing-expiry fallback, five-minute early refresh and permanent refresh rejection classes are mapped into the xAI provider and shared auth-storage owner. Runtime provider acceptance and remote login-policy branches remain unverified. |
| `command-code/1.93.4` | The npm package bundle (not a local install) keeps the 1.93.2 sign-in functions, callback server, auth headers, generate route, header names, account and usage routes, and embedded catalogue revision once short minified identifiers are masked. The generate body gains only an optional `subagent` link that the client sets for sub-agent turns; Pi sends none, so its request is unchanged. |
| `command-code/1.93.2` | Pi follows the production sign-in state machine: an ephemeral `127.0.0.1` callback, 32-byte base64url state, distinct browser-form and legacy-JSON contracts, the completion landing route and grace, bounded body handling, recovered CORS/preflight behavior, and concurrent manual API-key validation through `/alpha/whoami`. Browser startup, timeout and non-denial callback failures leave manual entry authoritative; exact `access_denied` is terminal. Browser and manual metadata include `authenticatedAt`, and AuthStorage persists the selected key before login completes. Pi deliberately makes a persistence failure terminal rather than returning to manual entry, because its provider-neutral storage owner refuses uncommitted login success. The native local/staging environment branches are not mapped into Pi's production-scoped inference adapter. Live browser delivery, key acceptance and entitlement remain unverified. |

Reviewed entries bind the version to the exact executable digest. Other platform
images and different binaries reporting the same version need their own review.
Static analysis establishes the inspected client contract; it does not establish
live authorization, refresh, entitlement, or inference acceptance.

The existing compatibility owners remain authoritative:

- Claude: `packages/ai/src/providers/anthropic-compatibility-profile.ts` owns
  reviewed images and the OAuth protocol. Login, refresh, Messages, and usage
  consume the compatibility resolver's snapshot.
- Antigravity: `packages/ai/src/utils/antigravity.ts` owns reviewed images and
  the shared request identity. Consumer and GCP OAuth clients remain distinct.
- Grok: `packages/ai/src/providers/xai-cli-identity.ts` owns reviewed images and
  shared subscription request headers. The OAuth owner keeps consumer, Team and customer-OIDC
  profiles distinct and persists the configuration that minted each session.
- Command Code: `packages/ai/src/providers/command-code-request.ts` owns the reviewed client version,
  the account client owns manual-key validation, and the OAuth coordinator selects exactly one browser
  or manual result before the shared AuthStorage owner commits it.

For a compatibility update, update the installed client, fingerprint its exact
artifact, and inspect the relevant native code with the BinaryAnalysis kit's
pinned REA. Follow the authorization and refresh callers into their constants,
scope construction, transport policy, and failure handling before admitting a
digest. Use the existing identity generators after review; those sync commands
execute the selected client's bounded `--version` query. Static-only generation
can use `writeClientIdentity` with the version recovered from the reviewed bytes.
Runtime startup does not update the native clients.
