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

1. Merge and review the exact OneClaw commit that belongs in the desktop
   release. Keep its full 40-character SHA as `ONECLAW_RELEASE_COMMIT`; point
   `ONECLAW_DIR` at that clean checkout when it is not the default sibling.
2. Bump `version` in package.json and package-lock.json.
3. `npm test`
4. With the variables above in the environment: `npm run release:mac`.
   The command now fails before upload unless the OneClaw checkout is clean
   and exactly matches `ONECLAW_RELEASE_COMMIT`. It then builds and verifies
   every local updater asset plus the packaged runtime digest before a separate
   publish step uploads those already-checked files. Finally it verifies the
   complete GitHub release, including blockmaps and `latest-mac.yml`.

Installed apps check about 20 seconds after launch and every 4 hours, download
in the background, and install on quit or from **TheOne → 重启以更新**.

`npm run dist:mac` builds without publishing and without a Developer ID: the
whole bundle is signed ad hoc (`identity: "-"`, no hardened runtime, no
notarization). A downloaded ad-hoc build opens through System Settings →
Privacy & Security → Open Anyway; it cannot update itself. Without the ad-hoc
signature macOS calls a downloaded app "damaged" and offers no way to open it.
