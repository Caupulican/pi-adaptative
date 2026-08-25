# Termux (Android)

Termux is not an officially supported Pi Adaptative release target. The maintained binary installers cover Linux x64/arm64 and Windows x64/arm64 only; there is no Android or Termux installer.

This page records limitations for contributors who choose to build from the source tree. It is not a supported installation path or a compatibility guarantee.

## Known constraints

- Android ARM64 does not receive a packaged Pi Adaptative release binary.
- Optional native modules, clipboard images, and desktop integrations may be unavailable.
- Termux process, storage, and permission behavior can differ from Linux hosts.
- Provider authentication, shell tools, and managed runtimes must be supplied and validated by the user.

## Device integrations

When working from a source checkout, Termux:API can provide text clipboard and device commands:

```bash
pkg install termux-api
termux-clipboard-set "text"
termux-clipboard-get
termux-setup-storage
```

The Termux and Termux:API applications should come from the same trusted distribution. Android shared-storage permissions are controlled by `termux-setup-storage`; do not assume paths under `/storage/emulated/0` are available to every process.

For supported releases, use the Linux installer on a supported Linux host or the native PowerShell installer on Windows. Do not attempt to run those installers inside Termux.
