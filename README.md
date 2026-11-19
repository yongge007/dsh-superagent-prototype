# dsh-superagent

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-superagent is a proactive coding agent for GitHub and self-hosted GitLab, packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). It listens to GitHub, self-hosted GitLab (via webhooks), and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request or merge request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Self-hosted GitLab Support

`dsh-superagent` supports self-hosted GitLab instances (REST API v4 + `glab` CLI) as a first-class Source (`dsh-superagent/gitlab-watch`), running either **standalone without GitHub** or alongside GitHub and/or Feishu.

### Architecture

- **Standalone Webhook Receiver (`lib/gitlab-webhook.js`)**: Runs as a dedicated HTTP process (default `0.0.0.0:3083`, `POST /hooks/gitlab` and `GET /healthz`) so the DSH management panel stays strictly loopback-only (`127.0.0.1:3082`).
- **Authenticated WAL SQLite Queue**: Verifies `X-Gitlab-Token` in constant time against a `0600` secret file (`<stateDir>/gitlab-webhook.token`), enforces a 2 MiB body limit, deduplicates by `X-Gitlab-Event-UUID`, and appends deliveries to a `0600` WAL-mode queue (`<stateDir>/gitlab-webhook-queue.sqlite`).
- **Managed Lifecycle**: `scripts/dsh-superagent` automatically starts, health-checks (`/healthz`), and gracefully stops the webhook receiver in the profile's `webhook` tmux window whenever `dsh-superagent-gitlab` is enabled.

### Key Capabilities

- **Multi-project & Group Scoping**: Filter incoming webhooks by exact path (`group/repo`), single-level wildcard (`group/*`), or recursive wildcard (`group/**`), with numeric `project_id`-keyed threads (`gitlab:<projectId>:issue:<iid>`, `gitlab:<projectId>:mr:<iid>`, `gitlab:<projectId>:pipeline:<ref>`).
- **Safe Mentions & Shared-Account Loop Guard**: Triggers explicitly on `@<login>` and configurable aliases (default `@agent, /agent`) without false positives on email addresses or URLs. Outbound replies embed a hidden `<!-- dsh-superagent:<messageId> -->` marker so retries stay idempotent and shared accounts never self-trigger.
- **Full MR & Context Workflow**: Reads Issue/MR roots, paginated notes, inline MR diff discussions, and `gitlab/*` resources via `glab api`; tracks MR lifecycle events (`merged`/`closed`); injects a `glab` worker shim (`GITLAB_HOST` + `NO_PROMPT=1`) and `DSH_SUPERAGENT_GITLAB_*` environment variables while keeping SSH (`~/.ssh/config`) intact.

### Quick Setup for Self-hosted GitLab

1. **Authenticate `glab`**: Sign in on the host machine against your GitLab instance (for example `glab auth login --hostname gitlab.example.com`) and verify `glab api user` succeeds.
2. **Enable the GitLab Source**: In `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (see [examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml)), enable `dsh-superagent-gitlab` (and optionally disable `dsh-superagent-github` for GitLab-only mode):

   ```yaml
   - id: dsh-superagent
     config:
       stateDir: /path/to/state/superagent
       gitlabWebhookHost: 0.0.0.0
       gitlabWebhookPort: 3083
   - id: dsh-superagent-gitlab
     disabled: false
   - id: dsh-superagent-github
     disabled: true
   ```

3. **Start & Configure in the Panel**: Start the service with `scripts/dsh-superagent start --profile <profile>`. Open the DSH panel (**Settings → Sources → GitLab**), set your GitLab instance URL (e.g. `https://gitlab.example.com`), `glab` path, and allowed project patterns (`group/repo`, `group/*`, `group/**`), then add allowed GitLab usernames under **Policy**.
4. **Configure the GitLab Webhook**: In your GitLab Project or Group **Settings → Webhooks**:
   - **URL**: `http://<host-ip>:3083/hooks/gitlab`
   - **Secret token**: copy from `<stateDir>/gitlab-webhook.token` (created automatically with mode `0600`)
   - **Triggers**: check `Comments`, `Issues events`, and `Merge request events` (optional: `Pipeline events`)

## Setup

Setup has many steps, so an agent does it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
