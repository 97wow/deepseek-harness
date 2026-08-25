# Agent Note: sign the self-contained Desktop runtime

Status: implemented

English | [中文](2026-08-25-desktop-runtime-code-signing.zh.md)

## Problem

MYTHOS Desktop embeds an extracted DSH release with about 29,000 files and pnpm links. Some profile links retained absolute paths into the extraction directory. The unsigned app worked only while that directory remained available, while strict Developer ID verification rejected the copied bundle because those links escaped `MYTHOS.app`.

Electron Builder's default macOS signer also walks every binary-looking file with unbounded recursive `Promise.all()` calls. The bundled runtime exhausted its file traversal with `EBADF`; after the runtime was excluded, the signer still followed Electron Framework aliases and attempted to sign localization `.pak` files repeatedly. A valid Developer ID identity therefore could not produce a stable signed artifact through the default path.

## Decision

`prepare-runtime.mjs` treats the extracted release as the permitted link root. It rejects every link whose canonical destination escapes that root and rewrites internal absolute links as relative links before Electron Builder copies the release. The installed app therefore resolves dependencies inside its own resources and does not retain a build-machine path.

Signed builds use `sign-macos.mjs`. The signer skips symbolic-link aliases, recognizes Mach-O magic only among executable files and native-library extensions, includes nested `.app`, `.framework`, and `.xpc` bundles, signs deepest paths first, and seals the top-level app last. Every signature uses a trusted timestamp and hardened runtime with Electron Builder's entitlements. `ElectronTeamID` is set in the app metadata for the owning Developer ID team.

Electron Builder still owns app assembly, ZIP/DMG creation, update metadata, and Notarization. Credentials enter only through its supported `APPLE_API_*` environment variables and remain outside the repository.

## Alternatives considered

**Keep the default `@electron/osx-sign` traversal.** Raising the shell file-descriptor limit does not address its unbounded file opens or duplicate Framework alias traversal. Ignoring the runtime is applied after the walk and cannot prevent the failure.

**Use `codesign --deep` on the complete app.** This hides nested signing order and applies one option set across code with different bundle roles. Explicit deepest-first signing keeps the signed subjects and entitlements reviewable.

**Store the DSH runtime as an archive inside the app.** Extracting on first launch would avoid Bundle link rules but adds mutable installation state, startup work, cleanup, and another integrity transition. Desktop keeps the verified release directly runnable from `Contents/Resources`.

## Consequences

Desktop packaging owns a small macOS-specific signer and must keep its native-file discovery aligned with future runtime binary formats and nested bundle types. Runtime links that previously depended on the extraction directory now fail during preparation instead of producing a locally functional but undistributable app.

The release path is pinned by unit tests for link normalization, link escape rejection, and Mach-O discovery. A signed package additionally requires `codesign --verify --deep --strict`, `stapler validate`, Gatekeeper acceptance, DMG/ZIP integrity checks, and a launch from an extracted distribution artifact. Remote channel publication and upgrade testing remain separate evidence.
