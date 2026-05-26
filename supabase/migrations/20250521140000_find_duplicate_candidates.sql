-- Text-similarity candidate search for duplicate detection (pg_trgm).

create extension if not exists pg_trgm;

create index if not exists github_issues_title_trgm_idx
  on public.github_issues using gin (title gin_trgm_ops);

create index if not exists github_issues_body_trgm_idx
  on public.github_issues using gin (left(coalesce(body, ''), 2000) gin_trgm_ops);

-- Rank open issues by textual similarity to a target issue (title weighted higher than body).
create or replace function public.find_duplicate_candidates(
  p_owner text,
  p_repo text,
  p_issue_number bigint,
  p_limit int default 40
)
returns table (
  issue_number bigint,
  title text,
  body text,
  state text,
  labels jsonb,
  html_url text,
  github_updated_at timestamptz,
  relevance_score real
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select
      title,
      left(coalesce(body, ''), 2000) as body_excerpt
    from public.github_issues
    where owner = p_owner
      and repo = p_repo
      and github_issues.issue_number = p_issue_number
  )
  select
    i.issue_number,
    i.title,
    i.body,
    i.state,
    i.labels,
    i.html_url,
    i.github_updated_at,
    (
      similarity(i.title, t.title) * 2.0
      + similarity(left(coalesce(i.body, ''), 2000), t.body_excerpt)
    )::real as relevance_score
  from public.github_issues i
  cross join target t
  where i.owner = p_owner
    and i.repo = p_repo
    and i.state = 'open'
    and i.issue_number <> p_issue_number
  order by relevance_score desc, i.github_updated_at desc
  limit greatest(1, least(p_limit, 80));
$$;

comment on function public.find_duplicate_candidates is
  'Returns open issues most similar to the target title/body for Gemini duplicate review';

grant execute on function public.find_duplicate_candidates(text, text, bigint, int) to service_role;
