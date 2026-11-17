function state(name) {
  return process.env[`STATE_${name}`] || '';
}

async function main() {
  if (state('TFGIT_REPORTED') === 'true') return;

  const secret = state('TFGIT_SECRET');
  const serviceUrl = state('TFGIT_URL');
  const repository = state('TFGIT_REPOSITORY');
  const pullRequestNumber = Number(state('TFGIT_PR_NUMBER'));
  const runId = state('TFGIT_RUN_ID');
  const runAttempt = state('TFGIT_RUN_ATTEMPT') || '1';
  if (!secret || !serviceUrl || !repository || !Number.isSafeInteger(pullRequestNumber) || !runId) {
    console.warn('::warning::TFgit could not report workflow completion because required Action context was unavailable.');
    return;
  }

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const response = await fetch(new URL('/api/v1/github-actions/report', serviceUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      secret,
      repository,
      pull_request_number: pullRequestNumber,
      run_id: runId,
      run_attempt: runAttempt,
      status: 'failure',
      plan_ready: null,
      apply_success: null,
      output: 'GitHub Actions ended before TFgit reported this run. TFgit released the PR lock so queued work can continue.',
      run_url: `${serverUrl}/${repository}/actions/runs/${runId}`,
    }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail || ''; } catch {}
    console.warn(`::warning::TFgit could not release the PR lock after workflow failure (HTTP ${response.status})${detail ? `: ${detail}` : ''}.`);
    return;
  }
  console.log('[TFgit] Workflow ended before completion was reported; sent a failure report to release its PR lock.');
}

main().catch((error) => {
  console.warn(`::warning::TFgit post-run lock cleanup failed: ${error.message}`);
});
