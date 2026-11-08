# Releasing loom

`@jbarket/loomai` publishes to npm from `.github/workflows/release.yml`, triggered by
pushing a `v*` tag. There is **no npm token anywhere in this repo** — the
workflow authenticates with npm *trusted publishing* (OIDC), which is why
nothing here expires.

## One-time setup

npm's trusted publishing cannot perform a package's **first** publish: the
trusted-publisher config lives in the package's settings page, and that page
does not exist until the package does ([npm/cli#8544][8544], still open).
So the first version goes up by hand, once, and every version after that is
CI-only.

[8544]: https://github.com/npm/cli/issues/8544

### 1. Publish the first version by hand

Keep 2FA enabled on the npm account — this flow does not need it disabled.

```bash
npm login                     # browser auth
git checkout main             # at the release commit
npm ci && npm run build && npm test
npm publish --provenance=false
```

`--provenance=false` is required: `package.json` sets
`publishConfig.provenance: true`, and npm hard-fails with
`EUSAGE: Automatic provenance generation not supported for provider: <name>`
when that is set outside a supported CI provider. CLI flags take precedence
over `publishConfig`, so the flag is enough — do not edit `package.json`.
npm will prompt for the 2FA one-time password.

This is the only release that ships without provenance.

### 2. Configure the trusted publisher

Either from the CLI (npm >= 11.15):

```bash
npm trust github sleepunit-agents/loom --workflow release.yml
```

or on <https://www.npmjs.com/package/@jbarket/loomai/access>, add a GitHub Actions
trusted publisher:

| Field | Value |
| --- | --- |
| Organization or user | `sleepunit-agents` |
| Repository | `loom` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |

The workflow filename is matched exactly. Renaming or moving `release.yml`
breaks publishing until the config is updated.

### 3. Optional: require 2FA for everything else

With trusted publishing in place, the npm account can keep 2FA on "auth and
writes" without breaking CI, because CI no longer authenticates as a user.

## Every release after that

```bash
# bump version in package.json, update CHANGELOG.md, commit
git tag v0.4.2
git push origin v0.4.2
```

The workflow builds, tests, checks that the tag matches
`package.json` version, publishes with provenance, and cuts a GitHub release
with generated notes. Tags containing `-alpha`/`-beta`/`-rc` are marked as
prereleases.

## Things that will bite you

- **Do not backfill historical tags.** The CHANGELOG lists versions back to
  `0.3.1` whose tags were lost in the Forgejo migration. Pushing them now
  would fire one publish job per tag.
- **`repository.url` must match the building repo.** Provenance validates the
  manifest's repository against the repository that built it; a mismatch fails
  at the publish step after a full build and test run.
- **npm >= 11.5.1 is required for OIDC.** Node 22.x ships npm 10.x, so the
  workflow runs `npm install -g npm@latest` before `npm ci`. If the publish
  step ever starts reporting `ENEEDAUTH` or a bare 404, check the npm version
  in the log first — failed trusted-publishing handshakes surface as
  misleading auth errors ([npm/cli#9088](https://github.com/npm/cli/issues/9088)).
- **`permissions: id-token: write`** is what makes OIDC possible. Removing it
  makes npm silently skip trusted publishing and fall back to looking for a
  token that does not exist.
