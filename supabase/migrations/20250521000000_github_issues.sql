-- GitHub issues cache for duplicate detection (containers/podman and other repos)

create table if not exists public.github_issues (
  issue_number bigint not null,
  owner text not null,
  repo text not null,
  title text not null default '',
  body text,
  state text not null default 'open',
  labels jsonb not null default '[]'::jsonb,
  html_url text,
  author_login text,
  github_created_at timestamptz,
  github_updated_at timestamptz not null,
  synced_at timestamptz not null default now(),
  primary key (owner, repo, issue_number)
);

create index if not exists github_issues_repo_state_updated_idx
  on public.github_issues (owner, repo, state, github_updated_at desc);

create index if not exists github_issues_repo_updated_idx
  on public.github_issues (owner, repo, github_updated_at desc);

comment on table public.github_issues is 'Mirror of GitHub issues; updated by scripts/sync_github_issues.py';

-- Per-repo sync cursor for incremental GitHub API (since=) fetches
create table if not exists public.github_sync_state (
  owner text not null,
  repo text not null,
  last_sync_completed_at timestamptz,
  last_github_updated_at timestamptz,
  issues_synced_count bigint not null default 0,
  primary key (owner, repo)
);

comment on table public.github_sync_state is 'Sync cursor: last_github_updated_at mirrors max(github_issues.github_updated_at); scripts/sync_github_issues.py reads both for since=';
comment on column public.github_sync_state.last_github_updated_at is 'Copied from max(github_updated_at) after each sync; used with issues table for next incremental since=';
comment on column public.github_sync_state.last_sync_completed_at is 'When the sync script last finished successfully';

-- Edge function uses service role; no RLS on these tables for simplicity.
alter table public.github_issues enable row level security;
alter table public.github_sync_state enable row level security;

create policy "service role full access github_issues"
  on public.github_issues for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "service role full access github_sync_state"
  on public.github_sync_state for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
