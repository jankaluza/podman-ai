# Skills index

Skills live in subfolders as **`SKILL.md`** (YAML frontmatter + markdown). They are meant to be **repository-agnostic**: anything specific to one GitHub repo (org, name, issue list URL) uses **placeholders** that tooling replaces at runtime.

## Sharing from a central repository

1. Keep the canonical skill tree in one repo (for example `your-org/agent-skills/`).
2. In each consumer repo, either:
   - set **`GITHUB_ISSUE_DEDUP_SKILL_PATH`** to the absolute path of `github-issue-deduplication/SKILL.md` on disk (clone, submodule, or CI checkout), or  
   - pass **`--skill-path /path/to/SKILL.md`** to `duplicate_tickets.py`.

No per-repo copy of the workflow prose is required unless you want local edits.

## Placeholders (issue-deduplication skill)

The orchestrator substitutes these **before** the model sees the skill body (and may substitute inside frontmatter if present):

| Placeholder | Replaced with | Typical source |
|-------------|----------------|----------------|
| `<<<GITHUB_OWNER>>>` | Organization or user login | `--owner` |
| `<<<GITHUB_REPO>>>` | Repository name | `--repo` |
| `<<<GITHUB_REPO_SLUG>>>` | `owner/repo` | `--owner` + `--repo` |
| `<<<GITHUB_REPO_URL>>>` | `https://github.com/owner/repo` | derived |
| `<<<GITHUB_ISSUES_URL>>>` | `https://github.com/owner/repo/issues` | derived |

Add more placeholders by extending the same convention in the shared skill and in `apply_skill_placeholders()` in `duplicate_tickets.py`.

## Skills in this tree

| Skill | Path | Purpose |
|-------|------|---------|
| GitHub issue deduplication | [github-issue-deduplication/SKILL.md](github-issue-deduplication/SKILL.md) | Judge duplicate issue pairs for any `owner/repo` |

The Python runner loads that file (or the path from env/CLI), applies placeholders from `--owner` / `--repo`, and uses tool **`report_duplicates`** for structured output.
