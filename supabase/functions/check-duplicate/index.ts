// Supabase Edge Function: check if a GitHub issue is a duplicate via Gemini 2.5 Flash Lite.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const CANDIDATE_LIMIT = 50;
const MAX_GEMINI_CANDIDATES = 25;
/** Cap full-table scan pages (1000 rows each) to avoid Edge Function timeouts. */
const MAX_FULL_SCAN_PAGES = 8;
const EXACT_TITLE_SIMILARITY = 0.92;
const MIN_TITLE_FOR_REVIEW = 0.22;

const GENERIC_TITLE_TOKENS = new Set([
  "podman", "docker", "container", "containers", "network", "networking", "ipv6", "ipv4",
  "bug", "issue", "error", "failed", "failure", "feature", "request", "support", "help",
  "linux", "macos", "windows", "rootless", "root", "remote", "local",
]);

interface GithubIssue {
  issue_number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  html_url: string | null;
  github_updated_at: string;
}

interface ScoredCandidate extends GithubIssue {
  relevance_score: number;
  title_similarity: number;
  distinctive_title_overlap: number;
  match_source?: string;
}

interface DuplicateResult {
  duplicate_issue_id: number | null;
  confidence: "high" | "medium" | "low";
  same_failure_mode: boolean;
  reason: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(): Response {
  return jsonResponse({ error: "Unauthorized" }, 401);
}

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function distinctiveTitleOverlap(titleA: string, titleB: string): number {
  const a = distinctiveTitleTokens(titleA);
  const b = distinctiveTitleTokens(titleB);
  let n = 0;
  for (const w of a) {
    if (b.has(w)) n++;
  }
  return n;
}

function distinctiveTitleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeText(title).split(" ")) {
    if (w.length > 3 && !GENERIC_TITLE_TOKENS.has(w)) out.add(w);
  }
  return out;
}

function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(" ").filter((w) => w.length > 2));
  const tb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) {
    if (tb.has(w)) inter++;
  }
  return (2 * inter) / (ta.size + tb.size);
}

function scoreIssue(target: GithubIssue, c: GithubIssue, source: string): ScoredCandidate {
  const titleSim = stringSimilarity(normalizeText(target.title), normalizeText(c.title));
  const bodySim = stringSimilarity(
    normalizeText((target.body ?? "").slice(0, 2000)),
    normalizeText((c.body ?? "").slice(0, 2000)),
  );
  let relevance_score = titleSim * 10 + bodySim * 0.15;
  if (titleSim < 0.12) relevance_score *= 0.3;
  else if (titleSim < 0.2) relevance_score *= 0.6;
  return {
    ...c,
    title_similarity: titleSim,
    distinctive_title_overlap: distinctiveTitleOverlap(target.title, c.title),
    relevance_score,
    match_source: source,
  };
}

function mergeCandidates(
  target: GithubIssue,
  lists: ScoredCandidate[][],
  excludeSameIssueNumber: boolean,
): ScoredCandidate[] {
  const byNum = new Map<number, ScoredCandidate>();
  for (const list of lists) {
    for (const c of list) {
      const prev = byNum.get(c.issue_number);
      if (!prev || c.relevance_score > prev.relevance_score) {
        byNum.set(c.issue_number, c);
      }
    }
  }
  return [...byNum.values()]
    .filter((c) => !excludeSameIssueNumber || c.issue_number !== target.issue_number)
    .sort((a, b) => b.title_similarity - a.title_similarity || b.relevance_score - a.relevance_score);
}

/** Exact title match in DB (catches copy-paste even when pg_trgm RPC fails). */
async function fetchExactTitleMatches(
  sb: ReturnType<typeof createClient>,
  target: GithubIssue,
  owner: string,
  repo: string,
  excludeSameIssueNumber: boolean,
): Promise<ScoredCandidate[]> {
  let q = sb
    .from("github_issues")
    .select("issue_number, title, body, state, labels, html_url, github_updated_at")
    .eq("owner", owner)
    .eq("repo", repo)
    .eq("title", target.title);
  if (excludeSameIssueNumber) {
    q = q.neq("issue_number", target.issue_number);
  }
  const { data, error } = await q;

  if (error) {
    console.warn("exact title query failed:", error.message);
    return [];
  }
  return ((data ?? []) as GithubIssue[]).map((c) => scoreIssue(target, c, "exact_title"));
}

async function fetchRpcCandidates(
  sb: ReturnType<typeof createClient>,
  target: GithubIssue,
  owner: string,
  repo: string,
): Promise<{ rows: ScoredCandidate[]; error: string | null }> {
  const { data, error } = await sb.rpc("find_duplicate_candidates", {
    p_owner: owner,
    p_repo: repo,
    p_issue_number: target.issue_number,
    p_limit: CANDIDATE_LIMIT,
  });

  if (error) return { rows: [], error: error.message };

  const rows = ((data ?? []) as Array<GithubIssue & { relevance_score: number; title_similarity?: number }>).map(
    (r) => ({
      ...scoreIssue(target, r, "pg_trgm"),
      relevance_score: Number(r.relevance_score),
      title_similarity: Number(r.title_similarity ?? stringSimilarity(
        normalizeText(target.title),
        normalizeText(r.title),
      )),
    }),
  );
  return { rows, error: null };
}

/** Paginate all issues when RPC unavailable (unordered .limit() missed copy-paste rows). */
async function fetchAllIssuesScored(
  sb: ReturnType<typeof createClient>,
  target: GithubIssue,
  owner: string,
  repo: string,
  excludeSameIssueNumber: boolean,
  maxPages: number = MAX_FULL_SCAN_PAGES,
): Promise<ScoredCandidate[]> {
  const pageSize = 1000;
  const pool: GithubIssue[] = [];
  let from = 0;
  let page = 0;

  while (page < maxPages) {
    page++;
    let q = sb
      .from("github_issues")
      .select("issue_number, title, body, state, labels, html_url, github_updated_at")
      .eq("owner", owner)
      .eq("repo", repo)
      .order("issue_number", { ascending: true })
      .range(from, from + pageSize - 1);
    if (excludeSameIssueNumber) {
      q = q.neq("issue_number", target.issue_number);
    }
    const { data, error } = await q;

    if (error) throw new Error(error.message);
    if (!data?.length) break;
    pool.push(...(data as GithubIssue[]));
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return attachScoresFromPool(target, pool);
}

function attachScoresFromPool(target: GithubIssue, pool: GithubIssue[]): ScoredCandidate[] {
  return pool
    .map((c) => scoreIssue(target, c, "full_scan"))
    .filter((c) =>
      c.title_similarity >= 0.12 ||
      c.relevance_score >= 0.5
    )
    .sort((a, b) => b.title_similarity - a.title_similarity || b.relevance_score - a.relevance_score)
    .slice(0, CANDIDATE_LIMIT);
}

async function fetchScoredCandidates(
  sb: ReturnType<typeof createClient>,
  target: GithubIssue,
  owner: string,
  repo: string,
  targetFromDb: boolean,
): Promise<{ rows: ScoredCandidate[]; method: string; rpc_error: string | null }> {
  const excludeSame = targetFromDb;
  const exact = await fetchExactTitleMatches(sb, target, owner, repo, excludeSame);

  if (!targetFromDb) {
    if (exact.length > 0) {
      return {
        rows: mergeCandidates(target, [exact], false).slice(0, CANDIDATE_LIMIT),
        method: "exact_title",
        rpc_error: null,
      };
    }
    const scanned = await fetchAllIssuesScored(sb, target, owner, repo, false);
    const merged = mergeCandidates(target, [exact, scanned], false);
    return { rows: merged.slice(0, CANDIDATE_LIMIT), method: "exact_title+full_scan", rpc_error: null };
  }

  const { rows: rpcRows, error: rpcError } = await fetchRpcCandidates(sb, target, owner, repo);

  let method = rpcError ? "full_scan" : "pg_trgm";
  let merged = mergeCandidates(target, [exact, rpcRows], true);

  if (rpcError || merged.length < 5) {
    console.warn("supplementing candidates:", rpcError ?? "few rpc rows");
    const scanned = await fetchAllIssuesScored(sb, target, owner, repo, true);
    merged = mergeCandidates(target, [exact, rpcRows, scanned], true);
    method = rpcError ? "full_scan+exact_title" : "pg_trgm+exact_title";
    if (rpcError && exact.length === 0 && scanned.length > 0) method = "full_scan";
  }

  return { rows: merged.slice(0, CANDIDATE_LIMIT), method, rpc_error: rpcError };
}

function parseInlineTarget(raw: unknown, issueNumber: number): GithubIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  const title = typeof t.title === "string" ? t.title : "";
  if (!title.trim()) return null;
  const labels = Array.isArray(t.labels)
    ? t.labels.filter((x): x is string => typeof x === "string")
    : [];
  return {
    issue_number: issueNumber,
    title,
    body: typeof t.body === "string" ? t.body : t.body == null ? null : String(t.body),
    state: typeof t.state === "string" ? t.state : "open",
    labels,
    html_url: typeof t.html_url === "string" ? t.html_url : null,
    github_updated_at: typeof t.github_updated_at === "string" ? t.github_updated_at : new Date().toISOString(),
  };
}

function filterCandidatesForReview(rows: ScoredCandidate[]): ScoredCandidate[] {
  const exact = rows.filter((c) => c.match_source === "exact_title");
  const byTitle = rows.filter((c) => c.title_similarity >= MIN_TITLE_FOR_REVIEW);
  const topByTitle = [...rows].sort((a, b) => b.title_similarity - a.title_similarity).slice(0, 15);
  const byNum = new Map<number, ScoredCandidate>();
  for (const c of [...exact, ...byTitle, ...topByTitle]) {
    byNum.set(c.issue_number, c);
  }
  return [...byNum.values()]
    .sort((a, b) => b.title_similarity - a.title_similarity)
    .slice(0, MAX_GEMINI_CANDIDATES);
}

function findHighConfidenceTitleDuplicate(
  target: GithubIssue,
  candidates: ScoredCandidate[],
): ScoredCandidate | undefined {
  return candidates.find((c) => c.title_similarity >= EXACT_TITLE_SIMILARITY);
}

async function callGemini(
  apiKey: string,
  target: GithubIssue,
  candidates: ScoredCandidate[],
): Promise<DuplicateResult> {
  const prompt = `You detect duplicate GitHub issues in the same repository.

TARGET ISSUE:
#${target.issue_number} [${target.state}] ${target.title}
Body excerpt:
${(target.body ?? "").slice(0, 2500)}

CANDIDATE ISSUES (sorted by title similarity; open or closed):
${candidates
  .map(
    (c) =>
      `#${c.issue_number} [${c.state}] title_sim=${c.title_similarity.toFixed(2)} ${c.title}\n` +
      `Body excerpt:\n${(c.body ?? "").slice(0, 1200)}\n---`,
  )
  .join("\n")}

Rules:
- duplicate_issue_id: same underlying bug/feature as TARGET (copy-paste reports = duplicate). CLOSED candidates count.
- Near-identical titles with the same compose/dependency repro are duplicates.
- NOT duplicates: vague "podman" problems without the same repro.
- confidence "high" only when certain. same_failure_mode must be true for duplicates.

Return JSON only.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.05,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            duplicate_issue_id: { type: "integer", nullable: true },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            same_failure_mode: { type: "boolean" },
            reason: { type: "string" },
          },
          required: ["duplicate_issue_id", "confidence", "same_failure_mode", "reason"],
        },
      },
    }),
  });

  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini response");

  const parsed = JSON.parse(text) as DuplicateResult;
  if (parsed.duplicate_issue_id === target.issue_number) {
    return { duplicate_issue_id: null, confidence: "low", same_failure_mode: false, reason: "Self-match ignored." };
  }
  if (parsed.duplicate_issue_id != null && !candidates.some((c) => c.issue_number === parsed.duplicate_issue_id)) {
    return {
      duplicate_issue_id: null,
      confidence: "low",
      same_failure_mode: false,
      reason: `Cited #${parsed.duplicate_issue_id} not in candidate set.`,
    };
  }
  return parsed;
}

function acceptDuplicateResult(result: DuplicateResult): DuplicateResult {
  if (result.duplicate_issue_id == null) return result;
  if (result.confidence !== "high" || !result.same_failure_mode) {
    return {
      duplicate_issue_id: null,
      confidence: result.confidence,
      same_failure_mode: result.same_failure_mode,
      reason: `Requires confidence=high and same_failure_mode=true. ${result.reason}`,
    };
  }
  return result;
}

function candidatePreview(list: ScoredCandidate[]) {
  return list.slice(0, 8).map((c) => ({
    issue_number: c.issue_number,
    state: c.state,
    title: c.title.slice(0, 100),
    relevance_score: c.relevance_score,
    title_similarity: c.title_similarity,
    match_source: c.match_source,
  }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-dedup-secret",
      },
    });
  }

  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secret = Deno.env.get("DEDUP_FUNCTION_SECRET");
  if (secret && req.headers.get("x-dedup-secret") !== secret) return unauthorized();

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 500);

  let body: {
    owner?: string;
    repo?: string;
    issue_number?: number;
    target?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const owner = body.owner ?? "containers";
  const repo = body.repo ?? "podman";
  const issueNumber = body.issue_number;
  if (issueNumber == null || !Number.isFinite(issueNumber)) {
    return jsonResponse({ error: "issue_number is required" }, 400);
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const inlineTarget = parseInlineTarget(body.target, issueNumber);
  let target: GithubIssue;
  let targetSource: "inline" | "database";

  if (inlineTarget) {
    target = inlineTarget;
    targetSource = "inline";
  } else {
    const { data: row, error: targetErr } = await sb
      .from("github_issues")
      .select("issue_number, title, body, state, labels, html_url, github_updated_at")
      .eq("owner", owner)
      .eq("repo", repo)
      .eq("issue_number", issueNumber)
      .maybeSingle();

    if (targetErr) return jsonResponse({ error: targetErr.message }, 500);
    if (!row) {
      return jsonResponse({
        error: "Issue not in database; pass target in request body or run sync",
        duplicate_issue_id: null,
        reason: "",
      }, 404);
    }
    target = row as GithubIssue;
    targetSource = "database";
  }

  let scored: ScoredCandidate[];
  let selectionMethod: string;
  let rpcError: string | null;
  try {
    const found = await fetchScoredCandidates(
      sb,
      target,
      owner,
      repo,
      targetSource === "database",
    );
    scored = found.rows;
    selectionMethod = found.method;
    rpcError = found.rpc_error;
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  if (!scored.length) {
    return jsonResponse({
      duplicate_issue_id: null,
      reason: "No issues in database to compare (run sync_github_issues.py --full).",
      target_source: targetSource,
      candidate_selection: { method: selectionMethod, rpc_error: rpcError, count: 0 },
    });
  }

  const forReview = filterCandidatesForReview(scored);
  const titleDup = findHighConfidenceTitleDuplicate(target, forReview);

  if (titleDup) {
    return jsonResponse({
      issue_number: issueNumber,
      owner,
      repo,
      target_source: targetSource,
      duplicate_issue_id: titleDup.issue_number,
      duplicate_url: titleDup.html_url ?? `https://github.com/${owner}/${repo}/issues/${titleDup.issue_number}`,
      reason: `Near-identical title (${titleDup.title_similarity.toFixed(2)} similarity) to #${titleDup.issue_number} [${titleDup.state}].`,
      model_confidence: "high",
      same_failure_mode: true,
      candidate_selection: { method: selectionMethod, rpc_error: rpcError, count: forReview.length, top_candidates: candidatePreview(forReview) },
    });
  }

  try {
    const raw = await callGemini(geminiKey, target, forReview);
    const result = acceptDuplicateResult(raw);

    let duplicate_url: string | null = null;
    if (result.duplicate_issue_id != null) {
      const dup = forReview.find((c) => c.issue_number === result.duplicate_issue_id);
      duplicate_url = dup?.html_url ?? `https://github.com/${owner}/${repo}/issues/${result.duplicate_issue_id}`;
    }

    return jsonResponse({
      issue_number: issueNumber,
      owner,
      repo,
      target_source: targetSource,
      duplicate_issue_id: result.duplicate_issue_id,
      duplicate_url,
      reason: result.reason,
      model_confidence: result.confidence,
      same_failure_mode: result.same_failure_mode,
      candidate_selection: {
        method: selectionMethod,
        rpc_error: rpcError,
        count: forReview.length,
        top_candidates: candidatePreview(forReview),
      },
    });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
