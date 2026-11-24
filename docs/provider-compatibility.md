# Subscription client compatibility

Pi packages these reviewed Linux x86-64 client identities:

| Client | Version | SHA-256 |
| --- | --- | --- |
| Claude Code | 2.1.326 | `b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37` |
| Antigravity CLI | 1.5.15 | `7b004d26c3fdea25a7c9d456de4bfaccef4be1e4cc7fd6db628859c5c941fa2d` |
| Grok CLI | 1.0.77 | `b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a` |

The November 18 installed-binary review compared selected OAuth paths with the
corresponding Pi adapters. BinaryAnalysis holds each digest and the REA evidence
under the case listed below.

| BinaryAnalysis case | Result for Pi |
| --- | --- |
| `claude-code/2.1.328` | The inspected production endpoints, scope strings, PKCE exchange and refresh request fields still match the previous review. |
| `antigravity/1.5.15` | The interactive consumer callback, S256 challenge and scope selection retain their normalized instruction shapes. The saved token source has the same normalized shape as 1.5.12; only the package-qualified name of its `IsNetworkError` callee changed. Token acquisition/persistence remains separate from account/project/model discovery. |
| `grok-cli/1.0.89` | The device grant fields, ten-entry consumer scope constructor and four candidate refresh-form blocks agree with the previous review. The native device request selects its surface from a table that includes Pi’s current value. The default selection, refresh routing and error handling remain unverified. Pi also admits 1.0.85, while its packaged default is 1.0.77. |

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
  shared subscription request headers. Consumer and Team scopes remain distinct.

For a compatibility update, update the installed client, fingerprint its exact
artifact, and inspect the relevant native code with the BinaryAnalysis kit's
pinned REA. Follow the authorization and refresh callers into their constants,
scope construction, transport policy, and failure handling before admitting a
digest. Use the existing identity generators after review; those sync commands
execute the selected client's bounded `--version` query. Static-only generation
can use `writeClientIdentity` with the version recovered from the reviewed bytes.
Runtime startup does not update the native clients.
