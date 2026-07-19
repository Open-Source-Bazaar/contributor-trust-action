import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeContributor,
  mergeAiReview,
  shouldBlockContributor,
  shouldRetainReviewLabel,
} from '../src/analyze.mjs';

const establishedProfile = {
  login: 'example',
  type: 'User',
  created_at: '2020-01-01T00:00:00Z',
  public_repos: 12,
  followers: 8,
  following: 4,
  name: 'Example User',
};

test('keeps an established contributor low risk', () => {
  const report = analyzeContributor({
    profile: establishedProfile,
    events: [{ type: 'PushEvent' }],
    authoredPullRequests: 20,
    authoredIssues: 3,
    content: 'A detailed explanation of the implementation and tests.',
    now: new Date('2026-07-15T00:00:00Z'),
  });
  assert.equal(report.level, 'low');
  assert.equal(report.score, 0);
});

test('flags a bot account as high risk', () => {
  const report = analyzeContributor({
    profile: { ...establishedProfile, login: 'agent[bot]', type: 'Bot' },
    now: new Date('2026-07-15T00:00:00Z'),
  });
  assert.equal(report.level, 'high');
  assert.equal(report.score, 100);
});

test('combines several sparse-account signals without treating one as proof', () => {
  const report = analyzeContributor({
    profile: {
      login: 'new-user',
      type: 'User',
      created_at: '2026-07-14T00:00:00Z',
      public_repos: 0,
      followers: 0,
    },
    content: 'claim',
    now: new Date('2026-07-15T00:00:00Z'),
  });
  assert.equal(report.level, 'high');
  assert.ok(report.reasons.length >= 5);
});

test('repository members bypass scoring', () => {
  const report = analyzeContributor({
    profile: { login: 'member', type: 'User', created_at: '2026-07-15T00:00:00Z' },
    association: 'MEMBER',
    now: new Date('2026-07-15T00:00:00Z'),
  });
  assert.equal(report.trusted, true);
  assert.equal(report.score, 0);
});

test('AI only changes the score when confidence is strong', () => {
  const base = { score: 40, level: 'medium', reasons: [], facts: {} };
  assert.equal(
    mergeAiReview(base, { classification: 'likely-automated', confidence: 0.5 }).score,
    40,
  );
  assert.equal(
    mergeAiReview(base, { classification: 'likely-automated', confidence: 0.9 }).score,
    60,
  );
});

test('blocks only high-confidence automated user accounts', () => {
  assert.equal(
    shouldBlockContributor({
      profile: { login: 'agent[bot]', type: 'Bot' },
      report: { level: 'high', trusted: false },
    }),
    false,
  );
  assert.equal(
    shouldBlockContributor({
      profile: { login: 'sparse-user', type: 'User' },
      report: { level: 'high', trusted: false, aiReview: { classification: 'inconclusive', confidence: 0.95 } },
    }),
    false,
  );
  assert.equal(
    shouldBlockContributor({
      profile: { login: 'automated-user', type: 'User' },
      report: { level: 'high', trusted: false, aiReview: { classification: 'likely-automated', confidence: 0.9 } },
    }),
    true,
  );
});

test('keeps review label while another contributor still needs review', () => {
  const comments = [
    {
      body: '<!-- contributor-trust:risky-user -->\n**@risky-user: HIGH (80/100)**',
    },
    {
      body: '<!-- contributor-trust:current-user -->\n**@current-user: HIGH (70/100)**',
    },
  ];

  assert.equal(
    shouldRetainReviewLabel({ author: 'current-user', level: 'low' }, comments),
    true,
  );
});

test('clears review label when only the current contributor is now low risk', () => {
  const comments = [
    {
      body: '<!-- contributor-trust:current-user -->\n**@current-user: HIGH (70/100)**',
    },
  ];

  assert.equal(
    shouldRetainReviewLabel({ author: 'current-user', level: 'low' }, comments),
    false,
  );
});
