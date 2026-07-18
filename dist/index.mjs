import { appendFile, readFile } from 'node:fs/promises';

import { analyzeContributor, mergeAiReview } from '../src/analyze.mjs';

const token = input('github-token');
const useAi = input('ai-review', 'true') === 'true';
const model = input('model', 'openai/gpt-4.1');
const shouldComment = input('comment', 'true') === 'true';
const failOnHighRisk = input('fail-on-high-risk', 'false') === 'true';
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');

if (!token || !owner || !repo || !process.env.GITHUB_EVENT_PATH) {
  throw new Error('github-token, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required');
}

const payload = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
const target = resolveTarget(payload);
const encodedLogin = encodeURIComponent(target.login);

const [profile, events, pullSearch, issueSearch, organizationSearch] = await Promise.all([
  github(`/users/${encodedLogin}`),
  github(`/users/${encodedLogin}/events/public?per_page=100`),
  github(`/search/issues?q=${encodeURIComponent(`type:pr author:${target.login}`)}&per_page=1`),
  github(`/search/issues?q=${encodeURIComponent(`type:issue author:${target.login}`)}&per_page=1`),
  github(`/search/issues?q=${encodeURIComponent(`type:pr org:${owner} author:${target.login}`)}&per_page=1`),
]);

let report = analyzeContributor({
  profile,
  events,
  authoredPullRequests: pullSearch.total_count,
  authoredIssues: issueSearch.total_count,
  organizationPullRequests: organizationSearch.total_count,
  association: target.association,
  content: target.content,
});

let aiError = '';
if (useAi && !report.trusted && profile.type !== 'Bot') {
  try {
    report = mergeAiReview(report, await reviewWithGitHubModels({ profile, report, target }));
  } catch (error) {
    aiError = error.message;
    console.warning?.(`GitHub Models review unavailable: ${aiError}`);
    console.log(`GitHub Models review unavailable: ${aiError}`);
  }
}

const finalReport = {
  author: target.login,
  subject: target.kind,
  number: target.number,
  ...report,
  aiError: aiError || undefined,
};

if (shouldComment) await syncRepositoryState(finalReport);
await writeSummary(finalReport);
await output('author', target.login);
await output('risk-level', report.level);
await output('risk-score', String(report.score));
await output('report-json', JSON.stringify(finalReport));

if (failOnHighRisk && report.level === 'high') {
  process.exitCode = 1;
  console.error(`Contributor report for @${target.login} is high risk (${report.score}/100).`);
}

function input(name, fallback = '') {
  return process.env[`INPUT_${name.toUpperCase()}`] ?? fallback;
}

function resolveTarget(event) {
  if (event.pull_request) {
    return {
      kind: 'pull request',
      number: event.pull_request.number,
      login: event.pull_request.user.login,
      association: event.pull_request.author_association ?? 'NONE',
      content: `${event.pull_request.title ?? ''}\n${event.pull_request.body ?? ''}`,
    };
  }
  if (event.comment && event.issue) {
    return {
      kind: 'issue comment',
      number: event.issue.number,
      login: event.comment.user.login,
      association: event.comment.author_association ?? 'NONE',
      content: event.comment.body ?? '',
    };
  }
  if (event.issue) {
    return {
      kind: 'issue',
      number: event.issue.number,
      login: event.issue.user.login,
      association: event.issue.author_association ?? 'NONE',
      content: `${event.issue.title ?? ''}\n${event.issue.body ?? ''}`,
    };
  }
  throw new Error(`Unsupported event payload: ${process.env.GITHUB_EVENT_NAME ?? 'unknown'}`);
}

async function github(path, options = {}, allowNotFound = false) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...options.headers,
    },
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function reviewWithGitHubModels({ profile, report, target }) {
  const response = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Assess whether a public GitHub contribution warrants maintainer review for likely automation or bounty spam.',
            'Use only supplied facts. Never infer identity from writing style, language, nationality, or AI-tool disclosure.',
            'A new or sparse account is not proof. Prefer inconclusive when evidence is weak.',
            'Return JSON: {"classification":"likely-human|inconclusive|likely-automated","confidence":0..1,"reasons":[...],"recommendation":"..."}.',
          ].join(' '),
        },
        {
          role: 'user',
          content: JSON.stringify({
            profile: {
              login: profile.login,
              type: profile.type,
              created_at: profile.created_at,
              public_repos: profile.public_repos,
              followers: profile.followers,
              profile_complete: Boolean(profile.name || profile.bio || profile.company || profile.blog),
            },
            facts: report.facts,
            heuristicReasons: report.reasons,
            contributionKind: target.kind,
            contributionText: target.content.slice(0, 4000),
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`GitHub Models returned ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
  const classifications = new Set(['likely-human', 'inconclusive', 'likely-automated']);
  if (!classifications.has(parsed.classification)) throw new Error('GitHub Models returned an invalid classification');
  return {
    classification: parsed.classification,
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 5).map(String) : [],
    recommendation: String(parsed.recommendation ?? ''),
  };
}

async function syncRepositoryState(report) {
  const label = 'needs-contributor-review';
  const marker = `<!-- contributor-trust:${report.author} -->`;
  const existingLabel = await github(`/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`, {}, true);
  if (!existingLabel) {
    await github(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name: label,
        color: 'bf8700',
        description: 'Public account signals need human review',
      }),
    });
  }

  const needsReview = report.level === 'medium' || report.level === 'high';
  if (needsReview) {
    await github(`/repos/${owner}/${repo}/issues/${report.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [label] }),
    });
  } else {
    await github(
      `/repos/${owner}/${repo}/issues/${report.number}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
      true,
    );
  }

  const comments = await github(`/repos/${owner}/${repo}/issues/${report.number}/comments?per_page=100`);
  const existing = comments.find(comment => comment.body?.includes(marker));
  const body = renderComment(report, marker);
  if (existing) {
    await github(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
  } else {
    await github(`/repos/${owner}/${repo}/issues/${report.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
}

function renderComment(report, marker) {
  const facts = report.facts;
  const reasons = report.reasons.length ? report.reasons.map(reason => `- ${reason}`).join('\n') : '- No heuristic warnings.';
  const ai = report.aiReview
    ? `\n### AI review\n\n- Classification: **${report.aiReview.classification}** (${Math.round(report.aiReview.confidence * 100)}% confidence)\n- Recommendation: ${report.aiReview.recommendation || 'No recommendation.'}\n${report.aiReview.reasons.map(reason => `- ${reason}`).join('\n')}`
    : report.aiError
      ? '\n### AI review\n\nUnavailable; the evidence-only report remains valid.'
      : '';
  return `${marker}
## Contributor trust report

**@${report.author}: ${report.level.toUpperCase()} (${report.score}/100)**

| Public signal | Value |
| --- | ---: |
| Account age | ${facts.accountAgeDays} days |
| Public repositories | ${facts.publicRepositories} |
| Recent public events | ${facts.recentPublicEvents} |
| Public pull requests | ${facts.authoredPullRequests} |
| Earlier PRs in this organization | ${facts.organizationPullRequests} |

### Evidence

${reasons}${ai}

This report uses public signals to prioritize human review. It is not proof that a contributor used automation, and it never blocks an account automatically.`;
}

async function writeSummary(report) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Contributor trust report\n\n- Author: @${report.author}\n- Risk: ${report.level} (${report.score}/100)\n- Subject: ${report.subject} #${report.number}\n`,
  );
}

async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
