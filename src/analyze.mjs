const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function accountAgeDays(createdAt, now) {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) ? Math.max(0, Math.floor((now.getTime() - created) / 86_400_000)) : 0;
}

export function analyzeContributor({
  profile,
  events = [],
  authoredPullRequests = 0,
  authoredIssues = 0,
  organizationPullRequests = 0,
  association = 'NONE',
  content = '',
  now = new Date(),
}) {
  if (trustedAssociations.has(association)) {
    return {
      score: 0,
      level: 'low',
      trusted: true,
      reasons: [`Repository association is ${association}.`],
      facts: buildFacts(profile, events, authoredPullRequests, authoredIssues, organizationPullRequests, now),
    };
  }

  const reasons = [];
  let score = 0;
  const ageDays = accountAgeDays(profile.created_at, now);
  const isBot = profile.type === 'Bot' || /\[bot\]$/i.test(profile.login ?? '');

  if (isBot) {
    score = 100;
    reasons.push('GitHub identifies the account as a bot.');
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

    if (profile.public_repos === 0) {
      score += 15;
      reasons.push('Account has no public repositories.');
    } else if (profile.public_repos <= 2) {
      score += 7;
      reasons.push(`Account has ${profile.public_repos} public repositories.`);
    }

    const profileFields = [profile.name, profile.bio, profile.company, profile.blog, profile.location];
    if (profileFields.every(value => !String(value ?? '').trim())) {
      score += 10;
      reasons.push('Public profile has no identifying or project context.');
    }

    if ((profile.followers ?? 0) === 0) {
      score += 4;
      reasons.push('Account has no followers.');
    }
    if (events.length === 0) {
      score += 12;
      reasons.push('No recent public activity is visible through the GitHub API.');
    }
    if (authoredPullRequests === 0) {
      score += 10;
      reasons.push('No public pull requests were found.');
    }
    if (organizationPullRequests > 0) {
      score -= Math.min(15, 5 + organizationPullRequests * 2);
      reasons.push(`Found ${organizationPullRequests} earlier pull request(s) in this organization.`);
    }
    if (content.trim().length < 20) {
      score += 5;
      reasons.push('Current contribution contains very little context.');
    }
  }

  score = clamp(score, 0, 100);
  return {
    score,
    level: score >= 55 ? 'high' : score >= 30 ? 'medium' : 'low',
    trusted: false,
    reasons,
    facts: buildFacts(profile, events, authoredPullRequests, authoredIssues, organizationPullRequests, now),
  };
}

export function mergeAiReview(report, aiReview) {
  if (!aiReview) return report;

  let score = report.score;
  if (aiReview.classification === 'likely-automated' && aiReview.confidence >= 0.75) score += 20;
  if (aiReview.classification === 'likely-human' && aiReview.confidence >= 0.75) score -= 10;
  score = clamp(score, 0, 100);

  return {
    ...report,
    score,
    level: score >= 55 ? 'high' : score >= 30 ? 'medium' : 'low',
    aiReview,
  };
}

function buildFacts(profile, events, authoredPullRequests, authoredIssues, organizationPullRequests, now) {
  return {
    accountAgeDays: accountAgeDays(profile.created_at, now),
    publicRepositories: profile.public_repos ?? 0,
    followers: profile.followers ?? 0,
    following: profile.following ?? 0,
    recentPublicEvents: events.length,
    authoredPullRequests,
    authoredIssues,
    organizationPullRequests,
  };
}
