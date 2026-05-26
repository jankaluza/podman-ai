-- Revert is_pull_request column if the previous migration was applied.
drop index if exists public.github_issues_repo_open_issues_idx;

alter table public.github_issues
  drop column if exists is_pull_request;
