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
  const playbook = process.env.INPUT_PLAYBOOK;
  const serviceUrl = process.env.INPUT_SERVICE_URL || 'https://tfgit.ukrgeeks.com';
  const validationPath = process.env.INPUT_VALIDATION_PATH || '/api/v1/github-actions/validate';
  const workspace = process.env.GITHUB_WORKSPACE;
  const token = process.env.INPUT_GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!secret) fail('Input tfgit_secret is required.');
  if (!playbook) fail('Input playbook is required.');
  if (!workspace || !eventPath) {
    fail('GITHUB_WORKSPACE and GITHUB_EVENT_PATH must be available.');
  }

  let event;
  try {
    event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch (error) {
    fail(`Could not read GitHub event payload: ${error.message}`);
  }
  const prNumber = validation.pr_number || validation.pull_request_number ||
    process.env.INPUT_PR_NUMBER ||
    event.pull_request?.number ||
    event.inputs?.pr_number || event.inputs?.pull_request_number ||
    event.client_payload?.pr_number || event.client_payload?.pull_request_number ||
    event.issue?.number;
  const repoFullName = process.env.GITHUB_REPOSITORY;
  if (!prNumber || !repoFullName) {
    fail('tfgit did not return pr_number (or pull_request_number), and no PR number was provided by the workflow event or action input.');
  }

  const endpoint = new URL(validationPath, serviceUrl);
  let validationResponse;
  try {
    validationResponse = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ secret, playbook }),
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
    fail(validation.message || `tfgit rejected the secret or playbook (HTTP ${validationResponse.status}).`);
  }
  console.log('tfgit secret validated.');

  const [owner, repo] = repoFullName.split('/');
  const apiHeaders = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'tfgit-github-action',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let pr;
  try {
    const prResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prNumber)}`, { headers: apiHeaders });
    if (!prResponse.ok) fail(`Could not retrieve pull request ${prNumber} (HTTP ${prResponse.status}).`);
    pr = await prResponse.json();
  } catch (error) {
    fail(`Could not retrieve pull request ${prNumber}: ${error.message}`);
  }
  if (!pr.head?.sha || !pr.head.repo?.full_name) {
    fail(`Pull request ${prNumber} has no accessible head repository.`);
  }

  const [headOwner, headRepo] = pr.head.repo.full_name.split('/');
  const sha = pr.head.sha;
  const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(headOwner)}/${encodeURIComponent(headRepo)}/tarball/${encodeURIComponent(sha)}`;
  let archiveResponse;
  try {
    archiveResponse = await fetch(archiveUrl, { headers: apiHeaders, redirect: 'follow' });
  } catch (error) {
    fail(`Could not download pull request content: ${error.message}`);
  }
  if (!archiveResponse.ok) {
    fail(`GitHub archive download failed (HTTP ${archiveResponse.status}). Ensure the workflow token can read the PR head repository.`);
  }

  const archivePath = path.join(os.tmpdir(), `tfgit-pr-${process.pid}.tar.gz`);
  try {
    fs.writeFileSync(archivePath, Buffer.from(await archiveResponse.arrayBuffer()));
    execFileSync('tar', ['-xzf', archivePath, '--strip-components=1', '-C', workspace], { stdio: 'inherit' });
    console.log(`Downloaded pull request ${prNumber} head ${sha} into ${workspace}.`);
  } catch (error) {
    fail(`Could not extract pull request content: ${error.message}`);
  } finally {
    try { fs.unlinkSync(archivePath); } catch {}
  }
}

main().catch((error) => fail(error.message));
