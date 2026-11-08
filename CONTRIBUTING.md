# Contributing

Use Node.js 24 or newer and npm.

```sh
git clone https://github.com/moejay/pi-observer.git
cd pi-observer
npm ci
npm run check
```

- `npm test`: deterministic unit/integration tests; no credentials or paid model calls.
- `npm run typecheck`: strict TypeScript checks.
- `npm run format`: apply Prettier; `npm run format:check` checks formatting.
- `npm run build:site`: copy the allowlisted static documentation into `dist/`.
- `npm pack --dry-run`: run release checks and inspect package contents.
- `pi -e ./src/index.ts`: try the extension in an actual session.

Settings and status changes should include keyboard, cancellation, narrow-terminal,
and RPC fallback tests where applicable. Keep old session entry types
(`pi-assess.*`) compatible; the public package is named `pi-observer`.

## Scope

V1 is an observer, not an enforcer. Do not add context injection, steering, automatic
interruptions, or blocking without an explicit design decision. Only observed human
input can authorize goal changes. Preserve raw source messages and validate citations.

Never attach real session files, credentials, proprietary tool output, or personal
information to public issues or pull requests. Use small synthetic fixtures.

## Documentation and releases

Documentation source is in `docs/`. Local preview:
`npm run build:site && python3 -m http.server 8080 --directory dist`.

CI checks formatting, types, tests, site generation, and package contents. Pages
publishes only static site assets after checks pass on `main`; pull requests cannot
deploy. Actions are pinned to commit SHAs and updated through Dependabot.

Before a release, update `package.json`, the lockfile, and `CHANGELOG.md`; run
`npm ci && npm run check && npm pack`. Verify CI, then create the matching
`vX.Y.Z` tag and GitHub release. The package is distributed through GitHub;
there is no automatic npm publish workflow.
