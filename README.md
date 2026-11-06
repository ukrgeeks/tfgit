# tfgit GitHub Action

This action validates a tfgit secret, prepares the pull request workspace, runs the playbook, and posts the playbook output as a PR comment. It is designed for workflows started by tfgit through `workflow_dispatch` or `repository_dispatch`.

When a PR opens, TFgit dispatches the workflow with no command, so the action runs the default playbook saved on tfgit.ukrgeeks.com. On an open PR, a repository owner, member, or collaborator can comment one single-line command beginning with `terraform`, such as `terraform plan -var-file=env/dev.tfvars`; TFgit runs the saved setup steps followed by that command. Multiline Terraform commands are rejected and not dispatched. Comments that do not start with `terraform` get an `Unknown command` reply; the action's own output comment does not trigger another run.

```yaml
name: tfgit
on:
  workflow_dispatch:
    inputs:
      pull_request_number:
        description: Pull request number selected by tfgit
        required: true
        type: number
      tfgit_playbook:
        description: Terraform command from a PR comment
        required: false
        type: string
        default: ""
permissions:
  contents: read
  pull-requests: write
jobs:
  terraform:
    runs-on: ubuntu-latest
    steps:
      - name: Run tfgit playbook
        uses: ukrgeeks/tfgit@main
        env:
          GITHUB_TOKEN: ${{ github.token }}
          TFGIT_URL: https://tfgit.ukrgeeks.com
          TFGIT_SECRET: ${{ secrets.TFGIT_SECRET }}
          # Optional: set one of these to pin the CLI version selected in TFgit Home.
          # TERRAFORM_VERSION: "1.10.5"
          # TOFU_VERSION: "1.10.0"
          # AWS credentials (uncomment and add these secrets to the repository):
          # AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
          # AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
          # AWS_DEFAULT_REGION: ${{ vars.AWS_DEFAULT_REGION }}
          # Azure service principal credentials (uncomment and add these secrets):
          # ARM_CLIENT_ID: ${{ secrets.ARM_CLIENT_ID }}
          # ARM_CLIENT_SECRET: ${{ secrets.ARM_CLIENT_SECRET }}
          # ARM_SUBSCRIPTION_ID: ${{ secrets.ARM_SUBSCRIPTION_ID }}
          # ARM_TENANT_ID: ${{ secrets.ARM_TENANT_ID }}
```

Set the default engine on **Playbooks → Default** and optionally override it on any repository playbook. Repository playbooks inherit the Default engine unless explicitly set. Available modes are Terraform, OpenTofu, and Custom. Terraform and OpenTofu modes install the latest CLI release by default and verify its SHA-256 checksum; pin a version with `TERRAFORM_VERSION` or `TOFU_VERSION`. Custom mode skips CLI installation and starts with empty pre-, main, and post-playbook commands so you can configure your own tools and commands. In OpenTofu mode, TFgit provides both `tofu` and `terraform` executable names, so existing playbook commands such as `terraform plan` continue to run using OpenTofu. Set `TFGIT_SECRET` from the repository Actions secret and `TFGIT_URL` to your TFgit service URL in the step environment. These can also be provided as action inputs (`tfgit_secret` and `service_url`) for compatibility. TFgit supplies the playbook and PR number. Before running commands, the action reads the PR through GitHub’s API and exports `GITHUB_PR_NUMBER`, `GITHUB_PR_BASE_BRANCH`, `GITHUB_PR_HEAD_BRANCH`, `GITHUB_PR_TITLE`, `GITHUB_PR_URL`, `GITHUB_PR_STATE`, `GITHUB_PR_AUTHOR`, `GITHUB_PR_BASE_REPOSITORY`, `GITHUB_PR_HEAD_REPOSITORY`, `GITHUB_PR_BASE_SHA`, `GITHUB_PR_HEAD_SHA`, and `GITHUB_PR_IS_DRAFT` to each playbook command. Use them like shell environment variables, for example `echo "$GITHUB_PR_BASE_BRANCH"`. The `GITHUB_TOKEN` environment variable is used internally for GitHub API calls; it is not a `github_token` action input.

Save the secret shown on the signed-in tfgit homepage as the repository Actions secret `TFGIT_SECRET`. The service validates it against the active subscription and returns that user's playbook. The action reads the PR number from the `workflow_dispatch` input or `repository_dispatch` `client_payload.pull_request_number`. For a comment dispatch, the service passes the one-line Terraform command in the optional `tfgit_playbook` input and parsed arguments separately. Any Terraform subcommand and its options are accepted. The action executes the arguments without a shell and posts its output as a PR comment. The workflow must declare both inputs as shown above.

By default, the action posts the tfgit secret and GitHub run context to `https://tfgit.ukrgeeks.com/api/v1/github-actions/validate`. On success, the service must return JSON in this shape. `playbook_name` is `Default` or the selected repository playbook's name. The action prints the selected name in the workflow log. `playbook` is an ordered list of shell commands; tfgit runs each command in the PR workspace, stopping after the first failed command.

```json
{
  "valid": true,
  "tfgit_mode": "terraform",
  "playbook": [
    "terraform init",
    "terraform plan -var-file=env/dev.tfvars"
  ],
  "playbook_name": "Default",
  "pr_number": 123
}
```

The workflow does not need an `actions/checkout` step. For PR-open and plan runs, the action fetches the exact PR head SHA into the runner workspace using `GITHUB_TOKEN`. For an apply-only run, it restores the saved workspace archive instead. This keeps apply tied to the same PR head that produced the plan. Grant `contents: read` and `pull-requests: write` so the action can fetch repository contents, read PR metadata, and post comments. The action writes the user's Terraform backend configuration to `backend.tf` only when backend generation is enabled in the TFgit Backend page (off by default). When enabled, it replaces an existing file in the prepared workspace; when disabled, the PR's `backend.tf` remains untouched. The Backend page also supports repository-specific exact, wildcard, and regex overrides using the same match priority as playbooks. A matching repository rule supplies both the HCL contents and its own enabled setting; if the matching rule is disabled, the PR's `backend.tf` is left untouched. It replaces `${path.module}` with the runner workspace, `${BASE_REPO_NAME}` with the repository name, `${BASE_BRANCH_NAME}` with the pull request's target branch (looked up through GitHub's pull-request API), and `${AWS_DEFAULT_REGION}` with the Action environment value. If using the supplied S3 backend example, expose `AWS_DEFAULT_REGION` in the workflow environment. The action executes playbook commands in order and streams command output into the GitHub Actions runner log while also posting it as one or more PR comments. Terraform `plan` and `apply` commands automatically include `-input=false`; `apply` also includes `-auto-approve`. This prevents interactive prompts; missing variable input causes a clear command failure. ANSI terminal color/control sequences are removed from PR comments. The final output comment shows Terraform plan totals when a plan command was run, or the apply resource summary when apply succeeded. Failed Terraform plan/apply commands are labeled **Plan Error** or **Apply Error** on the output comments. Full logs remain collapsed; click **Show Output** to expand them. Long output is split into parts instead of being truncated in the PR comments. If a command fails, later commands are skipped, the output is still commented, and the action fails. Override `service_url` or `validation_path` if the service uses a different endpoint.

After running, the action also reports the run status, URL, and up to 60 KB of command output to `/api/v1/github-actions/report`. This data is displayed only in the owning user's Terraform dashboard.

The Action transfers the runner workspace through `https://tfgit.ukrgeeks.com/storage` when storage is enabled. Before starting any playbook containing `terraform plan`, it deletes the previous workspace for that PR. After a successful plan, it archives regular workspace files (excluding `.git` and symlinks) and encrypts the archive locally using an AES-256-GCM key derived from `TFGIT_SECRET`, repository, PR number, and PR head SHA. The TFgit secret and the Action's `GITHUB_TOKEN` are removed from the environment passed to Terraform and other playbook subprocesses. Only encrypted bytes are uploaded; TFgit storage cannot decrypt them. This prevents a later apply from restoring an older successful plan if a newer plan fails or is cancelled. Before apply, the Action downloads and decrypts the workspace before pre-playbook commands. Storage is scoped to the TFgit account, GitHub organization/repository, PR, and PR head SHA; downloads expire after 1 hour. If no saved workspace exists, it expired, or the PR head changed, the Action comments that `terraform plan` must run first. The workflow never receives the storage service's shared secret; the validation response contains a scoped token. Changing `TFGIT_SECRET` invalidates stored archives; run a new plan after rotating it. The ingress should route `/storage` directly to the storage Service and preserve the path.

The playbook is executable shell input and runs against the PR head. Do not expose AWS/cloud credentials to this job for untrusted PRs. Review command output before sharing it in PR comments; Terraform output may contain sensitive values.

The action also exports `GITHUB_REPO_NAME` (the repository name without its owner) to every playbook command. Backend templates can use `${GITHUB_REPO_NAME}`, `${GITHUB_PR_BASE_REPOSITORY}`, `${GITHUB_PR_BASE_BRANCH}`, `${TFGIT_USERNAME}`, and `${TFGIT_SECRET}` as placeholders; TFgit replaces them with the repository name, PR target repository, PR target branch, signed-in TFgit username, and configured secret when generating `backend.tf`. `${TFGIT_STATE_BRANCH}` is replaced with the PR target branch in the generated local state filename.

The default TFgit state backend is Terraform's local backend with a repository/base-branch-specific state filename. Before the pre-playbook, the Action downloads any saved state file from `/storage/tfstate/{owner}/{repository}/{base-branch}`. After `TFGIT_SECRET` validation, the Action uses a short-lived token scoped to that customer/repository/base branch to upload and download state. State is isolated by customer, repository, and base branch; the Backends → TFstate page lists metadata without exposing state contents. State files previously stored by the HTTP backend remain readable at the same path.
