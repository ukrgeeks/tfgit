# tfgit GitHub Action

This action validates a tfgit secret, downloads the head of the pull request selected by tfgit, and posts the playbook output as a PR comment. It is designed for workflows started by tfgit through `workflow_dispatch` or `repository_dispatch`.

The TFgit service dispatches this workflow for pull request lifecycle events and for comments on an open PR by a repository owner, member, or collaborator. Terraform command comments run after the saved setup steps. Comments that do not start with `terraform` get an `Unknown command` reply; the action's own output comment does not trigger another run.

```yaml
name: tfgit
on:
  workflow_dispatch:
    inputs:
      pull_request_number:
        description: Pull request to run against
        required: true
        type: number
      command:
        description: Optional PR comment command (terraform plan, apply, or import)
        required: false
        type: string
        default: ''
permissions:
  contents: read
  pull-requests: write
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: "1.10.5"

      - name: Run tfgit
        uses: ukrgeeks/tfgit@v1
        env:
          GITHUB_TOKEN: ${{ github.token }}
        with:
          tfgit_secret: ${{ secrets.TFGIT_SECRET }}
```

The only action input needed is `tfgit_secret`. tfgit supplies the playbook and PR number. The `GITHUB_TOKEN` environment variable is used internally for GitHub API calls; it is not a `github_token` action input.

Save the secret shown on the signed-in tfgit homepage as the repository Actions secret `TFGIT_SECRET`. The service validates it against the active subscription and returns that user's playbook. The action reads the PR number from the `workflow_dispatch` input or `repository_dispatch` `client_payload.pull_request_number`. For a comment dispatch, the service passes the Terraform command in the optional `command` input and parsed arguments separately. Any Terraform subcommand and its options are accepted. The action executes the arguments without a shell and posts its output as a PR comment. The workflow must declare both inputs as shown above.

By default, the action posts the tfgit secret and GitHub run context to `https://tfgit.ukrgeeks.com/api/v1/github-actions/validate`. On success, the service must return JSON in this shape. `playbook` is an ordered list of shell commands; tfgit runs each command in the downloaded PR workspace, stopping after the first failed command.

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

The action downloads the PR head through the base repository's `pull/<number>/head` ref using `contents: read`, runs the playbook commands in order, and posts each command's output as a PR comment using `pull-requests: write`. If a command fails, later commands are skipped, the output is still commented, and the action fails. Override `service_url` or `validation_path` if the service uses a different endpoint.

After running, the action also reports the run status, URL, and up to 60 KB of command output to `/api/v1/github-actions/report`. This data is displayed only in the owning user's Terraform dashboard.

The playbook is executable shell input and the action checks out/runs the PR head. Do not expose AWS/cloud credentials to this job for untrusted PRs. Review command output before sharing it in PR comments; Terraform output may contain sensitive values.
