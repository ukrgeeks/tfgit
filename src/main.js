const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');

const MAX_STORAGE_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_TERRAFORM_STATE_BYTES = 100 * 1024 * 1024;
const MAX_TERRAFORM_ARCHIVE_BYTES = 100 * 1024 * 1024;
const ENCRYPTED_ARCHIVE_MAGIC = Buffer.from('TFGITENC1');
const ENCRYPTED_ARCHIVE_HEADER_SIZE = ENCRYPTED_ARCHIVE_MAGIC.length + 16 + 12 + 16;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main() {
  const secret = process.env.TFGIT_SECRET || process.env.INPUT_TFGIT_SECRET;
  const serviceUrl = process.env.TFGIT_URL || process.env.INPUT_SERVICE_URL || 'https://tfgit.ukrgeeks.com';
  const validationPath = process.env.INPUT_VALIDATION_PATH || '/api/v1/github-actions/validate';
  const workspace = process.env.GITHUB_WORKSPACE;
  const repoFullName = process.env.GITHUB_REPOSITORY;
  const workflowToken = process.env.GITHUB_TOKEN;
  const pullRequestNumber = readPullRequestNumber();
  const command = readCommentCommand();

  if (!secret) fail('Set TFGIT_SECRET in the step environment or provide the tfgit_secret input.');
  if (!workspace || !repoFullName) {
    fail('GITHUB_WORKSPACE and GITHUB_REPOSITORY must be available.');
  }

  console.log(`[TFgit] Starting run for ${repoFullName}; GitHub run ${process.env.GITHUB_RUN_ID || 'unknown'}.`);
  console.log(`[TFgit] Validating subscription, repository access, PR #${pullRequestNumber}, and playbook with ${serviceUrl}.`);
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
  console.log('[TFgit] Secret, subscription, and repository access validated.');
  const mode = validation.tfgit_mode || 'terraform';
  if (!['terraform', 'tofu', 'custom'].includes(mode)) {
    fail(`tfgit returned unsupported mode "${mode}". Expected "terraform", "tofu", or "custom".`);
  }
  if (mode === 'custom') {
    console.log('[TFgit] Mode: custom. Skipping Terraform/OpenTofu installation; playbook setup commands control the tools.');
  } else {
    const versionVariable = mode === 'tofu' ? 'TOFU_VERSION' : 'TERRAFORM_VERSION';
    const requestedTerraformVersion = (process.env[versionVariable] || 'latest').trim();
    if (!requestedTerraformVersion) fail(`${versionVariable} must be "latest" or an exact version.`);
    const cliName = mode === 'tofu' ? 'OpenTofu' : 'Terraform';
    console.log(`[TFgit] Mode: ${mode}. Installing ${cliName} ${requestedTerraformVersion}.`);
    const terraformInstallError = await installTerraform(requestedTerraformVersion, mode);
    if (terraformInstallError) fail(`Could not install ${cliName}: ${terraformInstallError}`);
  }

  const prNumber = validation.pr_number || validation.pull_request_number;
  const requestedCommand = validation.command || '';
  const commandArgs = validation.command_args;
  const mappedExecutionCommands = validation.execution_commands ?? [];
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
  const planSummaryEnabled = mode !== 'custom' && validation.terraform_plan_summary_enabled !== false;
  if (validation.terraform_plan_summary_enabled !== undefined && typeof validation.terraform_plan_summary_enabled !== 'boolean') {
    fail('tfgit response terraform_plan_summary_enabled must be a boolean.');
  }
  const playbookName = validation.playbook_name || 'Default';
  const prePlaybook = validation.pre_playbook ?? (mode === 'custom' ? [] : ['terraform init']);
  const postPlaybook = validation.post_playbook ?? [];
  if (!Array.isArray(prePlaybook) || !prePlaybook.every((item) => typeof item === 'string' && item.trim())
    || !Array.isArray(postPlaybook) || !postPlaybook.every((item) => typeof item === 'string' && item.trim())) {
    fail('tfgit response pre_playbook and post_playbook must be arrays of non-empty command strings.');
  }
  if (!Array.isArray(mappedExecutionCommands)
    || !mappedExecutionCommands.every((item) => typeof item === 'string' && item.trim())) {
    fail('tfgit response execution_commands must be an array of non-empty command strings.');
  }
  if (requestedCommand && mappedExecutionCommands.length === 0
    && (!Array.isArray(commandArgs) || commandArgs.length === 0
    || !commandArgs.every((arg) => typeof arg === 'string'))) {
    fail('tfgit response must include valid parsed Terraform command arguments.');
  }
  if (!Array.isArray(playbook) || (playbook.length === 0 && mode !== 'custom') || !playbook.every((command) => typeof command === 'string' && command.trim())) {
    fail(`tfgit response playbook must be ${mode === 'custom' ? 'an array' : 'a non-empty array'} of command strings.`);
  }
  if (typeof playbookName !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(playbookName)) {
    fail('tfgit response playbook_name must contain 1–32 letters or digits.');
  }
  if (typeof validation.terraform_backend !== 'string' || validation.terraform_backend.length > 20000) {
    fail('tfgit response terraform_backend must be a string of at most 20,000 characters.');
  }
  if (typeof validation.tfgit_username !== 'string' || !validation.tfgit_username) {
    fail('tfgit response must include the account username for Terraform state authentication.');
  }
  const backendEnabled = validation.terraform_backend_enabled === true;
  if (validation.terraform_backend_enabled !== undefined && typeof validation.terraform_backend_enabled !== 'boolean') {
    fail('tfgit response terraform_backend_enabled must be a boolean.');
  }
  const stateStorageEnabled = validation.terraform_state_storage_enabled === true;
  if (validation.terraform_state_storage_enabled !== undefined
    && typeof validation.terraform_state_storage_enabled !== 'boolean') {
    fail('tfgit response terraform_state_storage_enabled must be a boolean.');
  }
  if (stateStorageEnabled && (typeof validation.tfstate_key !== 'string' || !validation.tfstate_key
    || typeof validation.tfstate_token !== 'string' || !validation.tfstate_token)) {
    fail('TFgit state storage is enabled, but no scoped state-storage authorization was returned.');
  }
  if (validation.storage_actions !== undefined && (!Array.isArray(validation.storage_actions)
    || validation.storage_actions.length > 2
    || validation.storage_actions.some((item) => !item || !['temporary', 'permanent'].includes(item.type)))) {
    fail('TFgit response contains invalid storage actions.');
  }
  const storageActions = Array.isArray(validation.storage_actions) ? validation.storage_actions : null;
  const temporaryStorage = storageActions?.find((item) => item.type === 'temporary');
  const permanentStorage = storageActions?.find((item) => item.type === 'permanent');
  const workspaceStorageEnabled = storageActions ? Boolean(temporaryStorage) : validation.workspace_storage_enabled === true;
  const workspaceStoragePath = safeStoragePath(temporaryStorage?.path || validation.workspace_storage_path || '.');
  const workspaceStorageCommand = String(temporaryStorage?.store_command ?? validation.workspace_storage_command ?? 'terraform plan').trim();
  const workspaceRestoreComment = String(temporaryStorage?.restore_command ?? validation.workspace_restore_comment ?? '').trim();
  const workspaceStoragePolicy = workspaceStorageCommand ? 'after_command_success' : 'always';
  const workspaceRestorePolicy = workspaceRestoreComment ? 'after_pr_comment' : 'always';
  if (validation.workspace_storage_enabled !== undefined && typeof validation.workspace_storage_enabled !== 'boolean') {
    fail('tfgit response workspace_storage_enabled must be a boolean.');
  }
  if (!['always', 'after_command_success'].includes(workspaceStoragePolicy)
    || (workspaceStorageEnabled && workspaceStoragePolicy === 'after_command_success' && !workspaceStorageCommand)) {
    fail('tfgit response contains invalid workspace storage save settings.');
  }
  if (!['always', 'after_pr_comment'].includes(workspaceRestorePolicy)
    || (workspaceStorageEnabled && workspaceRestorePolicy === 'after_pr_comment' && !workspaceRestoreComment)) {
    fail('tfgit response contains invalid workspace storage restore settings.');
  }

  const pullRequest = await getPullRequestDetails(owner, repo, prNumber, apiHeaders);
  console.log(`[TFgit] Selected playbook: ${playbookName}.`);
  const pullRequestEnvironment = {
    GITHUB_REPO_NAME: repo,
    GITHUB_PR_NUMBER: String(pullRequest.number),
    GITHUB_PR_BASE_BRANCH: pullRequest.base.ref,
    GITHUB_PR_BASE_REPOSITORY: pullRequest.base.repo?.full_name || repoFullName,
    GITHUB_PR_HEAD_BRANCH: pullRequest.head.ref,
    GITHUB_PR_TITLE: pullRequest.title || '',
    GITHUB_PR_URL: pullRequest.html_url || '',
    GITHUB_PR_STATE: pullRequest.state || '',
    GITHUB_PR_AUTHOR: pullRequest.user?.login || '',
    GITHUB_PR_HEAD_REPOSITORY: pullRequest.head.repo?.full_name || '',
    GITHUB_PR_BASE_SHA: pullRequest.base.sha || '',
    GITHUB_PR_HEAD_SHA: pullRequest.head.sha || '',
    GITHUB_PR_IS_DRAFT: String(Boolean(pullRequest.draft)),
  };
  const expandedCommandArgs = requestedCommand && Array.isArray(commandArgs)
    ? commandArgs.map((argument) => argument
      .replaceAll('${GITHUB_PR_BASE_BRANCH}', pullRequestEnvironment.GITHUB_PR_BASE_BRANCH)
      .replaceAll('${GITHUB_REPO_NAME}', pullRequestEnvironment.GITHUB_REPO_NAME))
    : [];
  const expandedExecutionCommands = mappedExecutionCommands.map((command) => command
    .replaceAll('${GITHUB_PR_BASE_BRANCH}', pullRequestEnvironment.GITHUB_PR_BASE_BRANCH)
    .replaceAll('${GITHUB_REPO_NAME}', pullRequestEnvironment.GITHUB_REPO_NAME));
  for (const [name, value] of Object.entries(pullRequestEnvironment)) {
    process.env[name] = String(value).replaceAll('\0', '');
  }
  console.log(`[TFgit] Loaded PR #${pullRequestEnvironment.GITHUB_PR_NUMBER}: ${pullRequestEnvironment.GITHUB_PR_BASE_REPOSITORY} base branch ${pullRequestEnvironment.GITHUB_PR_BASE_BRANCH}, head ${pullRequestEnvironment.GITHUB_PR_HEAD_SHA}.`);

  const expandedCommentCommand = requestedCommand && expandedCommandArgs.length
    ? `terraform ${expandedCommandArgs.map((argument) => /\s/.test(argument) ? JSON.stringify(argument) : argument).join(' ')}`
    : requestedCommand;
  const hasMappedCommand = expandedExecutionCommands.length > 0;
  const mainPlaybook = hasMappedCommand ? expandedExecutionCommands : (requestedCommand ? [expandedCommentCommand] : playbook);
  const commentCommandIndex = requestedCommand && !hasMappedCommand ? 0 : -1;
  const planIsRequested = [...prePlaybook, ...mainPlaybook, ...postPlaybook]
    .some((item) => /^\s*(?:terraform|tofu)\s+plan(?:\s|$)/i.test(item));
  const applyIsRequested = [...prePlaybook, ...mainPlaybook, ...postPlaybook]
    .some((item) => /^\s*(?:terraform|tofu)\s+apply(?:\s|$)/i.test(item));
  const workspaceRestoreCommands = [...prePlaybook, ...mainPlaybook, ...postPlaybook, ...expandedExecutionCommands];
  const restoreWorkspaceThisRun = workspaceStorageEnabled && (
    !workspaceRestoreComment || workspaceRestoreCommands.some((command) => commandMatchesStorageTrigger(command, workspaceRestoreComment))
  );
  if (workspaceStorageEnabled) {
    const restoreDescription = workspaceRestorePolicy === 'always'
      ? 'every run'
      : `PR comment "${workspaceRestoreComment}"`;
    console.log(`[TFgit] Workspace restore policy: ${restoreDescription}${restoreWorkspaceThisRun ? ' (restore selected for this run).' : ' (restore skipped for this run).'}`);
  }
  const applyNeedsWorkspace = applyIsRequested && !planIsRequested && restoreWorkspaceThisRun;
  if (applyNeedsWorkspace && !validation.storage_token) {
    fail('Workspace storage is enabled, but TFgit storage is unavailable. Configure STORAGE_SECRET on the TFgit storage service.');
  }
  const canRestoreBeforeCheckout = applyNeedsWorkspace && workspaceStoragePath === '.';
  if (canRestoreBeforeCheckout) {
    console.log(`[TFgit] Apply-only run detected. Looking for saved files at ${workspaceStoragePath} for PR #${prNumber} and the current head SHA.`);
    const restored = await restoreWorkspace(serviceUrl, validation.storage_token, workspace, prNumber,
      pullRequestEnvironment.GITHUB_PR_HEAD_SHA, secret, repoFullName, workspaceStoragePath, true);
    if (restored.missing) {
      await reportRunState(serviceUrl, {
        secret,
        repository: repoFullName,
        pull_request_number: Number(prNumber),
        run_id: process.env.GITHUB_RUN_ID || '',
        run_attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
        status: 'failure',
        output: `There is no saved workspace for this pull request. Please run the configured storage command: ${workspaceStorageCommand}.`,
        run_url: `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`,
        plan_ready: false,
        apply_success: false,
      });
      await postPullRequestComment(owner, repo, prNumber, apiHeaders,
        `There is no saved workspace for this pull request. Please run the configured storage command: ${workspaceStorageCommand}.`);
      fail('No saved workspace was found for this pull request.');
    }
    if (restored.error) fail(`Could not restore saved workspace files: ${restored.error}`);
  } else {
    console.log(`[TFgit] Fetching PR #${prNumber} source at head ${pullRequestEnvironment.GITHUB_PR_HEAD_SHA}.`);
    const checkoutError = await checkoutPullRequestHead(owner, repo, pullRequestEnvironment.GITHUB_PR_HEAD_SHA,
      apiHeaders, workspace);
    if (checkoutError) fail(`Could not fetch the pull request workspace: ${checkoutError}`);
    console.log(`[TFgit] PR #${prNumber} source is ready in the runner workspace.`);
    if (restoreWorkspaceThisRun && validation.storage_token) {
      console.log(`[TFgit] Looking for saved files at ${workspaceStoragePath} to reuse for this run.`);
      const restored = await restoreWorkspace(serviceUrl, validation.storage_token, workspace, prNumber,
        pullRequestEnvironment.GITHUB_PR_HEAD_SHA, secret, repoFullName, workspaceStoragePath, workspaceStoragePath === '.');
      if (restored.error) fail(`Could not restore saved workspace files: ${restored.error}`);
      if (restored.missing && !applyNeedsWorkspace) {
        console.log('[TFgit] No saved execution files were found; continuing with the checked-out PR files.');
      }
      if (restored.missing && applyNeedsWorkspace) {
        await reportRunState(serviceUrl, {
          secret, repository: repoFullName, pull_request_number: Number(prNumber),
          run_id: process.env.GITHUB_RUN_ID || '', run_attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
          status: 'failure', output: 'No saved workspace was found for this pull request. Run the configured save command first.',
          run_url: `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`,
          plan_ready: false, apply_success: false,
        });
        await postPullRequestComment(owner, repo, prNumber, apiHeaders,
          'No saved workspace was found for this pull request. Run the configured save command first.');
        fail('No saved workspace was found for this pull request.');
      }
      if (restored.restored) console.log('[TFgit] Saved files are ready before the pre-playbook.');
    } else if (workspaceStorageEnabled) {
      const restoreReason = !validation.storage_token
        ? 'storage is unavailable'
        : `no scheduled command matches ${workspaceRestoreComment}`;
      console.log(`[TFgit] Saved files will not be restored because ${restoreReason}.`);
    }
  }

  if (backendEnabled) {
    console.log('[TFgit] Generating backend.tf from the selected backend configuration.');
    const baseBranch = pullRequestEnvironment.GITHUB_PR_BASE_BRANCH;
    const hclString = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const backendConfig = validation.terraform_backend
      .replaceAll('${TFGIT_STATE_BRANCH}', hclString(baseBranch))
      .replaceAll('${path.module}', hclString(workspace))
      .replaceAll('${GITHUB_REPO_NAME}', hclString(repo))
      .replaceAll('${GITHUB_PR_BASE_BRANCH}', hclString(baseBranch))
      .replaceAll('${GITHUB_PR_BASE_REPOSITORY}', hclString(pullRequestEnvironment.GITHUB_PR_BASE_REPOSITORY))
      .replaceAll('${TFGIT_USERNAME}', hclString(validation.tfgit_username))
      .replaceAll('${TFGIT_SECRET}', hclString(secret))
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
  let terraformStateFile = '';
  const stateRestoreCommand = String(validation.tfstate_restore_command ?? permanentStorage?.restore_command ?? '').trim();
  const stateRestoreThisRun = !stateRestoreCommand
    || [...prePlaybook, ...mainPlaybook, ...postPlaybook, ...expandedExecutionCommands]
      .some((command) => commandMatchesStorageTrigger(command, stateRestoreCommand));
  if (stateStorageEnabled) {
    const expectedStateKey = `${pullRequestEnvironment.GITHUB_PR_BASE_REPOSITORY}/${pullRequestEnvironment.GITHUB_PR_BASE_BRANCH}`;
    if (validation.tfstate_key !== expectedStateKey) {
      fail('TFgit returned a state key that does not match this PR repository and base branch.');
    }
    const stateFileName = String(validation.tfstate_path || '${GITHUB_PR_BASE_REPOSITORY}-${TFGIT_STATE_BRANCH}.tfstate')
      .replaceAll('${GITHUB_PR_BASE_REPOSITORY}', pullRequestEnvironment.GITHUB_PR_BASE_REPOSITORY)
      .replaceAll('${TFGIT_STATE_BRANCH}', pullRequestEnvironment.GITHUB_PR_BASE_BRANCH);
    terraformStateFile = safeWorkspaceFile(workspace, stateFileName);
    if (stateRestoreThisRun) {
      console.log(`[TFgit] Restoring permanent state file ${stateFileName}.`);
      const restoreState = await restoreTerraformState(serviceUrl, validation.tfstate_token, validation.tfstate_key,
        terraformStateFile);
      if (restoreState.error) fail(`Could not restore Terraform state: ${restoreState.error}`);
    } else {
      console.log(`[TFgit] Skipping permanent state restore; no scheduled command matches "${stateRestoreCommand}".`);
    }
  }
  if (planIsRequested && validation.storage_token) {
    console.log('[TFgit] Removing any previous saved plan workspace before starting a new plan.');
    const clearError = await clearWorkspaceBeforePlan(serviceUrl, validation.storage_token);
    if (clearError) fail(`Could not invalidate the previous saved plan before starting Terraform plan: ${clearError}`);
    console.log('[TFgit] Previous saved plan workspace cleared.');
  }
  const commandEnvironment = { ...process.env };
  commandEnvironment.TFGIT_MODE = mode;
  delete commandEnvironment.TFGIT_SECRET;
  delete commandEnvironment.INPUT_TFGIT_SECRET;
  delete commandEnvironment.GITHUB_TOKEN;
  const steps = await runPlaybook(prePlaybook, mainPlaybook, postPlaybook, workspace,
    expandedCommandArgs, commentCommandIndex, commandEnvironment, secret);
  console.log(`[TFgit] Playbook execution finished: ${steps.filter((step) => step.status === 'success').length}/${steps.length} command(s) succeeded.`);
  const playbookOutput = formatPlaybookOutput(steps).replaceAll(secret, '[REDACTED]');
  const runUrl = `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const runStatus = steps.some((step) => step.status !== 'success') ? 'failure' : 'success';
  const planSteps = steps.filter((step) => /^\s*(?:terraform|tofu)\s+plan(?:\s|$)/i.test(step.command));
  const successfulPlan = planSteps.length > 0 && planSteps.at(-1).status === 'success';
  const applySteps = steps.filter((step) => /^\s*(?:terraform|tofu)\s+apply(?:\s|$)/i.test(step.command));
  const successfulApply = applySteps.length > 0 && applySteps.at(-1).status === 'success';
  let storageTransferFailed = false;
  let workspaceSaved = false;
  const stateStoreCommand = String(validation.tfstate_store_command ?? permanentStorage?.store_command ?? '').trim();
  const successfulStateStoreTrigger = stateStoreCommand
    ? steps.some((step) => step.status === 'success' && commandMatchesStorageTrigger(step.command, stateStoreCommand))
    : runStatus === 'success';
  if (stateStorageEnabled && successfulStateStoreTrigger && terraformStateFile && fs.existsSync(terraformStateFile)) {
    console.log(`[TFgit] Uploading the updated Terraform state file for ${validation.tfstate_key}.`);
    const stateError = await saveTerraformState(serviceUrl, validation.tfstate_token, validation.tfstate_key,
      terraformStateFile);
    if (stateError) {
      storageTransferFailed = true;
      console.error(`::warning::Could not save Terraform state: ${stateError}`);
      await postPullRequestComment(owner, repo, prNumber, apiHeaders,
        'TFgit could not save the Terraform state file. The next run may use stale state until storage is available.');
    } else {
      console.log('[TFgit] Terraform state file uploaded successfully.');
    }
  }
  const successfulStorageTrigger = workspaceStorageCommand
    ? steps.some((step) => step.status === 'success' && commandMatchesStorageTrigger(step.command, workspaceStorageCommand))
    : runStatus === 'success';
  const shouldSaveWorkspace = workspaceStorageEnabled && !storageTransferFailed
    && (workspaceStoragePolicy === 'always' || successfulStorageTrigger);
  if (shouldSaveWorkspace) {
    console.log(`[TFgit] Storage save condition met (${workspaceStoragePolicy === 'always' ? 'always' : `successful command: ${workspaceStorageCommand}`}). Packaging ${workspaceStoragePath}.`);
    const storageError = await saveWorkspace(serviceUrl, validation.storage_token, workspace,
      pullRequestEnvironment.GITHUB_PR_HEAD_SHA, secret, repoFullName, prNumber, workspaceStoragePath);
    if (storageError) {
      storageTransferFailed = true;
      console.error(`::warning::Could not save the Terraform workspace: ${storageError}`);
      await postPullRequestComment(owner, repo, prNumber, apiHeaders,
        'TFgit could not save these execution files. A later run may not be able to reuse this workspace.');
    } else workspaceSaved = true;
  } else if (workspaceStorageEnabled) {
    console.log(`[TFgit] Workspace storage save skipped; ${workspaceStoragePolicy === 'always' ? 'a prior storage transfer failed' : `command did not succeed: ${workspaceStorageCommand}`}.`);
  }
  if (successfulApply) {
    console.log('[TFgit] Terraform apply succeeded. Deleting temporary execution files.');
    await deleteWorkspace(serviceUrl, validation.storage_token);
  }
  console.log(`[TFgit] Reporting ${storageTransferFailed ? 'failure' : runStatus} status to the TFgit dashboard.`);
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
        status: storageTransferFailed ? 'failure' : runStatus,
        plan_ready: successfulApply
          ? false
          : (planIsRequested ? successfulPlan && workspaceSaved && !storageTransferFailed : null),
        apply_success: applyIsRequested ? successfulApply && !storageTransferFailed : (planIsRequested ? false : null),
        output: (storageTransferFailed
          ? `${playbookOutput}\n\nTFgit could not persist Terraform state or plan data; apply may be unavailable until storage is healthy.`
          : playbookOutput).slice(0, 60000),
        run_url: runUrl,
      }),
    });
    if (!reportResponse.ok) console.error(`::warning::Could not save the Terraform run output in the tfgit dashboard (HTTP ${reportResponse.status}).`);
  } catch (error) {
    console.error(`::warning::Could not reach the tfgit dashboard to save run output: ${error.message}`);
  }
  const commentSummaries = summarizeTerraformResults(steps, planSummaryEnabled);
  const commentBodies = buildOutputComments(playbookOutput, runUrl, expandedCommentCommand || requestedCommand,
    commentSummaries.lines, commentSummaries.errorLabel);
  console.log(`[TFgit] Posting ${commentBodies.length} output comment(s) to PR #${prNumber}.`);
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
  if (storageTransferFailed) fail('Terraform state or plan data could not be saved to TFgit storage.');
  if (steps.some((step) => step.status !== 'success')) {
    fail('One or more tfgit playbook commands failed. See the pull request comment for output.');
  }
}

async function postPullRequestComment(owner, repo, prNumber, headers, body) {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(prNumber)}/comments`,
    { method: 'POST', headers, body: JSON.stringify({ body }) },
  );
  if (!response.ok) fail(`Could not post a comment to pull request ${prNumber} (HTTP ${response.status}).`);
}

async function reportRunState(serviceUrl, report) {
  try {
    const response = await fetch(new URL('/api/v1/github-actions/report', serviceUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(report),
    });
    if (!response.ok) console.error(`::warning::Could not update PR run status in the TFgit dashboard (HTTP ${response.status}).`);
  } catch (error) {
    console.error(`::warning::Could not reach the TFgit dashboard to update PR run status: ${error.message}`);
  }
}

function storageUrl(serviceUrl) {
  return new URL('/storage/tfplan', serviceUrl);
}

function tfstateStorageUrl(serviceUrl, stateKey) {
  const encodedKey = stateKey.split('/').map((part) => encodeURIComponent(part)).join('/');
  return new URL(`/storage/tfstate/${encodedKey}`, serviceUrl);
}

function safeWorkspaceFile(workspace, relativeFile) {
  const root = path.resolve(workspace);
  const destination = path.resolve(root, relativeFile);
  const relative = path.relative(root, destination);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('Refusing to use a Terraform state path outside the runner workspace.');
  }
  let current = root;
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail('Refusing to use a Terraform state path through a symbolic link.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  try {
    if (fs.lstatSync(destination).isSymbolicLink()) fail('Refusing to use a Terraform state file that is a symbolic link.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return destination;
}

async function restoreTerraformState(serviceUrl, stateToken, stateKey, stateFile) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfgit-tfstate-'));
  const downloadedState = path.join(tempDir, 'terraform.tfstate');
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    console.log(`[TFgit] Checking storage for the state file at ${stateKey}.`);
    const result = spawnSync('curl', [
      '--silent', '--show-error', '--location', '--max-filesize', String(MAX_TERRAFORM_STATE_BYTES),
      '--output', downloadedState, '--write-out', '%{http_code}',
      '-H', `Authorization: Bearer ${stateToken}`,
      tfstateStorageUrl(serviceUrl, stateKey).toString(),
    ], { encoding: 'utf8', timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 });
    if (result.error) return { error: result.error.message };
    const status = Number(result.stdout.trim());
    if (status === 404) {
      console.log(`[TFgit] No saved state file exists for ${stateKey}; Terraform will initialize state in the runner.`);
      return { missing: true };
    }
    if (result.status !== 0 || status !== 200) return { error: `storage returned HTTP ${status || result.status}` };
    const size = fs.statSync(downloadedState).size;
    if (size > MAX_TERRAFORM_STATE_BYTES) return { error: 'state file exceeds the 100 MiB limit' };
    console.log(`[TFgit] Found the saved state file (${formatBytes(size)}). Restoring it to the runner workspace.`);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.copyFileSync(downloadedState, stateFile);
    fs.chmodSync(stateFile, 0o600);
    console.log(`[TFgit] Restored state file to ${path.relative(process.env.GITHUB_WORKSPACE, stateFile)}.`);
    return { restored: true };
  } catch (error) {
    return { error: error.message };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function saveTerraformState(serviceUrl, stateToken, stateKey, stateFile) {
  try {
    const size = fs.statSync(stateFile).size;
    if (size > MAX_TERRAFORM_STATE_BYTES) return 'Terraform state file exceeds the 100 MiB limit';
    console.log(`[TFgit] Uploading Terraform state (${formatBytes(size)}) for ${stateKey}.`);
    const result = spawnSync('curl', [
      '--fail', '--silent', '--show-error', '--location', '-X', 'PUT',
      '-H', `Authorization: Bearer ${stateToken}`,
      '-H', 'Content-Type: application/json',
      '--upload-file', stateFile,
      tfstateStorageUrl(serviceUrl, stateKey).toString(),
    ], { encoding: 'utf8', timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) return result.stderr || result.error?.message || 'state upload failed';
    return '';
  } catch (error) {
    return error.message;
  }
}

function safeStoragePath(value) {
  const storagePath = String(value || '.').trim();
  if (storagePath === '.') return storagePath;
  if (!storagePath || storagePath.length > 500 || storagePath.startsWith('/') || storagePath.includes('\\')
    || storagePath.split('/').some((part) => !part || part === '.' || part === '..')
    || !/^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/.test(storagePath)) {
    fail('TFgit response contains an unsafe workspace storage path.');
  }
  return storagePath;
}

function commandMatchesStorageTrigger(executionCommand, configuredCommand) {
  const executed = String(executionCommand || '').trim().replace(/\s+/g, ' ');
  const trigger = String(configuredCommand || '').trim().replace(/\s+/g, ' ');
  return executed === trigger || executed.startsWith(`${trigger} `);
}

async function restoreWorkspace(serviceUrl, storageToken, workspace, prNumber, headSha, secret, repoFullName, storagePath = '.', replaceWorkspace = true) {
  if (!storageToken) return { error: 'storage is not configured; set STORAGE_SECRET on the backend and storage service' };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfgit-storage-'));
  const encryptedArchive = path.join(tempDir, 'workspace.tfgit.enc');
  const archive = path.join(tempDir, 'workspace.tar.gz');
  try {
    console.log(`[TFgit] Downloading saved workspace files for PR #${prNumber} from TFgit storage.`);
    const result = spawnSync('curl', [
      '--silent', '--show-error', '--location', '--max-filesize', String(MAX_STORAGE_ARCHIVE_BYTES),
      '--output', encryptedArchive, '--write-out', '%{http_code}',
      '-H', `Authorization: Bearer ${storageToken}`, '-H', `X-TFgit-PR-Head-SHA: ${headSha}`,
      storageUrl(serviceUrl).toString(),
    ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
    if (result.error) return { error: result.error.message };
    const status = Number(result.stdout.trim());
    if (status === 404) {
      console.log(`[TFgit] No saved plan workspace was found for PR #${prNumber}.`);
      return { missing: true };
    }
    if (result.status !== 0 || status !== 200) return { error: `storage returned HTTP ${status || result.status}` };
    const encryptedSize = fs.statSync(encryptedArchive).size;
    console.log(`[TFgit] Found saved plan workspace (${formatBytes(encryptedSize)} encrypted). Decrypting and checking archive contents.`);
    if (encryptedSize > MAX_STORAGE_ARCHIVE_BYTES) return { error: 'encrypted archive exceeds the 1 GiB limit' };
    await decryptArchive(encryptedArchive, archive, secret, archiveScope(repoFullName, prNumber, headSha));
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 2 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
    if (listing.error || listing.status !== 0) return { error: 'could not inspect the saved workspace archive' };
    const entries = listing.stdout.split('\n').filter(Boolean);
    const normalizedEntries = entries.map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''));
    if (!normalizedEntries.length || normalizedEntries.some((entry) => path.isAbsolute(entry) || entry.includes('\\') || entry.split('/').includes('..'))) {
      return { error: 'archive contains an unsafe path' };
    }
    if (storagePath !== '.' && normalizedEntries.some((entry) => entry !== storagePath && !entry.startsWith(`${storagePath}/`))) {
      return { error: 'archive contains files outside the configured storage path' };
    }
    if (replaceWorkspace) clearWorkspaceContents(workspace);
    else if (storagePath !== '.') clearWorkspacePath(workspace, storagePath);
    const extract = spawnSync('tar', ['-xzf', archive, '-C', workspace, '--no-same-owner', '--no-same-permissions'], {
      encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024,
    });
    if (extract.error || extract.status !== 0) return { error: extract.stderr || 'archive extraction failed' };
    console.log(`[TFgit] Restored saved files from ${storagePath} for PR #${prNumber}.`);
    return { restored: true };
  } catch (error) {
    return { error: error.message };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function checkoutPullRequestHead(owner, repo, headSha, headers, workspace) {
  if (!/^[0-9a-f]{40}$/i.test(String(headSha))) return 'GitHub returned an invalid pull request head SHA';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfgit-checkout-'));
  const archive = path.join(tempDir, 'pull-request.tar.gz');
  try {
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(headSha)}`;
    const download = spawnSync('curl', [
      '--silent', '--show-error', '--location', '--max-filesize', String(MAX_STORAGE_ARCHIVE_BYTES),
      '--output', archive, '--write-out', '%{http_code}',
      '-H', `Authorization: ${headers.authorization}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      archiveUrl,
    ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
    const status = Number(download.stdout.trim());
    if (download.error) return download.error.message;
    if (download.status !== 0 || status !== 200) {
      return `GitHub returned HTTP ${status || download.status}${download.stderr ? `: ${download.stderr.trim()}` : ''}`;
    }
    if (!fs.existsSync(archive) || fs.statSync(archive).size === 0) return 'GitHub returned an empty repository archive';

    const listing = spawnSync('tar', ['-tzf', archive], {
      encoding: 'utf8', timeout: 2 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
    });
    if (listing.error || listing.status !== 0) return 'could not inspect the pull request archive';
    const entries = listing.stdout.split('\n').filter(Boolean);
    const roots = new Set();
    if (!entries.length || entries.some((entry) => {
      const parts = entry.split('/');
      roots.add(parts[0]);
      return path.isAbsolute(entry) || entry.includes('\\') || parts.includes('..') || parts.length < 2;
    }) || roots.size !== 1) {
      return 'GitHub returned an unsafe repository archive';
    }

    const workspacePath = path.resolve(workspace);
    if (!workspacePath || workspacePath === path.parse(workspacePath).root) {
      return 'refusing to extract into a filesystem root';
    }
    fs.mkdirSync(workspacePath, { recursive: true });
    const extract = spawnSync('tar', [
      '-xzf', archive, '-C', workspacePath, '--strip-components=1', '--overwrite', '--no-same-owner', '--no-same-permissions',
    ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    if (extract.error || extract.status !== 0) return extract.stderr?.trim() || 'archive extraction failed';
    return '';
  } catch (error) {
    return error.message;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function clearWorkspaceContents(workspace) {
  const workspacePath = path.resolve(workspace);
  if (!workspacePath || workspacePath === path.parse(workspacePath).root) {
    throw new Error('refusing to clear a filesystem root');
  }
  fs.mkdirSync(workspacePath, { recursive: true });
  for (const entry of fs.readdirSync(workspacePath)) {
    fs.rmSync(path.join(workspacePath, entry), { recursive: true, force: true });
  }
  return workspacePath;
}

function clearWorkspacePath(workspace, storagePath) {
  const root = path.resolve(workspace);
  const target = path.resolve(root, storagePath);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('storage path escapes the runner workspace');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('storage path crosses a symbolic link');
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('storage path cannot be a symbolic link');
  fs.rmSync(target, { recursive: true, force: true });
}

async function saveWorkspace(serviceUrl, storageToken, workspace, headSha, secret, repoFullName, prNumber, storagePath = '.') {
  if (!storageToken) return 'storage is not configured; set STORAGE_SECRET on the backend and storage service';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfgit-storage-'));
  const archive = path.join(tempDir, 'workspace.tar.gz');
  const encryptedArchive = path.join(tempDir, 'workspace.tfgit.enc');
  try {
    const filesList = path.join(tempDir, 'files.list');
    const files = collectWorkspaceFiles(workspace, storagePath);
    if (!files.length) return 'the workspace contains no regular files to save';
    console.log(`[TFgit] Packaging ${files.length} file(s) from ${storagePath} for workspace storage.`);
    fs.writeFileSync(filesList, files.map((file) => `./${file}`).join('\0') + '\0');
    const tar = spawnSync('tar', ['-czf', archive, '--null', '-T', filesList], {
      cwd: workspace, encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024,
    });
    if (tar.error || tar.status !== 0) return tar.stderr || tar.error?.message || 'archive creation failed';
    await encryptArchive(archive, encryptedArchive, secret, archiveScope(repoFullName, prNumber, headSha));
    const archiveSize = fs.statSync(encryptedArchive).size;
    console.log(`Encrypted Terraform workspace archive size: ${formatBytes(archiveSize)}.`);
    if (archiveSize > MAX_STORAGE_ARCHIVE_BYTES) return 'encrypted archive exceeds the 1 GiB limit';
    console.log('Uploading workspace archive to TFgit storage...');
    const put = spawnSync('curl', [
      '--fail', '--silent', '--show-error', '--location', '-X', 'PUT',
      '-H', `Authorization: Bearer ${storageToken}`, '-H', `X-TFgit-PR-Head-SHA: ${headSha}`,
      '-H', 'Content-Type: application/vnd.tfgit.encrypted',
      '--upload-file', encryptedArchive, storageUrl(serviceUrl).toString(),
    ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
    if (put.error || put.status !== 0) return put.stderr || put.error?.message || 'storage upload failed';
    console.log('[TFgit] Saved plan workspace uploaded successfully; it is available for 1 hour.');
    return '';
  } catch (error) {
    return error.message;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function archiveScope(repository, prNumber, headSha) {
  return `${repository.toLowerCase()}\n${prNumber}\n${headSha.toLowerCase()}`;
}

function archiveKey(secret, salt, scope) {
  return crypto.scryptSync(secret, Buffer.concat([salt, Buffer.from(scope)]), 32);
}

async function encryptArchive(inputPath, outputPath, secret, scope) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const scopeBytes = Buffer.from(scope);
  const cipher = crypto.createCipheriv('aes-256-gcm', archiveKey(secret, salt, scope), iv);
  cipher.setAAD(scopeBytes);
  const ciphertextPath = `${outputPath}.payload`;
  try {
    await pipeline(createReadStream(inputPath), cipher, createWriteStream(ciphertextPath, { mode: 0o600 }));
    const header = Buffer.concat([ENCRYPTED_ARCHIVE_MAGIC, salt, iv, cipher.getAuthTag()]);
    fs.writeFileSync(outputPath, header, { mode: 0o600 });
    await pipeline(createReadStream(ciphertextPath), createWriteStream(outputPath, { flags: 'a', mode: 0o600 }));
  } finally {
    fs.rmSync(ciphertextPath, { force: true });
  }
}

async function decryptArchive(inputPath, outputPath, secret, scope, artifactName = 'saved workspace archive') {
  const header = Buffer.alloc(ENCRYPTED_ARCHIVE_HEADER_SIZE);
  const descriptor = fs.openSync(inputPath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (bytesRead !== header.length || !header.subarray(0, ENCRYPTED_ARCHIVE_MAGIC.length).equals(ENCRYPTED_ARCHIVE_MAGIC)) {
    throw new Error(`${artifactName} has an invalid encryption header`);
  }
  const saltStart = ENCRYPTED_ARCHIVE_MAGIC.length;
  const ivStart = saltStart + 16;
  const tagStart = ivStart + 12;
  const salt = header.subarray(saltStart, ivStart);
  const iv = header.subarray(ivStart, tagStart);
  const tag = header.subarray(tagStart, ENCRYPTED_ARCHIVE_HEADER_SIZE);
  const scopeBytes = Buffer.from(scope);
  const decipher = crypto.createDecipheriv('aes-256-gcm', archiveKey(secret, salt, scope), iv);
  decipher.setAAD(scopeBytes);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(inputPath, { start: ENCRYPTED_ARCHIVE_HEADER_SIZE }), decipher,
      createWriteStream(outputPath, { mode: 0o600 }));
  } catch {
    fs.rmSync(outputPath, { force: true });
    throw new Error(`could not decrypt the ${artifactName}; verify the TFgit secret and storage scope`);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function collectWorkspaceFiles(workspace, storagePath = '.') {
  const root = path.resolve(workspace);
  const selectedRoot = storagePath === '.' ? root : path.resolve(root, storagePath);
  if (!selectedRoot.startsWith(`${root}${path.sep}`) && selectedRoot !== root) throw new Error('storage path escapes the runner workspace');
  if (!fs.existsSync(selectedRoot)) throw new Error(`storage path does not exist: ${storagePath}`);
  let inspected = root;
  for (const part of path.relative(root, selectedRoot).split(path.sep).filter(Boolean)) {
    inspected = path.join(inspected, part);
    if (fs.lstatSync(inspected).isSymbolicLink()) throw new Error('storage path cannot cross a symbolic link');
  }
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
    }
  };
  const selectedStat = fs.lstatSync(selectedRoot);
  if (selectedStat.isSymbolicLink()) throw new Error('storage path cannot be a symbolic link');
  if (selectedStat.isFile()) files.push(path.relative(root, selectedRoot));
  else if (selectedStat.isDirectory()) visit(selectedRoot);
  else throw new Error('storage path must select a regular file or folder');
  return files.sort();
}

async function deleteWorkspace(serviceUrl, storageToken) {
  if (!storageToken) return;
  try {
    console.log('[TFgit] Deleting saved plan workspace from TFgit storage.');
    const response = await fetch(storageUrl(serviceUrl), {
      method: 'DELETE', headers: { authorization: `Bearer ${storageToken}` },
    });
    if (!response.ok) console.error(`::warning::Could not remove saved workspace after apply (HTTP ${response.status}).`);
    else console.log('[TFgit] Saved plan workspace deleted.');
  } catch (error) {
    console.error(`::warning::Could not remove saved workspace after apply: ${error.message}`);
  }
}

async function clearWorkspaceBeforePlan(serviceUrl, storageToken) {
  try {
    const response = await fetch(storageUrl(serviceUrl), {
      method: 'DELETE', headers: { authorization: `Bearer ${storageToken}` },
    });
    if (!response.ok && response.status === 404) {
      return 'HTTP 404 from the tfplan storage endpoint; route /storage directly to the storage service, preserve the path, and ensure the deployed service has DELETE /storage/tfplan. The storage API returns HTTP 200 when the PR folder is already absent';
    }
    if (!response.ok) return `storage returned HTTP ${response.status}`;
    return '';
  } catch (error) {
    return error.message;
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

async function runPlaybook(prePlaybook, playbook, postPlaybook, workspace, commandArgs = [], commentCommandIndex = -1,
  commandEnvironment = process.env, secret = '') {
  const results = [];
  const runStage = async (commands, stage) => {
    if (commands.length === 0) {
      console.log(`Running tfgit ${stage} step 1/1: list is empty`);
      return true;
    }
    for (const [index, command] of commands.entries()) {
      const stageLabel = stage === 'playbook' ? 'playbook step' : `${stage} steps`;
      const startedAt = Date.now();
      const isCommentTerraformCommand = stage === 'playbook' && index === commentCommandIndex;
      let effectiveCommand = command;
      let args;
      if (isCommentTerraformCommand) {
        args = [...commandArgs];
        if (['plan', 'apply'].includes(args[0]?.toLowerCase())) ensureNonInteractiveTerraformArguments(args);
        effectiveCommand = `terraform ${args.map((argument) => /\s/.test(argument) ? JSON.stringify(argument) : argument).join(' ')}`;
      } else if (/^\s*(?:terraform|tofu)\s+(?:plan|apply)(?=\s|$)/i.test(command)) {
        effectiveCommand = ensureNonInteractiveTerraformCommand(command);
      }
      console.log(`Running tfgit ${stageLabel} ${index + 1}/${commands.length}: ${effectiveCommand}`);
      console.log(`[TFgit] Streaming ${stageLabel} output to the GitHub Actions log.`);
      const result = await runCommand(isCommentTerraformCommand ? 'terraform' : effectiveCommand,
        isCommentTerraformCommand ? args : [], {
          cwd: workspace,
          env: commandEnvironment,
          shell: !isCommentTerraformCommand,
          timeout: 30 * 60 * 1000,
        }, secret);
      const output = stripTerminalSequences(result.output).replaceAll(secret, '[REDACTED]').trim();
      const status = result.status === 0 ? 'success' : 'failure';
      results.push({ command: effectiveCommand, status, output: output || '(no output)' });
      console.log(`[TFgit] ${stageLabel} ${index + 1}/${commands.length} ${status} after ${formatDuration(Date.now() - startedAt)}.`);
      if (status === 'failure') return false;
    }
    return true;
  };

  if (await runStage(prePlaybook, 'pre-playbook')) {
    if (await runStage(playbook, 'playbook')) {
      await runStage(postPlaybook, 'post-playbook');
    }
  }
  return results;
}

async function installTerraform(requestedVersion, mode = 'terraform') {
  const platformNames = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
  const architectureNames = { x64: 'amd64', arm64: 'arm64', ia32: '386' };
  const platform = platformNames[process.platform];
  const architecture = architectureNames[process.arch];
  if (!platform || !architecture) return `unsupported runner platform ${process.platform}/${process.arch}`;

  const isTofu = mode === 'tofu';
  let version = requestedVersion;
  if (version.toLowerCase() === 'latest') {
    try {
      const metadataUrl = isTofu
        ? 'https://api.github.com/repos/opentofu/opentofu/releases/latest'
        : 'https://checkpoint-api.hashicorp.com/v1/check/terraform';
      const response = await fetch(metadataUrl, {
        headers: { accept: 'application/json', 'user-agent': 'tfgit-github-action' },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) return `${isTofu ? 'OpenTofu' : 'HashiCorp'} version lookup returned HTTP ${response.status}`;
      const metadata = await response.json();
      version = isTofu ? metadata.tag_name?.replace(/^v/, '') : metadata.current_version;
    } catch (error) {
      return `${isTofu ? 'OpenTofu' : 'HashiCorp'} version lookup failed: ${error.message}`;
    }
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    return `invalid ${isTofu ? 'OpenTofu' : 'Terraform'} version "${version}"`;
  }

  if (isTofu && architecture === '386') return 'OpenTofu does not provide 32-bit runner binaries';
  const archiveName = `${isTofu ? 'tofu' : 'terraform'}_${version}_${platform}_${architecture}.zip`;
  const releaseBase = isTofu
    ? `https://github.com/opentofu/opentofu/releases/download/v${encodeURIComponent(version)}`
    : `https://releases.hashicorp.com/terraform/${encodeURIComponent(version)}`;
  const checksumName = `${isTofu ? 'tofu' : 'terraform'}_${version}_SHA256SUMS`;
  const installDirectory = path.join(os.tmpdir(), `tfgit-${isTofu ? 'tofu' : 'terraform'}-${version}-${platform}-${architecture}`);
  const archivePath = path.join(os.tmpdir(), archiveName);
  const executableName = process.platform === 'win32' ? `${isTofu ? 'tofu' : 'terraform'}.exe` : (isTofu ? 'tofu' : 'terraform');
  const executablePath = path.join(installDirectory, executableName);
  const terraformAlias = path.join(installDirectory, process.platform === 'win32' ? 'terraform.exe' : 'terraform');

  try {
    if (!fs.existsSync(executablePath)) {
      console.log(`[TFgit] Downloading ${isTofu ? 'OpenTofu' : 'Terraform'} ${version} for ${platform}/${architecture}.`);
      const [archiveResponse, checksumsResponse] = await Promise.all([
        fetch(`${releaseBase}/${archiveName}`, { signal: AbortSignal.timeout(120000) }),
        fetch(`${releaseBase}/${checksumName}`, {
          headers: isTofu ? { accept: 'application/octet-stream' } : undefined,
          signal: AbortSignal.timeout(30000),
        }),
      ]);
      if (!archiveResponse.ok) return `${isTofu ? 'OpenTofu' : 'Terraform'} archive download returned HTTP ${archiveResponse.status}`;
      if (!checksumsResponse.ok) return `${isTofu ? 'OpenTofu' : 'Terraform'} checksum download returned HTTP ${checksumsResponse.status}`;
      const checksumText = await checksumsResponse.text();
      const expectedHash = checksumText.split(/\r?\n/)
        .map((line) => line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(\S+)$/))
        .find((match) => match && match[2] === archiveName)?.[1]?.toLowerCase();
      if (!expectedHash) return `checksum list does not contain ${archiveName}`;

      const chunks = [];
      let archiveBytes = 0;
      for await (const chunk of archiveResponse.body) {
        archiveBytes += chunk.length;
        if (archiveBytes > MAX_TERRAFORM_ARCHIVE_BYTES) return `${isTofu ? 'OpenTofu' : 'Terraform'} archive exceeds the 100 MB safety limit`;
        chunks.push(Buffer.from(chunk));
      }
      const archive = Buffer.concat(chunks);
      const actualHash = crypto.createHash('sha256').update(archive).digest('hex');
      if (actualHash !== expectedHash) return 'Terraform archive SHA-256 checksum verification failed';
      fs.mkdirSync(installDirectory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(archivePath, archive, { mode: 0o600 });
      const extraction = process.platform === 'win32'
        ? spawnSync('powershell', ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', archivePath, installDirectory], { encoding: 'utf8' })
        : spawnSync('unzip', ['-o', archivePath, '-d', installDirectory], { encoding: 'utf8' });
      if (extraction.error || extraction.status !== 0) {
        return `could not extract the verified Terraform archive${extraction.error ? `: ${extraction.error.message}` : `: ${extraction.stderr.trim()}`}`;
      }
      if (process.platform !== 'win32') fs.chmodSync(executablePath, 0o700);
    }

    if (isTofu && !fs.existsSync(terraformAlias)) {
      if (process.platform === 'win32') fs.copyFileSync(executablePath, terraformAlias);
      else fs.symlinkSync(path.basename(executablePath), terraformAlias);
    }

    const githubPath = process.env.GITHUB_PATH;
    if (githubPath) fs.appendFileSync(githubPath, `${installDirectory}${os.EOL}`, { mode: 0o600 });
    process.env.PATH = `${installDirectory}${path.delimiter}${process.env.PATH || ''}`;
    const versionCheck = spawnSync(executablePath, ['version'], { encoding: 'utf8', timeout: 15000 });
    if (versionCheck.error || versionCheck.status !== 0) {
      return `installed ${isTofu ? 'OpenTofu' : 'Terraform'} could not be started${versionCheck.error ? `: ${versionCheck.error.message}` : ''}`;
    }
    const installedVersion = /(?:Terraform|OpenTofu) v([^\s]+)/.exec(versionCheck.stdout)?.[1];
    if (installedVersion !== version) return `requested ${isTofu ? 'OpenTofu' : 'Terraform'} ${version}, but ${installedVersion || 'an unknown version'} was installed`;
    console.log(`[TFgit] ${isTofu ? 'OpenTofu' : 'Terraform'} ${version} is installed and available on PATH${isTofu ? ' as both `tofu` and `terraform`' : ''}.`);
    return '';
  } catch (error) {
    return error.message;
  } finally {
    try { fs.rmSync(archivePath, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

function ensureNonInteractiveTerraformArguments(args) {
  const options = [['-input', 'false']];
  if (args[0]?.toLowerCase() === 'apply') options.unshift(['-auto-approve', 'true']);
  for (const [name, value] of options) {
    const index = args.findIndex((argument) => argument === name || argument.startsWith(`${name}=`));
    const desired = value === 'true' ? name : `${name}=${value}`;
    if (index < 0) args.splice(1, 0, desired);
    else if (args[index] !== desired) args[index] = desired;
  }
}

function ensureNonInteractiveTerraformCommand(command) {
  const match = /^(\s*)(terraform|tofu)\s+(plan|apply)(?=\s|$)/i.exec(command);
  const subcommand = match?.[3].toLowerCase();
  if (!subcommand) return command;
  const options = [['-input', 'false']];
  if (subcommand === 'apply') options.unshift(['-auto-approve', 'true']);
  let updated = command;
  const prefix = new RegExp(`^(\\s*${match[2]}\\s+${subcommand})(?=\\s|$)`, 'i');
  for (const [name, value] of options) {
    const optionPattern = new RegExp(`(^|\\s)${name}(?:=(?:true|false))?(?=\\s|$)`, 'i');
    if (optionPattern.test(updated)) {
      updated = updated.replace(optionPattern, `$1${value === 'true' ? name : `${name}=${value}`}`);
    } else {
      updated = updated.replace(prefix, `$1 ${value === 'true' ? name : `${name}=${value}`}`);
    }
  }
  return updated;
}

function runCommand(command, args, options, secret) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ status: 1, output: error.message });
      return;
    }
    const maxCapturedBytes = 20 * 1024 * 1024;
    const captured = [];
    let capturedBytes = 0;
    let outputTruncated = false;
    let spawnError = '';
    const logStreams = [
      { stream: child.stdout, destination: process.stdout, pending: '' },
      { stream: child.stderr, destination: process.stderr, pending: '' },
    ];
    const stopCommandToken = `TFGIT_${crypto.randomBytes(16).toString('hex')}`;
    process.stdout.write(`::stop-commands::${stopCommandToken}\n`);
    const emitLog = (state, chunk, flush = false) => {
      state.pending += chunk.toString('utf8');
      let safeLength = flush ? state.pending.length
        : Math.max(0, state.pending.length - (secret ? secret.length - 1 : 0));
      if (!flush && secret) {
        for (let match = state.pending.indexOf(secret); match >= 0 && match < safeLength;
          match = state.pending.indexOf(secret, match + 1)) {
          if (match + secret.length > safeLength) safeLength = match;
        }
        const maxPartial = Math.min(secret.length - 1, state.pending.length);
        for (let length = maxPartial; length > 0; length -= 1) {
          if (state.pending.endsWith(secret.slice(0, length))) {
            safeLength = Math.min(safeLength, state.pending.length - length);
            break;
          }
        }
      }
      if (!safeLength) return;
      const safe = state.pending.slice(0, safeLength);
      state.pending = state.pending.slice(safeLength);
      const redacted = secret ? safe.replaceAll(secret, '[REDACTED]') : safe;
      state.destination.write(stripTerminalSequences(redacted));
    };
    for (const state of logStreams) {
      state.stream.on('data', (chunk) => {
        if (capturedBytes < maxCapturedBytes) {
          const remaining = maxCapturedBytes - capturedBytes;
          const kept = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
          captured.push(kept);
          capturedBytes += kept.length;
          if (kept.length < chunk.length) outputTruncated = true;
        } else outputTruncated = true;
        emitLog(state, chunk);
      });
      state.stream.on('end', () => emitLog(state, Buffer.alloc(0), true));
    }
    child.on('error', (error) => { spawnError = error.message; });
    const timeout = setTimeout(() => {
      spawnError = `command timed out after ${Math.round(options.timeout / 60000)} minutes`;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 5000).unref();
    }, options.timeout);
    timeout.unref();
    child.on('close', (code) => {
      clearTimeout(timeout);
      process.stdout.write(`\n::${stopCommandToken}::\n`);
      let output = Buffer.concat(captured).toString('utf8');
      if (outputTruncated) output += '\n[TFgit truncated captured output after 20 MiB; full output is in the GitHub Actions log.]';
      if (spawnError) output += `${output ? '\n' : ''}${spawnError}`;
      resolve({ status: spawnError ? 1 : (code ?? 1), output });
    });
  });
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
    ...(index === chunks.length - 1 && summaries.length ? ['', summaries.join('\n\n')] : []),
  ].join('\n'));
}

function summarizeTerraformResults(steps, planSummaryEnabled = true) {
  const summaries = [];
  const failedPlan = steps.find((step) => step.status !== 'success' && /^\s*(?:terraform|tofu)\s+plan(?:\s|$)/i.test(step.command));
  const failedApply = steps.find((step) => step.status !== 'success' && /^\s*(?:terraform|tofu)\s+apply(?:\s|$)/i.test(step.command));
  const errorLabel = failedPlan ? 'Plan Error' : failedApply ? 'Apply Error' : '';
  const planSummaryPattern = /Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy\./i;
  const successfulPlan = steps.find((step) => step.status === 'success'
    && /^\s*(?:terraform|tofu)\s+plan(?:\s|$)/i.test(step.command));
  if (successfulPlan && planSummaryEnabled) {
    const resourcesByAction = { create: new Set(), delete: new Set(), update: new Set(), read: new Set() };
    const actionLine = /^\s*#\s+(.+?)\s+(?:will be (created|updated in-place|destroyed|read during apply|replaced)|must be replaced|is tainted, so must be replaced)\s*$/gm;
    for (const match of successfulPlan.output.matchAll(actionLine)) {
      const address = match[1].trim();
      const action = match[2];
      if (action === 'created') resourcesByAction.create.add(address);
      else if (action === 'destroyed') resourcesByAction.delete.add(address);
      else if (action === 'updated in-place') resourcesByAction.update.add(address);
      else if (action === 'read during apply') resourcesByAction.read.add(address);
      else {
        resourcesByAction.delete.add(address);
        resourcesByAction.create.add(address);
      }
    }
    const resourceSummary = [
      ['delete', 'deleted'], ['create', 'created'], ['update', 'updated'], ['read', 'read'],
    ].flatMap(([action, label]) => [...resourcesByAction[action]].sort()
      .map((address) => `- ${label} — \`${address}\``));
    if (resourceSummary.length) summaries.push(`**Terraform plan resource changes**\n\n${resourceSummary.join('\n')}`);

    const counts = successfulPlan.output.match(planSummaryPattern);
    const noChanges = /No changes\. Your infrastructure matches the configuration\./i.test(successfulPlan.output);
    const planLine = counts
      ? `Plan: ${counts[1]} to add, ${counts[2]} to change, ${counts[3]} to destroy.`
      : noChanges ? 'Plan: 0 to add, 0 to change, 0 to destroy.' : '';
    if (planLine && (noChanges || (counts && counts.slice(1).every((count) => Number(count) === 0)))) {
      summaries.push([
        '```sql',
        'No changes. Your infrastructure matches the configuration.',
        '',
        'Terraform has compared your real infrastructure against your configuration',
        'and found no differences, so no changes are needed.',
        '```',
      ].join('\n'));
      summaries.push(planLine);
    } else if (planLine) {
      summaries.push(planLine);
      summaries.push('- ▶️ To apply this plan, comment:');
      const cli = /^\s*(tofu)\s+plan(?:\s|$)/i.test(successfulPlan.command) ? 'tofu' : 'terraform';
      summaries.push(`\`\`\`text\n${cli} apply\n\`\`\``);
    }
  }

  const successfulApply = steps.find((step) => step.status === 'success' && /^\s*(?:terraform|tofu)\s+apply(?:\s|$)/i.test(step.command));
  if (successfulApply) {
    const applySummary = successfulApply.output.match(/^Apply complete! Resources:[^\r\n]*$/m)?.[0];
    if (applySummary) summaries.push(applySummary);
  }
  return { lines: summaries, errorLabel };
}

main().catch((error) => fail(error.message));
