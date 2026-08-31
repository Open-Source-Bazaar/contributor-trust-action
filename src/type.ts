import type { components } from '@octokit/openapi-types';

export type ContributorFacts = Record<
  | 'accountAgeDays'
  | 'publicRepositories'
  | 'followers'
  | 'following'
  | 'recentPublicEvents'
  | 'authoredPullRequests'
  | 'authoredIssues'
  | 'organizationPullRequests',
  number
>;

export interface GitHubProfile {
  login: string;
  type: string;
  created_at: string;
  public_repos?: number;
  followers?: number;
  following?: number;
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
}

export interface AiReview {
  classification: 'likely-human' | 'inconclusive' | 'likely-automated';
  confidence: number;
  reasons: string[];
  recommendation: string;
}

export interface ContributorReport {
  score: number;
  level: 'low' | 'medium' | 'high';
  trusted: boolean;
  reasons: string[];
  facts: ContributorFacts;
  author?: string;
  subject?: string;
  number?: number;
  blocked?: boolean;
  aiReview?: AiReview;
  aiError?: string;
}

export interface FinalContributorReport extends ContributorReport {
  author: string;
  subject: string;
  number: number;
  blocked: boolean;
}

export interface AnalyzeContributorOptions {
  profile: GitHubProfile;
  events?: unknown[];
  authoredPullRequests?: number;
  authoredIssues?: number;
  organizationPullRequests?: number;
  association?: string;
  content?: string;
  now?: Date;
}

export interface ContributorTarget {
  kind: string;
  number: number;
  login: string;
  association: string;
  content: string;
}

export type PullRequestPayload = {
  pull_request: Pick<
    components['schemas']['pull-request'],
    'number' | 'title' | 'body' | 'author_association'
  > & { user: Pick<components['schemas']['simple-user'], 'login'> };
};

export type IssueCommentPayload = {
  comment: Pick<components['schemas']['issue-comment'], 'body' | 'author_association'> & {
    user: Pick<components['schemas']['simple-user'], 'login'>;
  };
  issue: Pick<NonNullable<components['schemas']['nullable-issue']>, 'number'>;
};

export type IssuePayload = {
  issue: Pick<
    NonNullable<components['schemas']['nullable-issue']>,
    'number' | 'title' | 'body' | 'author_association'
  > & { user: Pick<components['schemas']['simple-user'], 'login'> };
};

export type WebhookEventPayload = PullRequestPayload | IssueCommentPayload | IssuePayload;
