# Agent Note: prune unreachable platform data from the macOS arm64 Desktop build

Status: implemented

English | [中文](2026-08-25-desktop-macos-arm64-size-pruning.zh.md)

## Problem

Archiving the Runtime reduced the app Bundle file count, but the notarized Beta 7 installation still occupied about 326 MB and its DMG was about 170.3 MB. The app shipped every Electron localization directory even though the product exposes only English and Chinese, and the macOS arm64 Runtime carried `node-pty` prebuilds for macOS x64, Linux, and Windows.

## Decision

The macOS arm64 build keeps only Electron's `en`, `zh_CN`, and `zh_TW` localization resources through Electron Builder's supported `electronLanguages` option. Product copy remains owned by the existing symmetric English and Chinese dictionaries; these Electron resources cover Chromium and native framework strings rather than adding product locales.

Before signing and re-sealing the Desktop-specific Runtime archive, the pack step locates physical `node-pty/prebuilds` trees that contain a `darwin-arm64` variant and deletes only their other platform directories. It does not prune JavaScript packages, provider SDKs, dynamic plugins, or native data from any unrelated package. The retained arm64 binaries are then signed and the release integrity inventory is regenerated from the pruned tree.

## Alternatives considered

**Remove large provider SDKs from the Runtime dependency closure.** The Host supports dynamically assembled providers and plugins, so package size alone does not prove a dependency unreachable. Removing those packages would need a separate product-profile reachability proof and broader behavior tests.

**Manually delete Electron framework data such as ICU, resource packs, or graphics components.** Those files are shared browser-runtime inputs rather than locale-specific variants. Electron Builder does not expose them as optional for this product, so deleting them would create an unsupported framework layout.

**Replace Electron with a native shell.** This could remove most of the Electron framework, but it changes the renderer, updater, process bridge, signing surface, and release architecture. It is a product rewrite rather than a distribution pruning step.

## Consequences

The notarized Beta 8 app contains three Electron localization directories instead of 220 and signs seven Runtime Mach-O binaries instead of nine. A fresh extracted Runtime contains only the `darwin-arm64` `node-pty` prebuild.

Installed app size fell from about 326 MB to 276 MB. The Runtime archive fell from 51,284,783 to 45,425,145 bytes, the DMG from 170,257,780 to 152,646,197 bytes, and the ZIP from 170,195,156 to 152,379,719 bytes. This is a low-risk reduction of about 50 MB installed and 17.6 MB downloaded; the remaining 229 MB Frameworks directory is principally Electron and cannot be removed without a larger shell change.

The distributed ZIP passed strict code-sign verification, Stapler validation, Gatekeeper as a Notarized Developer ID app, first Runtime activation, Host startup, and an HTTP 200 Web response. Unit coverage pins both the incompatible-prebuild removal and the rule that unrelated prebuild trees remain untouched.
