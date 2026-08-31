import { appendFile } from 'node:fs/promises';

import { shouldBlockContributor, shouldRetainReviewLabel } from './analyze.ts';
import {
  AiReview,
  ContributorReport,
  ContributorTarget,
  FinalContributorReport,
  GitHubProfile,
  IssueCommentPayload,
  IssuePayload,
  PullRequestPayload,
} from './type.ts';

export const input = (name: string, fallback = '') =>
  process.env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`] ?? fallback;

function isPullRequestEvent(event: Record<string, unknown>): event is PullRequestPayload {
  return 'pull_request' in event && event.pull_request != null;
}

function isIssueCommentEvent(event: Record<string, unknown>): event is IssueCommentPayload {
  return 'comment' in event && 'issue' in event && event.comment != null && event.issue != null;
}

function isIssueEvent(event: Record<string, unknown>): event is IssuePayload {
  return 'issue' in event && event.issue != null;
}

export function resolveTarget(event: Record<string, unknown>): ContributorTarget {
  if (isPullRequestEvent(event)) {
    const pr = event.pull_request;
    return {
      kind: 'pull request',
      number: pr.number,
      login: pr.user.login,
      association: (pr.author_association as string) ?? 'NONE',
      content: `${pr.title ?? ''}\n${pr.body ?? ''}`,
    };
  }
  if (isIssueCommentEvent(event)) {
    const { comment, issue } = event;
    return {
      kind: 'issue comment',
      number: issue.number,
      login: comment.user.login,
      association: (comment.author_association as string) ?? 'NONE',
      content: comment.body ?? '',
    };
  }
  if (isIssueEvent(event)) {
    const { issue } = event;
    return {
      kind: 'issue',
      number: issue.number,
      login: issue.user.login,
      association: (issue.author_association as string) ?? 'NONE',
      content: `${issue.title ?? ''}\n${issue.body ?? ''}`,
    };
  }
  throw new Error(`Unsupported event payload: ${process.env.GITHUB_EVENT_NAME ?? 'unknown'}`);
}

interface BlockContributorOptions {
  token: string;
  owner: string;
  profile: GitHubProfile;
  report: ContributorReport;
  target: ContributorTarget;
  blockHighConfidenceAutomation: boolean;
}

interface ReviewWithGitHubModelsOptions {
  token: string;
  profile: GitHubProfile;
  report: ContributorReport;
  target: ContributorTarget;
  model: string;
}

export async function github<T>(
  token: string,
  path: string,
  options: RequestInit = {},
  allowNotFound = false,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2026-03-10',
      ...options.headers,
    },
  });
  if (allowNotFound && response.status === 404) return undefined as T;

  if (!response.ok) throw new Error(`${(options.method ?? 'GET')} ${path}: ${response.status}`);

  if (response.status !== 204) return response.json() as Promise<T>;
  return undefined as T;
}

export async function blockContributorIfConfigured({
  token,
  owner,
  profile,
  report,
  target,
  blockHighConfidenceAutomation,
}: BlockContributorOptions): Promise<boolean> {
  if (!blockHighConfidenceAutomation) return false;
  if (!shouldBlockContributor({ profile, report })) return false;

  await github<void>(token, `/orgs/${encodeURIComponent(owner)}/blocks/${encodeURIComponent(target.login)}`, {
    method: 'PUT',
  });
  return true;
}

export async function reviewWithGitHubModels({
  token,
  profile,
  report,
  target,
  model,
}: ReviewWithGitHubModelsOptions): Promise<AiReview> {
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

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')) as Record<string, unknown>;
  const classifications = new Set(['likely-human', 'inconclusive', 'likely-automated']);

  if (!classifications.has(parsed.classification as string)) throw new Error('GitHub Models returned an invalid classification');

  return {
    classification: parsed.classification as AiReview['classification'],
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    reasons: Array.isArray(parsed.reasons) ? (parsed.reasons as unknown[]).slice(0, 5).map(String) : [],
    recommendation: String(parsed.recommendation ?? ''),
  };
}

export async function syncRepositoryState(
  token: string,
  owner: string,
  repo: string,
  report: FinalContributorReport,
): Promise<void> {
  const label = 'needs-contributor-review';
  const marker = `<!-- contributor-trust:${report.author} -->`;
  const comments = await github<Array<{ id: number; body?: string }>>(token, `/repos/${owner}/${repo}/issues/${report.number}/comments?per_page=100`);
  const existingLabel = await github<unknown>(token, `/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`, {}, true);
  if (!existingLabel) {
    await github<void>(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({
        name: label,
        color: 'bf8700',
        description: 'Public account signals need human review',
      }),
    });
  }

  const needsReview = shouldRetainReviewLabel(report, comments);
  if (needsReview) {
    await github<void>(token, `/repos/${owner}/${repo}/issues/${report.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [label] }),
    });
  } else {
    await github<void>(
      token,
      `/repos/${owner}/${repo}/issues/${report.number}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
      true,
    );
  }

  const existing = comments.find(({ body }) => body?.includes(marker));
  const body = renderComment(report, marker);
  if (existing) {
    await github<void>(token, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
  } else {
    await github<void>(token, `/repos/${owner}/${repo}/issues/${report.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
}

export function renderComment(report: FinalContributorReport, marker: string): string {
  const facts = report.facts;
  const reasons = report.reasons.length ? report.reasons.map(reason => `- ${reason}`).join('\n') : '- No heuristic warnings.';
  const ai = report.aiReview
    ? `\n### AI review\n\n- Classification: **${report.aiReview.classification}** (${Math.round(report.aiReview.confidence * 100)}% confidence)\n- Recommendation: ${report.aiReview.recommendation || 'No recommendation.'}\n${report.aiReview.reasons.map(reason => `- ${reason}`).join('\n')}`
    : report.aiError
      ? '\n### AI review\n\nUnavailable; the evidence-only report remains valid.'
      : '';
  return `${marker}
## Contributor detection

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

Blocking result: **${report.blocked ? 'blocked from the organization' : 'not blocked'}**.

This detection uses public evidence to prioritize human review. Sparse-account signals and GitHub App bot status alone never trigger blocking; blocking requires a high-confidence likely-automated classification for a user account.`;
}

export async function writeSummary(report: FinalContributorReport): Promise<void> {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `## Contributor detection\n\n- Author: @${report.author}\n- Risk: ${report.level} (${report.score}/100)\n- Subject: ${report.subject} #${report.number}\n- Blocked: ${report.blocked}\n`,
  );
}

export async function output(name: string, value: string): Promise<void> {
  if (!process.env.GITHUB_OUTPUT) return;
  const delimiter = `EOF_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await appendFile(process.env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}
