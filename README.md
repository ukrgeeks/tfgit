# tfgit GitHub Action

This action validates a tfgit secret and replaces the checked out workspace contents with the head commit of a pull request. It is designed for workflows started by tfgit through `workflow_dispatch` or `repository_dispatch`.

```yaml
name: tfgit
on:
  workflow_dispatch:
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
        with:
          tfgit_secret: ${{ secrets.TFGIT_SECRET }}
          playbook: dev-eks
          pr_number: ${{ inputs.pr_number }}
          github_token: ${{ github.token }}
```

The action posts `{ "secret": "…", "playbook": "…" }` to `https://tfgit.ukrgeeks.com/api/v1/github-actions/validate` by default. For an accepted secret and playbook, the service should return JSON with `{"valid": true, "pr_number": 123}`. The action uses that PR number to look up and download the PR head. `pull_request_number` is accepted as an alias. An optional `message` is shown when validation fails. Override `service_url` and `validation_path` if the service uses a different route.

If the validation response omits the PR number, it can also be passed as the action's `pr_number` input, as a `workflow_dispatch` input named `pr_number` or `pull_request_number`, or in `repository_dispatch`'s `client_payload` under either name. The action looks up that PR in `GITHUB_REPOSITORY`, then downloads its head archive using `github_token` and extracts it into `GITHUB_WORKSPACE`. Pass a token with `contents: read` and `pull-requests: read`; accessing private fork repositories may require additional access.
