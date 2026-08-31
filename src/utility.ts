import { appendFile } from 'node:fs/promises';

import { ContributorReport, GitHubProfile, shouldBlockContributor, shouldRetainReviewLabel } from './analyze.ts';

export interface ContributorTarget {
  kind: string;
  number: number;
  login: string;
  association: string;
  content: string;
}

export function input(name: string, fallback = ''): string {
  return process.env[`INPUT_${name.toUpperCase().replaceAll('-', '_')}`] ?? fallback;
}

export function resolveTarget(event: Record<string, unknown>): ContributorTarget {
  if (event.pull_request) {
    const pr = event.pull_request as Record<string, unknown>;
    return {
      kind: 'pull request',
      number: pr.number as number,
      login: (pr.user as Record<string, string>).login,
      association: (pr.author_association as string) ?? 'NONE',
      content: `${(pr.title as string) ?? ''}\n${(pr.body as string) ?? ''}`,
    };
  }
  if (event.comment && event.issue) {
    const comment = event.comment as Record<string, unknown>;
    const issue = event.issue as Record<string, unknown>;
    return {
      kind: 'issue comment',
      number: issue.number as number,
      login: (comment.user as Record<string, string>).login,
      association: (comment.author_association as string) ?? 'NONE',
      content: (comment.body as string) ?? '',
    };
  }
  if (event.issue) {
    const issue = event.issue as Record<string, unknown>;
    return {
      kind: 'issue',
      number: issue.number as number,
      login: (issue.user as Record<string, string>).login,
      association: (issue.author_association as string) ?? 'NONE',
      content: `${(issue.title as string) ?? ''}\n${(issue.body as string) ?? ''}`,
    };
  }
  throw new Error(`Unsupported event payload: ${process.env.GITHUB_EVENT_NAME ?? 'unknown'}`);
}

export async function github(
  token: string,
  path: string,
  options: RequestInit = {},
  allowNotFound = false,
): Promise<unknown> {
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
  if (!response.ok) throw new Error(`${(options.method ?? 'GET')} ${path}: ${response.status}`);
  return response.status === 204 ? null : response.json();
}

export async function blockContributorIfConfigured({
  token,
  owner,
  profile,
  report,
  target,
  blockHighConfidenceAutomation,
}: {
  token: string;
  owner: string;
  profile: GitHubProfile;
  report: ContributorReport;
  target: ContributorTarget;
  blockHighConfidenceAutomation: boolean;
}): Promise<boolean> {
  if (!blockHighConfidenceAutomation) return false;
  if (!shouldBlockContributor({ profile, report })) return false;

  await github(token, `/orgs/${encodeURIComponent(owner)}/blocks/${encodeURIComponent(target.login)}`, {
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
}: {
  token: string;
  profile: GitHubProfile;
  report: ContributorReport;
  target: ContributorTarget;
  model: string;
}) {
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
    classification: parsed.classification as 'likely-human' | 'inconclusive' | 'likely-automated',
    confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
    reasons: Array.isArray(parsed.reasons) ? (parsed.reasons as unknown[]).slice(0, 5).map(String) : [],
    recommendation: String(parsed.recommendation ?? ''),
  };
}

export async function syncRepositoryState(
  token: string,
  owner: string,
  repo: string,
  report: ContributorReport,
): Promise<void> {
  const label = 'needs-contributor-review';
  const marker = `<!-- contributor-trust:${report.author} -->`;
  const comments = await github(token, `/repos/${owner}/${repo}/issues/${report.number}/comments?per_page=100`) as Array<{ id: number; body?: string }>;
  const existingLabel = await github(token, `/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`, {}, true);
  if (!existingLabel) {
    await github(token, `/repos/${owner}/${repo}/labels`, {
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
    await github(token, `/repos/${owner}/${repo}/issues/${report.number}/labels`, {
      method: 'POST',
      body: JSON.stringify({ labels: [label] }),
    });
  } else {
    await github(
      token,
      `/repos/${owner}/${repo}/issues/${report.number}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
      true,
    );
  }

  const existing = comments.find(comment => comment.body?.includes(marker));
  const body = renderComment(report, marker);
  if (existing) {
    await github(token, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
  } else {
    await github(token, `/repos/${owner}/${repo}/issues/${report.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  }
}

export function renderComment(report: ContributorReport, marker: string): string {
  const facts = report.facts!;
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

export async function writeSummary(report: ContributorReport): Promise<void> {
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
