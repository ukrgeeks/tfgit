# tfgit GitHub Action

This action validates a tfgit secret, runs the playbook in the checked-out pull request head, and posts the playbook output as a PR comment. It is designed for workflows started by tfgit through `workflow_dispatch` or `repository_dispatch`.

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
      - uses: actions/checkout@v4
        with:
          ref: refs/pull/${{ inputs.pull_request_number }}/head

      - uses: hashicorp/setup-terraform@v4
        with:
          terraform_version: "1.10.5"

      # Configure cloud credentials here if Terraform needs them.
      - name: Run tfgit playbook
        uses: ukrgeeks/tfgit@main
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          tfgit_secret: ${{ secrets.TFGIT_SECRET }}
```

The only action input needed is `tfgit_secret`. tfgit supplies the playbook and PR number. The `GITHUB_TOKEN` environment variable is used internally for GitHub API calls; it is not a `github_token` action input.

Save the secret shown on the signed-in tfgit homepage as the repository Actions secret `TFGIT_SECRET`. The service validates it against the active subscription and returns that user's playbook. The action reads the PR number from the `workflow_dispatch` input or `repository_dispatch` `client_payload.pull_request_number`. For a comment dispatch, the service passes the one-line Terraform command in the optional `tfgit_playbook` input and parsed arguments separately. Any Terraform subcommand and its options are accepted. The action executes the arguments without a shell and posts its output as a PR comment. The workflow must declare both inputs as shown above.

By default, the action posts the tfgit secret and GitHub run context to `https://tfgit.ukrgeeks.com/api/v1/github-actions/validate`. On success, the service must return JSON in this shape. `playbook` is an ordered list of shell commands; tfgit runs each command in the checked-out PR workspace, stopping after the first failed command.

```json
{
  "valid": true,
  "playbook": [
    "terraform init",
    "terraform plan -var-file=env/dev.tfvars"
  ],
  "pr_number": 123
}
```

The workflow must check out `refs/pull/<number>/head` using `actions/checkout` before calling the action; this is the PR's feature branch head, not the workflow dispatch branch. The action writes the user's Terraform backend configuration to `backend.tf` only when backend generation is enabled in the TFgit Backend page (off by default). When enabled, it replaces an existing file in the temporary checkout; when disabled, the checked-out `backend.tf` remains untouched. The Backend page also supports repository-specific exact, wildcard, and regex overrides using the same match priority as playbooks. A matching repository rule supplies both the HCL contents and its own enabled setting; if the matching rule is disabled, the checked-out `backend.tf` is left untouched. It replaces `${path.module}` with the checked-out workspace, `${BASE_REPO_NAME}` with the repository name, `${BASE_BRANCH_NAME}` with the pull request's target branch (looked up through GitHub's pull-request API), and `${AWS_DEFAULT_REGION}` with the Action environment value. Grant `pull-requests: write` so the action can read PR metadata and post comments. If using the supplied S3 backend example, expose `AWS_DEFAULT_REGION` in the workflow environment. The action runs in the checked-out workspace, executes playbook commands in order, and posts the output as one or more PR comments. ANSI terminal color/control sequences are removed from command output. The final output comment shows Terraform plan totals when a plan command was run, or the apply resource summary when apply succeeded. Failed Terraform plan/apply commands are labeled **Plan Error** or **Apply Error** on the output comments. Full logs remain collapsed; click **Show Output** to expand them. Long output is split into parts instead of being truncated in the PR comments. If a command fails, later commands are skipped, the output is still commented, and the action fails. Override `service_url` or `validation_path` if the service uses a different endpoint.

After running, the action also reports the run status, URL, and up to 60 KB of command output to `/api/v1/github-actions/report`. This data is displayed only in the owning user's Terraform dashboard.

The playbook is executable shell input and runs against the PR head. Do not expose AWS/cloud credentials to this job for untrusted PRs. Review command output before sharing it in PR comments; Terraform output may contain sensitive values.
