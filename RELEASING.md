# Releasing Noddit

`.github/workflows/release.yml` builds the desktop app for macOS, Windows and Linux,
opens a draft GitHub Release with every installer attached, and optionally publishes the
`nod`/`decs` npm package and the `noddit` PyPI package. It runs on two triggers:

- **push a tag matching `v*`** (e.g. `v1.2.3`) — builds everything, opens a draft release,
  and (if configured) publishes npm/PyPI.
- **"Run workflow" (`workflow_dispatch`) with a version input** — a dry run. It builds the
  same matrix and checks the same versions, but publishes nothing: no release, no npm, no
  PyPI. Use it to prove all three platforms still build before cutting a real tag, or after
  changing the workflow itself.

## One-time setup

Nothing below is required to build or test the app locally — only to sign/notarize the
release builds and to turn on the optional publish jobs. Everything is off (unsigned build,
no publish) until its secrets exist.

Add these under the repo's **Settings → Secrets and variables → Actions**.

### macOS signing + notarization (secrets)

See [`app/SIGNING.md`](app/SIGNING.md) for how to get these in the first place.

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64 of the exported "Developer ID Application" `.p12` (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | Optional. The identity's full name (e.g. `Developer ID Application: Example Ltd (TEAMID1234)`). If omitted, CI finds it itself from the imported certificate. |

Pick **one** notarization method:

| Secret | What it is |
| --- | --- |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | An Apple ID email, an app-specific password for it, and the team id |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | An App Store Connect API key: `APPLE_API_KEY` is the base64 of the downloaded `AuthKey_<id>.p8` file (not the key id itself — that's `APPLE_API_KEY_ID`), plus the issuer id |

Without `APPLE_CERTIFICATE`, macOS builds are unsigned (well, ad-hoc signed — see
[What users download](#what-users-download)). Without a notarization method, they're
signed but not notarized; Gatekeeper still warns once.

### Windows signing (hook only, nothing wired up yet)

Windows builds are unsigned today. `release.yml` has a gated, documented hook for Azure
Artifact Signing (formerly Trusted Signing): set the repo **variable** `WINDOWS_CODESIGN` to
`azure-artifact-signing`, the repo variables `AZURE_SIGNING_ENDPOINT`,
`AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_CERT_PROFILE`, and the secrets `AZURE_TENANT_ID`,
`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` for an Azure service principal with Trusted Signing
permission. This path hasn't been exercised against a real Azure account — treat it as a
starting point, not a guarantee. See [`app/SIGNING.md`](app/SIGNING.md) for the other
options (OV/EV certificate, SignPath) if Azure Trusted Signing doesn't fit.

### npm publish (optional)

Set the secret `NPM_TOKEN` (an npm automation token with publish rights to
`@wecarbon/noddit`). The job runs `npm publish --provenance --access public` on every tag
push; without the secret it's skipped.

### PyPI publish (optional)

Either:
- Set the secret `PYPI_API_TOKEN` (a PyPI API token scoped to the `noddit` project), or
- Configure a [PyPI trusted publisher](https://docs.pypi.org/trusted-publishers/) for this
  repo (`WeCarbon/noddit`), workflow (`release.yml`), job (`pypi-publish`) — no secret
  needed, PyPI trusts GitHub's OIDC token directly — and then set the repo **variable**
  `PYPI_TRUSTED_PUBLISHING` to `true`. (The variable just turns the job on; trusted
  publishing itself needs no secret, which is the point, but the job still has to know to
  run.)

Without either, the job is skipped.

## Cutting a release

1. From a clean `main`, run:

   ```sh
   scripts/release.sh 1.2.3
   ```

   (or `node scripts/release.mjs 1.2.3` — same thing, no bash/perl, for a Windows machine
   without Git Bash/WSL.) This bumps the version in `package.json`, `app/package.json`,
   `app/src-tauri/tauri.conf.json`, `app/src-tauri/Cargo.toml` and `python/pyproject.toml`,
   runs the gate (`npm test && npm run typecheck`), commits `release v1.2.3`, and tags it
   locally. It does **not** push — it prints the exact command to run next.

2. Review the commit, then run the command it printed:

   ```sh
   git push origin main v1.2.3
   ```

3. Watch the `release` workflow run in the Actions tab. It builds macOS (universal dmg),
   Windows (NSIS `.exe` + `.msi`) and Linux (`.AppImage` + `.deb`), then opens a **draft**
   release named `v1.2.3` with all five files attached and generated release notes
   (prefixed with a line about what's signed and what isn't).

4. Open the draft, check it, edit the notes if you want, and publish it yourself. Nothing
   publishes automatically except the optional npm/PyPI jobs above, which run alongside the
   build (not gated on you publishing the draft).

### Dry run

Before cutting a tag — especially after touching `release.yml` itself — use **Actions →
release → Run workflow**, type the version currently on `main` (or whatever you want
checked), and run it on `main`. It runs the exact same version check and the exact same
three-platform build, uploads the installers as workflow artifacts you can download and
poke at, and stops: no draft release, no npm publish, no PyPI publish.

## What users download

| Platform | File(s) | Notes |
| --- | --- | --- |
| macOS | `noddit_<version>_universal.dmg` | One universal dmg, Apple Silicon and Intel |
| Windows | `.exe` (NSIS installer), `.msi` | Either works; NSIS is smaller |
| Linux | `.AppImage`, `.deb` | AppImage runs on most distros without installing; `.deb` is for Debian/Ubuntu |

### Gatekeeper (macOS)

If the release wasn't built with a Developer ID certificate (see above), the app is
unsigned. Opening it after downloading: right-click (or Control-click) `Noddit.app`, choose
**Open**, confirm once in the dialog that appears. After that it opens normally. If it's
signed but not notarized, Gatekeeper shows a milder "can't verify" prompt the first time
instead. Signed *and* notarized: no prompt at all.

### SmartScreen (Windows)

Unsigned (today, always, until Windows signing is wired up): SmartScreen says "Windows
protected your PC". Click **More info**, then **Run anyway**. This is routine for any new,
unsigned installer — it's not specific to Noddit.

### Linux

AppImage and `.deb` builds aren't code-signed on Linux (there's no OS-level equivalent of
Gatekeeper/SmartScreen to satisfy); nothing extra to click through.
