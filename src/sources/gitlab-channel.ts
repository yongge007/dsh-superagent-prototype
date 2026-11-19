/** GitLab outbound channel: posts Issue/MR notes and discussion replies idempotently with hidden loop-prevention markers. */
import { z } from 'zod'
import type { OutboundMessage } from '../core/index.ts'
import { CliError } from '../infra/commands.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, ChannelLinks } from './kind.ts'
import { botMarker, gitlabPage } from './gitlab-trigger.ts'

const NoteSchema = z.looseObject({
  id: z.number(),
  body: z.string().nullish(),
  author: z.looseObject({ username: z.string() }).nullish(),
})

/** True when the target Issue/MR is permanently gone (410) or locked (403 locked); 404 on the noteable is retried. */
const gone = (error: unknown): boolean => error instanceof CliError
  && (error.code === 410 || (error.code === 403 && /locked/i.test(error.message)))
const missing = (error: unknown): boolean => error instanceof CliError && (error.code === 400 || error.code === 404 || error.code === 410)

/** Posts a GitLab note or discussion reply with an embedded HTML marker so retries never duplicate and self-comments never loop. */
export async function sendGitlab(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const { commands } = host
  const gitlab = commands.deployment.gitlab
  if (!gitlab) throw new Error('The GitLab Source is not configured')
  const projectId = Number(message.channel.address.projectId)
  const kind = message.channel.address.kind
  const iid = Number(message.channel.address.iid)
  const discussionId = message.channel.address.discussionId
  if (!projectId || !iid || (kind !== 'issue' && kind !== 'mr')) throw new Error('Missing GitLab reply target')

  const noteable = kind === 'mr' ? 'merge_requests' : 'issues'
  const notesPath = `projects/${projectId}/${noteable}/${iid}/notes`
  const marker = botMarker(message.id)
  const body = `body=${message.text}\n\n${marker}`

  try {
    const existing = await commands.gitlabPages(NoteSchema, `${notesPath}?sort=desc&order_by=created_at`)
    if (existing.some(note => sameName(note.author?.username ?? '', gitlab.login) && (note.body ?? '').includes(marker))) {
      return 'sent'
    }
    if (discussionId) {
      const discussionPath = `projects/${projectId}/${noteable}/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`
      try {
        await commands.gitlabApi(z.unknown(), discussionPath, '-X', 'POST', '-f', body)
        return 'sent'
      } catch (error) {
        if (!missing(error)) throw error
        // Fall back to a top-level note when the discussion thread was deleted or unavailable.
      }
    }
    await commands.gitlabApi(z.unknown(), notesPath, '-X', 'POST', '-f', body)
    return 'sent'
  } catch (error) {
    if (gone(error)) return 'gone'
    throw error
  }
}

export function gitlabLink(address: Record<string, string>, links: ChannelLinks): ChannelLink {
  const projectPath = address.projectPath || address.projectId || ''
  const kind = address.kind === 'mr' ? 'mr' : 'issue'
  const iid = Number(address.iid)
  const url = address.url || (links.gitlab?.host && address.projectPath && iid ? gitlabPage(links.gitlab.host, address.projectPath, kind, iid) : '')
  const ref = `${projectPath}${kind === 'mr' ? '!' : '#'}${address.iid ?? ''}`
  return {
    url,
    label: address.discussionId
      ? { zh: `GitLab ${ref} 的讨论`, en: `Discussion on GitLab ${ref}` }
      : { zh: `GitLab ${ref}`, en: `GitLab ${ref}` },
  }
}
