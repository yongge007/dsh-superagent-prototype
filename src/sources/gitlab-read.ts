/** Read-only GitLab repository, Issue/MR, discussion notes, and threadContext readers for assessments and workers. */
import { z } from 'zod'
import { validItems, type Commands } from '../infra/commands.ts'
import type { ContextMessage, ThreadContext } from './kind.ts'
import { hasBotMarker } from './gitlab-trigger.ts'

const AuthorSchema = z.looseObject({
  username: z.string(),
  bot: z.boolean().nullish(),
}).nullish().transform(author => author ?? { username: 'ghost', bot: false })

const PositionSchema = z.looseObject({
  new_path: z.string().nullish(),
  old_path: z.string().nullish(),
  new_line: z.number().int().nullish(),
  old_line: z.number().int().nullish(),
}).nullish()

const NoteSchema = z.looseObject({
  id: z.number().int().positive(),
  body: z.string().nullish(),
  author: AuthorSchema,
  system: z.boolean().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  position: PositionSchema,
})

const IssueSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  author: AuthorSchema,
  created_at: z.string().nullish(),
  web_url: z.string().nullish(),
  labels: z.array(z.string()).nullish(),
})

const MergeRequestDetailSchema = IssueSchema.extend({
  draft: z.boolean().nullish(),
  work_in_progress: z.boolean().nullish(),
  source_branch: z.string().nullish(),
  target_branch: z.string().nullish(),
})

const MergeRequestChangesSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string().optional(),
  changes: z.array(z.looseObject({
    old_path: z.string().optional(),
    new_path: z.string().optional(),
    diff: z.string().optional(),
  })).default([]),
})

function noteToContextMessage(note: z.infer<typeof NoteSchema>): ContextMessage {
  const body = note.body ?? ''
  const path = note.position?.new_path ?? note.position?.old_path ?? undefined
  const line = note.position?.new_line ?? note.position?.old_line ?? undefined
  const bot = note.author.bot === true || hasBotMarker(body)
  return {
    id: String(note.id),
    from: note.author.username,
    at: note.created_at ?? note.updated_at ?? '',
    text: body,
    ...(bot ? { bot: true as const } : {}),
    ...(path ? { path, ...(line != null ? { line } : {}) } : {}),
  }
}

function itemToContextMessage(item: z.infer<typeof IssueSchema>): ContextMessage {
  const body = item.description ?? ''
  const text = [item.title, body].filter(Boolean).join('\n\n')
  const bot = item.author.bot === true || hasBotMarker(body)
  return {
    id: item.web_url ?? String(item.iid),
    from: item.author.username,
    at: item.created_at ?? '',
    text,
    ...(bot ? { bot: true as const } : {}),
    ...(item.web_url ? { url: item.web_url } : {}),
  }
}

/** Reads a non-hidden file or directory listing from a GitLab project via `glab api`; hidden entries and `node_modules` are rejected. */
export async function readGitlabRepositoryPath(commands: Commands, projectId: number, path: string, kind: 'file' | 'directory', ref = 'HEAD'): Promise<string> {
  const parts = path.split('/').filter(part => part && part !== '.')
  if (parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) {
    throw new Error('Only non-hidden repository source paths are available')
  }
  const cleanPath = parts.join('/')
  if (kind === 'file') {
    if (!cleanPath) throw new Error('File path must not be empty')
    return commands.gitlabApi(`projects/${projectId}/repository/files/${encodeURIComponent(cleanPath)}/raw?ref=${encodeURIComponent(ref)}`)
  }
  const query = cleanPath ? `path=${encodeURIComponent(cleanPath)}&per_page=100` : 'per_page=100'
  const entries = await commands.gitlabApi(z.array(z.looseObject({ name: z.string() })), `projects/${projectId}/repository/tree?${query}`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/**
 * Reads a GitLab Issue, Merge Request, paginated notes, or MR changes for `orchestrator_read`.
 * Supports `gitlab/<projectId>/(issues|merge_requests)/<iid>[/notes/<page>|/changes]`.
 */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const match = /^gitlab\/([1-9]\d*)\/(issues|merge_requests)\/([1-9]\d*)(?:\/(notes|changes)(?:\/([1-9]\d*))?)?$/.exec(resource)
  if (!match) {
    throw new Error('Use gitlab/<projectId>/issues/<iid>, gitlab/<projectId>/merge_requests/<iid>, or append /notes/<page> or /changes')
  }
  const [, projectId, kind, iid, section, page = '1'] = match
  if (kind === 'issues' && section === 'changes') throw new Error('Changes require a merge request')
  const basePath = `projects/${projectId}/${kind}/${iid}`
  if (!section) {
    if (kind === 'merge_requests') {
      const mr = await commands.gitlabApi(MergeRequestDetailSchema, basePath)
      return {
        iid: mr.iid, title: mr.title, state: mr.state,
        ...(mr.draft || mr.work_in_progress ? { draft: true } : {}),
        ...(mr.source_branch ? { source_branch: mr.source_branch } : {}),
        ...(mr.target_branch ? { target_branch: mr.target_branch } : {}),
        ...(mr.labels?.length ? { labels: mr.labels } : {}),
        ...itemToContextMessage(mr),
      }
    }
    const issue = await commands.gitlabApi(IssueSchema, basePath)
    return {
      iid: issue.iid, title: issue.title, state: issue.state,
      ...(issue.labels?.length ? { labels: issue.labels } : {}),
      ...itemToContextMessage(issue),
    }
  }
  if (section === 'changes') {
    if (match[5]) throw new Error('Changes do not take a page number')
    const data = await commands.gitlabApi(MergeRequestChangesSchema, `${basePath}/changes`)
    return { iid: data.iid, ...(data.title ? { title: data.title } : {}), changes: data.changes }
  }
  const listed = await commands.gitlabApi(z.array(z.unknown()), `${basePath}/notes?sort=asc&order_by=created_at&per_page=20&page=${page}`)
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally).filter(note => note.system !== true)
  return {
    messages: notes.map(noteToContextMessage),
    ...(tally.skipped ? { skipped: tally.skipped } : {}),
    ...(listed.length === 20 ? { next_resource: `gitlab/${projectId}/${kind}/${iid}/notes/${Number(page) + 1}` } : {}),
  }
}

/** Bounded thread context reader for GitLab Triggers during proactive candidate assessment. */
export const gitlabThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => trigger.meta.noteId != null ? String(trigger.meta.noteId) : (trigger.url ?? String(trigger.meta.iid ?? trigger.id)),
  read: async (commands, trigger, part, cursor) => {
    if (trigger.meta.kind === 'pipeline' && trigger.meta.iid == null) {
      const message: ContextMessage = { id: trigger.url ?? trigger.id, from: 'CI', at: trigger.at, text: trigger.text, bot: true }
      return { messages: [message], body: { status: 'pipeline', messages: [message] }, status: 'pipeline' }
    }
    const projectId = Number(trigger.meta.projectId)
    const iid = Number(trigger.meta.iid)
    const kind = trigger.meta.noteableType === 'mr' || trigger.meta.kind === 'mr' ? 'mr' : 'issue'
    const noteable = kind === 'mr' ? 'merge_requests' : 'issues'
    if (part === 'root') {
      const item = await commands.gitlabApi(IssueSchema, `projects/${projectId}/${noteable}/${iid}`)
      const message = itemToContextMessage(item)
      return { messages: [message], body: { status: part, messages: [message] }, status: part }
    }
    const discussionId = typeof trigger.meta.discussionId === 'string' && trigger.meta.discussionId ? trigger.meta.discussionId : undefined
    if (discussionId && trigger.meta.position) {
      const discussion = await commands.gitlabApi(
        z.looseObject({ notes: z.array(z.unknown()).default([]) }),
        `projects/${projectId}/${noteable}/${iid}/discussions/${encodeURIComponent(discussionId)}`,
      )
      const tally = { skipped: 0 }
      const notes = validItems(NoteSchema, discussion.notes, tally).filter(note => note.system !== true)
      const all = notes.map(noteToContextMessage)
      const messages = part === 'parent' ? all.slice(0, 1) : all
      return {
        messages,
        body: { status: 'discussion', messages, ...(tally.skipped ? { skipped: tally.skipped } : {}) },
        status: 'discussion',
      }
    }
    if (part === 'parent') {
      const item = await commands.gitlabApi(IssueSchema, `projects/${projectId}/${noteable}/${iid}`)
      const message = itemToContextMessage(item)
      return { messages: [message], body: { status: part, messages: [message] }, status: part }
    }
    const page = Number(cursor ?? '1')
    const rootMessages = page === 1
      ? [itemToContextMessage(await commands.gitlabApi(IssueSchema, `projects/${projectId}/${noteable}/${iid}`))]
      : []
    const listed = await commands.gitlabApi(z.array(z.unknown()), `projects/${projectId}/${noteable}/${iid}/notes?sort=asc&order_by=created_at&per_page=50&page=${page}`)
    const tally = { skipped: 0 }
    const notes = validItems(NoteSchema, listed, tally).filter(note => note.system !== true)
    const messages = [...rootMessages, ...notes.map(noteToContextMessage)]
    const next = listed.length === 50 ? String(page + 1) : undefined
    return {
      messages,
      ...(next ? { next } : {}),
      body: { messages, next_resource: next ?? null, ...(tally.skipped ? { skipped: tally.skipped } : {}) },
    }
  },
}
