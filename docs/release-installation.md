# Installing a GitHub release on Homey Pro

Download `homey-sigenergy-vX.Y.Z.tar.gz` and `SHA256SUMS` from the same [GitHub release](https://github.com/Marza/homey-sigenergy/releases). Use the attached build, not GitHub's automatically generated source archives.

Requirements: Node.js 24 or newer, npm, a local Homey Pro running Homey 12.3.0 or newer, a Homey account with access to it, and network access from the computer to Homey. Basic hardware verification currently covers one Homey Pro on firmware 13.5.4; see the repository README for compatibility limits.

In a terminal, replace `X.Y.Z` with the downloaded version:

```sh
# Linux:
sha256sum -c SHA256SUMS
# macOS alternative:
shasum -a 256 -c SHA256SUMS

mkdir homey-sigenergy-release
cd homey-sigenergy-release
tar -xzf ../homey-sigenergy-vX.Y.Z.tar.gz
npx --yes --package homey@4.6.3 homey login
npx --yes --package homey@4.6.3 homey select
npx --yes --package homey@4.6.3 homey app install
```

Select the intended Homey. The archive contains the production app and its runtime dependencies. The pinned Homey CLI validates and prepares those files before uploading them; a repository checkout and `npm ci` are unnecessary. npm downloads the CLI on first use. Windows users can use a terminal with `tar` and verify the archive with `Get-FileHash -Algorithm SHA256` against `SHA256SUMS`.

Installation updates the app with the same ID, `com.local.sigenergy.optimizer`. Do not uninstall the existing app or use `--clean` when updating. Export history first as a backup. Installation restarts the app and temporarily interrupts readings. After installation, check that the Sigenergy device is available and Tibber diagnostics show fresh prices. The app remains read-only, in learning mode.

This is a local developer installation, not an App Store release or a package that can be opened directly in the Homey mobile app. GitHub Actions never connects to your Homey or receives your Homey/Tibber credentials.

## Release automation

After the CI test job succeeds for a push to `main`, the release job selects the next stable SemVer, stamps `app.json`, `package.json` and the lockfile in the runner, reruns tests, builds with the locked Homey CLI, and verifies the extracted archive can be built. Only then does it push a `vX.Y.Z` tag and publish the GitHub release with the archive, SHA-256 checksum and these instructions. Pull requests and other branches never publish.

The first release increments the manifest patch (`0.17.0` → `0.17.1`). Subsequent releases increment the highest stable `vX.Y.Z` tag numerically. For a minor/major release, raise both manifest and package versions (including the lockfile) above the latest tag in your PR. Commit messages are not interpreted as release instructions. Prerelease and unrelated tags are ignored.

The tag points to the tested source commit on `main`. Release versions are injected only into the build; the automation does not commit version changes back to `main`. `release.json` in the archive records its version, exact source commit, CLI version and build Node version. Rebuilding a source tag manually requires stamping that tag's version with `node scripts/release-version.js` before building.

Release jobs are serialized and active releases are not cancelled. GitHub concurrency can replace pending jobs when pushes arrive rapidly; the newest queued push is then released. A rerun reuses the version already tagged on its commit and leaves a published release untouched. If publication fails after tagging, rerun the failed job to finish the draft and upload assets. Tags and published releases are never moved or overwritten by the workflow.

The job uses the repository's `GITHUB_TOKEN` with `contents: write` to create tags/releases; no personal token is needed. Repository or organization rules that block Actions from creating tags/releases must allow this workflow. Tests do not certify App Store readiness or physical installation of each release.
