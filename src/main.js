const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main() {
  const secret = process.env.INPUT_TFGIT_SECRET;
  const serviceUrl = process.env.INPUT_SERVICE_URL || 'https://tfgit.ukrgeeks.com';
  const validationPath = process.env.INPUT_VALIDATION_PATH || '/api/v1/github-actions/validate';
  const workspace = process.env.GITHUB_WORKSPACE;
  const repoFullName = process.env.GITHUB_REPOSITORY;
  const workflowToken = process.env.GITHUB_TOKEN;

  if (!secret) fail('Input tfgit_secret is required.');
  if (!workspace || !repoFullName) {
    fail('GITHUB_WORKSPACE and GITHUB_REPOSITORY must be available.');
  }

  const endpoint = new URL(validationPath, serviceUrl);
  let validationResponse;
  try {
    validationResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        secret,
        repository: repoFullName,
        run_id: process.env.GITHUB_RUN_ID,
        run_attempt: process.env.GITHUB_RUN_ATTEMPT,
      }),
    });
  } catch (error) {
    fail(`Could not connect to tfgit service: ${error.message}`);
  }

  let validation;
  try {
    validation = await validationResponse.json();
  } catch {
    fail(`tfgit returned a non-JSON response (HTTP ${validationResponse.status}).`);
  }
  if (!validationResponse.ok || validation.valid !== true) {
    fail(validation.message || `tfgit rejected the secret (HTTP ${validationResponse.status}).`);
  }
  console.log('tfgit secret validated.');

  const playbook = validation.playbook;
  const prNumber = validation.pr_number || validation.pull_request_number;
  if (!playbook || !prNumber) {
    fail('tfgit response must include playbook and pr_number.');
  }
  if (!workflowToken) {
    fail('Set GITHUB_TOKEN in the Run tfgit step environment and grant contents: read and pull-requests: write to the workflow token.');
  }
  if (validation.playbook_output === undefined) {
    fail('tfgit response must include playbook_output with the completed playbook step output.');
  }
  if (!/^\d+$/.test(String(prNumber))) {
    fail('tfgit response pr_number must be a positive integer.');
  }

  const [owner, repo] = repoFullName.split('/');
  const apiHeaders = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${workflowToken}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'tfgit-github-action',
  };

  // The PR head ref is exposed through the base repository, so the workflow's
  // contents:read token can download it without needing access to a fork repo.
  const prHeadRef = encodeURIComponent(`pull/${prNumber}/head`);
  const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${prHeadRef}`;
  let archiveResponse;
  try {
    archiveResponse = await fetch(archiveUrl, { headers: apiHeaders, redirect: 'follow' });
  } catch (error) {
    fail(`Could not download pull request content: ${error.message}`);
  }
  if (!archiveResponse.ok) {
    fail(`GitHub archive download failed (HTTP ${archiveResponse.status}). Check the workflow token has contents: read permission.`);
  }

  const archivePath = path.join(os.tmpdir(), `tfgit-pr-${process.pid}.tar.gz`);
  try {
    fs.writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
    execFileSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', workspace], { stdio: 'inherit' });
    console.log(`Downloaded pull request ${prNumber} head into ${workspace}.`);
  } catch (error) {
    fail(`Could not extract pull request content: ${error.message}`);
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
  }

  const playbookOutput = formatPlaybookOutput(validation.playbook_output);
  const runUrl = `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const commentBody = [
    `### tfgit playbook: ${playbook}`,
    `Run: ${runUrl}`,
    '',
    '```text',
    playbookOutput.slice(0, 60000),
    '```',
    ...(playbookOutput.length > 60000 ? ['', '_Output truncated to fit in a GitHub comment._'] : []),
  ].join('\n');
  const commentResponse = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(prNumber)}/comments`,
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${workflowToken}`,
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'tfgit-github-action',
      },
      body: JSON.stringify({ body: commentBody }),
    },
  );
  if (!commentResponse.ok) {
    fail(`Could not comment on pull request ${prNumber} (HTTP ${commentResponse.status}). Check that the workflow token has pull-requests: write permission.`);
  }
  console.log(`Posted playbook output to pull request ${prNumber}.`);
}

function formatPlaybookOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((step, index) => {
      if (typeof step === 'string') return `Step ${index + 1}\n${step}`;
      const name = step.name || step.step || `Step ${index + 1}`;
      const status = step.conclusion || step.status;
      const detail = step.output ?? step.logs ?? step.message ?? '';
      return `${name}${status ? ` (${status})` : ''}\n${detail}`;
    }).join('\n\n');
  }
  return JSON.stringify(output, null, 2);
}

main().catch((error) => fail(error.message));
