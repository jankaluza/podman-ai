#!/usr/bin/env python3
"""Build JSON body for check-duplicate (fetch issue from GitHub, do not write to Supabase)."""

from __future__ import annotations

import argparse
import json
import os
import sys

import httpx

GITHUB_API = "https://api.github.com"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--owner", required=True, help="Upstream index owner (e.g. containers)")
    p.add_argument("--repo", required=True, help="Upstream index repo (e.g. podman)")
    p.add_argument("--issue-number", type=int, required=True)
    p.add_argument("--github-owner", help="Repo to fetch issue from (default: --owner)")
    p.add_argument("--github-repo", help="Repo to fetch issue from (default: --repo)")
    args = p.parse_args()

    gh_owner = args.github_owner or args.owner
    gh_repo = args.github_repo or args.repo
    token = os.environ.get("GITHUB_TOKEN")

    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    url = f"{GITHUB_API}/repos/{gh_owner}/{gh_repo}/issues/{args.issue_number}"
    print(f"GET {url}", file=sys.stderr)
    with httpx.Client(timeout=60.0) as client:
        r = client.get(url, headers=headers)
        if r.status_code >= 400:
            print(f"GitHub API error {r.status_code}: {r.text[:500]}", file=sys.stderr)
            r.raise_for_status()
        raw = r.json()

    if raw.get("pull_request"):
        print(f"Issue {gh_owner}/{gh_repo}#{args.issue_number} is a pull request", file=sys.stderr)
        return 1

    labels = [lb["name"] for lb in raw.get("labels") or [] if isinstance(lb, dict)]
    payload = {
        "owner": args.owner,
        "repo": args.repo,
        "issue_number": args.issue_number,
        "target": {
            "title": raw.get("title") or "",
            "body": raw.get("body"),
            "state": raw.get("state") or "open",
            "labels": labels,
            "html_url": raw.get("html_url"),
        },
    }
    title_preview = (payload["target"]["title"] or "")[:60]
    print(f"Built inline target for #{args.issue_number}: {title_preview!r}", file=sys.stderr)
    json.dump(payload, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
