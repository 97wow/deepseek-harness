# Agent Note: keep Desktop beta updates on a discoverable channel

Status: implemented

English | [中文](2026-08-25-desktop-beta-update-channel.zh.md)

## Problem

The packaged beta client inferred prerelease eligibility from its own version but did not set an update channel. The generic provider therefore requested `latest-mac.yml` instead of the published `beta-mac.yml`. The GitHub fallback also ignored the release because its product-prefixed tag was not valid SemVer.

## Decision

Every Desktop beta updater explicitly enables prereleases and selects the `beta` channel before disabling downgrades. Release tags consumed by Electron Updater use the SemVer-compatible `v<version>` form, while human-readable product naming remains in the release title and asset names.

The assignment order is intentional: Electron Updater enables downgrades when its channel setter runs, so `allowDowngrade = false` must remain after `channel = 'beta'`.

## Consequences

Both the managed generic source and GitHub fallback request `beta-mac.yml`. Release automation must preserve SemVer-compatible tags, and tests pin prerelease, channel, and downgrade settings. A published artifact is not considered accepted until an older signed build discovers, downloads, and installs it.
