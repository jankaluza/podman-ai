#!/usr/bin/env python3
"""
Sync GitHub issues into Supabase for duplicate detection.

Uses minimal API calls:
  - Full sync: paginated list (100 per page), delay between pages
  - Incremental: reads since watermark from github_sync_state / max(github_updated_at), then GET .../issues?since=

Environment:
  GITHUB_TOKEN              Recommended (5000 req/h); required for large repos
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY Service role for upserts

Usage:
  python scripts/sync_github_issues.py
  python scripts/sync_github_issues.py --owner containers --repo podman --full
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

GITHUB_API = "https://api.github.com"
DEFAULT_OWNER = "containers"
DEFAULT_REPO = "podman"
PER_PAGE = 100
PAGE_DELAY_SEC = 0.75
MAX_RETRIES = 5
# GitHub REST list endpoints: max 100 pages × per_page (10_000 items per query).
GITHUB_MAX_PAGES = 100


class PaginationEnd(Exception):
    """Raised when GitHub indicates there is no further page (422 or missing Link)."""


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


def _log_rate_limit(headers: httpx.Headers) -> None:
    remaining = headers.get("X-RateLimit-Remaining")
    if remaining is not None:
        log(f"GitHub API rate limit remaining: {remaining}")


def _headers(token: str | None) -> dict[str, str]:
    h = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def _parse_ts(value: str | None) -> str | None:
    if not value:
        return None
    return value.replace("Z", "+00:00")


def _parse_dt(value: str) -> datetime:
    """Parse ISO timestamp from DB or GitHub into UTC."""
    s = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def format_github_since(dt: datetime) -> str:
    """GitHub Issues API since= expects ISO 8601 UTC (Z)."""
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get_max_github_updated_at(sb: Any, owner: str, repo: str) -> str | None:
    """Latest github_updated_at stored in github_issues (source of truth for issue data)."""
    r = (
        sb.table("github_issues")
        .select("github_updated_at")
        .eq("owner", owner)
        .eq("repo", repo)
        .order("github_updated_at", desc=True)
        .limit(1)
        .execute()
    )
    if not r.data:
        return None
    return r.data[0].get("github_updated_at")


def resolve_since_from_db(
    sb: Any,
    owner: str,
    repo: str,
    *,
    overlap_seconds: int = 60,
) -> tuple[str | None, dict[str, Any]]:
    """Build GitHub since= from DB. Returns (since_param, debug_info)."""
    state = load_sync_state(sb, owner, repo)
    state_watermark = state.get("last_github_updated_at") if state else None
    issues_watermark = get_max_github_updated_at(sb, owner, repo)

    chosen: str | None = None
    source = "none"
    if state_watermark and issues_watermark:
        if _parse_dt(state_watermark) >= _parse_dt(issues_watermark):
            chosen = state_watermark
            source = "github_sync_state"
        else:
            chosen = issues_watermark
            source = "github_issues.max"
    elif state_watermark:
        chosen = state_watermark
        source = "github_sync_state"
    elif issues_watermark:
        chosen = issues_watermark
        source = "github_issues.max"

    since_param: str | None = None
    if chosen:
        dt = _parse_dt(chosen) - timedelta(seconds=overlap_seconds)
        since_param = format_github_since(dt)

    return since_param, {
        "source": source,
        "github_sync_state_at": state_watermark,
        "max_github_updated_at_in_issues": issues_watermark,
        "since_sent_to_github": since_param,
        "overlap_seconds": overlap_seconds,
    }


def _link_next_url(link_header: str | None) -> str | None:
    """Parse GitHub Link header and return the URL for rel=\"next\", if any."""
    if not link_header:
        return None
    for part in link_header.split(","):
        if 'rel="next"' in part:
            return part.split(";")[0].strip().strip("<>")
    return None


def github_get(
    client: httpx.Client,
    url: str,
    *,
    params: dict[str, Any] | None,
    token: str | None,
    pagination: bool = False,
) -> httpx.Response:
    for attempt in range(MAX_RETRIES):
        r = client.get(url, params=params, headers=_headers(token))
        if pagination and r.status_code == 422:
            raise PaginationEnd("GitHub returned 422 (page out of range or pagination limit)")
        if r.status_code == 403 and "rate limit" in r.text.lower():
            reset = r.headers.get("X-RateLimit-Reset")
            wait = max(1, int(reset) - int(time.time()) + 1) if reset else 60
            log(f"Rate limited; sleeping {wait}s...")
            time.sleep(wait)
            continue
        if r.status_code in (502, 503):
            time.sleep(2**attempt)
            continue
        r.raise_for_status()
        _log_rate_limit(r.headers)
        return r
    raise RuntimeError(f"GitHub request failed after retries: {url}")


def fetch_single_issue(
    client: httpx.Client,
    owner: str,
    repo: str,
    issue_number: int,
    *,
    token: str | None,
) -> dict[str, Any]:
    """Fetch one issue/PR from GitHub Issues API (owner/repo = where to read from)."""
    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues/{issue_number}"
    r = github_get(client, url, params=None, token=token)
    data = r.json()
    if data.get("pull_request") is not None:
        raise ValueError(
            f"{owner}/{repo}#{issue_number} is a pull request on GitHub, not an issue "
            f"(check --github-owner/--github-repo if using a fork)"
        )
    return data


def fetch_issues(
    client: httpx.Client,
    owner: str,
    repo: str,
    *,
    token: str | None,
    since: str | None,
    state: str,
    page_delay: float,
) -> list[dict[str, Any]]:
    """List issues (excludes PRs). Uses since= when set for incremental sync.

    GitHub's Issues API also returns pull requests; those are skipped (pull_request key set).
    Pagination follows Link headers. 422 ends a pass (GitHub ~10k items/query cap).
    """
    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues"
    params: dict[str, Any] = {
        "state": state,
        "per_page": PER_PAGE,
        "sort": "updated",
        "direction": "desc",
    }
    if since:
        params["since"] = since

    log(f"Fetching issues from {owner}/{repo} (state={state}, per_page={PER_PAGE})")
    if since:
        log(f"  filter: updated since {since}")
    else:
        log("  filter: none (full listing for this state)")

    out: list[dict[str, Any]] = []
    skipped_prs = 0
    page = 1
    hit_pagination_cap = False
    next_url: str | None = url
    next_params: dict[str, Any] | None = params

    while next_url:
        log(f"GitHub page {page}: requesting...")
        t0 = time.monotonic()
        try:
            r = github_get(
                client,
                next_url,
                params=next_params,
                token=token,
                pagination=page > 1,
            )
        except PaginationEnd:
            hit_pagination_cap = True
            log(
                f"GitHub page {page}: pagination ended (422 — likely past page "
                f"{GITHUB_MAX_PAGES} or end of results). Stopping this pass."
            )
            break

        batch = r.json()
        page_issues = 0
        for item in batch:
            if item.get("pull_request") is not None:
                skipped_prs += 1
                continue
            out.append(item)
            page_issues += 1
        elapsed = time.monotonic() - t0
        log(
            f"GitHub page {page}: {len(batch)} items, "
            f"{page_issues} issues kept, {len(batch) - page_issues} PRs skipped "
            f"({elapsed:.1f}s) — running total: {len(out)} issues"
        )

        link_next = _link_next_url(r.headers.get("Link"))
        if not batch:
            break
        if not link_next:
            if len(batch) >= PER_PAGE and page >= GITHUB_MAX_PAGES:
                hit_pagination_cap = True
                log(
                    f"Stopped at GitHub pagination cap ({GITHUB_MAX_PAGES} pages × "
                    f"{PER_PAGE} items). Older issues may be missing for state={state!r}."
                )
            break

        page += 1
        next_url = link_next
        next_params = None
        log(f"  sleeping {page_delay}s before next page...")
        time.sleep(page_delay)

    if hit_pagination_cap:
        log(
            "Warning: listing may be incomplete. For a full backfill, run with "
            "--full (splits open/closed) or sync each state separately."
        )
    if skipped_prs:
        log(f"Fetch complete: {len(out)} issues ({skipped_prs} pull requests skipped)")
    else:
        log(f"Fetch complete: {len(out)} issues")
    return out


def fetch_issues_merged(
    client: httpx.Client,
    owner: str,
    repo: str,
    *,
    token: str | None,
    since: str | None,
    state: str,
    page_delay: float,
) -> list[dict[str, Any]]:
    """Fetch issues; when state=all and no since, run open + closed passes to avoid one 10k cap."""
    if state != "all" or since:
        return fetch_issues(
            client,
            owner,
            repo,
            token=token,
            since=since,
            state=state,
            page_delay=page_delay,
        )

    by_number: dict[int, dict[str, Any]] = {}
    for st in ("open", "closed"):
        log(f"--- GitHub list pass: state={st} ---")
        batch = fetch_issues(
            client,
            owner,
            repo,
            token=token,
            since=None,
            state=st,
            page_delay=page_delay,
        )
        for item in batch:
            by_number[item["number"]] = item
    merged = list(by_number.values())
    log(f"Merged open+closed passes: {len(merged)} unique issues")
    return merged


def issue_to_row(owner: str, repo: str, raw: dict[str, Any]) -> dict[str, Any]:
    labels = [lb["name"] for lb in raw.get("labels") or [] if isinstance(lb, dict)]
    user = raw.get("user") or {}
    return {
        "owner": owner,
        "repo": repo,
        "issue_number": raw["number"],
        "title": raw.get("title") or "",
        "body": raw.get("body"),
        "state": raw.get("state") or "open",
        "labels": labels,
        "html_url": raw.get("html_url"),
        "author_login": user.get("login"),
        "github_created_at": _parse_ts(raw.get("created_at")),
        "github_updated_at": _parse_ts(raw.get("updated_at")),
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }


def get_supabase():
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY")
    return create_client(url, key)


def load_sync_state(sb: Any, owner: str, repo: str) -> dict[str, Any] | None:
    r = (
        sb.table("github_sync_state")
        .select("*")
        .eq("owner", owner)
        .eq("repo", repo)
        .limit(1)
        .execute()
    )
    if not r.data:
        return None
    return r.data[0]


def upsert_issues(
    sb: Any,
    rows: list[dict[str, Any]],
    batch_size: int = 50,
) -> int:
    if not rows:
        log("Supabase: nothing to upsert")
        return 0
    batches = (len(rows) + batch_size - 1) // batch_size
    log(f"Supabase: upserting {len(rows)} row(s) in {batches} batch(es) of up to {batch_size}")
    n = 0
    for i in range(0, len(rows), batch_size):
        batch_no = i // batch_size + 1
        chunk = rows[i : i + batch_size]
        t0 = time.monotonic()
        sb.table("github_issues").upsert(chunk, on_conflict="owner,repo,issue_number").execute()
        n += len(chunk)
        nums = [r["issue_number"] for r in chunk]
        range_hint = f"#{min(nums)}–#{max(nums)}" if len(nums) > 1 else f"#{nums[0]}"
        log(
            f"Supabase batch {batch_no}/{batches}: {len(chunk)} row(s) "
            f"({range_hint}, {time.monotonic() - t0:.1f}s) — {n}/{len(rows)} done"
        )
    return n


def save_sync_state(
    sb: Any,
    owner: str,
    repo: str,
    *,
    completed_at: str,
    total_count: int,
) -> str | None:
    """Persist sync cursor from max(github_updated_at); never move watermark backward."""
    max_updated = get_max_github_updated_at(sb, owner, repo)
    existing = load_sync_state(sb, owner, repo)
    prev = existing.get("last_github_updated_at") if existing else None
    if max_updated and prev:
        try:
            if _parse_dt(max_updated) < _parse_dt(prev):
                log(
                    f"Watermark unchanged (parallel sync?): keeping {prev} "
                    f"(computed max was {max_updated})"
                )
                max_updated = prev
        except ValueError:
            pass
    row = {
        "owner": owner,
        "repo": repo,
        "last_sync_completed_at": completed_at,
        "last_github_updated_at": max_updated,
        "issues_synced_count": total_count,
    }
    sb.table("github_sync_state").upsert(row, on_conflict="owner,repo").execute()
    return max_updated


def count_issues(sb: Any, owner: str, repo: str) -> int:
    r = (
        sb.table("github_issues")
        .select("issue_number", count="exact")
        .eq("owner", owner)
        .eq("repo", repo)
        .execute()
    )
    return r.count or 0


def main() -> int:
    p = argparse.ArgumentParser(description="Sync GitHub issues to Supabase")
    p.add_argument("--owner", default=DEFAULT_OWNER)
    p.add_argument("--repo", default=DEFAULT_REPO)
    p.add_argument(
        "--state",
        default="all",
        choices=["open", "closed", "all"],
        help="Issue state filter for GitHub API",
    )
    p.add_argument(
        "--full",
        action="store_true",
        help="Ignore watermark and refetch all issues (still paginated)",
    )
    p.add_argument("--page-delay", type=float, default=PAGE_DELAY_SEC)
    p.add_argument(
        "--issue",
        type=int,
        metavar="N",
        help="Sync only this issue number (one GitHub API request)",
    )
    p.add_argument(
        "--github-owner",
        metavar="ORG",
        help="GitHub org/user to fetch --issue from (default: --owner). Use fork when index is upstream.",
    )
    p.add_argument(
        "--github-repo",
        metavar="NAME",
        help="GitHub repo to fetch --issue from (default: --repo). Use fork when index is upstream.",
    )
    args = p.parse_args()

    started = time.monotonic()
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        log("Warning: GITHUB_TOKEN unset; low rate limits (60/h).")

    log(f"Sync start: {args.owner}/{args.repo}")
    log("Connecting to Supabase...")
    sb = get_supabase()
    log("Supabase connected.")

    state = load_sync_state(sb, args.owner, args.repo)
    db_before = count_issues(sb, args.owner, args.repo)
    if state:
        log(
            f"Previous sync: completed={state.get('last_sync_completed_at')}, "
            f"watermark={state.get('last_github_updated_at')}, "
            f"db_count={state.get('issues_synced_count')}"
        )
    else:
        log("No previous sync state in database (first run for this repo).")
    log(f"Issues currently in database: {db_before}")

    since: str | None = None
    since_meta: dict[str, Any] = {}
    mode = "single"

    with httpx.Client(timeout=90.0) as client:
        if args.issue is not None:
            gh_owner = args.github_owner or args.owner
            gh_repo = args.github_repo or args.repo
            log(f"Mode: single issue #{args.issue}")
            log(f"GET /repos/{gh_owner}/{gh_repo}/issues/{args.issue}")
            if gh_owner != args.owner or gh_repo != args.repo:
                log(f"Upsert into Supabase index as {args.owner}/{args.repo}")
            raw_issues = [
                fetch_single_issue(client, gh_owner, gh_repo, args.issue, token=token)
            ]
            title = (raw_issues[0].get("title") or "")[:80]
            log(f"Fetched: #{args.issue} [{raw_issues[0].get('state')}] {title!r}")
        else:
            if args.full:
                mode = "full"
                log("Mode: full (--full: ignoring DB watermark)")
            else:
                since, since_meta = resolve_since_from_db(sb, args.owner, args.repo)
                if since:
                    mode = "incremental"
                    log(
                        f"Mode: incremental — since={since} "
                        f"(from DB: {since_meta.get('source')}, "
                        f"sync_state={since_meta.get('github_sync_state_at')}, "
                        f"issues_max={since_meta.get('max_github_updated_at_in_issues')})"
                    )
                else:
                    mode = "full"
                    log("Mode: full (no watermark in database yet)")
            raw_issues = fetch_issues_merged(
                client,
                args.owner,
                args.repo,
                token=token,
                since=since,
                state=args.state,
                page_delay=args.page_delay,
            )

    log(f"Transforming {len(raw_issues)} issue(s) for Supabase...")
    rows = [issue_to_row(args.owner, args.repo, x) for x in raw_issues]
    upserted = upsert_issues(sb, rows)

    log("Updating sync state from max(github_updated_at) in database...")
    completed = datetime.now(timezone.utc).isoformat()
    total = count_issues(sb, args.owner, args.repo)
    watermark = save_sync_state(
        sb,
        args.owner,
        args.repo,
        completed_at=completed,
        total_count=total,
    )
    if watermark:
        log(f"Stored watermark last_github_updated_at={watermark}")

    elapsed = time.monotonic() - started
    log(
        f"Done in {elapsed:.1f}s — fetched {len(raw_issues)}, upserted {upserted}, "
        f"total in DB: {db_before} → {total}"
    )

    summary = {
        "owner": args.owner,
        "repo": args.repo,
        "mode": mode,
        "fetched_from_github": len(raw_issues),
        "upserted": upserted,
        "total_in_db": total,
        "total_in_db_before": db_before,
        "since": since_meta if since_meta else None,
        "last_github_updated_at": watermark,
        "last_sync_completed_at": completed,
        "elapsed_seconds": round(elapsed, 1),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
