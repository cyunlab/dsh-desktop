# DeepSeek Harness Desktop

Secure Electron shell for the DeepSeek Harness Web Client. This first runnable
slice uses a loopback-only fake Host behind the production launcher interface;
the published Harness composition is integrated separately.

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
