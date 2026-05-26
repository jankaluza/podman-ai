-- Reduce false positives: weight titles more, penalize generic body-only matches.

drop function if exists public.find_duplicate_candidates(text, text, bigint, int);

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
  relevance_score real,
  title_similarity real
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
  ),
  scored as (
    select
      i.issue_number,
      i.title,
      i.body,
      i.state,
      i.labels,
      i.html_url,
      i.github_updated_at,
      similarity(i.title, t.title)::real as title_similarity,
      similarity(left(coalesce(i.body, ''), 2000), t.body_excerpt)::real as body_similarity
    from public.github_issues i
    cross join target t
    where i.owner = p_owner
      and i.repo = p_repo
      and i.state = 'open'
      and i.issue_number <> p_issue_number
  )
  select
    issue_number,
    title,
    body,
    state,
    labels,
    html_url,
    github_updated_at,
    (
      title_similarity * 4.0
      + body_similarity * 0.35
    ) * case
      when title_similarity < 0.12 then 0.4
      when title_similarity < 0.18 then 0.7
      else 1.0
    end as relevance_score,
    title_similarity
  from scored
  where title_similarity >= 0.10
     or (title_similarity * 4.0 + body_similarity * 0.35) >= 0.30
  order by relevance_score desc, github_updated_at desc
  limit greatest(1, least(p_limit, 80));
$$;

grant execute on function public.find_duplicate_candidates(text, text, bigint, int) to service_role;
