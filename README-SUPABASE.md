# Supabase + Gemini duplicate detection

Pipeline for [containers/podman issues](https://github.com/containers/podman/issues):

1. **`scripts/sync_github_issues.py`** — sync issues into Supabase (full or incremental via GitHub `since=`).
2. **`supabase/functions/check-duplicate`** — Edge Function calling **Gemini 2.5 Flash Lite**; returns `duplicate_issue_id` and `reason`.
3. **GitHub Action** — on `issues.opened`, upserts the issue, calls the function, comments if a duplicate is found.

## Setup

### 1. Supabase project

```bash
# Install Supabase CLI, link project
supabase login
supabase link --project-ref YOUR_REF
supabase db push   # applies supabase/migrations/
```

Set Edge Function secrets:

```bash
supabase secrets set GEMINI_API_KEY=your_google_ai_key
supabase secrets set DEDUP_FUNCTION_SECRET=long_random_string
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

Deploy the function:

```bash
supabase functions deploy check-duplicate
```

`SUPABASE_URL` is injected automatically for Edge Functions.

### 2. Initial data load (local)

```bash
pip install -r requirements-sync.txt
export GITHUB_TOKEN=ghp_...
export SUPABASE_URL=...
export SUPABASE_SERVICE_ROLE_KEY=...
python scripts/sync_github_issues.py --owner containers --repo podman
```

First run fetches all issues (paginated, ~0.75s delay between pages). Re-runs read the watermark from the database (`github_sync_state.last_github_updated_at` and `max(github_issues.github_updated_at)`), subtract a 60s overlap, and call GitHub with **`since=<ISO timestamp>`**. After each run the script writes **`last_github_updated_at`** back from `max(github_updated_at)` in `github_issues`.

```bash
# Force full refresh
python scripts/sync_github_issues.py --owner containers --repo podman --full

# One issue (used by the GitHub Action on open)
python scripts/sync_github_issues.py --owner containers --repo podman --issue 28750
```

### 3. GitHub Actions

Workflow: [`.github/workflows/issue-duplicate-check.yml`](.github/workflows/issue-duplicate-check.yml)

On **`issues.opened`** (or manual **workflow_dispatch**):

1. **Incremental sync** — `sync_github_issues.py` uses the Supabase DB watermark (`since=`)
2. **Sync target issue** — `--issue <number>` so the new issue is up to date
3. **`check-duplicate`** Edge Function
4. **Comment** on the issue if a duplicate is found (skipped for manual runs)

| Secret | Purpose |
|--------|---------|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Sync steps |
| `SUPABASE_ANON_KEY` | Invoke Edge Function |
| `DEDUP_FUNCTION_SECRET` | Must match Supabase secret |
| `GITHUB_TOKEN` | Sync + comment (default Actions token is enough) |

**In this repo:** enable the workflow and add secrets.

**In containers/podman:** copy the workflow file and set repository variable `DEDUP_TOOLING_REPO` to `your-org/duplicate` so Actions checks out this tooling repo into `tooling/`.

**Parallel runs:** The workflow uses a [concurrency group](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#concurrency) per repository (`duplicate-check-<owner>/<repo>`), so two issues opened at once are processed **one after another**, not in parallel. Issue upserts are idempotent; the sync script also never lowers `last_github_updated_at` if jobs did overlap. Duplicate checks for different issues do not share state beyond the shared issue index.

### 4. Candidate selection

`check-duplicate` ranks candidates with `find_duplicate_candidates` (title-heavy `pg_trgm`, penalizes generic body-only matches), then filters by **distinctive title word overlap** (ignoring broad terms like `ipv6`, `network`, `podman`). Gemini runs only on survivors and must return **`confidence: high`** and **`same_failure_mode: true`** to report a duplicate—otherwise the API returns null (avoids related-topic false positives).

Apply the migration and redeploy:

```bash
supabase db push
supabase functions deploy check-duplicate
```

### 5. Test the Edge Function

```bash
curl -X POST "$SUPABASE_URL/functions/v1/check-duplicate" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhicGF4aHh3YXVldnJuY2ppcGpuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkzNTA2MjMsImV4cCI6MjA5NDkyNjYyM30.yPC7dAOQX6Iab_W5fCorUxY06N8xdAqqottbXvyx6UU" \
  -H "Content-Type: application/json" \
  -H "x-dedup-secret: long_random_string" \
  -d '{"owner":"containers","repo":"podman","issue_number":28750}'
```

Example response:

```json
{
  "issue_number": 28750,
  "owner": "containers",
  "repo": "podman",
  "duplicate_issue_id": 28675,
  "duplicate_url": "https://github.com/containers/podman/issues/28675",
  "reason": "Both report ...",
  "candidate_selection": { "method": "pg_trgm", "count": 40, "top_candidates": [...] }
}
```

## Rate limits

- Sync uses **`per_page=100`**, sleeps **`PAGE_DELAY_SEC`** (default 0.75s) between pages, and honors **`X-RateLimit-Reset`** on 403.
- Incremental sync typically needs **one or a few** API calls when few issues changed.
- New-issue Action uses **one** `GET /issues/{n}` per opened issue.

## Schema

- `github_issues` — cached **issues only** (pull requests from the GitHub Issues API are not stored).
- `github_sync_state` — watermark for incremental `since=` sync.
