# Subscription client compatibility

Pi packages these reviewed Linux x86-64 client identities:

| Client | Version | SHA-256 |
| --- | --- | --- |
| Claude Code | 2.1.316 | `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824` |
| Antigravity CLI | 1.4.12 | `1edfb30477447825f0aaa05fd9a91d82f9adf26686f41cd4f5c70b90abe383e8` |
| Grok CLI | 1.0.70 | `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9` |

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
