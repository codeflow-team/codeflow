# Releasing

Five packages publish from this repository: `@codeflow-team/core`, `@codeflow-team/react`,
`@codeflow-team/cli`, `@codeflow-team/mcp` and `@codeflow-team/examples`. The demo app does not
publish.

A release is **a version bump merged to `main`**. There is no tag step and no
release script: `.github/workflows/release.yml` runs on every push to `main`,
compares each package's version against the registry, and publishes only what is
not there yet. A commit that bumps nothing publishes nothing.

---

## 0. The scope, and why it is what it is

On npm a scope belongs to an organisation (or user) of the *same* name. The
obvious scope for this project, `@codeflow`, is **taken by someone else** — the
`codeflow` organisation already exists and is not ours. The organisation we own
is `codeflow-team`, so the packages are `@codeflow-team/*`.

The GitHub organisation and the npm organisation are separate namespaces that
happen to agree here: the repository is `codeflow-team/codeflow` and the npm
scope is `@codeflow-team`. Nothing under that scope is published yet.

This was settled before the first publish deliberately. A scope rename touches
every package name, every internal import, the `.npmrc` registry line, the CI
consumer smoke test and every README — mechanical, but it is the public API of
five packages, and it costs a major version and a deprecation notice once
anything is on the registry instead of a single commit before.

---

## 1. First publish: a granular access token

A trusted publisher is configured on a package's settings page, and a package
that has never been published has no settings page. So the first publish of each
package needs a token; after that it should not.

1. npm → **Access Tokens** → *Generate New Token* → **Granular Access Token**.
   (Classic "automation" tokens were removed from npm in November 2025. If a
   guide mentions them, it means this.)
2. Configure it:
   - **Packages and scopes**: read *and write*, limited to the `@codeflow-team`
     scope.
   - **Expiration**: short. This token exists to bootstrap five packages; a week
     is plenty.
   - **Bypass 2FA**: enabled — a CI job cannot answer a 2FA prompt.
3. GitHub → repository **Settings → Secrets and variables → Actions → New
   repository secret**, named exactly `NPM_TOKEN`.
4. Bump the versions you want to release (they start at `0.1.0`, which has never
   been published, so the first release needs no bump at all), and push to
   `main`.
5. Watch the run. The job summary says how it authenticated and what it
   published.

The token is never written to a file in the repository. The workflow appends the
*templated* line `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` to `$HOME/.npmrc`
and npm substitutes it from the environment.

> Why not commit that line, as npm's own CI/CD guide suggests? Because pnpm
> discards an entire `.npmrc` whose env placeholder it cannot resolve, which
> would take the `@codeflow-team:registry` line down with it for every contributor
> without an `NPM_TOKEN`. See the comment in [`.npmrc`](.npmrc).

---

## 2. Every publish after that: trusted publishing, no secret

Once a package exists on the registry, configure it to trust this workflow and
the long-lived secret stops being necessary.

For **each** of the five packages, on npmjs.com → the package → **Settings** →
*Trusted Publisher*:

| Field | Value |
|---|---|
| Publisher | GitHub Actions |
| Organization or user | `codeflow-team` |
| Repository | `codeflow` |
| Workflow filename | `release.yml` |
| Environment | *(leave empty)* |

Every field is matched **case-sensitively and exactly**, the workflow filename
included. If you later rename the workflow file, every one of these five entries
has to be updated or publishing stops.

Then:

1. Delete the `NPM_TOKEN` secret from the repository.
2. Optionally, on the npm organisation: **Require two-factor authentication and
   disallow tokens**. Trusted publishing keeps working — it does not use a token
   — so this closes the door behind you.

The workflow already carries what OIDC needs: `permissions: id-token: write`,
Node 24, and an npm upgraded to ≥ 11.5.1 at the start of the job. Provenance is
generated automatically, so each published version links back to the commit and
the workflow run that built it.

---

## 3. Cutting a release

```bash
# 1. Decide the version. All five move together unless you have a reason.
#    (`workspace:^` dependencies are rewritten to a real range at pack time.)
pnpm -r --filter "./packages/*" exec npm version minor --no-git-tag-version

# 2. Update CHANGELOG.md.

# 3. Commit on a branch, open a PR, let CI run, merge.
```

CI on the PR is the real gate. Beyond unit tests and typecheck it packs every
package, refuses any tarball that still contains a `workspace:` specifier,
installs the tarballs into a scratch project, imports them as ESM, type-checks a
consumer file under both `bundler` and `node16` module resolution, and runs the
`codeflow` binary end to end. That job exists because `pnpm build` cannot see a
wrong `files` or `exports` field — only a real install of a real tarball can.

Merging to `main` triggers the release job, which repeats build/test/typecheck
before publishing anything.

### If a publish fails halfway

Nothing is transactional: if `@codeflow-team/core` published and `@codeflow-team/react`
failed, core stays published. Fix the cause and push again — the loop skips
every version already on the registry, so re-running is safe and idempotent.
Do not `npm unpublish`; bump the patch version instead.

---

## 4. The demo site

`.github/workflows/deploy-demo.yml` builds the demo as a static bundle and
deploys it to GitHub Pages. It needs one manual step, once:

**Settings → Pages → Build and deployment → Source → GitHub Actions.**

Until that is set, the workflow builds successfully and the deploy step fails.
The two server-shaped features (the MCP-backed runner and the AI chat) degrade
explicitly in that build rather than pretending to work — see
`apps/demo/src/deployment.ts`.
