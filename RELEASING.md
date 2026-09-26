# Releasing TheOne for macOS

Updates are served from GitHub Releases of `weareoneconnection/theonedesktop`
(this repository, public). TheOne's download link (`/api/theone/desktop/download`)
follows the newest release's .dmg. macOS installs an update
only into a signed app, so every release must be signed and notarized.

## One-time setup (done by the account owner)

1. Apple Developer Program membership.
2. A **Developer ID Application** certificate in the login keychain
   (Xcode → Settings → Accounts → Manage Certificates → +), or exported as a
   .p12 for CI (`CSC_LINK` = path or base64, `CSC_KEY_PASSWORD`).
3. Notarization credentials, one of:
   - App Store Connect API key: `APPLE_API_KEY` (path to .p8), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
   - Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
4. A GitHub token that can create releases in `weareoneconnection/theonedesktop`: `GH_TOKEN`.

## Each release

1. Bump `version` in package.json.
2. `npm test`
3. With the variables above in the environment: `npm run release:mac`
   (bundles the runtime, builds dmg + zip, signs, notarizes, uploads to a
   draft-free GitHub release together with `latest-mac.yml`).

Installed apps check about 20 seconds after launch and every 4 hours, download
in the background, and install on quit or from **TheOne → 重启以更新**.

`npm run dist:mac` builds locally without publishing (unsigned when no
certificate is found; such a build runs but cannot update itself).
