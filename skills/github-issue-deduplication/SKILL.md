---
name: github-issue-deduplication
description: Identifies duplicate GitHub issues in a single repository by comparing titles, bodies, labels, and symptoms. Use when deduplicating an issue tracker or finding the same bug reported twice. Repository identity is injected at runtime (see placeholders <<<GITHUB_*>>> in the skill body).
---

# GitHub issue deduplication

## Repository context (injected)

This run targets **`<<<GITHUB_REPO_SLUG>>>`** (issues: **`<<<GITHUB_ISSUES_URL>>>`**). All issue numbers and `html_url` fields refer to that repository.

## Goal

Find pairs of issues that describe the **same underlying bug or feature request**, so maintainers can close one and keep the other.

## Inputs you receive

For each issue you may see:

- `number`, `title`, `body` (markdown), `labels`, `state`, `html_url`, `created_at`

Treat the **title + first ~2k chars of body** as primary signal; ignore boilerplate (CI logs pasted twice, giant stack traces duplicated across issues—focus on error message **types** and reproduction steps).

## Definition of duplicate

Two issues are **duplicates** when fixing or implementing one would **fully address** the other from a product perspective, even if wording differs. If they are merely in the same subsystem but describe different bugs or different feature requests, **do not** treat them as duplicates.

**Not duplicates** (same subsystem, different bugs): e.g. IPv6 ULA-vs-GUA address selection in pasta ([#28257](https://github.com/containers/podman/issues/28257)) vs IPv6 `::1` port-forwarding differing from Docker ([#14491](https://github.com/containers/podman/issues/14491)) — both involve IPv6/network labels but different symptoms and root causes.

## Analysis checklist

1. **Normalize mentally**: strip noisy URLs and repeated log blocks; compare **symptoms** and **versions/OS** if stated.
2. **Prefer newer ↔ older**: if one issue clearly links to another or repeats an older report, set `keep_issue` to the number that should stay open (usually the one with more discussion, unless the newer one has a clearer repro).
3. **Labels**: shared labels can hint at overlap but are not enough on their own to mark a duplicate.
4. **Uncertainty**: if you are not confident they are the same issue, **omit** the pair from the tool output (do not guess duplicates).

## Output contract

When asked to analyze candidate pairs, respond **only** by calling the provided tool `report_duplicates` once per batch.

- Include **only** pairs you judge as duplicates in the `duplicates` array.
- Pairs that are not duplicates are **omitted** entirely (no row, no flag).
- Each duplicate entry must include: `issue_a`, `issue_b`, `confidence` (`high` | `medium` | `low`), `keep_issue` (the issue number to keep open), `rationale` (one short paragraph).

Do not invent issue numbers; only use numbers present in the batch.
