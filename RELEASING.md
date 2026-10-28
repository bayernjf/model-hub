# Releasing model-kit

Owner decision (2026-10-28, bayjf `docs/tier0/Tier0-model-hub落码任务列表.md`
W4-1a): the TypeScript client (`packages/model-kit`) and the Python client
(`clients/python`) are consumed as **Git-tag dependencies**; no private npm
registry. Both live in this monorepo; consumers pin a semver tag.

## Versioning

- Tags are annotated semver: `vMAJOR.MINOR.PATCH`.
- Keep `version` in `packages/model-kit/package.json` and
  `clients/python/pyproject.toml` in lockstep, then tag the release commit.
- Current release: `v0.1.0`.

## Consumption coordinates (verified 2026-10-28)

### pnpm projects (agent-world, job-agent, future pnpm apps)

```jsonc
"@model-hub/model-kit": "git+ssh://git@github.com:bayernjf/model-hub.git#vX.Y.Z&path:/packages/model-kit"
```

- The `&path:/packages/model-kit` fragment is **pnpm-only**. Without it, pnpm
  (and npm) unpack the repo root, which is the private workspace root package,
  and `@model-hub/model-kit` cannot be resolved.
- pnpm runs the package's `prepare` script after the clone; `prepare` builds
  `dist/` on the fly (typescript and @types/node are declared as the package's
  own devDependencies, so the fetch builds standalone).

### Python (atlas, loom, future Python apps)

```text
model-hub-client @ git+ssh://git@github.com:bayernjf/model-hub.git@vX.Y.Z#subdirectory=clients/python
```

uv/pyproject:

```toml
[tool.uv.sources]
model-hub-client = { git = "git+ssh://git@github.com:bayernjf/model-hub.git", tag = "vX.Y.Z", subdirectory = "clients/python" }
```

### npm projects (zeus)

npm does **not** support a subdirectory in git URLs (the whole fragment is
treated as the git ref), so npm projects cannot consume the workspace subpackage
this way today. zeus keeps the sibling `file:` dependency
(`file:../model-hub/packages/model-kit`) for development and same-host Docker
builds; if zeus ever needs a detached (non-sibling) deployment, revisit this
(standalone publishable layout or npm→pnpm migration) rather than inventing an
unsupported syntax.

## Release checklist

1. Land the changes on `main` (normal feature → dev → main PR flow).
2. `npm run check:all` green at the release commit.
3. Annotated tag + push:
   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   git push origin vX.Y.Z
   ```
4. Smoke-test the coordinates above in a throwaway project: install from the
   tag, then `import { initModelKit } from '@model-hub/model-kit'` and
   `import model_hub_client` must resolve.
