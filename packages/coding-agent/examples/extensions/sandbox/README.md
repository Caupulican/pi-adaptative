# Sandbox extension dependency safety

The extension retains the sandbox SDK's Node APIs and uses the packaged `pi-certificate-codec`
adapter through the SDK's `node-forge` import identifier. The private adapter has a distinct name;
it is not an upstream release. Its upstream source, license, advisory and exact patches are
recorded in `vendor/pi-certificate-codec/PROVENANCE.json`.

Install with `npm ci --ignore-scripts`. The example's direct local alias and referential override
also apply when it is copied from a standalone Pi archive and installed outside this workspace.
Source reproduction, malformed-signature negative controls and native SDK certificate controls
are mandatory repository checks. A fresh standalone install is verified in release CI.

The adapter supplies the Node main/lib contract used by this extension. Unused upstream
browser/Flash distribution artifacts are not republished as hardened assets.
