# Consume published Harness packages

Status: accepted

Desktop production builds consume exact versions of the published `@deepseek-ai/dsh-*` npm packages. The `deepseek-harness/` submodule remains a read-only source and documentation reference outside the Desktop pnpm workspace; it is not a normal build input.

The initial runtime family is `0.1.0-rc.6`. Every direct `@deepseek-ai/dsh-*` dependency is pinned to that exact version rather than a range or npm dist-tag; the registry's `latest` tag is not assumed to identify a mutually compatible bundle family.

The first runnable milestone uses the upstream Web profile composition: `@deepseek-ai/dsh-base` followed by `@deepseek-ai/dsh-web-app`. These are aggregate bundles whose transitive dependencies provide and configure the full standard Web Host and Client plugin roster. Desktop also declares the small set of launcher/runtime packages required to boot that composition inside Electron; it does not copy the bundle patches or curate a reduced plugin list.

The milestone does not require an integration test that compares Desktop's resolved plugin inventory row-for-row with the `dsh web` CLI. Startup and user-visible end-to-end coverage remain required; an exact inventory parity gate can be added when the packaging path is stable.

The repository records the pinned upstream source commit and shipped npm runtime version independently because they may not correspond to the same unpublished source state. Updating either pin is a deliberate compatibility change, and Desktop does not patch published Harness packages without a separate architecture decision.
