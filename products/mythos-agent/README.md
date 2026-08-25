# Mythos Agent

English | [中文](README.zh.md)

Mythos Agent is a product-specific coding agent built on DeepSeek Harness. This directory owns the Mythos composition, evaluation suites, evidence flywheel, release process, and strategic controller; reusable agent runtime capabilities remain in the repository's `packages/` workspaces.

## Product status

The product manifest is version `0.1.1` and pins DeepSeek Harness `0.1.0-rc.8`. Source and self-contained Headless/Web surfaces, a resumable interactive CLI, repeatable evaluation infrastructure, content-verified release archives, and the controller decision kernel exist. MYTHOS Desktop is at `0.2.0-beta.7` with an archived self-contained runtime, managed service routing, signed hot configuration, and verified application updates. The active work is refreshing paid evaluation evidence, completing real-repository and server-data release gates, and connecting the controller to real project state and Lead ports.

The maintained project plan and evidence-backed status are in the [project documentation](docs/项目文档索引.md). That documentation is currently maintained in Simplified Chinese for the project owner.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`.
- The repository dependencies installed with the root-pinned pnpm version.
- A completed root build for source launches because the source launcher executes `apps/cli/lib/bin.js`; an extracted release carries its own runtime closure.
- `DEEPSEEK_API_KEY` in the environment or the ignored root `.env` file for real model runs.

## Run the product

Run a headless task from the repository root:

```sh
pnpm --dir products/mythos-agent agent -- "inspect this repository and report the relevant test commands"
```

Run the Web surface:

```sh
pnpm --dir products/mythos-agent web
```

Both surfaces set `DSH_HOME` to this product's `home/` directory and use the same model identity, persona, and agent preset. The Web surface disables user presets and product-changing model or plugin controls.

## Development commands

| Command | Purpose |
|---|---|
| `pnpm --dir products/mythos-agent test` | Run product unit and contract tests. |
| `pnpm --dir products/mythos-agent typecheck` | Type-check evaluation, flywheel, product, and release code. |
| `pnpm --dir products/mythos-agent typecheck:control` | Type-check the strategic controller separately. |
| `pnpm --dir products/mythos-agent smoke:web` | Exercise the built Web product surface. |
| `pnpm --dir products/mythos-agent eval` | Run the release evaluation suite with the real product. |
| `pnpm --dir products/mythos-agent eval:comprehensive` | Run all single-turn evaluation cases. |
| `pnpm --dir products/mythos-agent eval:journey` | Run the cold-resume multi-turn journey. |
| `pnpm --dir products/mythos-agent eval:advanced-journey` | Run compaction and parallel-subagent journeys. |
| `pnpm --dir products/mythos-agent eval:real-repo` | Run pinned real-repository cases. |
| `pnpm --dir products/mythos-agent release:verify` | Run the assembled product release checks and gates. |
| `pnpm --dir products/mythos-agent release:pack` | Create a deterministic archive and SHA-256 file from `HEAD`. |
| `npm --prefix apps/desktop test` | Run MYTHOS Desktop presentation, routing, and signed-config tests. |
| `MYTHOS_RUNTIME_ARCHIVE=<release.tar.gz> npm --prefix apps/desktop run pack:mac` | Package the Desktop beta with a deterministic Mythos runtime archive and its sibling `.sha256`. |

Real evaluations consume model quota and create local run data. Use the smallest suite that covers a change; do not rerun paid evaluations for documentation-only or unrelated edits.

## Directory ownership

| Directory | Responsibility |
|---|---|
| `control/` | Strategic project model, decision policy, durable controller memory, review, and watchdog. |
| `docs/` | Product vision, architecture, module map, roadmap, progress, development rules, and quality gates. |
| `eval/` | Evaluation cases, immutable execution snapshots, launchers, and external verifiers. |
| `flywheel/` | Raw-evidence archival, cohort analysis, curation, server-data import, and release gates. |
| `home/` | Shippable Headless/Web profiles and the Mythos agent preset. |
| `product/` | Product launch and configuration-identity verification. |
| `release/` | Secret checks, release verification, deterministic packing, and archive validation. |
| `../../apps/desktop/` | Electron desktop shell, managed routing, signed hot configuration, updates, and macOS packaging. |

## Runtime data and secrets

The product reads credentials from the environment. Never place a real key in tracked YAML, tests, logs, evaluation fixtures, or release archives. The product `.gitignore` excludes local credentials and state, including `home/sessions/`, `home/storages/`, `runs/`, `flywheel/data/`, and `dist/`.

Flywheel source data may intentionally preserve raw identity and content for controlled analysis, but that data is not source code and must remain outside Git and release artifacts. Release secret scanning reports only policy names and must never echo suspected credential values.

## Documentation

Start with the [Mythos Agent project documentation](docs/项目文档索引.md). Repository-wide architecture, subsystem contracts, and contributor workflow remain in the root [architecture](../../docs/architecture.md), [subsystem index](../../docs/subsystems/README.md), and [development guide](../../docs/development.md).
