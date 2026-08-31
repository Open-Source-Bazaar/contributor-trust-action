// src/index.ts
import { readFile } from "node:fs/promises";

// src/analyze.ts
var trustedAssociations = /* @__PURE__ */ new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
var clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
var accountAgeDays = (createdAt, now) => {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / 864e5)) : 0;
};
function analyzeContributor({
  profile: profile2,
  events: events2 = [],
  authoredPullRequests = 0,
  authoredIssues = 0,
  organizationPullRequests = 0,
  association = "NONE",
  content = "",
  now = /* @__PURE__ */ new Date()
}) {
  if (trustedAssociations.has(association)) {
    return {
      score: 0,
      level: "low",
      trusted: true,
      reasons: [`Repository association is ${association}.`],
      facts: buildFacts(profile2, events2, authoredPullRequests, authoredIssues, organizationPullRequests, now)
    };
  }
  const reasons = [];
  let score = 0;
  const ageDays = accountAgeDays(profile2.created_at, now);
  const isBot = profile2.type === "Bot" || /\[bot\]$/i.test(profile2.login ?? "");
  if (isBot) {
    score = 100;
    reasons.push("GitHub identifies the account as a bot.");
  } else {
    if (ageDays < 7) {
      score += 35;
      reasons.push(`Account is only ${ageDays} days old.`);
    } else if (ageDays < 30) {
      score += 24;
      reasons.push(`Account is ${ageDays} days old.`);
    } else if (ageDays < 90) {
      score += 10;
      reasons.push(`Account is relatively new (${ageDays} days).`);
    }
    if (profile2.public_repos === 0) {
      score += 15;
      reasons.push("Account has no public repositories.");
    } else if ((profile2.public_repos ?? 0) <= 2) {
      score += 7;
      reasons.push(`Account has ${profile2.public_repos} public repositories.`);
    }
    const profileFields = [profile2.name, profile2.bio, profile2.company, profile2.blog, profile2.location];
    if (profileFields.every((value) => !String(value ?? "").trim())) {
      score += 10;
      reasons.push("Public profile has no identifying or project context.");
    }
    if ((profile2.followers ?? 0) === 0) {
      score += 4;
      reasons.push("Account has no followers.");
    }
    if (events2.length === 0) {
      score += 12;
      reasons.push("No recent public activity is visible through the GitHub API.");
    }
    if (authoredPullRequests === 0) {
      score += 10;
      reasons.push("No public pull requests were found.");
    }
    if (organizationPullRequests > 0) {
      score -= Math.min(15, 5 + organizationPullRequests * 2);
      reasons.push(`Found ${organizationPullRequests} earlier pull request(s) in this organization.`);
    }
    if (content.trim().length < 20) {
      score += 5;
      reasons.push("Current contribution contains very little context.");
    }
  }
  score = clamp(score, 0, 100);
  return {
    score,
    level: score >= 55 ? "high" : score >= 30 ? "medium" : "low",
    trusted: false,
    reasons,
    facts: buildFacts(profile2, events2, authoredPullRequests, authoredIssues, organizationPullRequests, now)
  };
}
function mergeAiReview(report2, aiReview) {
  if (!aiReview) return report2;
  let score = report2.score;
  if (aiReview.classification === "likely-automated" && aiReview.confidence >= 0.75) score += 20;
  if (aiReview.classification === "likely-human" && aiReview.confidence >= 0.75) score -= 10;
  score = clamp(score, 0, 100);
  return {
    ...report2,
    score,
    level: score >= 55 ? "high" : score >= 30 ? "medium" : "low",
    aiReview
  };
}
function shouldRetainReviewLabel(report2, comments = []) {
  if (report2.level === "medium" || report2.level === "high") return true;
  const ownMarker = `<!-- contributor-trust:${report2.author} -->`;
  return comments.some((comment) => {
    const body = String(comment.body ?? "");
    if (!body.includes("<!-- contributor-trust:") || body.includes(ownMarker)) return false;
    return /\*\*@[\w-]+:\s+(?:MEDIUM|HIGH)\s+\(\d+\/100\)\*\*/.test(body);
  });
}
function shouldBlockContributor({ profile: profile2, report: report2 }) {
  if (report2.trusted || report2.level !== "high") return false;
  if (profile2.type === "Bot" || /\[bot\]$/i.test(profile2.login ?? "")) return false;
  return report2.aiReview?.classification === "likely-automated" && report2.aiReview.confidence >= 0.9;
}
function buildFacts(profile2, events2, authoredPullRequests, authoredIssues, organizationPullRequests, now) {
  return {
    accountAgeDays: accountAgeDays(profile2.created_at, now),
    publicRepositories: profile2.public_repos ?? 0,
    followers: profile2.followers ?? 0,
    following: profile2.following ?? 0,
    recentPublicEvents: events2.length,
    authoredPullRequests,
    authoredIssues,
    organizationPullRequests
  };
}

// src/utility.ts
import { appendFile } from "node:fs/promises";
var input = (name, fallback = "") => process.env[`INPUT_${name.toUpperCase().replaceAll("-", "_")}`] ?? fallback;
function isPullRequestEvent(event) {
  return "pull_request" in event && event.pull_request != null;
}
function isIssueCommentEvent(event) {
  return "comment" in event && "issue" in event && event.comment != null && event.issue != null;
}
function isIssueEvent(event) {
  return "issue" in event && event.issue != null;
}
function resolveTarget(event) {
  if (isPullRequestEvent(event)) {
    const pr = event.pull_request;
    return {
      kind: "pull request",
      number: pr.number,
      login: pr.user.login,
      association: pr.author_association ?? "NONE",
      content: `${pr.title ?? ""}
${pr.body ?? ""}`
    };
  }
  if (isIssueCommentEvent(event)) {
    const { comment, issue } = event;
    return {
      kind: "issue comment",
      number: issue.number,
      login: comment.user.login,
      association: comment.author_association ?? "NONE",
      content: comment.body ?? ""
    };
  }
  if (isIssueEvent(event)) {
    const { issue } = event;
    return {
      kind: "issue",
      number: issue.number,
      login: issue.user.login,
      association: issue.author_association ?? "NONE",
      content: `${issue.title ?? ""}
${issue.body ?? ""}`
    };
  }
  throw new Error(`Unsupported event payload: ${process.env.GITHUB_EVENT_NAME ?? "unknown"}`);
}
async function github(token2, path, options = {}, allowNotFound = false) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token2}`,
      "X-GitHub-Api-Version": "2026-03-10",
      ...options.headers
    }
  });
  if (allowNotFound && response.status === 404) return void 0;
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status}`);
  if (response.status !== 204) return response.json();
  return void 0;
}
async function blockContributorIfConfigured({
  token: token2,
  owner: owner2,
  profile: profile2,
  report: report2,
  target: target2,
  blockHighConfidenceAutomation: blockHighConfidenceAutomation2
}) {
  if (!blockHighConfidenceAutomation2) return false;
  if (!shouldBlockContributor({ profile: profile2, report: report2 })) return false;
  await github(token2, `/orgs/${encodeURIComponent(owner2)}/blocks/${encodeURIComponent(target2.login)}`, {
    method: "PUT"
  });
  return true;
}
async function reviewWithGitHubModels({
  token: token2,
  profile: profile2,
  report: report2,
  target: target2,
  model: model2
}) {
  const response = await fetch("https://models.github.ai/inference/chat/completions", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token2}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2026-03-10"
    },
    body: JSON.stringify({
      model: model2,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Assess whether a public GitHub contribution warrants maintainer review for likely automation or bounty spam.",
            "Use only supplied facts. Never infer identity from writing style, language, nationality, or AI-tool disclosure.",
            "A new or sparse account is not proof. Prefer inconclusive when evidence is weak.",
            'Return JSON: {"classification":"likely-human|inconclusive|likely-automated","confidence":0..1,"reasons":[...],"recommendation":"..."}.'
          ].join(" ")
        },
        {
          role: "user",
          content: JSON.stringify({
            profile: {
              login: profile2.login,
              type: profile2.type,
              created_at: profile2.created_at,
              public_repos: profile2.public_repos,
              followers: profile2.followers,
              profile_complete: Boolean(profile2.name || profile2.bio || profile2.company || profile2.blog)
            },
            facts: report2.facts,
            heuristicReasons: report2.reasons,
            contributionKind: target2.kind,
            contributionText: target2.content.slice(0, 4e3)
          })
        }
      ]
    })
  });
  if (!response.ok) throw new Error(`GitHub Models returned ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
  const classifications = /* @__PURE__ */ new Set(["likely-human", "inconclusive", "likely-automated"]);
  if (!classifications.has(parsed.classification)) throw new Error("GitHub Models returned an invalid classification");
  return {
    classification: parsed.classification,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5).map(String) : [],
    recommendation: String(parsed.recommendation ?? "")
  };
}
async function syncRepositoryState(token2, owner2, repo2, report2) {
  const label = "needs-contributor-review";
  const marker = `<!-- contributor-trust:${report2.author} -->`;
  const comments = await github(token2, `/repos/${owner2}/${repo2}/issues/${report2.number}/comments?per_page=100`);
  const existingLabel = await github(token2, `/repos/${owner2}/${repo2}/labels/${encodeURIComponent(label)}`, {}, true);
  if (!existingLabel) {
    await github(token2, `/repos/${owner2}/${repo2}/labels`, {
      method: "POST",
      body: JSON.stringify({
        name: label,
        color: "bf8700",
        description: "Public account signals need human review"
      })
    });
  }
  const needsReview = shouldRetainReviewLabel(report2, comments);
  if (needsReview) {
    await github(token2, `/repos/${owner2}/${repo2}/issues/${report2.number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [label] })
    });
  } else {
    await github(
      token2,
      `/repos/${owner2}/${repo2}/issues/${report2.number}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" },
      true
    );
  }
  const existing = comments.find(({ body: body2 }) => body2?.includes(marker));
  const body = renderComment(report2, marker);
  if (existing) {
    await github(token2, `/repos/${owner2}/${repo2}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ body })
    });
  } else {
    await github(token2, `/repos/${owner2}/${repo2}/issues/${report2.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body })
    });
  }
}
function renderComment(report2, marker) {
  const facts = report2.facts;
  const reasons = report2.reasons.length ? report2.reasons.map((reason) => `- ${reason}`).join("\n") : "- No heuristic warnings.";
  const ai = report2.aiReview ? `
### AI review

- Classification: **${report2.aiReview.classification}** (${Math.round(report2.aiReview.confidence * 100)}% confidence)
- Recommendation: ${report2.aiReview.recommendation || "No recommendation."}
${report2.aiReview.reasons.map((reason) => `- ${reason}`).join("\n")}` : report2.aiError ? "\n### AI review\n\nUnavailable; the evidence-only report remains valid." : "";
  return `${marker}
## Contributor detection

**@${report2.author}: ${report2.level.toUpperCase()} (${report2.score}/100)**

| Public signal | Value |
| --- | ---: |
| Account age | ${facts.accountAgeDays} days |
| Public repositories | ${facts.publicRepositories} |
| Recent public events | ${facts.recentPublicEvents} |
| Public pull requests | ${facts.authoredPullRequests} |
| Earlier PRs in this organization | ${facts.organizationPullRequests} |

### Evidence

${reasons}${ai}

Blocking result: **${report2.blocked ? "blocked from the organization" : "not blocked"}**.

This detection uses public evidence to prioritize human review. Sparse-account signals and GitHub App bot status alone never trigger blocking; blocking requires a high-confidence likely-automated classification for a user account.`;
}
async function writeSummary(report2) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Contributor detection

- Author: @${report2.author}
- Risk: ${report2.level} (${report2.score}/100)
- Subject: ${report2.subject} #${report2.number}
- Blocked: ${report2.blocked}
`
  );
}
async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}
${value}
${delimiter}
`);
}

// src/index.ts
var token = input("github-token");
var blockHighConfidenceAutomation = input("block-high-confidence-automation") === "true";
var useAi = input("ai-review", "true") === "true";
var model = input("model", "openai/gpt-4.1");
var shouldComment = input("comment", "true") === "true";
var failOnHighRisk = input("fail-on-high-risk") === "true";
var [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
var eventPath = process.env.GITHUB_EVENT_PATH;
if (!token || !owner || !repo || !eventPath) {
  throw new Error("github-token, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required");
}
var payload = JSON.parse(await readFile(eventPath, "utf8"));
var target = resolveTarget(payload);
var encodedLogin = encodeURIComponent(target.login);
var [profile, events, pullSearch, issueSearch, organizationSearch] = await Promise.all([
  github(token, `/users/${encodedLogin}`),
  github(token, `/users/${encodedLogin}/events/public?${new URLSearchParams({ per_page: "100" })}`),
  github(token, `/search/issues?${new URLSearchParams({ q: `type:pr author:${target.login}`, per_page: "1" })}`),
  github(token, `/search/issues?${new URLSearchParams({ q: `type:issue author:${target.login}`, per_page: "1" })}`),
  github(token, `/search/issues?${new URLSearchParams({ q: `type:pr org:${owner} author:${target.login}`, per_page: "1" })}`)
]);
var report = analyzeContributor({
  profile,
  events,
  authoredPullRequests: pullSearch.total_count,
  authoredIssues: issueSearch.total_count,
  organizationPullRequests: organizationSearch.total_count,
  association: target.association,
  content: target.content
});
var aiError = "";
if (useAi && !report.trusted && profile.type !== "Bot")
  try {
    report = mergeAiReview(
      report,
      await reviewWithGitHubModels({ token, profile, report, target, model })
    );
  } catch (error) {
    aiError = error.message;
    console.log(`GitHub Models review unavailable: ${aiError}`);
  }
var blocked = await blockContributorIfConfigured({
  token,
  owner,
  profile,
  report,
  target,
  blockHighConfidenceAutomation
});
var finalReport = {
  author: target.login,
  subject: target.kind,
  number: target.number,
  ...report,
  blocked,
  aiError: aiError || void 0
};
if (shouldComment) await syncRepositoryState(token, owner, repo, finalReport);
await writeSummary(finalReport);
await output("author", target.login);
await output("risk-level", report.level);
await output("risk-score", String(report.score));
await output("report-json", JSON.stringify(finalReport));
await output("blocked", String(blocked));
if (failOnHighRisk && report.level === "high")
  throw new Error(`Contributor detection for @${target.login} is high risk (${report.score}/100).`);
