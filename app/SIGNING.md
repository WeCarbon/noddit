# Signing the desktop app

An unsigned build works on the machine that built it. On anyone else's Mac, Gatekeeper
says the developer cannot be verified; on Windows, SmartScreen warns before the installer
runs. Signing (and on macOS, notarisation) removes that.

`npm run dmg` builds whichever it can: signed and notarised when the Mac has the
credentials below, unsigned otherwise. Nothing here is needed to develop or test the app.

For CI releases (`.github/workflows/release.yml`, cut with `scripts/release.sh`), the same
credentials go in as GitHub secrets instead of local keychain/notarytool state — see
[RELEASING.md](../RELEASING.md) for the exact secret names and what each build type looks
like unsigned. Unsigned macOS builds, local or CI, still get an ad-hoc signature
(`bundle.macOS.signingIdentity: "-"` in `tauri.conf.json`) — without even that, Apple
Silicon refuses to launch a binary downloaded from the browser at all (it reports the app as
"damaged", which is really Gatekeeper rejecting a completely unsigned arm64 Mach-O). A real
Developer ID identity, local or via `APPLE_SIGNING_IDENTITY`, always wins over the ad-hoc
default.

## macOS: Developer ID signing and notarisation

You need a paid [Apple Developer Program](https://developer.apple.com/programs/) membership
(about US$99 a year) on the account that will publish the app.

### One-time setup (on the Mac that builds releases)

1. **Create a "Developer ID Application" certificate.** Either
   - in Xcode: Settings → Accounts → select the team → Manage Certificates → **+** →
     *Developer ID Application*; or
   - at [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list):
     **+** → *Developer ID Application*, upload a certificate signing request made with
     Keychain Access (Certificate Assistant → Request a Certificate from a Certificate
     Authority → Saved to disk), download the certificate and double-click it.

   Only the account holder or an admin of the team can create it. The certificate and its
   private key end up in the **login** keychain. Check:

   ```sh
   security find-identity -v -p codesigning
   # 1) 0123ABCD… "Developer ID Application: Example Ltd (TEAMID1234)"
   ```

   Back the identity up (Keychain Access → export as .p12 with a password) and keep it out
   of the repository. Anyone holding it can sign software as you.

2. **Give `notarytool` credentials.** Notarisation uploads the dmg to Apple, which scans it
   and issues a ticket. `notarytool` keeps the credentials in the keychain under a profile
   name; the build uses the profile `noddit-notary`. Use one of:

   - **An app-specific password.** Create one at [account.apple.com](https://account.apple.com)
     → Sign-In and Security → App-Specific Passwords. Then:

     ```sh
     xcrun notarytool store-credentials noddit-notary \
       --apple-id <the Apple Account email> --team-id <TEAMID1234>
     # it prompts for the app-specific password; it is never written anywhere else
     ```

   - **An App Store Connect API key** (better for CI). In App Store Connect → Users and
     Access → Integrations → Team Keys, create a key with the *Developer* role, download
     the `AuthKey_<KEYID>.p8` once, and either store it in the profile:

     ```sh
     xcrun notarytool store-credentials noddit-notary \
       --key AuthKey_<KEYID>.p8 --key-id <KEYID> --issuer <ISSUER-UUID>
     ```

     or skip the profile and export `APPLE_API_KEY_PATH`, `APPLE_API_KEY` (the key id) and
     `APPLE_API_ISSUER` for the build.

   Check the profile works: `xcrun notarytool history --keychain-profile noddit-notary`.

### Building a release

```sh
cd app
npm run dmg
# … Submitting to Apple's notary service (usually a few minutes)…
# src-tauri/target/release/bundle/dmg/noddit_0.1.0_aarch64.dmg (2.1M, signed, notarised)
```

What it does:

1. Finds the first *Developer ID Application* identity in the keychain (or uses
   `APPLE_SIGNING_IDENTITY`), and has Tauri sign `Noddit.app` with it, with the hardened
   runtime and [`src-tauri/entitlements.plist`](src-tauri/entitlements.plist).
2. Packs the app into a dmg and signs the dmg.
3. Submits the dmg with `notarytool` (profile `NOTARY_PROFILE`, default `noddit-notary`, or
   the API key variables), waits, prints Apple's log if it is rejected.
4. Staples the ticket to the dmg, so it opens without a network round trip.

`npm run dmg -- --no-notarize` signs only; `npm run dmg -- --unsigned` does neither. With no
identity in the keychain it builds unsigned and says so.

### Checking a build

```sh
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/Noddit.app
codesign -dv src-tauri/target/release/bundle/macos/Noddit.app   # flags=…(runtime), Authority=Developer ID Application: …
xcrun stapler validate src-tauri/target/release/bundle/dmg/noddit_*.dmg
spctl -a -t open --context context:primary-signature -vv src-tauri/target/release/bundle/dmg/noddit_*.dmg
# …: accepted   source=Notarized Developer ID
spctl -a -vv /Applications/Noddit.app                            # after installing from the dmg
```

### Entitlements

The app runs with the hardened runtime and no exceptions (`entitlements.plist` is an
empty dictionary). Nothing it does needs one: it starts `node`/`nod` as child processes
that run under their own signatures, the global hotkey uses Carbon's `RegisterEventHotKey`,
notifications are granted by the user on first use, and WebKit's JIT runs in WebKit's own
process. It is not sandboxed, because it reads project folders anywhere on disk and runs the
`nod` CLI. If a future feature needs an exception (loading a third-party library, say),
add only that key and say why next to it.

## Windows: Authenticode

### Can a website's SSL/TLS certificate sign the app?

No. A TLS certificate is issued for server authentication only (its Extended Key Usage is
`serverAuth`), and Windows rejects it for code. Signing executables needs a certificate
issued for code signing (`codeSigning` EKU) — an Authenticode certificate — or a signing
service that holds one for you.

### Options

| Option | Rough cost | What you need | Notes |
| --- | --- | --- | --- |
| [Azure Artifact Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/) (formerly Trusted Signing) | ~US$9.99/month (Basic, 5,000 signatures) | An Azure subscription; Microsoft validates the organisation's identity (a few business days) | Microsoft's recommended route outside the Store. Organisations in the USA, Canada, EU and UK; individuals in the USA and Canada only — check eligibility first. No hardware token. |
| OV code-signing certificate (DigiCert, Sectigo, GlobalSign…) | ~US$150–300/year | The CA validates the organisation; since June 2023 the private key must live on a hardware token or a cloud HSM | Works from any country. |
| EV code-signing certificate | ~US$400+/year | Stricter validation, hardware token or HSM | Since 2024 no longer skips SmartScreen; no advantage over OV for that. |
| [SignPath Foundation](https://signpath.io) | Free for qualifying open-source projects | An application; signing runs in their managed pipeline | Noddit is MIT-licensed, so worth checking. |

Prices are approximate, as listed by Microsoft in
[Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
(updated 2026-08) and the Artifact Signing pricing page; CA prices vary by vendor and term.

### What Tauri needs

Tauri signs the app executable, the NSIS installer and its uninstaller, and the MSI.
See [Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/).

- **Artifact Signing:** install `artifact-signing-cli` (or use `signtool` with Microsoft's
  signing dlib), set the Azure credentials (`AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
  `AZURE_TENANT_ID`) and add to `tauri.conf.json`:

  ```json
  "bundle": { "windows": { "signCommand": "artifact-signing-cli -e https://<region>.codesigning.azure.net -a <account> -c <certificate-profile> -d Noddit %1" } }
  ```

- **OV/EV certificate on a token or in a cloud HSM:** `signtool` with the vendor's
  instructions, or set `bundle.windows.certificateThumbprint`, `digestAlgorithm: "sha256"`
  and `timestampUrl` (the CA's RFC 3161 server) when the certificate is in the Windows
  certificate store.

Windows builds have to run on Windows (or in CI on a Windows runner); none of this has
been tried yet.

### SmartScreen

Signing alone does not silence SmartScreen. Reputation builds per file hash and per signing
identity as people download and run the app; the first releases from a new identity can
still show "Windows protected your PC" until it has enough. Keep the same signing identity
from release to release so later versions inherit it. See
[SmartScreen reputation for developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).
