import { readFile } from 'node:fs/promises';

import { analyzeContributor, FinalContributorReport, mergeAiReview } from './analyze.ts';
import {
  blockContributorIfConfigured,
  github,
  input,
  output,
  resolveTarget,
  reviewWithGitHubModels,
  syncRepositoryState,
  writeSummary,
} from './utility.ts';

const token = input('github-token');
const blockHighConfidenceAutomation = input('block-high-confidence-automation') === 'true';
const useAi = input('ai-review', 'true') === 'true';
const model = input('model', 'openai/gpt-4.1');
const shouldComment = input('comment', 'true') === 'true';
const failOnHighRisk = input('fail-on-high-risk') === 'true';
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!token || !owner || !repo || !eventPath) {
  throw new Error('github-token, GITHUB_REPOSITORY and GITHUB_EVENT_PATH are required');
}

const payload = JSON.parse(await readFile(eventPath, 'utf8')) as Record<string, unknown>;
const target = resolveTarget(payload);
const encodedLogin = encodeURIComponent(target.login);

const [profile, events, pullSearch, issueSearch, organizationSearch] = (await Promise.all([
  github(token, `/users/${encodedLogin}`),
  github(token, `/users/${encodedLogin}/events/public?${new URLSearchParams({ per_page: '100' })}`),
  github(token, `/search/issues?${new URLSearchParams({ q: `type:pr author:${target.login}`, per_page: '1' })}`),
  github(token, `/search/issues?${new URLSearchParams({ q: `type:issue author:${target.login}`, per_page: '1' })}`),
  github(token, `/search/issues?${new URLSearchParams({ q: `type:pr org:${owner} author:${target.login}`, per_page: '1' })}`),
])) as [Record<string, unknown>, unknown[], { total_count: number }, { total_count: number }, { total_count: number }];

let report = analyzeContributor({
  profile: profile as Parameters<typeof analyzeContributor>[0]['profile'],
  events,
  authoredPullRequests: pullSearch.total_count,
  authoredIssues: issueSearch.total_count,
  organizationPullRequests: organizationSearch.total_count,
  association: target.association,
  content: target.content,
});

let aiError = '';

if (useAi && !report.trusted && profile.type !== 'Bot')
  try {
    report = mergeAiReview(
      report,
      await reviewWithGitHubModels({
        token,
        profile: profile as Parameters<typeof reviewWithGitHubModels>[0]['profile'],
        report,
        target,
        model,
      }),
    );
  } catch (error) {
    aiError = (error as Error).message;
    console.log(`GitHub Models review unavailable: ${aiError}`);
  }

const blocked = await blockContributorIfConfigured({
  token,
  owner,
  profile: profile as Parameters<typeof blockContributorIfConfigured>[0]['profile'],
  report,
  target,
  blockHighConfidenceAutomation,
});
const finalReport: FinalContributorReport = {
  author: target.login,
  subject: target.kind,
  number: target.number,
  ...report,
  blocked,
  aiError: aiError || undefined,
};

if (shouldComment) await syncRepositoryState(token, owner, repo, finalReport);
await writeSummary(finalReport);
await output('author', target.login);
await output('risk-level', report.level);
await output('risk-score', String(report.score));
await output('report-json', JSON.stringify(finalReport));
await output('blocked', String(blocked));

if (failOnHighRisk && report.level === 'high')
  throw new Error(`Contributor detection for @${target.login} is high risk (${report.score}/100).`);
