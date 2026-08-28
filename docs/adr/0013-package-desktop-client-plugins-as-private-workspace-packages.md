# Package Desktop client plugins as private workspace packages

Desktop-owned Harness client extensions live as private packages under `packages/`, beginning with `packages/desktop-update-client/`. Each package owns its client metadata, composition patch, source, locale, and tests, is built by the root orchestrator, and enters the verified `dist/node_modules` Runtime closure. This follows the Harness package seam and establishes a reusable home for future Desktop client plugins without modifying the upstream Harness submodule or creating a second JavaScript resource layout under Tauri.
