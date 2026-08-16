# DeepSeek Harness Desktop

Secure Electron shell for the DeepSeek Harness Web Client. Desktop starts the
pinned published Harness Web composition on a loopback-only listener.

## Development

Use Node 24 and Corepack. The repository pins pnpm 11.7.0 and Electron 43.4.0.

```sh
corepack pnpm install
corepack pnpm dev
```

The application opens a sandboxed startup page, starts the fake Host on an
operating-system-assigned `127.0.0.1` port, and navigates the same window to it.

```sh
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

Desktop application for DSH.

## Unsigned development packages

Run `corepack pnpm package` on the native target platform. Artifacts are written
to `release/` with a space-free `deepseek-harness-desktop-<version>-unsigned-dev-…`
filename. The supported native targets are Windows x64 NSIS, separate macOS
arm64 and x64 DMGs, and Linux x64 AppImage.

These development artifacts are not signed. On macOS, Control-click the app,
choose **Open**, then confirm **Open** to pass Gatekeeper. On Windows, choose
**More info** and **Run anyway** in the SmartScreen prompt. Only use artifacts
from a build you trust.
