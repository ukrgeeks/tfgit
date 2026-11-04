const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');

const MAX_STORAGE_ARCHIVE_BYTES = 1024 * 1024 * 1024;
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
  const playbookName = validation.playbook_name || 'Default';
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
  if (typeof playbookName !== 'string' || !/^[A-Za-z0-9]{1,32}$/.test(playbookName)) {
    fail('tfgit response playbook_name must contain 1–32 letters or digits.');
  }
  if (typeof validation.terraform_backend !== 'string' || validation.terraform_backend.length > 20000) {
    fail('tfgit response terraform_backend must be a string of at most 20,000 characters.');
  }
  const backendEnabled = validation.terraform_backend_enabled === true;
  if (validation.terraform_backend_enabled !== undefined && typeof validation.terraform_backend_enabled !== 'boolean') {
    fail('tfgit response terraform_backend_enabled must be a boolean.');
  }

  const pullRequest = await getPullRequestDetails(owner, repo, prNumber, apiHeaders);
  console.log(`Using playbook: ${playbookName}.`);
  const pullRequestEnvironment = {
    GITHUB_REPO_NAME: repo,
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
  const expandedCommandArgs = requestedCommand
    ? commandArgs.map((argument) => argument
      .replaceAll('${GITHUB_PR_BASE_BRANCH}', pullRequestEnvironment.GITHUB_PR_BASE_BRANCH)
      .replaceAll('${GITHUB_REPO_NAME}', pullRequestEnvironment.GITHUB_REPO_NAME))
    : [];
  for (const [name, value] of Object.entries(pullRequestEnvironment)) {
    process.env[name] = String(value).replaceAll('\0', '');
  }
  console.log(`Loaded pull request metadata for PR #${pullRequestEnvironment.GITHUB_PR_NUMBER}.`);

  const expandedCommentCommand = requestedCommand
    ? `terraform ${expandedCommandArgs.map((argument) => /\s/.test(argument) ? JSON.stringify(argument) : argument).join(' ')}`
    : '';
  const mainPlaybook = requestedCommand ? [expandedCommentCommand] : playbook;
  const commentCommandIndex = requestedCommand ? 0 : -1;
  const planIsRequested = [...prePlaybook, ...mainPlaybook, ...postPlaybook]
    .some((item) => /^\s*terraform\s+plan(?:\s|$)/i.test(item));
  const applyIsRequested = [...prePlaybook, ...mainPlaybook, ...postPlaybook]
    .some((item) => /^\s*terraform\s+apply(?:\s|$)/i.test(item));
  const useSavedWorkspace = applyIsRequested && !planIsRequested;
  if (useSavedWorkspace) {
    const restored = await restoreWorkspace(serviceUrl, validation.storage_token, workspace, prNumber,
      pullRequestEnvironment.GITHUB_PR_HEAD_SHA, secret, repoFullName);
    if (restored.missing) {
      await reportRunState(serviceUrl, {
        secret,
        repository: repoFullName,
        pull_request_number: Number(prNumber),
        run_id: process.env.GITHUB_RUN_ID || '',
        run_attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
        status: 'failure',
        output: 'There is no saved plan for this pull request. Please execute `terraform plan` first.',
        run_url: `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`,
        plan_ready: false,
        apply_success: false,
      });
      await postPullRequestComment(owner, repo, prNumber, apiHeaders,
        'There is no saved plan for this pull request. Please execute `terraform plan` first.');
      fail('No saved plan was found for this pull request. Run terraform plan first.');
    }
    if (restored.error) fail(`Could not restore the saved Terraform workspace: ${restored.error}`);
  } else {
    console.log(`Fetching pull request ${prNumber} head ${pullRequestEnvironment.GITHUB_PR_HEAD_SHA} into the runner workspace.`);
    const checkoutError = await checkoutPullRequestHead(owner, repo, pullRequestEnvironment.GITHUB_PR_HEAD_SHA,
      apiHeaders, workspace);
    if (checkoutError) fail(`Could not fetch the pull request workspace: ${checkoutError}`);
  }

  if (backendEnabled) {
    const baseBranch = pullRequestEnvironment.GITHUB_PR_BASE_BRANCH;
    const hclString = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const backendConfig = validation.terraform_backend
      .replaceAll('${path.module}', hclString(workspace))
      .replaceAll('${GITHUB_REPO_NAME}', hclString(repo))
      .replaceAll('${GITHUB_PR_BASE_BRANCH}', hclString(baseBranch))
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
  if (planIsRequested && validation.storage_token) {
    const clearError = await clearWorkspaceBeforePlan(serviceUrl, validation.storage_token);
    if (clearError) fail(`Could not invalidate the previous saved plan before starting Terraform plan: ${clearError}`);
  }
  const commandEnvironment = { ...process.env };
  delete commandEnvironment.TFGIT_SECRET;
  delete commandEnvironment.INPUT_TFGIT_SECRET;
  delete commandEnvironment.GITHUB_TOKEN;
  const steps = runPlaybook(prePlaybook, mainPlaybook, postPlaybook, workspace,
    expandedCommandArgs, commentCommandIndex, commandEnvironment);
  const playbookOutput = formatPlaybookOutput(steps).replaceAll(secret, '[REDACTED]');
  const runUrl = `https://github.com/${repoFullName}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const runStatus = steps.some((step) => step.status !== 'success') ? 'failure' : 'success';
  let storageTransferFailed = false;
  const planSteps = steps.filter((step) => /^\s*terraform\s+plan(?:\s|$)/i.test(step.command));
  const successfulPlan = planSteps.length > 0 && planSteps.at(-1).status === 'success';
  const applySteps = steps.filter((step) => /^\s*terraform\s+apply(?:\s|$)/i.test(step.command));
  const successfulApply = applySteps.length > 0 && applySteps.at(-1).status === 'success';
  if (successfulPlan) {
    const storageError = await saveWorkspace(serviceUrl, validation.storage_token, workspace,
      pullRequestEnvironment.GITHUB_PR_HEAD_SHA, secret, repoFullName, prNumber);
    if (storageError) {
      storageTransferFailed = true;
      console.error(`::warning::Could not save the Terraform workspace: ${storageError}`);
      await postPullRequestComment(owner, repo, prNumber, apiHeaders,
        'TFgit could not save this plan workspace. Apply will be unavailable until a plan is saved successfully.');
    }
  }
  if (successfulApply) await deleteWorkspace(serviceUrl, validation.storage_token);
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
          : (planIsRequested ? successfulPlan && !storageTransferFailed : null),
        apply_success: applyIsRequested ? successfulApply : (planIsRequested ? false : null),
        output: (storageTransferFailed
          ? `${playbookOutput}\n\nTFgit could not save the workspace; apply is unavailable until a plan is saved successfully.`
          : playbookOutput).slice(0, 60000),
        run_url: runUrl,
      }),
    });
    if (!reportResponse.ok) console.error(`::warning::Could not save the Terraform run output in the tfgit dashboard (HTTP ${reportResponse.status}).`);
  } catch (error) {
    console.error(`::warning::Could not reach the tfgit dashboard to save run output: ${error.message}`);
  }
  const commentSummaries = summarizeTerraformResults(steps);
  const commentBodies = buildOutputComments(playbookOutput, runUrl, expandedCommentCommand || requestedCommand,
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
  if (storageTransferFailed) fail('The Terraform plan succeeded, but TFgit could not save its workspace for apply.');
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
  return new URL('/storage', serviceUrl);
}

async function restoreWorkspace(serviceUrl, storageToken, workspace, prNumber, headSha, secret, repoFullName) {
  if (!storageToken) return { error: 'storage is not configured; set STORAGE_SECRET on the backend and storage service' };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfgit-storage-'));
  const encryptedArchive = path.join(tempDir, 'workspace.tfgit.enc');
  const archive = path.join(tempDir, 'workspace.tar.gz');
  try {
    const result = spawnSync('curl', [
      '--silent', '--show-error', '--location', '--max-filesize', String(MAX_STORAGE_ARCHIVE_BYTES),
      '--output', encryptedArchive, '--write-out', '%{http_code}',
      '-H', `Authorization: Bearer ${storageToken}`, '-H', `X-TFgit-PR-Head-SHA: ${headSha}`,
      storageUrl(serviceUrl).toString(),
    ], { encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
    if (result.error) return { error: result.error.message };
    const status = Number(result.stdout.trim());
    if (status === 404) return { missing: true };
    if (result.status !== 0 || status !== 200) return { error: `storage returned HTTP ${status || result.status}` };
    if (fs.statSync(encryptedArchive).size > MAX_STORAGE_ARCHIVE_BYTES) return { error: 'encrypted archive exceeds the 1 GiB limit' };
    await decryptArchive(encryptedArchive, archive, secret, archiveScope(repoFullName, prNumber, headSha));
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', timeout: 2 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
    if (listing.error || listing.status !== 0) return { error: 'could not inspect the saved workspace archive' };
    const entries = listing.stdout.split('\n').filter(Boolean);
    if (!entries.length || entries.some((entry) => path.isAbsolute(entry) || entry.includes('\\') || entry.split('/').includes('..'))) {
      return { error: 'archive contains an unsafe path' };
    }
    clearWorkspaceContents(workspace);
    const extract = spawnSync('tar', ['-xzf', archive, '-C', workspace, '--no-same-owner', '--no-same-permissions'], {
      encoding: 'utf8', timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024,
    });
    if (extract.error || extract.status !== 0) return { error: extract.stderr || 'archive extraction failed' };
    console.log(`Restored saved files for PR #${prNumber} before the pre-playbook.`);
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

async function saveWorkspace(serviceUrl, storageToken, workspace, headSha, secret, repoFullName, prNumber) {
  if (!storageToken) return 'storage is not configured; set STORAGE_SECRET on the backend and storage service';
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tfgit-storage-'));
  const archive = path.join(tempDir, 'workspace.tar.gz');
  const encryptedArchive = path.join(tempDir, 'workspace.tfgit.enc');
  try {
    const filesList = path.join(tempDir, 'files.list');
    const files = collectWorkspaceFiles(workspace);
    if (!files.length) return 'the workspace contains no regular files to save';
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
    console.log('Saved the Terraform workspace; it is available for 30 minutes.');
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

async function decryptArchive(inputPath, outputPath, secret, scope) {
  const header = Buffer.alloc(ENCRYPTED_ARCHIVE_HEADER_SIZE);
  const descriptor = fs.openSync(inputPath, 'r');
  let bytesRead;
  try {
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (bytesRead !== header.length || !header.subarray(0, ENCRYPTED_ARCHIVE_MAGIC.length).equals(ENCRYPTED_ARCHIVE_MAGIC)) {
    throw new Error('saved workspace archive has an invalid encryption header');
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
    throw new Error('could not decrypt the saved workspace archive; verify TFgit secret and PR revision');
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function collectWorkspaceFiles(workspace) {
  const root = path.resolve(workspace);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
    }
  };
  visit(root);
  return files.sort();
}

async function deleteWorkspace(serviceUrl, storageToken) {
  if (!storageToken) return;
  try {
    const response = await fetch(storageUrl(serviceUrl), {
      method: 'DELETE', headers: { authorization: `Bearer ${storageToken}` },
    });
    if (!response.ok) console.error(`::warning::Could not remove saved workspace after apply (HTTP ${response.status}).`);
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
      return 'HTTP 404 from the storage endpoint; route /storage directly to the storage service, preserve the path, and ensure the deployed service has DELETE /storage. The storage API returns HTTP 200 when the PR folder is already absent';
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

function runPlaybook(prePlaybook, playbook, postPlaybook, workspace, commandArgs = [], commentCommandIndex = -1,
  commandEnvironment = process.env) {
  const results = [];
  const runStage = (commands, stage) => {
    if (commands.length === 0) {
      console.log(`Running tfgit ${stage} step 1/1: list is empty`);
      return true;
    }
    for (const [index, command] of commands.entries()) {
      const stageLabel = stage === 'playbook' ? 'playbook step' : `${stage} steps`;
      console.log(`Running tfgit ${stageLabel} ${index + 1}/${commands.length}: ${command}`);
      const result = stage === 'playbook' && index === commentCommandIndex
        ? spawnSync('terraform', commandArgs, {
          cwd: workspace,
          env: commandEnvironment,
          shell: false,
          encoding: 'utf8',
          maxBuffer: 20 * 1024 * 1024,
          timeout: 30 * 60 * 1000,
        })
        : spawnSync(command, {
          cwd: workspace,
          env: commandEnvironment,
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

function summarizeTerraformResults(steps) {
  const summaries = [];
  const failedPlan = steps.find((step) => step.status !== 'success' && /^\s*terraform\s+plan(?:\s|$)/i.test(step.command));
  const failedApply = steps.find((step) => step.status !== 'success' && /^\s*terraform\s+apply(?:\s|$)/i.test(step.command));
  const errorLabel = failedPlan ? 'Plan Error' : failedApply ? 'Apply Error' : '';
  const planSummaryPattern = /Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy\./i;
  const successfulPlan = steps.find((step) => step.status === 'success'
    && /^\s*terraform\s+plan(?:\s|$)/i.test(step.command));
  if (successfulPlan) {
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
      summaries.push('```text\nterraform apply\n```');
    }
  }

  const successfulApply = steps.find((step) => step.status === 'success' && /^\s*terraform\s+apply(?:\s|$)/i.test(step.command));
  if (successfulApply) {
    const applySummary = successfulApply.output.match(/^Apply complete! Resources:[^\r\n]*$/m)?.[0];
    if (applySummary) summaries.push(applySummary);
  }
  return { lines: summaries, errorLabel };
}

main().catch((error) => fail(error.message));
