import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Engine, type Assessor, type Executor, type OutboundMessage, type Ticket, type Trigger } from '../src/core/index.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { CliError, Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { GitlabWebhookQueue, webhookQueuePath } from '../src/webhook/gitlab-queue.ts'
import { botMarker, gitlabAddress, gitlabChannel, hasBotMarker, matchesProjectPattern, mentionsGitlab, parseGitlabWebhookEvent } from '../src/sources/gitlab-trigger.ts'
import { gitlabLink, sendGitlab } from '../src/sources/gitlab-channel.ts'
import { gitlabThreadContext, readGitlab, readGitlabRepositoryPath } from '../src/sources/gitlab-read.ts'
import { claimMergeRequest, mrEndNotices, mrOf, observeMergeRequestEvent } from '../src/sources/gitlab-mr.ts'
import { apply as applyGitlab, gitlabKind, pollGitlabQueue } from '../src/sources/gitlab.ts'
import { testDeployment } from './fixtures/deployment.ts'

describe('gitlab project matching & mention/loop detection', () => {
  it('matches exact paths, single-level group/*, and recursive group/** case-insensitively', () => {
    expect(matchesProjectPattern('Team/Repo-A', 'team/repo-a')).toBe(true)
    expect(matchesProjectPattern('team/repo-a', 'team/repo-b')).toBe(false)
    expect(matchesProjectPattern('team/repo-a', 'team/*')).toBe(true)
    expect(matchesProjectPattern('team/sub/repo-a', 'team/*')).toBe(false)
    expect(matchesProjectPattern('team/repo-a', 'team/**')).toBe(true)
    expect(matchesProjectPattern('team/sub/deep/repo-a', 'team/**')).toBe(true)
    expect(matchesProjectPattern('team2/repo-a', 'team/**')).toBe(false)
  })

  it('detects @login and configured aliases without false positives on emails or URLs', () => {
    const aliases = ['@agent', '/agent']
    expect(mentionsGitlab('请 @agent-bot 帮忙修复', 'agent-bot', aliases)).toBe(true)
    expect(mentionsGitlab('@agent fix this bug', 'agent-bot', aliases)).toBe(true)
    expect(mentionsGitlab('/agent fix this bug', 'agent-bot', aliases)).toBe(true)
    expect(mentionsGitlab('line1\n/agent fix', 'agent-bot', aliases)).toBe(true)
    expect(mentionsGitlab('contact user@agent-bot.example.com for help', 'agent-bot', aliases)).toBe(false)
    expect(mentionsGitlab('see https://gitlab.example.com/team/agent/issues/1', 'agent-bot', aliases)).toBe(false)
    expect(mentionsGitlab('looks good to me', 'agent-bot', aliases)).toBe(false)
  })

  it('unconditionally drops comments containing bot marker even when quoting @agent-bot or /agent', () => {
    const text = `> @agent-bot /agent fix this\n\n已收到。\n\n${botMarker('ack-1')}`
    expect(hasBotMarker(text)).toBe(true)
    const parsed = parseGitlabWebhookEvent('Note Hook', {
      object_kind: 'note',
      user: { username: 'agent-bot', bot: false },
      project: { id: 42, path_with_namespace: 'team/repo', git_ssh_url: 'git@gitlab.example.com:team/repo.git', git_http_url: 'https://gitlab.example.com/team/repo.git', web_url: 'https://gitlab.example.com/team/repo' },
      object_attributes: { id: 99, note: text, noteable_type: 'Issue', created_at: '2026-11-19T02:00:00Z', updated_at: '2026-11-19T02:00:00Z', url: 'https://gitlab.example.com/team/repo/-/issues/5#note_99' },
      issue: { iid: 5, title: 'Bug', url: 'https://gitlab.example.com/team/repo/-/issues/5' },
    }, { login: 'agent-bot', aliases: ['@agent', '/agent'] })
    expect(parsed.trigger).toBeUndefined()
  })

  it('allows shared personal account agent-bot without bot marker to trigger explicitly, and keeps unaddressed comments unaddressed', () => {
    const base = {
      object_kind: 'note',
      user: { username: 'agent-bot', bot: false },
      project: { id: 42, path_with_namespace: 'team/repo', git_ssh_url: 'git@gitlab.example.com:team/repo.git', git_http_url: 'https://gitlab.example.com/team/repo.git', web_url: 'https://gitlab.example.com/team/repo' },
      merge_request: { iid: 12, title: 'Feat', source_branch: 'feat/x', target_branch: 'main', url: 'https://gitlab.example.com/team/repo/-/merge_requests/12' },
    }
    const explicit = parseGitlabWebhookEvent('Note Hook', {
      ...base,
      object_attributes: { id: 101, note: '@agent-bot 请补单元测试', noteable_type: 'MergeRequest', discussion_id: 'disc-1', created_at: '2026-11-19T02:00:00Z', updated_at: '2026-11-19T02:00:00Z', url: 'https://gitlab.example.com/team/repo/-/merge_requests/12#note_101', position: { new_path: 'src/a.ts', new_line: 14 } },
    }, { login: 'agent-bot', aliases: ['@agent', '/agent'] })
    expect(explicit.trigger?.human).toBe(true)
    expect(explicit.trigger?.addressed).toBe('mention')
    expect(explicit.trigger?.threads).toEqual([{ source: 'gitlab', id: '42:mr:12' }])
    expect(explicit.trigger?.text).toContain('src/a.ts:14')
    expect(explicit.trigger?.channel?.address).toMatchObject({ projectId: '42', projectPath: 'team/repo', kind: 'mr', iid: '12', discussionId: 'disc-1' })

    const plain = parseGitlabWebhookEvent('Note Hook', {
      ...base,
      object_attributes: { id: 102, note: '这里变量名可以更清晰', noteable_type: 'MergeRequest', created_at: '2026-11-19T02:01:00Z', updated_at: '2026-11-19T02:01:00Z', url: 'https://gitlab.example.com/team/repo/-/merge_requests/12#note_102' },
    }, { login: 'agent-bot', aliases: ['@agent', '/agent'] })
    expect(plain.trigger?.human).toBe(true)
    expect(plain.trigger?.addressed).toBeUndefined()
  })

  it('parses Issue Hook, Merge Request Hook lifecycle events, and URL addresses', () => {
    expect(gitlabAddress('https://gitlab.example.com/team/sub/repo/-/merge_requests/7#note_3', 'https://gitlab.example.com'))
      .toEqual({ projectPath: 'team/sub/repo', kind: 'mr', iid: 7 })
    const mrMerged = parseGitlabWebhookEvent('Merge Request Hook', {
      object_kind: 'merge_request',
      user: { username: 'agent-bot' },
      project: { id: 42, path_with_namespace: 'team/repo', git_ssh_url: 'git@gitlab.example.com:team/repo.git', git_http_url: 'https://gitlab.example.com/team/repo.git', web_url: 'https://gitlab.example.com/team/repo' },
      object_attributes: { iid: 12, title: 'Fix', state: 'merged', action: 'merge', source_branch: 'agent/fix-abc', target_branch: 'main', url: 'https://gitlab.example.com/team/repo/-/merge_requests/12', updated_at: '2026-11-19T03:00:00Z' },
    }, { login: 'agent-bot', aliases: ['@agent', '/agent'] })
    expect(mrMerged.mrEvent).toMatchObject({ projectId: 42, iid: 12, action: 'merge', state: 'merged' })
  })
})

const gitlabDep = () => testDeployment({
  github: undefined,
  repository: undefined,
  gitlab: { host: 'https://gitlab.example.com', cli: '/usr/bin/glab', login: 'agent-bot', webhook: { host: '0.0.0.0', port: 3083, tokenFile: '/tmp/t' } },
})

describe('sendGitlab & gitlabLink', () => {
  const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
    id: 'msg-1',
    channel: gitlabChannel({ projectId: 42, projectPath: 'team/repo', kind: 'mr', iid: 12, discussionId: 'disc-1', url: 'https://gitlab.example.com/team/repo/-/merge_requests/12#note_1' }),
    text: 'Done',
    kind: 'reply',
    ...overrides,
  })

  it('posts to discussion endpoint with bot marker and skips duplicate sends idempotently', async () => {
    const commands = new Commands(gitlabDep, {}, new AbortController().signal)
    const pages = vi.spyOn(commands, 'gitlabPages').mockResolvedValueOnce([])
    const api = vi.spyOn(commands, 'gitlabApi').mockResolvedValueOnce({} as never)
    expect(await sendGitlab({ commands }, message())).toBe('sent')
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'projects/42/merge_requests/12/notes?sort=desc&order_by=created_at')
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/42/merge_requests/12/discussions/disc-1/notes', '-X', 'POST', '-f', `body=Done\n\n${botMarker('msg-1')}`)

    // Already posted -> skips POST
    pages.mockResolvedValueOnce([{ id: 7, body: `Done\n\n${botMarker('msg-1')}`, author: { username: 'agent-bot' } }])
    expect(await sendGitlab({ commands }, message())).toBe('sent')
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('falls back to top-level MR notes on 404 discussion, returns gone on 410, and rethrows 500', async () => {
    const commands = new Commands(gitlabDep, {}, new AbortController().signal)
    vi.spyOn(commands, 'gitlabPages').mockResolvedValue([])
    const api = vi.spyOn(commands, 'gitlabApi')
      .mockRejectedValueOnce(new CliError('404 Not Found', 404, 1))
      .mockResolvedValueOnce({} as never)
    expect(await sendGitlab({ commands }, message())).toBe('sent')
    expect(api.mock.calls[1]![1]).toBe('projects/42/merge_requests/12/notes')

    api.mockRejectedValueOnce(new CliError('410 Gone', 410, 1))
    expect(await sendGitlab({ commands }, message({ channel: gitlabChannel({ projectId: 42, projectPath: 'team/repo', kind: 'issue', iid: 5 }) }))).toBe('gone')

    api.mockRejectedValueOnce(new CliError('500 Server Error', 500, 1))
    await expect(sendGitlab({ commands }, message({ channel: gitlabChannel({ projectId: 42, projectPath: 'team/repo', kind: 'issue', iid: 5 }) }))).rejects.toThrow('500')
  })

  it('builds channel links with discussion and fallback host URLs', () => {
    const dep = gitlabDep()
    expect(gitlabLink({ projectId: '42', projectPath: 'team/repo', kind: 'mr', iid: '12', discussionId: 'd1' }, { gitlab: dep.gitlab })).toEqual({
      url: 'https://gitlab.example.com/team/repo/-/merge_requests/12',
      label: { zh: 'GitLab team/repo!12 的讨论', en: 'Discussion on GitLab team/repo!12' },
    })
  })
})

describe('gitlabThreadContext, readGitlab & readGitlabRepositoryPath', () => {
  it('reads paginated notes with diff path/line, filters system notes, and marks bot-marked messages', async () => {
    const commands = new Commands(gitlabDep, {}, new AbortController().signal)
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      body: i === 0 ? `Bot reply\n\n${botMarker('x')}` : `Note ${i + 1}`,
      author: { username: 'agent-bot', bot: false },
      system: i === 1,
      created_at: '2026-11-19T02:00:00Z',
      ...(i === 2 ? { position: { new_path: 'src/app.ts', new_line: 9 } } : {}),
    }))
    const api = vi.spyOn(commands, 'gitlabApi')
      .mockResolvedValueOnce({ iid: 12, title: 'Feat', description: 'MR body', state: 'opened', author: { username: 'alice' }, created_at: '2026-11-19T01:00:00Z', web_url: 'https://gitlab.example.com/team/repo/-/merge_requests/12' } as never)
      .mockResolvedValueOnce(fullPage as never)
      .mockResolvedValueOnce([{ id: 51, body: 'Last note', author: { username: 'alice', bot: false }, system: false, created_at: '2026-11-19T02:05:00Z' }] as never)
    const trigger: Trigger = {
      id: 't1', source: 'gitlab', threads: [{ source: 'gitlab', id: '42:mr:12' }],
      actor: { source: 'gitlab', id: 'agent-bot' }, human: true, at: '2026-11-19T02:00:00Z', text: '@agent-bot check',
      meta: { projectId: 42, kind: 'note', noteableType: 'mr', iid: 12, noteId: 3 },
    }
    const page1 = await gitlabThreadContext.read(commands, trigger, 'thread', undefined, {})
    expect(api).toHaveBeenCalledWith(expect.anything(), 'projects/42/merge_requests/12/notes?sort=asc&order_by=created_at&per_page=50&page=1')
    expect(page1.next).toBe('2')
    expect(page1.messages).toHaveLength(50)
    expect(page1.messages[0]).toMatchObject({ id: 'https://gitlab.example.com/team/repo/-/merge_requests/12', from: 'alice' })
    expect(page1.messages[1]?.bot).toBe(true)
    expect(page1.messages[2]).toMatchObject({ path: 'src/app.ts', line: 9 })

    const page2 = await gitlabThreadContext.read(commands, trigger, 'thread', '2', {})
    expect(page2.next).toBeUndefined()
    expect(page2.messages).toHaveLength(1)
  })

  it('reads issues, MRs, repository files, and repository directory trees', async () => {
    const commands = new Commands(gitlabDep, {}, new AbortController().signal)
    vi.spyOn(commands, 'gitlabApi')
      .mockResolvedValueOnce({ iid: 5, title: 'Bug', description: 'Details', state: 'opened', author: { username: 'alice' }, created_at: '2026-11-19T01:00:00Z', web_url: 'https://gitlab.example.com/team/repo/-/issues/5', labels: ['bug'] } as never)
      .mockResolvedValueOnce({ iid: 12, title: 'Feat', description: 'Desc', state: 'opened', source_branch: 'feat/x', target_branch: 'main', author: { username: 'agent-bot' }, created_at: '2026-11-19T01:00:00Z', web_url: 'https://gitlab.example.com/team/repo/-/merge_requests/12' } as never)
      .mockResolvedValueOnce('console.log(1)\n')
      .mockResolvedValueOnce([{ name: 'index.ts' }, { name: '.env' }, { name: 'node_modules' }, { name: 'a.ts' }] as never)

    expect(await readGitlab(commands, 'gitlab/42/issues/5')).toMatchObject({ iid: 5, title: 'Bug', labels: ['bug'] })
    expect(await readGitlab(commands, 'gitlab/42/merge_requests/12')).toMatchObject({ iid: 12, source_branch: 'feat/x', target_branch: 'main' })
    expect(await readGitlabRepositoryPath(commands, 42, 'src/index.ts', 'file')).toBe('console.log(1)\n')
    expect(await readGitlabRepositoryPath(commands, 42, 'src', 'directory')).toBe('a.ts\nindex.ts')
    await expect(readGitlabRepositoryPath(commands, 42, '.git/config', 'file')).rejects.toThrow()
  })
})

describe('GitLab MR lifecycle tracking', () => {
  const makeTicket = (id: string, name: string, overrides: Partial<Ticket> = {}): Ticket => ({
    id,
    title: 'Fix bug',
    state: 'open',
    origin: { triggerId: 'tr-1', triggerIds: ['tr-1'] },
    channels: [
      gitlabChannel({ projectId: 42, projectPath: 'team/repo', kind: 'issue', iid: 5 }),
      { source: 'feishu', thread: 'feishu:oc_1:om_1', address: { chatId: 'oc_1', messageId: 'om_1' } },
    ],
    execution: { name, directory: '/tmp/t', assignment: 'Fix it' },
    assignments: [],
    inputs: [],
    createdAt: '2026-11-19T01:00:00Z',
    updatedAt: '2026-11-19T01:00:00Z',
    ...overrides,
  } as Ticket)

  it('claims agent-authored MR on ticket branch, rejects conflicts, closes on merge webhook, and builds IM notices', () => {
    const tickets = new Map<string, Ticket>([
      ['tk-1', makeTicket('tk-1', 'fix-login')],
      ['tk-2', makeTicket('tk-2', 'other-task')],
    ])
    const bindThread = vi.fn((ticketId: string, thread: { source: string; id: string }, own: boolean) => {
      const tk = tickets.get(ticketId)!
      tk.follows = [...(tk.follows ?? []), { thread: `${thread.source}:${thread.id}`, own }]
    })
    const threadClosed = vi.fn()
    const patch = vi.fn()
    const ctx = {
      deployment: gitlabDep(),
      atomic: <T>(fn: () => T) => fn(),
      tickets: { get: (id: string) => tickets.get(id), open: () => [...tickets.values()], bindThread, threadClosed },
      triggers: { get: () => undefined, latest: () => undefined },
      threads: { get: () => undefined, subscribed: () => [], describe: vi.fn(), patch },
    } as unknown as SourceContext

    const mr = {
      projectId: 42, projectPath: 'team/repo', iid: 12, title: 'Fix login', state: 'opened',
      source_branch: 'agent/fix-login', target_branch: 'main', web_url: 'https://gitlab.example.com/team/repo/-/merge_requests/12',
      author: { username: 'agent-bot' },
    }
    expect(claimMergeRequest(ctx, 'tk-1', mr)).toBeUndefined()
    expect(bindThread).toHaveBeenCalledWith('tk-1', { source: 'gitlab', id: '42:mr:12' }, true)
    expect(mrOf(tickets.get('tk-1')!)).toEqual({ projectId: 42, iid: 12 })

    // Another ticket cannot steal an already-bound MR
    const mr2 = { ...mr, source_branch: 'agent/other-task' }
    expect(claimMergeRequest(ctx, 'tk-2', mr2)).toContain('another active ticket')

    // Merge webhook closes the bound MR thread
    observeMergeRequestEvent(ctx, {
      projectId: 42, projectPath: 'team/repo', iid: 12, action: 'merge', state: 'merged',
      sourceBranch: 'agent/fix-login', targetBranch: 'main', title: 'Fix login',
      url: 'https://gitlab.example.com/team/repo/-/merge_requests/12', author: 'agent-bot', updatedAt: '2026-11-19T03:00:00Z',
    })
    expect(threadClosed).toHaveBeenCalledWith({ source: 'gitlab', id: '42:mr:12' }, 'merged', '2026-11-19T03:00:00Z')

    // End notices go only to non-gitlab channels in source language
    const ended = makeTicket('tk-1', 'fix-login', {
      follows: [{ thread: 'gitlab:42:mr:12', own: true, closed: { outcome: 'merged', at: '2026-11-19T03:00:00Z' } }],
      ended: { outcome: 'merged', by: 'executor', at: '2026-11-19T03:00:00Z' },
    })
    const zhNotices = mrEndNotices(ended, '请帮忙修复登录问题', 'https://gitlab.example.com', () => 'team/repo')
    expect(zhNotices).toHaveLength(1)
    expect(zhNotices[0]!.channel.source).toBe('feishu')
    expect(zhNotices[0]!.text).toContain('MR !12')
    expect(zhNotices[0]!.text).toContain('已合并')

    const enNotices = mrEndNotices(ended, 'Please fix login bug', 'https://gitlab.example.com', () => 'team/repo')
    expect(enNotices[0]!.text).toContain('has merged')
  })
})

describe('gitlabKind Source plugin & queue consumer', () => {
  function setupHost(stateDir: string, overrides: Partial<SourceContextDeps> = {}) {
    const store = new Store(join(stateDir, 'db.sqlite'))
    const settings = SettingsSchema.parse({
      policy: { sources: { gitlab: { allowed: [{ id: 'agent-bot' }] } } },
      eval: { mode: 'auto' },
      sources: {
        gitlab: {
          enabled: true,
          config: {
            host: 'https://gitlab.example.com',
            cli: '/usr/bin/glab',
            mentionAliases: '@agent, /agent',
            projects: [{ path: 'team/*', listen: 'mentions' }],
          },
        },
      },
    })
    store.saveSettings(settings)
    const board = new HealthBoard()
    const sources = new SourceRegistry(() => store.settings(), board)
    const unregisterGitlab = sources.register(gitlabKind)
    const deployment = testDeployment({
      stateDir,
      github: undefined,
      repository: undefined,
      gitlab: { host: 'https://gitlab.example.com', cli: '/usr/bin/glab', login: 'agent-bot', webhook: { host: '0.0.0.0', port: 3083, tokenFile: join(stateDir, 'gitlab-webhook.token') } },
    })
    const assessor: Assessor = { request: vi.fn(async () => {}) }
    const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
    const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor, outbox })
    const commands = new Commands(() => deployment, {}, new AbortController().signal)
    const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
    const parts: SourceContextDeps = {
      store, engine, outbox: { send: m => { store.receipts.add(m) } }, commands, sources, deployment,
      ready: Promise.resolve(), configured: () => true, receive, ...overrides,
    }
    return { ctx: sourceContextOf(parts, gitlabKind), host: { sources, context: (k: { kind: string; health: readonly string[] }) => sourceContextOf(parts, k) }, store, board, sources, engine, receive, unregisterGitlab }
  }

  it('consumes allowed projects as explicit, filters out-of-scope projects, skips malformed JSON, and stops cleanly on abort', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-queue-poll-'))
    try {
      const { ctx, store, engine } = setupHost(dir)
      const queue = new GitlabWebhookQueue(webhookQueuePath(dir))
      const notePayload = (id: number, projectPath: string, note: string) => JSON.stringify({
        object_kind: 'note',
        user: { username: 'agent-bot', bot: false },
        project: { id: 42, path_with_namespace: projectPath, git_ssh_url: `git@gitlab.example.com:${projectPath}.git`, git_http_url: `https://gitlab.example.com/${projectPath}.git`, web_url: `https://gitlab.example.com/${projectPath}` },
        object_attributes: { id, note, noteable_type: 'Issue', created_at: '2026-11-19T02:00:00Z', updated_at: '2026-11-19T02:00:00Z', url: `https://gitlab.example.com/${projectPath}/-/issues/5#note_${id}` },
        issue: { iid: 5, title: 'Bug', url: `https://gitlab.example.com/${projectPath}/-/issues/5` },
      })
      queue.enqueue({ deliveryUuid: 'd-1', eventType: 'Note Hook', payload: notePayload(1, 'team/repo', '@agent-bot fix it') })
      queue.enqueue({ deliveryUuid: 'd-2', eventType: 'Note Hook', payload: notePayload(2, 'team/sub/repo', '@agent-bot deep') })
      queue.enqueue({ deliveryUuid: 'd-3', eventType: 'Note Hook', payload: '{malformed json' })
      queue.close()

      const res = await pollGitlabQueue(ctx, new AbortController().signal)
      expect(res).toEqual({ read: 2, unreadable: 1 })
      expect(store.get(KV.gitlab.cursor)).toBe(3)

      const triggers = store.read.recentTriggers(0, 10)
      expect(triggers).toHaveLength(2)
      const inScope = triggers.find(t => t.meta.projectPath === 'team/repo')!
      const outScope = triggers.find(t => t.meta.projectPath === 'team/sub/repo')!
      expect(engine.candidate(inScope.id)?.strength).toBe('explicit')
      expect(store.triggers.disposition(outScope.id)?.filtered).toEqual({ code: 'project_not_listed' })

      // Aborted mid-batch keeps unprocessed row's cursor untouched
      const queue2 = new GitlabWebhookQueue(webhookQueuePath(dir))
      queue2.enqueue({ deliveryUuid: 'd-4', eventType: 'Note Hook', payload: notePayload(4, 'team/repo', '@agent-bot fourth') })
      queue2.close()
      const aborted = new AbortController()
      aborted.abort()
      await pollGitlabQueue(ctx, aborted.signal)
      expect(store.get(KV.gitlab.cursor)).toBe(3)
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('populates all 10 DSH_SUPERAGENT_GITLAB_* env vars and resolves find queries', () => {
    const dep = gitlabDep()
    const config = gitlabKind.schema.parse({ host: 'https://gitlab.example.com', cli: '/usr/bin/glab' })
    const trigger: Trigger = {
      id: 't-mr', source: 'gitlab', threads: [{ source: 'gitlab', id: '42:mr:12' }],
      actor: { source: 'gitlab', id: 'agent-bot' }, human: true, at: '2026-11-19T02:00:00Z', text: '@agent-bot fix',
      meta: { projectId: 42, projectPath: 'team/repo', sshUrl: 'git@gitlab.example.com:team/repo.git', httpUrl: 'https://gitlab.example.com/team/repo.git', kind: 'note', noteableType: 'mr', iid: 12 },
    }
    const env = gitlabKind.environment!.values({ deployment: dep, config, trigger })
    expect(env).toEqual({
      DSH_SUPERAGENT_GITLAB_HOST: 'https://gitlab.example.com',
      DSH_SUPERAGENT_GITLAB_ACCOUNT: 'agent-bot',
      DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: '',
      DSH_SUPERAGENT_GITLAB_PROJECT: 'team/repo',
      DSH_SUPERAGENT_GITLAB_PROJECT_ID: '42',
      DSH_SUPERAGENT_GITLAB_REPO_SSH: 'git@gitlab.example.com:team/repo.git',
      DSH_SUPERAGENT_GITLAB_REPO_HTTP: 'https://gitlab.example.com/team/repo.git',
      DSH_SUPERAGENT_GITLAB_KIND: 'mr',
      DSH_SUPERAGENT_GITLAB_IID: '12',
      DSH_SUPERAGENT_GITLAB_MR_REF: 'refs/merge-requests/12/head',
    })
    const nonGitlab = gitlabKind.environment!.values({ deployment: dep, config, trigger: { ...trigger, source: 'feishu' } })
    expect(nonGitlab.DSH_SUPERAGENT_GITLAB_HOST).toBe('https://gitlab.example.com')
    expect(nonGitlab.DSH_SUPERAGENT_GITLAB_PROJECT).toBe('')
    expect(nonGitlab.DSH_SUPERAGENT_GITLAB_MR_REF).toBe('')

    expect(gitlabKind.find!('https://gitlab.example.com/team/repo/-/merge_requests/12').terms).toContain('team/repo!12')
    expect(gitlabKind.find!('team/repo#5').terms).toContain('team/repo#5')
    expect(gitlabKind.find!('42:mr:12').threads).toEqual(['gitlab:42:mr:12'])
  })

  it('registers gitlabKind via Cordis apply(), reports setupPending when unconfigured, and unregisters on dispose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-cordis-'))
    try {
      const { host, board, sources, store, unregisterGitlab } = setupHost(dir, { configured: () => false })
      // Unregister pre-registered kind so apply() performs registration cleanly
      unregisterGitlab()
      const disposers: (() => unknown)[] = []
      applyGitlab({ orchestrator: host, effect: (fn: () => () => unknown) => { disposers.push(fn()) } } as never)
      expect(sources.kind('gitlab')).toBe(gitlabKind)
      await vi.waitFor(() => expect(board.all.gitlab?.code).toBe('setupPending'))
      for (const dispose of disposers) await dispose()
      expect(sources.kind('gitlab')).toBeUndefined()
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Review fixes: scope/policy alignment, threadContext root & diff discussions, and readMergeRequest projectPath', () => {
  it('keeps mentions-only projects strictly explicit even when observe* switches are on, and exposes admission cells for listen=all projects', () => {
    const mixed = gitlabKind.schema.parse({
      host: 'https://gitlab.example.com',
      cli: '/usr/bin/glab',
      projects: [
        { path: 'team/strict', listen: 'mentions' },
        { path: 'team/open', listen: 'all' },
      ],
      observeIssues: true,
      observeMergeRequests: false,
      observeNotes: false,
      observePipelines: false,
    })
    expect(gitlabKind.scope!({ meta: { projectPath: 'team/strict', kind: 'issue' } }, mixed))
      .toEqual({ listened: true, observed: false, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { projectPath: 'team/open', kind: 'issue' } }, mixed))
      .toEqual({ listened: true, observed: true, row: 'issues' })
    expect(gitlabKind.scope!({ meta: { projectPath: 'team/open', kind: 'note' } }, mixed))
      .toEqual({ listened: true, observed: false, row: 'notes' })

    const mixedRows = gitlabKind.policy!.rows!(mixed)
    expect(mixedRows.find(r => r.id === 'issues')?.cells.listedUnaddressed).toBe(true)
    expect(mixedRows.find(r => r.id === 'notes')?.cells.listedUnaddressed).toBe(false)

    // When all observe* switches are false, listen='all' observes all kinds and enables all admission cells (including pipelines)
    const allOpen = gitlabKind.schema.parse({
      host: 'https://gitlab.example.com',
      cli: '/usr/bin/glab',
      projects: [{ path: 'team/open', listen: 'all' }],
    })
    expect(gitlabKind.scope!({ meta: { projectPath: 'team/open', kind: 'pipeline', ci: true } }, allOpen))
      .toEqual({ listened: true, observed: true, row: 'pipelines' })
    const allRows = gitlabKind.policy!.rows!(allOpen)
    expect(allRows.find(r => r.id === 'issues')?.cells.listedUnaddressed).toBe(true)
    expect(allRows.find(r => r.id === 'pipelines')?.cells.unlistedUnaddressed).toBe(true)
  })

  it('prepends Issue/MR root body on page 1 of gitlabThreadContext and scopes inline MR diff discussions to discussionId', async () => {
    const commands = new Commands(gitlabDep, {}, new AbortController().signal)
    const api = vi.spyOn(commands, 'gitlabApi')
      .mockResolvedValueOnce({ iid: 5, title: 'Bug', description: 'Root body', state: 'opened', author: { username: 'alice' }, created_at: '2026-11-19T01:00:00Z', web_url: 'https://gitlab.example.com/team/repo/-/issues/5' } as never)
      .mockResolvedValueOnce([{ id: 10, body: 'First note', author: { username: 'bob', bot: false }, system: false, created_at: '2026-11-19T02:00:00Z' }] as never)
    const issueTrigger: Trigger = {
      id: 't-issue', source: 'gitlab', threads: [{ source: 'gitlab', id: '42:issue:5' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, at: '2026-11-19T01:00:00Z', text: 'Bug\n\nRoot body',
      url: 'https://gitlab.example.com/team/repo/-/issues/5',
      meta: { projectId: 42, kind: 'issue', iid: 5 },
    }
    const page1 = await gitlabThreadContext.read(commands, issueTrigger, 'thread', undefined, {})
    expect(page1.messages[0]).toMatchObject({ id: 'https://gitlab.example.com/team/repo/-/issues/5', from: 'alice', text: 'Bug\n\nRoot body' })
    expect(page1.messages[1]).toMatchObject({ id: '10', from: 'bob', text: 'First note' })
    expect(gitlabThreadContext.messageId(issueTrigger)).toBe(page1.messages[0]!.id)

    // Inline MR diff discussion reads /discussions/<id> directly
    api.mockResolvedValueOnce({
      id: 'disc-9',
      notes: [
        { id: 21, body: 'Diff comment', author: { username: 'alice', bot: false }, system: false, created_at: '2026-11-19T02:00:00Z', position: { new_path: 'src/a.ts', new_line: 8 } },
        { id: 22, body: 'Followup', author: { username: 'agent-bot', bot: false }, system: false, created_at: '2026-11-19T02:05:00Z' },
      ],
    } as never)
    const diffTrigger: Trigger = {
      id: 't-diff', source: 'gitlab', threads: [{ source: 'gitlab', id: '42:mr:12' }],
      actor: { source: 'gitlab', id: 'alice' }, human: true, at: '2026-11-19T02:00:00Z', text: 'Diff comment',
      meta: { projectId: 42, kind: 'note', noteableType: 'mr', iid: 12, noteId: 21, discussionId: 'disc-9', position: 'src/a.ts:8' },
    }
    const diffRes = await gitlabThreadContext.read(commands, diffTrigger, 'thread', undefined, {})
    expect(api).toHaveBeenLastCalledWith(expect.anything(), 'projects/42/merge_requests/12/discussions/disc-9')
    expect(diffRes.status).toBe('discussion')
    expect(diffRes.messages).toHaveLength(2)
  })

  it('derives projectPath from web_url in readMergeRequest and falls back on 400 IndividualNote in sendGitlab', async () => {
    const commands = new Commands(gitlabDep, {}, new AbortController().signal)
    vi.spyOn(commands, 'gitlabApi').mockResolvedValueOnce({
      iid: 12, title: 'Feat', state: 'opened', source_branch: 'agent/fix', target_branch: 'main',
      web_url: 'https://gitlab.example.com/team/sub/repo/-/merge_requests/12', author: { username: 'agent-bot' },
    } as never)
    const ctx = { deployment: gitlabDep(), commands } as unknown as SourceContext
    const { readMergeRequest } = await import('../src/sources/gitlab-mr.ts')
    const mr = await readMergeRequest(ctx, 42, 12)
    expect(mr.projectPath).toBe('team/sub/repo')

    // sendGitlab uses descending sort and falls back on 400 (IndividualNote)
    const pages = vi.spyOn(commands, 'gitlabPages').mockResolvedValueOnce([])
    const api = vi.spyOn(commands, 'gitlabApi')
      .mockRejectedValueOnce(new CliError('400 Bad Request', 400, 1))
      .mockResolvedValueOnce({} as never)
    expect(await sendGitlab({ commands }, {
      id: 'msg-400',
      channel: gitlabChannel({ projectId: 42, projectPath: 'team/repo', kind: 'mr', iid: 12, discussionId: 'ind-1' }),
      text: 'Reply', kind: 'reply',
    })).toBe('sent')
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'projects/42/merge_requests/12/notes?sort=desc&order_by=created_at')
    expect(api.mock.calls.at(-1)![1]).toBe('projects/42/merge_requests/12/notes')
  })
})
