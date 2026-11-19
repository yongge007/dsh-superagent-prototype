/** Normalizes self-hosted GitLab webhook payloads into domain Triggers, MR lifecycle events, project scopes, and loop guards. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp } from '../infra/text.ts'

export const SOURCE = 'gitlab'
export const BOT_MARKER_RE = /<!--\s*dsh-superagent:[^\n>]+-->/
export const botMarker = (messageId: string): string => `<!-- dsh-superagent:${messageId} -->`
export const hasBotMarker = (text: string): boolean => BOT_MARKER_RE.test(text)

export function parseAliases(raw: string): string[] {
  return raw.split(/[\s,]+/).map(item => item.trim()).filter(Boolean)
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '').toLowerCase()
}

/** Matches a GitLab `path_with_namespace` against exact `group/repo`, single-level `group/*`, or recursive `group/**`. */
export function matchesProjectPattern(projectPath: string, pattern: string): boolean {
  const path = normalizePath(projectPath)
  const pat = normalizePath(pattern)
  if (!path || !pat) return false
  if (pat.endsWith('/**')) {
    const prefix = pat.slice(0, -3)
    return prefix.length > 0 && path.startsWith(`${prefix}/`)
  }
  if (pat.endsWith('/*')) {
    const prefix = pat.slice(0, -2)
    return prefix.length > 0 && path.startsWith(`${prefix}/`) && !path.slice(prefix.length + 1).includes('/')
  }
  return path === pat
}

/** True when `text` explicitly addresses `@login` or any configured alias (`@agent`, `/agent`), avoiding email and URL false positives. */
export function mentionsGitlab(text: string, login: string, aliases: readonly string[] = []): boolean {
  if (!text) return false
  const mentionPattern = (token: string): RegExp =>
    new RegExp(`(?:^|[^a-zA-Z0-9_@.%+-])${escapeRegExp(token)}(?![a-zA-Z0-9_.-])`, 'i')
  if (login && mentionPattern(`@${login}`).test(text)) return true
  for (const alias of aliases) {
    const clean = alias.trim()
    if (!clean) continue
    if (clean.startsWith('@')) {
      if (mentionPattern(clean).test(text)) return true
    } else if (new RegExp(`(?:^|\\s)${escapeRegExp(clean)}(?=$|\\s|[，。,:：!?！？])`, 'i').test(text)) {
      return true
    }
  }
  return false
}

export interface GitlabChannelAddress {
  projectId: number
  projectPath: string
  kind: 'issue' | 'mr'
  iid: number
  discussionId?: string
  url?: string
}

export const gitlabThreadId = (projectId: number, kind: 'issue' | 'mr' | 'pipeline', id: number | string): string =>
  `${projectId}:${kind}:${id}`

export function parseGitlabThreadId(threadId: string): { projectId: number; kind: 'issue' | 'mr'; iid: number } | { projectId: number; kind: 'pipeline'; ref: string } | undefined {
  const issueOrMr = /^(\d+):(issue|mr):(\d+)$/.exec(threadId)
  if (issueOrMr) return { projectId: Number(issueOrMr[1]), kind: issueOrMr[2] as 'issue' | 'mr', iid: Number(issueOrMr[3]) }
  const pipeline = /^(\d+):pipeline:(.+)$/.exec(threadId)
  if (pipeline) return { projectId: Number(pipeline[1]), kind: 'pipeline', ref: pipeline[2]! }
  return undefined
}

export const gitlabChannel = (addr: GitlabChannelAddress): ChannelRef => ({
  source: SOURCE,
  thread: `${SOURCE}:${gitlabThreadId(addr.projectId, addr.kind, addr.iid)}`,
  address: {
    projectId: String(addr.projectId),
    projectPath: addr.projectPath,
    kind: addr.kind,
    iid: String(addr.iid),
    ...(addr.discussionId ? { discussionId: addr.discussionId } : {}),
    ...(addr.url ? { url: addr.url } : {}),
  },
})

export const gitlabPage = (host: string, projectPath: string, kind: 'issue' | 'mr', iid: number): string =>
  `${host.replace(/\/+$/, '')}/${projectPath.replace(/^\/+|\/+$/g, '')}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`

/** Parses a GitLab web URL for an Issue or Merge Request, optionally validating its host origin. */
export function gitlabAddress(url: string, host?: string): { projectPath: string; kind: 'issue' | 'mr'; iid: number } | undefined {
  let parsedUrl: URL
  try { parsedUrl = new URL(url) } catch { return undefined }
  if (host) {
    try { if (parsedUrl.origin.toLowerCase() !== new URL(host).origin.toLowerCase()) return undefined }
    catch { return undefined }
  }
  const match = /^\/(.+?)(?:\/-)?\/(issues|merge_requests)\/(\d+)\/?$/i.exec(parsedUrl.pathname)
  if (!match) return undefined
  let projectPath: string
  try { projectPath = decodeURIComponent(match[1]!) } catch { projectPath = match[1]! }
  return { projectPath, kind: match[2]!.toLowerCase() === 'issues' ? 'issue' : 'mr', iid: Number(match[3]) }
}

function normalizeTimestamp(raw?: string | null): string {
  if (!raw) return new Date().toISOString()
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/i.test(raw.trim())
    ? `${raw.trim().slice(0, 10)}T${raw.trim().slice(11, 19)}Z`
    : raw.trim()
  const time = Date.parse(candidate)
  return Number.isNaN(time) ? new Date().toISOString() : new Date(time).toISOString()
}

const ProjectSchema = z.looseObject({
  id: z.number().int().positive(),
  path_with_namespace: z.string().min(1),
  git_ssh_url: z.string().nullish(),
  git_http_url: z.string().nullish(),
  web_url: z.string().nullish(),
  default_branch: z.string().nullish(),
})

const UserSchema = z.looseObject({
  username: z.string().min(1),
  name: z.string().nullish(),
  bot: z.boolean().nullish(),
})

const NotePositionSchema = z.looseObject({
  new_path: z.string().nullish(),
  old_path: z.string().nullish(),
  new_line: z.number().int().nullish(),
  old_line: z.number().int().nullish(),
}).nullish()

const NoteHookSchema = z.looseObject({
  object_kind: z.literal('note'),
  user: UserSchema,
  project: ProjectSchema,
  object_attributes: z.looseObject({
    id: z.number().int().positive(),
    note: z.string().nullish(),
    noteable_type: z.string(),
    discussion_id: z.string().nullish(),
    system: z.boolean().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    url: z.string().nullish(),
    position: NotePositionSchema,
  }),
  issue: z.looseObject({ iid: z.number().int().positive(), title: z.string().nullish(), url: z.string().nullish() }).nullish(),
  merge_request: z.looseObject({
    iid: z.number().int().positive(),
    title: z.string().nullish(),
    source_branch: z.string().nullish(),
    target_branch: z.string().nullish(),
    url: z.string().nullish(),
  }).nullish(),
})

const IssueHookSchema = z.looseObject({
  object_kind: z.literal('issue'),
  user: UserSchema,
  project: ProjectSchema,
  object_attributes: z.looseObject({
    iid: z.number().int().positive(),
    title: z.string(),
    description: z.string().nullish(),
    action: z.string().nullish(),
    state: z.string().nullish(),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    url: z.string().nullish(),
  }),
})

const MergeRequestHookSchema = z.looseObject({
  object_kind: z.literal('merge_request'),
  user: UserSchema,
  project: ProjectSchema,
  object_attributes: z.looseObject({
    iid: z.number().int().positive(),
    title: z.string(),
    description: z.string().nullish(),
    action: z.string().nullish(),
    state: z.string().nullish(),
    source_branch: z.string().default(''),
    target_branch: z.string().default(''),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    url: z.string().nullish(),
  }),
})

const PipelineHookSchema = z.looseObject({
  object_kind: z.literal('pipeline'),
  user: UserSchema.nullish(),
  project: ProjectSchema,
  object_attributes: z.looseObject({
    id: z.number().int().positive(),
    ref: z.string().min(1),
    sha: z.string().nullish(),
    status: z.string(),
    created_at: z.string().nullish(),
    finished_at: z.string().nullish(),
    url: z.string().nullish(),
  }),
  merge_request: z.looseObject({
    iid: z.number().int().positive(),
    title: z.string().nullish(),
    url: z.string().nullish(),
  }).nullish(),
  builds: z.array(z.looseObject({
    name: z.string().optional(),
    stage: z.string().optional(),
    status: z.string().optional(),
  })).nullish(),
})

export interface GitlabMrLifecycleEvent {
  projectId: number
  projectPath: string
  iid: number
  action: string
  state: string
  sourceBranch: string
  targetBranch: string
  title: string
  url: string
  author?: string
  sshUrl?: string
  httpUrl?: string
  updatedAt: string
}

export interface ParsedGitlabWebhook {
  trigger?: Trigger
  mrEvent?: GitlabMrLifecycleEvent
  threadLabel?: string
  projectPath?: string
  kind?: 'note' | 'issue' | 'mr' | 'pipeline'
}

export interface ParseGitlabWebhookOptions {
  login: string
  aliases: readonly string[]
  nextPipelineRevision?: (projectId: number, ref: string, fingerprint: string) => number | undefined
}

function projectMeta(project: z.infer<typeof ProjectSchema>): Record<string, unknown> {
  return {
    projectId: project.id,
    projectPath: project.path_with_namespace,
    ...(project.git_ssh_url ? { sshUrl: project.git_ssh_url } : {}),
    ...(project.git_http_url ? { httpUrl: project.git_http_url } : {}),
    ...(project.web_url ? { webUrl: project.web_url } : {}),
  }
}

function diffLocation(position: z.infer<typeof NotePositionSchema>): string {
  if (!position) return ''
  const path = position.new_path ?? position.old_path
  if (!path) return ''
  const line = position.new_line ?? position.old_line
  return line != null ? `${path}:${line}` : path
}

/** Translates a single GitLab webhook payload into a Trigger and/or MR lifecycle event. */
export function parseGitlabWebhookEvent(eventType: string, payload: unknown, options: ParseGitlabWebhookOptions): ParsedGitlabWebhook {
  if (!payload || typeof payload !== 'object') return {}
  const objectKind = (payload as { object_kind?: unknown }).object_kind
  const isNote = eventType === 'Note Hook' || objectKind === 'note'
  if (isNote) {
    const parsed = NoteHookSchema.safeParse(payload)
    if (!parsed.success) return {}
    const { user, project, object_attributes: attr, issue, merge_request: mr } = parsed.data
    const projectPath = project.path_with_namespace
    if (attr.system) return { projectPath, kind: 'note' }
    const body = attr.note ?? ''
    if (hasBotMarker(body)) return { projectPath, kind: 'note' }
    const kind = attr.noteable_type === 'Issue' && issue ? 'issue'
      : attr.noteable_type === 'MergeRequest' && mr ? 'mr' : undefined
    if (!kind) return { projectPath, kind: 'note' }
    const iid = kind === 'issue' ? issue!.iid : mr!.iid
    const title = (kind === 'issue' ? issue!.title : mr!.title) ?? ''
    const url = attr.url ?? (kind === 'issue' ? issue!.url : mr!.url) ?? undefined
    const at = normalizeTimestamp(attr.updated_at ?? attr.created_at)
    const place = diffLocation(attr.position)
    const text = [place, body].filter(Boolean).join('\n\n')
    const threadId = gitlabThreadId(project.id, kind, iid)
    const channel = gitlabChannel({
      projectId: project.id, projectPath, kind, iid,
      ...(attr.discussion_id ? { discussionId: attr.discussion_id } : {}),
      ...(url ? { url } : {}),
    })
    const trigger: Trigger = {
      id: key('gitlab-note', String(project.id), String(attr.id), attr.updated_at ?? ''),
      source: SOURCE,
      threads: [{ source: SOURCE, id: threadId }],
      actor: { source: SOURCE, id: user.username },
      human: user.bot !== true,
      at,
      text,
      ...(mentionsGitlab(body, options.login, options.aliases) ? { addressed: 'mention' as const } : {}),
      channel,
      ...(url ? { url } : {}),
      meta: {
        ...projectMeta(project),
        kind: 'note',
        noteableType: kind,
        iid,
        noteId: attr.id,
        ...(attr.discussion_id ? { discussionId: attr.discussion_id } : {}),
        ...(kind === 'mr' && mr?.source_branch ? { sourceBranch: mr.source_branch } : {}),
        ...(kind === 'mr' && mr?.target_branch ? { targetBranch: mr.target_branch } : {}),
        ...(place ? { position: place } : {}),
      },
    }
    const label = `${projectPath}${kind === 'mr' ? '!' : '#'}${iid}${title ? ` ${title}` : ''}`
    return { trigger, threadLabel: label, projectPath, kind: 'note' }
  }

  const isIssue = eventType === 'Issue Hook' || objectKind === 'issue'
  if (isIssue) {
    const parsed = IssueHookSchema.safeParse(payload)
    if (!parsed.success) return {}
    const { user, project, object_attributes: attr } = parsed.data
    const projectPath = project.path_with_namespace
    const action = attr.action ?? ''
    if (action !== 'open' && action !== 'reopen') return { projectPath, kind: 'issue' }
    const description = attr.description ?? ''
    if (hasBotMarker(description) || hasBotMarker(attr.title)) return { projectPath, kind: 'issue' }
    const at = normalizeTimestamp(attr.created_at ?? attr.updated_at)
    const text = [attr.title, description].filter(Boolean).join('\n\n')
    const url = attr.url ?? undefined
    const threadId = gitlabThreadId(project.id, 'issue', attr.iid)
    const trigger: Trigger = {
      id: key('gitlab-issue', String(project.id), String(attr.iid), action === 'reopen' ? at : ''),
      source: SOURCE,
      threads: [{ source: SOURCE, id: threadId }],
      actor: { source: SOURCE, id: user.username },
      human: user.bot !== true,
      at,
      text,
      ...(mentionsGitlab(text, options.login, options.aliases) ? { addressed: 'mention' as const } : {}),
      channel: gitlabChannel({ projectId: project.id, projectPath, kind: 'issue', iid: attr.iid, ...(url ? { url } : {}) }),
      ...(url ? { url } : {}),
      meta: { ...projectMeta(project), kind: 'issue', iid: attr.iid, action },
    }
    return { trigger, threadLabel: `${projectPath}#${attr.iid} ${attr.title}`, projectPath, kind: 'issue' }
  }

  const isMr = eventType === 'Merge Request Hook' || objectKind === 'merge_request'
  if (isMr) {
    const parsed = MergeRequestHookSchema.safeParse(payload)
    if (!parsed.success) return {}
    const { user, project, object_attributes: attr } = parsed.data
    const projectPath = project.path_with_namespace
    const action = attr.action ?? ''
    const state = attr.state ?? ''
    const url = attr.url ?? ''
    const updatedAt = normalizeTimestamp(attr.updated_at ?? attr.created_at)
    const mrEvent: GitlabMrLifecycleEvent = {
      projectId: project.id,
      projectPath,
      iid: attr.iid,
      action,
      state,
      sourceBranch: attr.source_branch,
      targetBranch: attr.target_branch,
      title: attr.title,
      url,
      author: user.username,
      ...(project.git_ssh_url ? { sshUrl: project.git_ssh_url } : {}),
      ...(project.git_http_url ? { httpUrl: project.git_http_url } : {}),
      updatedAt,
    }
    const threadLabel = `${projectPath}!${attr.iid} ${attr.title}`
    if (action !== 'open' && action !== 'reopen') return { mrEvent, threadLabel, projectPath, kind: 'mr' }
    const description = attr.description ?? ''
    if (hasBotMarker(description) || hasBotMarker(attr.title)) return { mrEvent, threadLabel, projectPath, kind: 'mr' }
    const text = [attr.title, description].filter(Boolean).join('\n\n')
    const threadId = gitlabThreadId(project.id, 'mr', attr.iid)
    const trigger: Trigger = {
      id: key('gitlab-mr', String(project.id), String(attr.iid), action === 'reopen' ? updatedAt : ''),
      source: SOURCE,
      threads: [{ source: SOURCE, id: threadId }],
      actor: { source: SOURCE, id: user.username },
      human: user.bot !== true,
      at: normalizeTimestamp(attr.created_at ?? attr.updated_at),
      text,
      ...(mentionsGitlab(text, options.login, options.aliases) ? { addressed: 'mention' as const } : {}),
      channel: gitlabChannel({ projectId: project.id, projectPath, kind: 'mr', iid: attr.iid, ...(url ? { url } : {}) }),
      ...(url ? { url } : {}),
      meta: {
        ...projectMeta(project),
        kind: 'mr',
        iid: attr.iid,
        action,
        mrAuthor: user.username,
        sourceBranch: attr.source_branch,
        targetBranch: attr.target_branch,
      },
    }
    return { trigger, mrEvent, threadLabel, projectPath, kind: 'mr' }
  }

  const isPipeline = eventType === 'Pipeline Hook' || objectKind === 'pipeline'
  if (isPipeline) {
    const parsed = PipelineHookSchema.safeParse(payload)
    if (!parsed.success) return {}
    const { project, object_attributes: attr, merge_request: mr, builds } = parsed.data
    const projectPath = project.path_with_namespace
    if (attr.status !== 'failed' && attr.status !== 'success') return { projectPath, kind: 'pipeline' }
    const failedJobs = (builds ?? []).filter(b => b.status === 'failed' && b.name).map(b => b.name!).sort()
    const fingerprint = `${attr.status}:${failedJobs.join(',')}`
    const revision = options.nextPipelineRevision?.(project.id, attr.ref, fingerprint)
    if (revision === undefined) return { projectPath, kind: 'pipeline' }
    const url = attr.url ?? (project.web_url ? `${project.web_url.replace(/\/+$/, '')}/-/pipelines/${attr.id}` : undefined)
    const summary = attr.status === 'failed'
      ? `GitLab pipeline #${attr.id} on ${projectPath}@${attr.ref} failed${failedJobs.length ? `: ${failedJobs.join(', ')}` : ''}.`
      : `GitLab pipeline #${attr.id} on ${projectPath}@${attr.ref} recovered (success).`
    const thread = mr
      ? { source: SOURCE, id: gitlabThreadId(project.id, 'mr', mr.iid) }
      : { source: SOURCE, id: gitlabThreadId(project.id, 'pipeline', attr.ref) }
    const trigger: Trigger = {
      id: key('gitlab-pipeline', String(project.id), attr.ref, String(revision)),
      source: SOURCE,
      threads: [thread],
      actor: { source: SOURCE, id: '' },
      human: false,
      at: normalizeTimestamp(attr.finished_at ?? attr.created_at),
      text: summary,
      ...(mr ? { channel: gitlabChannel({ projectId: project.id, projectPath, kind: 'mr', iid: mr.iid, ...(mr.url ? { url: mr.url } : {}) }) } : {}),
      ...(url ? { url } : {}),
      meta: {
        ...projectMeta(project),
        kind: 'pipeline',
        ci: true,
        ref: attr.ref,
        pipelineId: attr.id,
        status: attr.status,
        ...(attr.sha ? { sha: attr.sha } : {}),
        ...(mr ? { iid: mr.iid } : {}),
        revision,
      },
    }
    return { trigger, threadLabel: mr ? `${projectPath}!${mr.iid}` : `${projectPath} CI (${attr.ref})`, projectPath, kind: 'pipeline' }
  }

  return {}
}
