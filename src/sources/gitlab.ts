/** GitLab source kind definition, WAL webhook queue consumer loop, and Cordis plugin entry. */
import { existsSync, watch as watchFs, type FSWatcher } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import { KV } from '../kv.ts'
import { GitlabWebhookQueue, webhookQueuePath } from '../webhook/gitlab-queue.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { observeMergeRequestEvent } from './gitlab-mr.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { gitlabAddress, matchesProjectPattern, parseAliases, parseGitlabWebhookEvent, SOURCE } from './gitlab-trigger.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { pause } from './poll.ts'

export { SOURCE, gitlabAddress, gitlabChannel, gitlabPage, matchesProjectPattern, mentionsGitlab, parseGitlabWebhookEvent }
  from './gitlab-trigger.ts'

export const GitlabProjectSchema = z.object({
  path: z.string().trim().min(1),
  listen: z.enum(['mentions', 'all']).default('mentions'),
}).strict()

export const GitlabConfigSchema = GitlabAccountsSchema.extend({
  mentionAliases: z.string().trim().default('@agent, /agent'),
  projects: z.array(GitlabProjectSchema).default([]),
  observeIssues: z.boolean().default(false),
  observeMergeRequests: z.boolean().default(false),
  observeNotes: z.boolean().default(false),
  observePipelines: z.boolean().default(false),
  pollSeconds: z.number().int().min(1).max(300).default(2),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>

const OBSERVED = {
  issues: 'observeIssues',
  merge_requests: 'observeMergeRequests',
  notes: 'observeNotes',
  pipelines: 'observePipelines',
} as const
type Scope = keyof typeof OBSERVED

function scopeOf(meta: Record<string, unknown>): Scope | undefined {
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'merge_requests'
  if (meta.kind === 'note') return 'notes'
  if (meta.kind === 'pipeline' || meta.ci === true) return 'pipelines'
  return undefined
}

const RETENTION_MS = 7 * 24 * 3600_000

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: {
    zh: '自部署 GitLab 实例；通过独立 Webhook 接收多项目与多分组的 Issue、MR、讨论评论和 Pipeline 事件。',
    en: 'Self-hosted GitLab instance; receives multi-project and group Issue, MR, note, and Pipeline events via a standalone Webhook receiver.',
  },
  schema: GitlabConfigSchema,
  fields: [
    {
      key: 'host', type: 'text',
      label: { zh: 'GitLab 地址', en: 'GitLab host URL' },
      hint: { zh: '例如 https://gitlab.example.com。保存时通过 glab 验证登录账号并生成 Webhook 密钥文件，然后重启 dsh-superagent。', en: 'For example https://gitlab.example.com. Saving verifies the glab account, ensures the webhook token file, and restarts dsh-superagent.' },
    },
    {
      key: 'cli', type: 'text',
      label: { zh: '智能体的 GitLab CLI（glab）', en: 'Agent GitLab CLI (glab)' },
      hint: { zh: '命令名或绝对路径（默认 glab）。智能体与执行器都通过它访问 GitLab API，不会覆写本机 SSH 配置。', en: 'Command name or absolute path (default glab). Both the agent and workers call it for GitLab API operations while keeping SSH intact.' },
    },
    {
      key: 'webhook', type: 'fact',
      label: { zh: 'Webhook 接收器', en: 'Webhook receiver' },
    },
    {
      key: 'mentionAliases', type: 'text',
      label: { zh: '额外触发别名', en: 'Extra trigger aliases' },
      hint: { zh: '逗号或空格分隔（如 @agent, /agent）；除 @当前账号 外，评论中出现这些别名也视为显式触发。', en: 'Comma- or space-separated aliases (such as @agent, /agent) that explicitly address the agent in addition to @login.' },
    },
    {
      key: 'projects', type: 'rows',
      label: { zh: '允许监听的项目 / 分组', en: 'Allowed projects / groups' },
      hint: { zh: '支持精确路径（group/repo）、单层通配（group/*）和递归通配（group/**）。未命中的项目 Webhook 会被过滤。', en: 'Supports exact paths (group/repo), single-level wildcards (group/*), and recursive wildcards (group/**). Unmatched projects are filtered.' },
      columns: [
        { key: 'path', type: 'text', label: { zh: '项目或分组模式', en: 'Project or group pattern' } },
        {
          key: 'listen', type: 'select', label: { zh: '接收模式', en: 'Receive' },
          options: [
            { value: 'mentions', label: { zh: '仅 @ / 别名', en: '@ / alias only' } },
            { value: 'all', label: { zh: '全部事件', en: 'All events' } },
          ],
        },
      ],
    },
    {
      key: 'observeIssues', type: 'switch',
      label: { zh: '观察新建 Issue', en: 'Observe new Issues' },
      hint: { zh: '仅对接收模式为「全部事件」的项目生效；全部开关关闭时观察全部类型，打开任意一项时仅观察已勾选的事件类型。', en: 'Applies to projects set to "All events"; when all switches are off every kind is observed, otherwise only enabled kinds are observed.' },
    },
    {
      key: 'observeMergeRequests', type: 'switch',
      label: { zh: '观察新建 MR', en: 'Observe new Merge Requests' },
      hint: { zh: '仅对接收模式为「全部事件」的项目生效。', en: 'Applies to projects set to "All events".' },
    },
    {
      key: 'observeNotes', type: 'switch',
      label: { zh: '观察普通评论', en: 'Observe notes & comments' },
      hint: { zh: '仅对接收模式为「全部事件」的项目生效。', en: 'Applies to projects set to "All events".' },
    },
    {
      key: 'observePipelines', type: 'switch',
      label: { zh: '观察 Pipeline 状态变化', en: 'Observe Pipeline transitions' },
      hint: { zh: '仅对接收模式为「全部事件」的项目生效。', en: 'Applies to projects set to "All events".' },
    },
    {
      key: 'pollSeconds', type: 'number', advanced: true, min: 1, max: 300,
      label: { zh: '队列兜底轮询间隔 / 秒', en: 'Queue fallback poll interval / seconds' },
      hint: { zh: '正常情况下队列文件变动会立即唤醒；此间隔仅作兜底检查。', en: 'Queue file changes wake the consumer immediately; this interval is the fallback check.' },
    },
    {
      key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20,
      label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
    },
  ],
  scope({ meta }, config) {
    const projectPath = typeof meta.projectPath === 'string' ? meta.projectPath : ''
    const matched = projectPath ? config.projects.find(item => matchesProjectPattern(projectPath, item.path)) : undefined
    if (!matched) return { listened: false, reason: 'project_not_listed' }
    const row = scopeOf(meta)
    const anySwitch = Object.values(OBSERVED).some(key => Boolean(config[key]))
    const observed = matched.listen === 'all' && row !== undefined && (!anySwitch || Boolean(config[OBSERVED[row]]))
    return { listened: true, observed, ...(row ? { row } : {}) }
  },
  health: ['gitlab'],
  channel: {
    allowed: (address, config) =>
      !address.projectPath || config.projects.some(item => matchesProjectPattern(address.projectPath!, item.path)),
    send: sendGitlab,
    link: gitlabLink,
  },
  threadContext: gitlabThreadContext,
  find(query) {
    const trimmed = query.trim()
    const directThread = /^(?:gitlab:)?(\d+:(?:issue|mr|pipeline):[^\s]+)$/i.exec(trimmed)
    if (directThread) return { threads: [`${SOURCE}:${directThread[1]!}`], terms: [] }
    const parsedUrl = gitlabAddress(trimmed)
    if (parsedUrl) {
      const ref = `${parsedUrl.projectPath}${parsedUrl.kind === 'mr' ? '!' : '#'}${parsedUrl.iid}`
      return { threads: [], terms: [ref, trimmed] }
    }
    const shortRef = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)([#!])(\d+)$/.exec(trimmed)
    if (shortRef) return { threads: [], terms: [trimmed] }
    return { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/) }).strict()).optional(),
    }).strict(),
    fields: [
      {
        key: 'allowed', type: 'rows',
        label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: '[A-Za-z0-9_.\\-]+' }],
      },
      {
        key: 'bots', type: 'rows',
        label: { zh: '评论可成为候选的 GitLab 机器人', en: 'GitLab bots whose comments may become candidates' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户名', en: 'Username' }, pattern: '[A-Za-z0-9_.\\-]+' }],
      },
    ],
    explicit: {
      zh: '名单里的账号在允许监听的项目中通过 @智能体账号 或触发别名显式请求。',
      en: 'An account on the list mentions the agent account or uses a trigger alias in an allowed project.',
    },
    rows(stored) {
      const config = GitlabConfigSchema.partial().parse(stored)
      const hasAll = (config.projects ?? []).some(project => project.listen === 'all')
      const anySwitch = Object.values(OBSERVED).some(key => Boolean(config[key]))
      const isObserved = (id: Scope): boolean => hasAll && (!anySwitch || Boolean(config[OBSERVED[id]]))
      const note = (observed: boolean) => observed ? { zh: '全部', en: 'All' } : { zh: '仅 @ / 别名', en: '@ / alias only' }
      const row = (id: Scope, label: Localized) => {
        const observed = isObserved(id)
        return {
          id, label, note: note(observed),
          cells: { listedUnaddressed: observed, unlistedAddressed: true, unlistedUnaddressed: observed },
        }
      }
      const pipelinesObserved = isObserved('pipelines')
      return [
        row('issues', { zh: '新 Issue', en: 'New Issues' }),
        row('merge_requests', { zh: '新 MR', en: 'New Merge Requests' }),
        row('notes', { zh: '评论', en: 'Notes' }),
        {
          id: 'pipelines', label: { zh: 'Pipeline 状态变化', en: 'Pipeline transitions' },
          note: pipelinesObserved ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: pipelinesObserved },
        },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '自部署 GitLab 实例地址（如 https://gitlab.example.com）；glab 包装脚本已自动绑定 GITLAB_HOST', en: 'Self-hosted GitLab origin URL (for example https://gitlab.example.com); the glab shim binds GITLAB_HOST automatically' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 用户名；以该账号通过 glab 操作并在开 MR 时把分支末段命名为 DSH_SUPERAGENT_NAME', en: 'The agent\'s GitLab username; use glab under this account and end MR source branches with DSH_SUPERAGENT_NAME' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体 GitLab 账号的提交邮箱；提示词未指定作者时用账号和此邮箱提交', en: 'Commit email of the agent\'s GitLab account; commit with this email when instructions name no other author' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '触发本次工单的 GitLab 项目路径（group/repo）；非 GitLab 工单为空', en: 'GitLab project path (group/repo) that started this ticket; empty for non-GitLab tickets' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT_ID', description: { zh: '触发本次工单的 GitLab 数字项目 ID；用于 REST API v4 和 gitlab/<projectId>/... 资源读取', en: 'Numeric GitLab project ID for this ticket; used for REST API v4 calls and gitlab/<projectId>/... resource reads' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPO_SSH', description: { zh: '目标 GitLab 项目的 SSH 克隆地址；推荐优先用于 git clone / push', en: 'SSH clone URL of the target GitLab project; preferred for git clone and push' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPO_HTTP', description: { zh: '目标 GitLab 项目的 HTTP 克隆地址；非 GitLab 工单为空', en: 'HTTP clone URL of the target GitLab project; empty for non-GitLab tickets' } },
      { key: 'DSH_SUPERAGENT_GITLAB_KIND', description: { zh: '触发工单的对象类型：issue、mr 或 pipeline；非 GitLab 工单为空', en: 'Object kind that started this ticket: issue, mr, or pipeline; empty for non-GitLab tickets' } },
      { key: 'DSH_SUPERAGENT_GITLAB_IID', description: { zh: '触发工单的 Issue 或 MR 编号（IID）；非 Issue/MR 工单为空', en: 'Issue or MR IID that started this ticket; empty when not an Issue or MR' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_REF', description: { zh: 'MR 对应的 git ref（refs/merge-requests/<iid>/head）；非 MR 工单为空', en: 'Git ref refs/merge-requests/<iid>/head for an MR ticket; empty when not an MR' } },
    ],
    values({ deployment, trigger }) {
      const fromGitlab = trigger?.source === SOURCE
      const meta = fromGitlab ? trigger.meta : {}
      const kind = !fromGitlab ? ''
        : meta.kind === 'note' ? (typeof meta.noteableType === 'string' ? meta.noteableType : '')
          : typeof meta.kind === 'string' ? meta.kind : ''
      const iid = fromGitlab && meta.iid != null ? String(meta.iid) : ''
      return {
        DSH_SUPERAGENT_GITLAB_HOST: deployment.gitlab?.host ?? '',
        DSH_SUPERAGENT_GITLAB_ACCOUNT: deployment.gitlab?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: deployment.gitlab?.email ?? '',
        DSH_SUPERAGENT_GITLAB_PROJECT: fromGitlab && typeof meta.projectPath === 'string' ? meta.projectPath : '',
        DSH_SUPERAGENT_GITLAB_PROJECT_ID: fromGitlab && meta.projectId != null ? String(meta.projectId) : '',
        DSH_SUPERAGENT_GITLAB_REPO_SSH: fromGitlab && typeof meta.sshUrl === 'string' ? meta.sshUrl : '',
        DSH_SUPERAGENT_GITLAB_REPO_HTTP: fromGitlab && typeof meta.httpUrl === 'string' ? meta.httpUrl : '',
        DSH_SUPERAGENT_GITLAB_KIND: kind,
        DSH_SUPERAGENT_GITLAB_IID: iid,
        DSH_SUPERAGENT_GITLAB_MR_REF: kind === 'mr' && iid ? `refs/merge-requests/${iid}/head` : '',
      }
    },
  },
  facts: (deployment): Record<string, Localized | string> => deployment?.gitlab ? {
    cli: { zh: `当前账号 @${deployment.gitlab.login}（${deployment.gitlab.host}）`, en: `Current account @${deployment.gitlab.login} (${deployment.gitlab.host})` },
    webhook: {
      zh: `端口 ${deployment.gitlab.webhook.port}（密钥文件 ${deployment.gitlab.webhook.tokenFile}）`,
      en: `Port ${deployment.gitlab.webhook.port} (token file ${deployment.gitlab.webhook.tokenFile})`,
    },
  } : {},
}

/** Reads pending webhook events after `KV.gitlab.cursor`, dispatches triggers and MR events, advances cursor per row, and prunes rows older than 7 days. */
export async function pollGitlabQueue(ctx: SourceContext, signal: AbortSignal): Promise<{ read: number; unreadable: number }> {
  const gitlab = ctx.deployment.gitlab
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!gitlab || !config || signal.aborted) return { read: 0, unreadable: 0 }
  const queuePath = webhookQueuePath(ctx.deployment.stateDir)
  if (!existsSync(queuePath)) return { read: 0, unreadable: 0 }

  const aliases = parseAliases(config.mentionAliases)
  let read = 0
  let unreadable = 0
  let cursor = ctx.state.get(KV.gitlab.cursor) ?? 0
  const queue = new GitlabWebhookQueue(queuePath)
  try {
    const rows = queue.readAfter(cursor, 100)
    for (const row of rows) {
      if (signal.aborted) break
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(row.payload)
      } catch {
        unreadable += 1
        ctx.state.set(KV.gitlab.cursor, row.seq)
        cursor = row.seq
        continue
      }
      const event = parseGitlabWebhookEvent(row.eventType, parsedJson, {
        login: gitlab.login,
        aliases,
        nextPipelineRevision: (projectId, ref, fingerprint) => {
          const prev = ctx.state.get(KV.gitlab.pipeline(projectId, ref))
          if (prev?.fingerprint === fingerprint) return undefined
          const revision = (prev?.revision ?? 0) + 1
          ctx.state.set(KV.gitlab.pipeline(projectId, ref), { fingerprint, revision })
          return revision
        },
      })
      if (event.mrEvent) observeMergeRequestEvent(ctx, event.mrEvent)
      if (event.trigger) {
        await ctx.receive(event.trigger)
        if (event.threadLabel) {
          ctx.threads.describe(threadKey(event.trigger.threads[0]!), {
            label: event.threadLabel,
            ...(event.trigger.url ? { url: event.trigger.url } : {}),
          })
        }
        read += 1
      }
      ctx.state.set(KV.gitlab.cursor, row.seq)
      cursor = row.seq
    }
    if (!signal.aborted && cursor > 0) {
      queue.pruneConsumed(cursor, new Date(Date.now() - RETENTION_MS).toISOString())
    }
  } finally {
    queue.close()
  }
  return { read, unreadable }
}

function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

async function watchQueue(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  if (!ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'sourceOff')); return }

  let wake: (() => void) | undefined
  let watcher: FSWatcher | undefined
  try {
    watcher = watchFs(ctx.deployment.stateDir, (_event, filename) => {
      if (!filename || String(filename).startsWith('gitlab-webhook-queue.sqlite')) wake?.()
    })
    watcher.on('error', () => { /* Fallback polling interval handles recovery if fs.watch fails. */ })
  } catch {
    watcher = undefined
  }

  let failures = 0
  try {
    while (!signal.aborted) {
      const config = ctx.config<GitlabConfig>(SOURCE)
      try {
        if (config) {
          const { read, unreadable } = await pollGitlabQueue(ctx, signal)
          if (!signal.aborted) {
            const detail = read > 0
              ? `Processed ${read} webhook event(s)${unreadable ? `, skipped ${unreadable} unreadable` : ''}`
              : 'Listening for GitLab webhooks'
            ctx.report('gitlab', { state: 'ready', detail, at: new Date().toISOString() })
          }
        } else {
          ctx.report('gitlab', health('paused', 'sourceOff'))
        }
        failures = 0
      } catch (error) {
        failures += 1
        const failed = pollFailure(failures, config?.failuresBeforeError ?? 3, error)
        if (!signal.aborted && failed) ctx.report('gitlab', failed)
      }
      if (signal.aborted) break
      const waitMs = (ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 2) * 1000
      const wakeup = new AbortController()
      wake = () => wakeup.abort()
      await pause(waitMs, AbortSignal.any([signal, wakeup.signal]))
      wake = undefined
    }
  } finally {
    watcher?.close()
  }
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watchQueue(source, controller.signal)
      .catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
