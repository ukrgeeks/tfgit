const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

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
  const pullRequestNumber = readPullRequestNumber();
  const command = readCommentCommand();

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
        pull_request_number: pullRequestNumber,
        command,
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
    const reason = validation.detail || validation.message;
    fail(reason
      ? `tfgit validation failed (HTTP ${validationResponse.status}): ${reason}`
      : `tfgit validation failed (HTTP ${validationResponse.status}).`);
  }
  console.log('tfgit secret validated.');

  const prNumber = validation.pr_number || validation.pull_request_number;
  const requestedCommand = validation.command || '';
  const commandArgs = validation.command_args;
  if (Boolean(command) !== Boolean(requestedCommand)) {
    fail('tfgit response command does not match the dispatched workflow input.');
  }
  if (!prNumber) {
    fail('tfgit response must include pr_number.');
  }
  if (!workflowToken) {
    fail('Set GITHUB_TOKEN in the Run tfgit step environment and grant contents: read and pull-requests: write to the workflow token.');
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

  if (validation.unknown_command === true) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(prNumber)}/comments`,
      {
        method: 'POST',
        headers: { ...apiHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          body: [
            '### tfgit playbook output',
            '',
            'Unknown command. Start a PR comment with `terraform` followed by a Terraform command and its options.',
          ].join('\n'),
        }),
      },
    );
    if (!response.ok) {
      fail(`Could not post the unknown-command reply to pull request ${prNumber} (HTTP ${response.status}). Check that the workflow token has pull-requests: write permission.`);
    }
    console.log(`Posted an unknown-command reply to pull request ${prNumber}.`);
    return;
  }

  const playbook = validation.playbook;
  if (requestedCommand && (!Array.isArray(commandArgs) || commandArgs.length === 0
    || !commandArgs.every((arg) => typeof arg === 'string'))) {
    fail('tfgit response must include valid parsed Terraform command arguments.');
  }
  if (!Array.isArray(playbook) || playbook.length === 0 || !playbook.every((command) => typeof command === 'string' && command.trim())) {
    fail('tfgit response playbook must be a non-empty array of command strings.');
  }

  console.log(`Running the playbook in the checked-out pull request ${prNumber} head.`);

  if (requestedCommand && playbook[playbook.length - 1] !== requestedCommand) {
    fail('tfgit response playbook must end with the requested Terraform command.');
  }
  const steps = runPlaybook(playbook, workspace, requestedCommand, commandArgs);
  const playbookOutput = formatPlaybookOutput(steps).replaceAll(secret, '[REDACTED]');
  const runUrl = `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const runStatus = steps.some((step) => step.status !== 'success') ? 'failure' : 'success';
  try {
    const reportResponse = await fetch(new URL('/api/v1/github-actions/report', serviceUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        secret,
        repository: repoFullName,
        pull_request_number: Number(prNumber),
        run_id: process.env.GITHUB_RUN_ID || '',
        run_attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
        status: runStatus,
        output: playbookOutput.slice(0, 60000),
        run_url: runUrl,
      }),
    });
    if (!reportResponse.ok) console.error(`::warning::Could not save the Terraform run output in the tfgit dashboard (HTTP ${reportResponse.status}).`);
  } catch (error) {
    console.error(`::warning::Could not reach the tfgit dashboard to save run output: ${error.message}`);
  }
  const commentBody = [
    '### tfgit playbook output',
    ...(requestedCommand ? [`Command: \`${requestedCommand}\``, ''] : []),
    `Run: ${runUrl}`,
    '',
    '````text',
    playbookOutput.slice(0, 60000),
    '````',
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
  if (steps.some((step) => step.status !== 'success')) {
    fail('One or more tfgit playbook commands failed. See the pull request comment for output.');
  }
}

function readPullRequestNumber() {
  const event = readEventPayload();
  const value = event.pull_request?.number
    ?? event.issue?.number
    ?? event.client_payload?.pull_request_number
    ?? event.inputs?.pull_request_number
    ?? event.pull_request_number;
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    fail('The GitHub event must include a pull request number (pull_request_number for workflow_dispatch/repository_dispatch).');
  }
  return Number(value);
}

function readCommentCommand() {
  const event = readEventPayload();
  const value = event.inputs?.tfgit_playbook
    ?? event.client_payload?.tfgit_playbook
    ?? event.inputs?.command
    ?? event.client_payload?.command
    ?? '';
  const command = String(value).trim();
  if (/[\r\n]/.test(command)) {
    fail('Terraform commands from PR comments must fit on one line.');
  }
  return command;
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) fail('GITHUB_EVENT_PATH is unavailable; run tfgit from a pull request workflow event.');
  try {
    return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  } catch {
    fail('Could not read the GitHub event payload.');
  }
}

function runPlaybook(commands, workspace, commentCommand = '', commandArgs = []) {
  const results = [];
  for (const [index, command] of commands.entries()) {
    console.log(`Running tfgit playbook step ${index + 1}/${commands.length}: ${command}`);
    const result = command === commentCommand
      ? spawnSync('terraform', commandArgs, {
        cwd: workspace,
        env: process.env,
        shell: false,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      })
      : spawnSync(command, {
        cwd: workspace,
        env: process.env,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
      });
    const output = [result.stdout, result.stderr, result.error?.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    const status = !result.error && result.status === 0 ? 'success' : 'failure';
    results.push({ command, status, output: output || '(no output)' });
    if (status === 'failure') break;
  }
  return results;
}

function formatPlaybookOutput(steps) {
  return steps.map((step, index) => [
    `Step ${index + 1}: ${step.command} — ${step.status}`,
    step.output,
  ].join('\n')).join('\n\n');
}

main().catch((error) => fail(error.message));
