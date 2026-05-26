-- Applied on remote; kept locally so migration history matches.
-- Reverted by 20250521130000_drop_is_pull_request.sql (issues-only storage).

alter table public.github_issues
  add column if not exists is_pull_request boolean not null default false;

create index if not exists github_issues_repo_open_issues_idx
  on public.github_issues (owner, repo, github_updated_at desc)
  where is_pull_request = false and state = 'open';

comment on column public.github_issues.is_pull_request is
  'True when GitHub pull_request key is set on list/get — item is a PR, not a standalone issue';
