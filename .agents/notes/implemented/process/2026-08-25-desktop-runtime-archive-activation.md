# Agent Note: activate the Desktop runtime outside the app bundle

Status: implemented

English | [中文](2026-08-25-desktop-runtime-archive-activation.zh.md)

## Problem

The signed Desktop beta copied the complete Mythos release tree into `MYTHOS.app`. Of 28,823 regular release files, 28,808 belonged to the runtime, alongside 3,292 links and about 297 MB of installed data. This made macOS signing traverse thousands of subjects and made app installation copy a large small-file tree even though the deterministic product archive was only about 49 MB.

## Decision

Desktop embeds the existing deterministic Mythos `.tar.gz` release and its SHA-256 file as signed app resources. On first packaged launch it verifies the archive path inventory, streams and compares the archive digest, extracts into a unique staging directory under Application Support, and verifies the extracted tree against `release-integrity.json`. Only then does it write a `.ready` marker and atomically rename staging to the digest-addressed runtime directory.

The BrowserWindow loading surface is visible during activation. Concurrent activation calls share one task. A later launch requires both a `.ready` marker matching the signed archive digest and a fresh verification of the mutable extracted tree; a failed verification deletes and reconstructs that digest directory. The application version chooses the runtime by content digest, so it does not need a mutable global current-version pointer.

## Alternatives considered

**Keep the expanded runtime inside `MYTHOS.app`.** This has the simplest startup path but preserves the signing, copying, and Bundle link costs that motivated the change.

**Bundle DSH into one executable.** DSH loads a broad production dependency closure, native modules, profiles, and static Web assets. Freezing those dynamic boundaries into one executable would be a larger compatibility project and would weaken reuse of the already verified release format.

**Extract without full release verification.** The app signature and archive SHA-256 already protect the resource, but validating `release-integrity.json` before activation keeps the installed mutable copy independently auditable and rejects link or extraction anomalies.

## Consequences

First launch performs one extraction and approximately 31,000 integrity checks; the measured release took about 10.7 seconds on the development machine. A repeat full verification took about 5.3 seconds. Runtime data now consumes Application Support space in addition to the compressed archive inside the app, and a later cleanup policy must retain any runtime still used by an installed version.

Release packaging now requires `MYTHOS_RUNTIME_ARCHIVE` and the sibling `.sha256`, not an extracted `MYTHOS_RUNTIME_ROOT`. Signed-release acceptance still requires first-launch, repeat-launch, corrupted-archive, and application-update tests on the distributed artifact.
