# Agent Note: Mythos project management documents

Status: implemented

English | [中文](2026-08-25-mythos-project-management-documents.zh.md)

## Problem

The repository documents DeepSeek Harness architecture, subsystem contracts, contributor workflows, and decisions in depth, while `products/mythos-agent/` has no product entry point. Maintainers cannot determine the Mythos mission, product-owned modules, Desktop ownership, milestone order, evidence-backed progress, development rules, or release gaps without reconstructing them from source, local evaluation data, artifacts, and commit history.

General repository documentation cannot own a mutable Mythos roadmap or progress view because those facts concern one product and change independently from reusable Harness contracts. Generated evaluation reports are authoritative for measurements but do not explain project priorities, incomplete integration, or the next accepted work package.

## Decision

`products/mythos-agent/README.md` is the product entry point and links a product-local project-management suite under `products/mythos-agent/docs/`. The suite separates vision and principles, product and Desktop architecture, module ownership, roadmap, progress, development rules, and evaluation/release policy into individual owners modeled after the useful separation in TheArcher's project records.

The product progress board is the only maintained interpretation of work-item state and ordering. Executable sources remain authoritative for versions, configuration, evaluation cases, generated measurements, release checks, and controller policy; the board links those owners and records its evidence date rather than replacing them.

The project-local suite is maintained in Simplified Chinese for the project owner. The product README remains a complete bilingual repository README under the existing pairing contract. Durable Harness architecture and package contracts remain in the repository documentation hierarchy and are linked instead of copied.

## Ownership and updates

- Product scope or principles update the vision page and the executable project model together.
- Composition, Desktop hosting, or directory responsibility changes update the architecture and module map.
- Accepted future scope enters the roadmap before it becomes a progress work item.
- A work item reaches complete only after its stated verification exists; generated evaluation data remains the numeric source.
- Evaluation, release, security, or Git workflow changes update the development-rules and quality pages with their automation.

## Alternatives considered

**Put everything in the product README.** A single long page mixes onboarding, current status, architecture, policy, and planning, making frequently changing progress edits expensive to review and obscuring the consumer-facing product contract.

**Use only source code and generated reports.** These sources accurately describe mechanisms and measurements but do not own project intent, milestone dependencies, accepted gaps, or execution order, so every maintainer must repeatedly reconstruct the same project model.

**Add Mythos status to repository-wide architecture documents.** This would mix one product's mutable implementation status into durable Harness documentation and violate the repository's one-home-per-fact hierarchy.

## Consequences

Mythos gains a stable documentation entry point and explicit maintenance rules without duplicating the Harness subsystem corpus. Product changes now carry a small documentation cost across the owning project page and progress board, while generated metrics and executable policy remain authoritative. The Chinese-only project-management pages are not covered by the repository-wide translation pairing gate, so reviewers must explicitly check their links and current-state accuracy.
