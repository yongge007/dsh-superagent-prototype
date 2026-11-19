import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { resolveGitlabDeployment } from '../src/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { workerBin, workerGitConfig } from '../src/infra/environment.ts'
import { Runtime } from '../src/app/runtime.ts'
import { Setup } from '../src/app/setup.ts'
import { Store } from '../src/app/store.ts'
import { ticketCard } from '../src/app/cards.ts'
import { workerSessionId } from '../src/executor/dsh.ts'
import { SettingsSchema } from '../src/policy.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { gitlabChannel } from '../src/sources/gitlab-trigger.ts'
import { testDeployment, testMachine } from './fixtures/deployment.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'setup-gitlab-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolveGitlabDeployment', () => {
  it('verifies glab user on target host and creates 0600 webhook token file', async () => {
    const cli = join(dir, 'glab')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    const probe = vi.fn(async (argv: string[]) => {
      expect(argv).toContain('GITLAB_HOST=https://gitlab.example.com')
      expect(argv).toContain('user')
      return JSON.stringify({ id: 7, username: 'agent-bot', email: 'agent-bot@example.com' })
    })
    const result = await resolveGitlabDeployment(testMachine({ stateDir: dir }), { host: 'https://gitlab.example.com/', cli }, probe)
    expect(result.host).toBe('https://gitlab.example.com')
    expect(result.login).toBe('agent-bot')
    expect(result.email).toBe('agent-bot@example.com')
    expect(statSync(result.webhook.tokenFile).mode & 0o777).toBe(0o600)
  })

  it('rejects unset host or unauthenticated glab with structured SetupError codes', async () => {
    const probe = vi.fn(async () => { throw new Error('401 Unauthorized') })
    await expect(resolveGitlabDeployment(testMachine({ stateDir: dir }), { host: '', cli: 'glab' }, probe))
      .rejects.toMatchObject({ code: 'gitlabHostUnset', place: 'gitlab' })
    const cli = join(dir, 'glab')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    await expect(resolveGitlabDeployment(testMachine({ stateDir: dir }), { host: 'https://gitlab.example.com', cli }, probe))
      .rejects.toMatchObject({ code: 'gitlabCliSignedOut', place: 'gitlab' })
  })
})

describe('GitLab-only environment & Setup', () => {
  it('writes glab shim with GITLAB_HOST, keeps SSH intact, and passes Setup without GitHub', async () => {
    const cli = join(dir, 'glab')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const answers: Record<string, string> = {
      [`${cli} api user`]: JSON.stringify({ id: 7, username: 'agent-bot', email: 'agent-bot@example.com' }),
      ['git config -z --show-origin --get user.useConfigOnly']: `file:${workerGitConfig(dir)}\0true\0`,
    }
    const subprocess = {
      spawn: (spec: { argv: readonly string[] }) => {
        const argv = [...spec.argv]
        while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
        const stdout = answers[argv.join(' ')] ?? ''
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(stdout), stderr: reader('') } }
      },
    }
    const ctx = new Context()
    ctx.reflect.provide('subprocess', subprocess)
    const setup = new Setup({
      context: ctx,
      machine: testMachine({ stateDir: dir }),
      lifetime: new AbortController().signal,
      restart: () => {},
      hasSource: id => id === 'gitlab' || id === 'github',
    })
    const settings = SettingsSchema.parse({
      sources: {
        github: { enabled: true, config: { repository: '', cli: '' } },
        gitlab: { enabled: true, config: { host: 'https://gitlab.example.com', cli } },
      },
    })
    expect(await setup.run(settings)).toBe(true)
    expect(setup.deployment.github).toBeUndefined()
    expect(setup.deployment.gitlab?.login).toBe('agent-bot')
    const gitconfig = readFileSync(workerGitConfig(dir), 'utf8')
    expect(gitconfig).toContain('useConfigOnly = true')
    expect(gitconfig).not.toContain('github.com')
    expect(gitconfig).not.toContain('insteadOf = git@gitlab.example.com')
    const glabShim = readFileSync(join(workerBin(dir), 'glab'), 'utf8')
    expect(glabShim).toContain('GITLAB_HOST')
    expect(glabShim).toContain('https://gitlab.example.com')
    const ghShim = readFileSync(join(workerBin(dir), 'gh'), 'utf8')
    expect(ghShim).toContain('unavailable')
    setup.restore()
  })

  it('Commands.gitlabApi rejects paths escaping API namespace and passes GITLAB_HOST', async () => {
    const dep = testDeployment({
      github: undefined,
      repository: undefined,
      gitlab: { host: 'https://gitlab.example.com', cli: '/usr/bin/glab', login: 'agent-bot', webhook: { host: '0.0.0.0', port: 3083, tokenFile: join(dir, 't') } },
    })
    const commands = new Commands(() => dep, {}, new AbortController().signal)
    const spy = vi.spyOn(commands, 'run').mockResolvedValue('{"iid":3}')
    await expect(commands.gitlabApi('/etc/passwd')).rejects.toThrow()
    const raw = await commands.gitlabApi('projects/9/issues/3')
    expect(raw).toBe('{"iid":3}')
    expect(spy).toHaveBeenCalledWith('/usr/bin/glab', ['api', 'projects/9/issues/3'], undefined, { GITLAB_HOST: 'https://gitlab.example.com', NO_PROMPT: '1' })
  })
})

describe('GitLab-only Runtime end-to-end integration', () => {
  it('boots standalone without GitHub, registers only gitlab skill, binds MR via orchestrator_report, and serves gitlab/* reads', async () => {
    const cli = join(dir, 'glab')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const answers: Record<string, string> = {
      [`${cli} api user`]: JSON.stringify({ id: 7, username: 'agent-bot', email: 'agent-bot@example.com' }),
      ['git config -z --show-origin --get user.useConfigOnly']: `file:${workerGitConfig(dir)}\0true\0`,
      ['git config -z --show-scope --get-regexp ^(credential\\..*|http\\..*extraheader)$']: '',
    }
    const subprocess = {
      spawn: (spec: { argv: readonly string[] }) => {
        const argv = [...spec.argv]
        while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(answers[argv.join(' ')] ?? ''), stderr: reader('') } }
      },
    }
    type Tool = { name: string; execute: (args: unknown, execution: { signal: AbortSignal }) => Promise<unknown> }
    type Skill = { name: string; description: string; content: string }
    const agents = new Map<string, { status: string }>()
    const tools = new Map<string, Map<string, Tool>>()
    const skills = new Map<string, Skill[]>()
    const create = async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const own = new Map<string, Tool>(), registered: Skill[] = []
      tools.set(sessionId, own); skills.set(sessionId, registered)
      agentCtx.reflect.provide('tools', { register: (t: Tool) => { own.set(t.name, t); return () => own.delete(t.name) }, get: () => undefined, restrict: () => () => {}, guard: () => () => {} })
      agentCtx.reflect.provide('skills', { register: (s: Skill) => { registered.push(s); return () => {} } })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[], remove: () => false }
      const deliver = (queue: UserMessage[]) => (message: UserMessage) => { queue.push(message); agents.get(sessionId)!.status = 'running' }
      const session = { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: () => {} }
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver(inbox.nextTurn), steer: deliver(inbox.nextStep), inject: () => {}, status: 'idle', cancel: () => {}, whenIdle: async () => {}, session } as never)
    }
    const resolveAgent = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
    const ctx = new Context()
    const history = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
    const services = {
      agents, llm: { resolveCallConfig: async (value: unknown) => value },
      workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) },
      sessionController: { create, resolveAgent, selectModel: async () => {}, rename: async () => {}, inspect: async () => ({ events: [] }) },
      sessionPersistence: { flush: async () => {}, open: async () => history },
      permissionPresets: { set: () => {} },
      subprocess,
      webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} },
    }
    for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)

    const seed = new Store(join(dir, 'orchestrator.sqlite'))
    seed.saveSettings(SettingsSchema.parse({
      policy: { sources: { gitlab: { allowed: [{ id: 'agent-bot' }] } } },
      sources: {
        github: { enabled: false, config: { repository: '', cli: '' } },
        gitlab: { enabled: true, config: { host: 'https://gitlab.example.com', cli, projects: [{ path: 'team/*', listen: 'mentions' }] } },
      },
    }))
    seed.close()

    const runtime = new Runtime(ctx, testMachine({ stateDir: dir }), () => {})
    runtime.sources.register(gitlabKind)
    try {
      await runtime.ready
      expect(runtime.configured()).toBe(true)
      expect(runtime.setupProblem).toBeUndefined()
      const masterSkillNames = (skills.get(runtime.masterId) ?? []).map(s => s.name)
      expect(masterSkillNames).toContain('dsh-superagent-gitlab')
      expect(masterSkillNames).not.toContain('dsh-superagent-github')

      const trigger = {
        id: 'gl-tr-1', source: 'gitlab', threads: [{ source: 'gitlab', id: '42:issue:5' }],
        actor: { source: 'gitlab', id: 'agent-bot' }, human: true, addressed: 'mention' as const,
        at: '2026-11-19T02:00:00Z', text: '@agent-bot 请修复登录 bug',
        channel: gitlabChannel({ projectId: 42, projectPath: 'team/repo', kind: 'issue', iid: 5 }),
        url: 'https://gitlab.example.com/team/repo/-/issues/5#note_1',
        meta: { projectId: 42, projectPath: 'team/repo', sshUrl: 'git@gitlab.example.com:team/repo.git', httpUrl: 'https://gitlab.example.com/team/repo.git', kind: 'note', noteableType: 'issue', iid: 5, noteId: 1 },
      }
      await runtime.receive(trigger)
      const run = async (sessionId: string, name: string, args: unknown) =>
        await tools.get(sessionId)!.get(name)!.execute(args, { signal: new AbortController().signal }) as Record<string, unknown>

      const routed = await run(runtime.masterId, 'orchestrator_route', {
        decisions: [{ kind: 'accept', trigger_id: trigger.id, title: 'Fix login bug', worktree_name: 'fix-login', acknowledgement: '收到，开始修复登录问题。' }],
      }) as { results: { ticket?: { ticket_id: string } }[] }
      const ticketId = routed.results[0]!.ticket!.ticket_id
      await runtime.idle()

      const ticketName = runtime.store.tickets.get(ticketId)!.execution!.name
      const gitlabApiSpy = vi.spyOn(Commands.prototype, 'gitlabApi').mockImplementation((async (_schema: unknown, path?: string) => {
        const target = typeof _schema === 'string' ? _schema : path
        if (target === 'projects/42/merge_requests/12') {
          return { iid: 12, title: 'Fix login', state: 'opened', source_branch: `agent/${ticketName}`, target_branch: 'main', web_url: 'https://gitlab.example.com/team/repo/-/merge_requests/12', author: { username: 'agent-bot' } }
        }
        if (target === 'projects/42/issues/5') {
          return { iid: 5, title: 'Login broken', description: 'Cannot sign in', state: 'opened', author: { username: 'agent-bot' }, created_at: '2026-11-19T01:00:00Z', web_url: 'https://gitlab.example.com/team/repo/-/issues/5' }
        }
        throw new Error(`Unexpected gitlabApi path: ${String(target)}`)
      }) as never)

      const workerId = workerSessionId(ticketId)
      await run(workerId, 'orchestrator_report', { state: 'progress', summary: 'Opened MR !12', mr_iid: 12 })
      const updated = runtime.store.tickets.get(ticketId)!
      expect(updated.follows).toContainEqual(expect.objectContaining({ thread: 'gitlab:42:mr:12', own: true }))
      expect(ticketCard(updated)).toMatchObject({ mr_iid: 12, mr_project_id: 42 })

      const readRes = await run(workerId, 'orchestrator_read', { resource: 'gitlab/42/issues/5' }) as { text: string }
      expect(JSON.parse(readRes.text)).toMatchObject({ iid: 5, title: 'Login broken' })
      expect(gitlabApiSpy).toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await runtime.stop()
    }
  })
})

describe('Review fixes: cold-start Cordis ordering, GitLab-only prompts, and executor guards', () => {
  const fakeHost = (answers: Record<string, string>) => {
    const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
    const subprocess = {
      spawn: (spec: { argv: readonly string[] }) => {
        const argv = [...spec.argv]
        while (argv[0] === 'env' || /^[A-Z_]+=/.test(argv[0] ?? '')) argv.shift()
        const key = argv.join(' ')
        const out = answers[key]
        if (out === undefined) {
          return { done: Promise.resolve({ exitCode: 1, signal: null }), collected: { stdout: reader(''), stderr: reader(`unexpected: ${key}`) } }
        }
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(out), stderr: reader('') } }
      },
    }
    const agents = new Map<string, { status: string }>()
    const tools = new Map<string, Map<string, { name: string; execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> }>>()
    const create = async ({ sessionId }: { sessionId: string }) => {
      if (agents.has(sessionId)) return
      const agentCtx = new Context()
      const own = new Map<string, { name: string; execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> }>()
      tools.set(sessionId, own)
      agentCtx.reflect.provide('tools', { register: (t: { name: string; execute: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> }) => { own.set(t.name, t); return () => own.delete(t.name) }, get: () => undefined, restrict: () => () => {}, guard: () => () => {} })
      agentCtx.reflect.provide('skills', { register: () => () => {} })
      agentCtx.reflect.provide('systemPrompt', { section: () => () => {} })
      const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[], remove: () => false }
      const deliver = (queue: UserMessage[]) => (message: UserMessage) => { queue.push(message); agents.get(sessionId)!.status = 'running' }
      const session = { id: sessionId, snapshotEvents: () => [], requestHeader: () => undefined, append: () => {} }
      agents.set(sessionId, { id: sessionId, ctx: agentCtx, inbox, followup: deliver(inbox.nextTurn), steer: deliver(inbox.nextStep), inject: () => {}, status: 'idle', cancel: () => {}, whenIdle: async () => {}, session } as never)
    }
    const resolveAgent = async (id: string) => agents.has(id) ? { agent: agents.get(id) } : { error: { code: 'session/not-found' } }
    const ctx = new Context()
    const history = { read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }
    const services = {
      agents, llm: { resolveCallConfig: async (value: unknown) => value },
      workspaceRegistry: { create: async (cwd: string) => ({ id: cwd }) },
      sessionController: { create, resolveAgent, selectModel: async () => {}, rename: async () => {}, inspect: async () => ({ events: [] }) },
      sessionPersistence: { flush: async () => {}, open: async () => history },
      permissionPresets: { set: () => {} },
      subprocess,
      webServer: { host: '127.0.0.1', port: 3082, register: () => () => {} },
    }
    for (const [name, service] of Object.entries(services)) ctx.reflect.provide(name, service)
    return { ctx, tools }
  }

  it('re-checks setup when gitlabKind registers after Runtime.ready on a fresh DB, reporting gitlabHostUnset instead of noForgeConfigured', async () => {
    const { ctx } = fakeHost({})
    const runtime = new Runtime(ctx, testMachine({ stateDir: dir }), () => {})
    try {
      await runtime.ready
      // Simulate Cordis activating dsh-superagent-gitlab after dsh-superagent apply() finishes
      runtime.sources.register(gitlabKind)
      await runtime.ready
      expect(runtime.configured()).toBe(false)
      expect(runtime.setupProblem?.code).toBe('gitlabHostUnset')
      expect(runtime.setupProblem?.place).toBe('gitlab')
      // Active skills before setup completes should reflect installed gitlab plugin, not uninstalled github
      const skillNames = runtime.prompts.skills(runtime.prompts.current().config).map(([n]) => n)
      expect(skillNames).toContain('gitlab')
      expect(skillNames).not.toContain('github')
    } finally {
      await runtime.stop()
    }
  })

  it('adapts orchestrator/worker prompts and skill/gitlab for GitLab-only deployments without telling models to use gh', async () => {
    const cli = join(dir, 'glab')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    const { ctx } = fakeHost({
      [`${cli} api user`]: JSON.stringify({ id: 7, username: 'agent-bot', email: 'agent-bot@example.com' }),
      ['git config -z --show-origin --get user.useConfigOnly']: `file:${workerGitConfig(dir)}\0true\0`,
    })
    const seed = new Store(join(dir, 'orchestrator.sqlite'))
    seed.saveSettings(SettingsSchema.parse({
      sources: {
        github: { enabled: false, config: { repository: '', cli: '' } },
        gitlab: { enabled: true, config: { host: 'https://gitlab.example.com', cli } },
      },
    }))
    seed.close()
    const runtime = new Runtime(ctx, testMachine({ stateDir: dir }), () => {})
    runtime.sources.register(gitlabKind)
    try {
      await runtime.ready
      const config = runtime.prompts.current().config
      const workerText = runtime.prompts.compose(config, 'worker')
      const orchText = runtime.prompts.compose(config, 'orchestrator')
      const gitlabSkill = Object.fromEntries(runtime.prompts.skills(config)).gitlab ?? ''
      expect(workerText).not.toContain('Use gh for ALL GitHub operations')
      expect(workerText).toContain('Use glab for ALL GitLab operations')
      expect(workerText).toContain('DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL')
      expect(orchText).not.toContain("deployment's GitHub account")
      expect(orchText).toContain("deployment's GitLab account")
      expect(gitlabSkill).not.toContain('Use gh for every GitHub call')
      expect(gitlabSkill).toContain('glab')
    } finally {
      await runtime.stop()
    }
  })

  it('rejects orchestrator_report mr_iid cleanly when GitLab is not configured', async () => {
    const { executorTools } = await import('../src/app/tools/executor.ts')
    const ticket = {
      id: 'tk-gh', title: 'Fix', state: 'open' as const,
      origin: { triggerId: 'tr-1', triggerIds: ['tr-1'] },
      channels: [], assignments: [], inputs: [],
      createdAt: '2026-11-19T01:00:00Z', updatedAt: '2026-11-19T01:00:00Z',
    }
    const ghOnlyDep = testDeployment({ gitlab: undefined })
    const tools = executorTools({
      engine: {} as never,
      store: { tickets: { get: () => ticket }, replyStatus: () => undefined, atomic: <T>(fn: () => T) => fn() } as never,
      sessions: {} as never,
      resources: {} as never,
      github: { deployment: ghOnlyDep } as never,
      gitlab: { deployment: ghOnlyDep, triggers: { get: () => undefined } } as never,
      sendReplies: async () => {},
    }, ticket as never)
    const reportTool = tools.find(t => t.name === 'orchestrator_report')!
    await expect(reportTool.execute({ state: 'progress', summary: 'Opened MR', mr_iid: 12 }, new AbortController().signal))
      .rejects.toThrow('The GitLab Source is not configured')
  })

  it('boots GitLab + Feishu together with GitHub disabled, activating both skills and exposing null GitHub accounts', async () => {
    const cli = join(dir, 'glab')
    const bot = join(dir, 'lark-bot')
    writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(bot, '#!/bin/sh\n', { mode: 0o755 })
    const { ctx } = fakeHost({
      [`${cli} api user`]: JSON.stringify({ id: 7, username: 'agent-bot', email: 'agent-bot@example.com' }),
      [`${bot} auth status`]: JSON.stringify({ appId: 'cli_bot', brand: 'feishu', identities: { bot: { status: 'ready' } } }),
      [`${bot} config strict-mode`]: 'strict-mode: bot (source: profile)',
      [`${bot} api GET /open-apis/bot/v3/info --as bot --format ndjson`]: '{"bot":{"open_id":"ou_bot","app_name":"Widgets Bot"},"code":0,"msg":"ok"}',
      ['git config -z --show-origin --get user.useConfigOnly']: `file:${workerGitConfig(dir)}\0true\0`,
    })
    const seed = new Store(join(dir, 'orchestrator.sqlite'))
    seed.saveSettings(SettingsSchema.parse({
      sources: {
        github: { enabled: false, config: { repository: '', cli: '' } },
        gitlab: { enabled: true, config: { host: 'https://gitlab.example.com', cli } },
        feishu: { enabled: true, config: { cli: bot } },
      },
    }))
    seed.close()
    const runtime = new Runtime(ctx, testMachine({ stateDir: dir }), () => {})
    runtime.sources.register(gitlabKind)
    runtime.sources.register(feishuKind)
    try {
      await runtime.ready
      expect(runtime.configured()).toBe(true)
      expect(runtime.setupProblem).toBeUndefined()
      expect(runtime.feishuProblem).toBeUndefined()
      expect(runtime.deployment.github).toBeUndefined()
      expect(runtime.deployment.gitlab?.login).toBe('agent-bot')
      expect(runtime.deployment.feishu?.name).toBe('Widgets Bot')
      const skillNames = runtime.prompts.skills(runtime.prompts.current().config).map(([name]) => name)
      expect(skillNames).toEqual(['feishu', 'gitlab'])
    } finally {
      await runtime.stop()
    }
  })
})
