const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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
    const body = [
      '### tfgit playbook output',
      '',
      '<details>',
      '<summary>Expand to view reply</summary>',
      '',
      'Unknown command. Start a PR comment with `terraform` followed by a Terraform command and its options.',
      '',
      '</details>',
    ].join('\n');
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(prNumber)}/comments`,
      {
        method: 'POST',
        headers: { ...apiHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      fail(`Could not post the unknown-command reply to pull request ${prNumber} (HTTP ${response.status}). Check that the workflow token has pull-requests: write permission.`);
    }
    console.log(`Posted an unknown-command reply to pull request ${prNumber}.`);
    return;
  }

  const playbook = validation.playbook;
  const prePlaybook = validation.pre_playbook ?? ['terraform init'];
  const postPlaybook = validation.post_playbook ?? [];
  if (!Array.isArray(prePlaybook) || !prePlaybook.every((item) => typeof item === 'string' && item.trim())
    || !Array.isArray(postPlaybook) || !postPlaybook.every((item) => typeof item === 'string' && item.trim())) {
    fail('tfgit response pre_playbook and post_playbook must be arrays of non-empty command strings.');
  }
  if (requestedCommand && (!Array.isArray(commandArgs) || commandArgs.length === 0
    || !commandArgs.every((arg) => typeof arg === 'string'))) {
    fail('tfgit response must include valid parsed Terraform command arguments.');
  }
  if (!Array.isArray(playbook) || playbook.length === 0 || !playbook.every((command) => typeof command === 'string' && command.trim())) {
    fail('tfgit response playbook must be a non-empty array of command strings.');
  }
  if (typeof validation.terraform_backend !== 'string' || validation.terraform_backend.length > 20000) {
    fail('tfgit response terraform_backend must be a string of at most 20,000 characters.');
  }
  const backendEnabled = validation.terraform_backend_enabled === true;
  if (validation.terraform_backend_enabled !== undefined && typeof validation.terraform_backend_enabled !== 'boolean') {
    fail('tfgit response terraform_backend_enabled must be a boolean.');
  }

  console.log(`Running the playbook in the checked-out pull request ${prNumber} head.`);

  const pullRequest = await getPullRequestDetails(owner, repo, prNumber, apiHeaders);
  const pullRequestEnvironment = {
    GITHUB_PR_NUMBER: String(pullRequest.number),
    GITHUB_PR_BASE_BRANCH: pullRequest.base.ref,
    GITHUB_PR_HEAD_BRANCH: pullRequest.head.ref,
    GITHUB_PR_TITLE: pullRequest.title || '',
    GITHUB_PR_URL: pullRequest.html_url || '',
    GITHUB_PR_STATE: pullRequest.state || '',
    GITHUB_PR_AUTHOR: pullRequest.user?.login || '',
    GITHUB_PR_BASE_REPOSITORY: pullRequest.base.repo?.full_name || '',
    GITHUB_PR_HEAD_REPOSITORY: pullRequest.head.repo?.full_name || '',
    GITHUB_PR_BASE_SHA: pullRequest.base.sha || '',
    GITHUB_PR_HEAD_SHA: pullRequest.head.sha || '',
    GITHUB_PR_IS_DRAFT: String(Boolean(pullRequest.draft)),
  };
  for (const [name, value] of Object.entries(pullRequestEnvironment)) {
    process.env[name] = String(value).replaceAll('\0', '');
  }
  console.log(`Loaded pull request metadata for PR #${pullRequestEnvironment.GITHUB_PR_NUMBER}.`);

  if (backendEnabled) {
    const baseBranch = pullRequestEnvironment.GITHUB_PR_BASE_BRANCH;
    const hclString = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const backendConfig = validation.terraform_backend
      .replaceAll('${path.module}', hclString(workspace))
      .replaceAll('${BASE_REPO_NAME}', hclString(repo))
      .replaceAll('${BASE_BRANCH_NAME}', hclString(baseBranch))
      .replaceAll('${AWS_DEFAULT_REGION}', hclString(process.env.AWS_DEFAULT_REGION || ''));
    const backendFile = path.join(workspace, 'backend.tf');
    try {
      if (fs.lstatSync(backendFile).isSymbolicLink()) {
        fail('Refusing to overwrite backend.tf because it is a symbolic link.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.writeFileSync(backendFile, backendConfig, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(backendFile, 0o600);
    console.log('Wrote Terraform backend configuration to backend.tf.');
  } else {
    console.log('Terraform backend injection is disabled; leaving backend.tf unchanged.');
  }

  const mainPlaybook = requestedCommand ? [requestedCommand] : playbook;
  const commentCommandIndex = requestedCommand ? 0 : -1;
  const steps = runPlaybook(prePlaybook, mainPlaybook, postPlaybook, workspace,
    requestedCommand, commandArgs, commentCommandIndex);
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
  const commentSummaries = summarizeTerraformResults(steps);
  const commentBodies = buildOutputComments(playbookOutput, runUrl, requestedCommand,
    commentSummaries.lines, commentSummaries.errorLabel);
  for (const [index, body] of commentBodies.entries()) {
    const commentResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(prNumber)}/comments`,
      {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify({ body }),
      },
    );
    if (!commentResponse.ok) {
      fail(`Could not post output comment ${index + 1}/${commentBodies.length} to pull request ${prNumber} (HTTP ${commentResponse.status}). Check that the workflow token has pull-requests: write permission.`);
    }
  }
  console.log(`Posted playbook output in ${commentBodies.length} collapsed comment${commentBodies.length === 1 ? '' : 's'} to pull request ${prNumber}.`);
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

async function getPullRequestDetails(owner, repo, prNumber, headers) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(prNumber)}`,
    { headers },
  );
  if (!response.ok) {
    fail(`Could not read pull request details (HTTP ${response.status}). Check pull-requests: read permission.`);
  }
  const pullRequest = await response.json();
  if (typeof pullRequest.base?.ref !== 'string' || !pullRequest.base.ref) {
    fail('GitHub did not return the pull request target branch.');
  }
  if (typeof pullRequest.head?.ref !== 'string' || !pullRequest.head.ref) {
    fail('GitHub did not return the pull request source branch.');
  }
  return pullRequest;
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

function runPlaybook(prePlaybook, playbook, postPlaybook, workspace, commentCommand = '', commandArgs = [], commentCommandIndex = -1) {
  const results = [];
  const runStage = (commands, stage) => {
    if (commands.length === 0) {
      console.log(`Running tfgit ${stage} step 1/1: list is empty`);
      return true;
    }
    for (const [index, command] of commands.entries()) {
      const stageLabel = stage === 'playbook' ? 'playbook step' : `${stage} steps`;
      console.log(`Running tfgit ${stageLabel} ${index + 1}/${commands.length}: ${command}`);
      const result = stage === 'playbook' && index === commentCommandIndex && command === commentCommand
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
      const output = stripTerminalSequences([result.stdout, result.stderr, result.error?.message]
        .filter(Boolean)
        .join('\n')
        .trim());
      const status = !result.error && result.status === 0 ? 'success' : 'failure';
      results.push({ command, status, output: output || '(no output)' });
      if (status === 'failure') return false;
    }
    return true;
  };

  if (runStage(prePlaybook, 'pre-playbook')) {
    if (runStage(playbook, 'playbook')) {
      runStage(postPlaybook, 'post-playbook');
    }
  }
  return results;
}

function formatPlaybookOutput(steps) {
  return steps.map((step, index) => [
    `Step ${index + 1}: ${step.command} — ${step.status}`,
    step.output,
  ].join('\n')).join('\n\n');
}

function stripTerminalSequences(value) {
  return value
    // ANSI CSI styling/cursor sequences and OSC terminal metadata sequences.
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    // Some log collectors render the ESC byte as U+FFFD; remove the same visible artifacts.
    .replace(/\uFFFD\[[0-?]*[ -/]*[@-~]/g, '')
    // Remove remaining terminal control characters while preserving tabs and newlines.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

function buildOutputComments(output, runUrl, command = '', summaries = [], errorLabel = '') {
  // Keep substantial headroom below GitHub's per-comment body limit for Markdown wrappers.
  const chunkSize = 48000;
  const chunks = [];
  for (let offset = 0; offset < output.length;) {
    let end = Math.min(offset + chunkSize, output.length);
    // Do not split a UTF-16 surrogate pair between comments.
    if (end < output.length && /[\uD800-\uDBFF]/.test(output[end - 1])) end -= 1;
    chunks.push(output.slice(offset, end));
    offset = end;
  }
  if (chunks.length === 0) chunks.push('(no output)');
  return chunks.map((chunk, index) => [
    `### tfgit playbook output${chunks.length > 1 ? ` — part ${index + 1}/${chunks.length}` : ''}`,
    '',
    ...(errorLabel ? [`**${errorLabel}**`, ''] : []),
    ...(index === chunks.length - 1 && summaries.length ? [summaries.map((line) => `> ${line}`).join('\n'), ''] : []),
    '<details>',
    `<summary>Show Output${chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : ''}</summary>`,
    '',
    ...(command ? [`Command: \`${command}\``, ''] : []),
    `Run: ${runUrl}`,
    '',
    '````text',
    chunk,
    '````',
    '',
    '</details>',
  ].join('\n'));
}

function summarizeTerraformResults(steps) {
  const summaries = [];
  const failedPlan = steps.find((step) => step.status !== 'success' && /^\s*terraform\s+plan(?:\s|$)/i.test(step.command));
  const failedApply = steps.find((step) => step.status !== 'success' && /^\s*terraform\s+apply(?:\s|$)/i.test(step.command));
  const errorLabel = failedPlan ? 'Plan Error' : failedApply ? 'Apply Error' : '';
  const planWasRun = !failedPlan && steps.some((step) => /^\s*terraform\s+plan(?:\s|$)/i.test(step.command));
  if (planWasRun) {
    const planSummary = steps.map((step) => step.output.match(/^Plan: \d+ to add, \d+ to change, \d+ to destroy\.$/m)?.[0]).find(Boolean);
    if (planSummary) summaries.push(planSummary);
  }

  const successfulApply = steps.find((step) => step.status === 'success' && /^\s*terraform\s+apply(?:\s|$)/i.test(step.command));
  if (successfulApply) {
    const applySummary = successfulApply.output.match(/^Apply complete! Resources:[^\r\n]*$/m)?.[0];
    if (applySummary) summaries.push(applySummary);
  }
  return { lines: summaries, errorLabel };
}

main().catch((error) => fail(error.message));
