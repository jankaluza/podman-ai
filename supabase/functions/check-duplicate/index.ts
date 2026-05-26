// Supabase Edge Function: check if a GitHub issue is a duplicate via Gemini 2.5 Flash Lite.
// Invoke: POST /functions/v1/check-duplicate
// Body: { "owner": "containers", "repo": "podman", "issue_number": 28750 }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const GEMINI_MODEL = "gemini-2.5-flash-lite";
const CANDIDATE_LIMIT = 40;
const MAX_GEMINI_CANDIDATES = 25;

/** Broad terms shared across many Podman issues — not evidence of duplication. */
const GENERIC_TITLE_TOKENS = new Set([
  "podman", "docker", "container", "containers", "network", "networking", "ipv6", "ipv4",
  "bug", "issue", "error", "failed", "failure", "feature", "request", "support", "help",
  "linux", "macos", "windows", "rootless", "root", "remote", "local",
]);

const MIN_TITLE_SIMILARITY = 0.14;
const MIN_TOP_RELEVANCE = 0.28;
const MIN_DISTINCTIVE_TITLE_OVERLAP = 2;
const STRONG_RELEVANCE_BYPASS = 0.55;

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

function distinctiveTitleTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of normalizeText(title).split(" ")) {
    if (w.length > 3 && !GENERIC_TITLE_TOKENS.has(w)) out.add(w);
  }
  return out;
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

function attachScores(target: GithubIssue, pool: GithubIssue[]): ScoredCandidate[] {
  const targetTitle = normalizeText(target.title);
  const targetBody = normalizeText((target.body ?? "").slice(0, 2000));

  return pool
    .filter((c) => c.issue_number !== target.issue_number)
    .map((c) => {
      const titleSim = stringSimilarity(targetTitle, normalizeText(c.title));
      const bodySim = stringSimilarity(targetBody, normalizeText((c.body ?? "").slice(0, 2000)));
      const overlap = distinctiveTitleOverlap(target.title, c.title);
      let relevance_score = titleSim * 4 + bodySim * 0.35;
      if (titleSim < 0.12) relevance_score *= 0.4;
      else if (titleSim < 0.18) relevance_score *= 0.7;
      return {
        ...c,
        title_similarity: titleSim,
        distinctive_title_overlap: overlap,
        relevance_score,
      };
    })
    .sort((a, b) => b.relevance_score - a.relevance_score);
}

function mapRpcRows(target: GithubIssue, rpcData: unknown[]): ScoredCandidate[] {
  return (rpcData as Array<GithubIssue & { relevance_score: number; title_similarity?: number }>)
    .map((r) => ({
      issue_number: r.issue_number,
      title: r.title,
      body: r.body,
      state: r.state,
      labels: (r.labels ?? []) as string[],
      html_url: r.html_url,
      github_updated_at: r.github_updated_at,
      relevance_score: Number(r.relevance_score),
      title_similarity: Number(r.title_similarity ?? 0),
      distinctive_title_overlap: distinctiveTitleOverlap(target.title, r.title),
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
}

function filterCandidatesForReview(rows: ScoredCandidate[]): ScoredCandidate[] {
  const passed = rows.filter((c) => {
    if (c.relevance_score >= STRONG_RELEVANCE_BYPASS) return true;
    if (c.title_similarity >= MIN_TITLE_SIMILARITY && c.distinctive_title_overlap >= MIN_DISTINCTIVE_TITLE_OVERLAP) {
      return true;
    }
    return false;
  });
  return (passed.length > 0 ? passed : rows.slice(0, 3)).slice(0, MAX_GEMINI_CANDIDATES);
}

function shouldSkipGemini(top: ScoredCandidate | undefined): string | null {
  if (!top) return "No candidates above similarity threshold.";
  if (top.relevance_score < MIN_TOP_RELEVANCE && top.title_similarity < MIN_TITLE_SIMILARITY) {
    return "Top candidate similarity too low for duplicate review (likely different issues).";
  }
  if (top.distinctive_title_overlap < MIN_DISTINCTIVE_TITLE_OVERLAP && top.relevance_score < STRONG_RELEVANCE_BYPASS) {
    return "Titles only share generic terms (e.g. ipv6/network), not a specific duplicate signal.";
  }
  return null;
}

async function fetchScoredCandidates(
  sb: ReturnType<typeof createClient>,
  target: GithubIssue,
  owner: string,
  repo: string,
): Promise<{ rows: ScoredCandidate[]; method: string }> {
  const { data: rpcData, error: rpcErr } = await sb.rpc("find_duplicate_candidates", {
    p_owner: owner,
    p_repo: repo,
    p_issue_number: target.issue_number,
    p_limit: CANDIDATE_LIMIT,
  });

  if (!rpcErr && rpcData !== null) {
    return { rows: mapRpcRows(target, rpcData as unknown[]), method: "pg_trgm" };
  }

  if (rpcErr) {
    console.warn("find_duplicate_candidates RPC failed, using in-memory fallback:", rpcErr.message);
  }

  const { data: pool, error: poolErr } = await sb
    .from("github_issues")
    .select("issue_number, title, body, state, labels, html_url, github_updated_at")
    .eq("owner", owner)
    .eq("repo", repo)
    .eq("state", "open")
    .neq("issue_number", target.issue_number)
    .limit(500);

  if (poolErr) throw new Error(poolErr.message);
  return {
    rows: attachScores(target, (pool ?? []) as GithubIssue[]).slice(0, CANDIDATE_LIMIT),
    method: "in_memory",
  };
}

async function callGemini(
  apiKey: string,
  target: GithubIssue,
  candidates: ScoredCandidate[],
): Promise<DuplicateResult> {
  const prompt = `You detect duplicate GitHub issues in the same repository.

TARGET ISSUE (newly opened):
#${target.issue_number} [${target.state}] ${target.title}
Labels: ${JSON.stringify(target.labels)}
Body excerpt:
${(target.body ?? "").slice(0, 2500)}

CANDIDATE ISSUES (textually similar; NOT necessarily duplicates):
${candidates
  .map(
    (c) =>
      `#${c.issue_number} [${c.state}] ${c.title}\n` +
      `  title_similarity=${c.title_similarity.toFixed(2)} distinctive_overlap=${c.distinctive_title_overlap}\n` +
      `Labels: ${JSON.stringify(c.labels)}\nBody excerpt:\n${(c.body ?? "").slice(0, 1200)}\n---`,
  )
  .join("\n")}

STRICT RULES — read carefully:
1. duplicate_issue_id: set only if fixing ONE candidate would fully resolve the TARGET (same root cause, same user-visible failure, same reproduction).
2. NOT duplicates (return null) when issues only share a broad area:
   - Example: IPv6 ULA-vs-GUA address selection for pasta/remote hosts (#28257) vs IPv6 localhost port-forwarding vs Docker (#14491) — both mention ipv6/network but are DIFFERENT bugs.
   - Shared labels (network, pasta) or shared words (ipv6, podman) alone are NEVER enough.
3. same_failure_mode: true only if the user would describe the same broken behavior; false if only the subsystem matches.
4. confidence: "high" only when you are certain; "medium"/"low" when related but not the same bug.
5. Prefer null when symptoms, affected component, or reproduction differ.

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

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ??
    data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text).join("");

  if (!text) throw new Error("Empty Gemini response");

  const parsed = JSON.parse(text) as DuplicateResult;
  if (parsed.duplicate_issue_id === target.issue_number) {
    return {
      duplicate_issue_id: null,
      confidence: "low",
      same_failure_mode: false,
      reason: "Model returned self; treated as no duplicate.",
    };
  }
  const valid = candidates.some((c) => c.issue_number === parsed.duplicate_issue_id);
  if (parsed.duplicate_issue_id != null && !valid) {
    return {
      duplicate_issue_id: null,
      confidence: "low",
      same_failure_mode: false,
      reason: `Model cited #${parsed.duplicate_issue_id} which was not in the candidate set.`,
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
      reason: `Not reported as duplicate: requires confidence=high and same_failure_mode=true. ${result.reason}`,
    };
  }
  return result;
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

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const secret = Deno.env.get("DEDUP_FUNCTION_SECRET");
  if (secret && req.headers.get("x-dedup-secret") !== secret) {
    return unauthorized();
  }

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY not configured" }, 500);
  }

  let body: { owner?: string; repo?: string; issue_number?: number };
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

  const { data: target, error: targetErr } = await sb
    .from("github_issues")
    .select("issue_number, title, body, state, labels, html_url, github_updated_at")
    .eq("owner", owner)
    .eq("repo", repo)
    .eq("issue_number", issueNumber)
    .maybeSingle();

  if (targetErr) return jsonResponse({ error: targetErr.message }, 500);
  if (!target) {
    return jsonResponse(
      { error: "Issue not in database; run scripts/sync_github_issues.py first", duplicate_issue_id: null, reason: "" },
      404,
    );
  }

  let scored: ScoredCandidate[];
  let selectionMethod: string;
  try {
    const found = await fetchScoredCandidates(sb, target as GithubIssue, owner, repo);
    scored = found.rows;
    selectionMethod = found.method;
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }

  if (!scored.length) {
    return jsonResponse({
      duplicate_issue_id: null,
      reason: "No other open issues in the database to compare against.",
      candidate_selection: { method: selectionMethod, count: 0 },
    });
  }

  const forReview = filterCandidatesForReview(scored);
  const skipReason = shouldSkipGemini(forReview[0]);
  if (skipReason) {
    return jsonResponse({
      issue_number: issueNumber,
      owner,
      repo,
      duplicate_issue_id: null,
      duplicate_url: null,
      reason: skipReason,
      candidate_selection: {
        method: selectionMethod,
        count: forReview.length,
        skipped_gemini: true,
        top_candidates: forReview.slice(0, 5).map((c) => ({
          issue_number: c.issue_number,
          title: c.title.slice(0, 100),
          relevance_score: c.relevance_score,
          title_similarity: c.title_similarity,
          distinctive_title_overlap: c.distinctive_title_overlap,
        })),
      },
    });
  }

  try {
    const raw = await callGemini(geminiKey, target as GithubIssue, forReview);
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
      duplicate_issue_id: result.duplicate_issue_id,
      duplicate_url,
      reason: result.reason,
      model_confidence: result.confidence,
      same_failure_mode: result.same_failure_mode,
      candidate_selection: {
        method: selectionMethod,
        count: forReview.length,
        skipped_gemini: false,
        top_candidates: forReview.slice(0, 5).map((c) => ({
          issue_number: c.issue_number,
          title: c.title.slice(0, 100),
          relevance_score: c.relevance_score,
          title_similarity: c.title_similarity,
          distinctive_title_overlap: c.distinctive_title_overlap,
        })),
      },
    });
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
