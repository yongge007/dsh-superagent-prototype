/** GitLab Merge Request binding, webhook lifecycle observation, and terminal IM notification helpers. */
import { z } from 'zod'
import { key, liveTicket, type Follow, type OutboundMessage, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { gitlabAddress, gitlabPage, gitlabThreadId, parseGitlabThreadId, SOURCE, type GitlabMrLifecycleEvent } from './gitlab-trigger.ts'

const MergeRequestSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string().optional(),
  state: z.string(),
  source_branch: z.string(),
  target_branch: z.string().optional(),
  web_url: z.string(),
  author: z.looseObject({ username: z.string() }).nullish(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  updated_at: z.string().nullish(),
})

export type MergeRequest = z.infer<typeof MergeRequestSchema> & { projectId: number; projectPath?: string }

export async function readMergeRequest(ctx: SourceContext, projectId: number, iid: number, signal?: AbortSignal): Promise<MergeRequest> {
  const data = await ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `projects/${projectId}/merge_requests/${iid}`)
  const projectPath = gitlabAddress(data.web_url, ctx.deployment.gitlab?.host)?.projectPath
  return { ...data, projectId, ...(projectPath ? { projectPath } : {}) }
}

const mrRefOfThread = (thread: string): { projectId: number; iid: number } | undefined => {
  if (!thread.startsWith(`${SOURCE}:`)) return undefined
  const parsed = parseGitlabThreadId(thread.slice(SOURCE.length + 1))
  return parsed?.kind === 'mr' ? { projectId: parsed.projectId, iid: parsed.iid } : undefined
}

export const mrsOf = (ticket: Pick<Ticket, 'follows'>, open = false): { projectId: number; iid: number }[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => {
    const ref = mrRefOfThread(item.thread)
    return ref ? [ref] : []
  })

export const mrOf = (ticket: Pick<Ticket, 'follows'>): { projectId: number; iid: number } | undefined =>
  mrsOf(ticket, true).at(-1) ?? mrsOf(ticket).at(-1)

const sameMr = (a: { projectId: number; iid: number }, b: { projectId: number; iid: number }): boolean =>
  a.projectId === b.projectId && a.iid === b.iid

const agentMr = (authorUsername: string | undefined, deployment: Pick<Deployment, 'gitlab'>): boolean =>
  !!deployment.gitlab && !!authorUsername && sameName(authorUsername, deployment.gitlab.login)

const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string): boolean =>
  !!ticket.execution?.name && ref.split('/').at(-1) === ticket.execution.name

function bindMr(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  const threadId = gitlabThreadId(mr.projectId, 'mr', mr.iid)
  const threadKey = `${SOURCE}:${threadId}`
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: threadId }, own)
    ctx.threads.patch(threadKey, {
      projectId: mr.projectId,
      ...(mr.projectPath ? { projectPath: mr.projectPath } : {}),
      iid: mr.iid,
      kind: 'mr',
      url: mr.web_url,
      ...(mr.author?.username ? { mrAuthor: mr.author.username } : {}),
      sourceBranch: mr.source_branch,
      ...(mr.target_branch ? { targetBranch: mr.target_branch } : {}),
    })
  })
}

/**
 * Validates and binds an open GitLab MR to a ticket when the MR is either the ticket's origin MR or an agent-authored MR
 * on the ticket's branch, enforcing that one MR binds to at most one open ticket.
 */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  const source = ctx.triggers.get(ticket.origin.triggerId)
  const started = source?.source === SOURCE
    && Number(source.meta.projectId) === mr.projectId
    && Number(source.meta.iid) === mr.iid
    && (source.meta.kind === 'mr' || source.meta.noteableType === 'mr')
  const opened = agentMr(mr.author?.username, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const login = ctx.deployment.gitlab?.login ?? 'agent'
    return `MR does not belong to this ticket: use the source MR or an MR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit mr_iid when no MR exists`
  }
  const target = { projectId: mr.projectId, iid: mr.iid }
  const owner = ctx.tickets.open().find(item => mrsOf(item, true).some(ref => sameMr(ref, target)))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const threadKey = `${SOURCE}:${gitlabThreadId(mr.projectId, 'mr', mr.iid)}`
  const follow = ticket.follows?.find(item => item.thread === threadKey)
  if (mr.state === 'opened' && (!follow || follow.closed || (opened && !follow.own))) bindMr(ctx, ticketId, mr, opened)
  return undefined
}

/** Reconciles a GitLab Merge Request webhook event against open tickets (binding new agent MRs and closing merged/closed ones). */
export function observeMergeRequestEvent(ctx: SourceContext, event: GitlabMrLifecycleEvent): void {
  const target = { projectId: event.projectId, iid: event.iid }
  const threadId = gitlabThreadId(event.projectId, 'mr', event.iid)
  const threadKey = `${SOURCE}:${threadId}`
  const merged = event.state === 'merged' || event.action === 'merge'
  const closed = event.state === 'closed' || event.action === 'close'
  if (merged || closed) {
    if (!ctx.tickets.open().some(ticket => mrsOf(ticket, true).some(ref => sameMr(ref, target)))) return
    ctx.tickets.threadClosed({ source: SOURCE, id: threadId }, merged ? 'merged' : 'closed', event.updatedAt)
    return
  }
  if (event.state === 'opened' || event.action === 'open' || event.action === 'reopen') {
    const candidates = agentMr(event.author, ctx.deployment)
      ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, event.sourceBranch))
      : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    if (!ticket) return
    const reopened = ticket.follows?.some(item => item.thread === threadKey && item.closed)
    if (reopened || mrsOf(ticket, true).every(ref => sameMr(ref, target))) {
      claimMergeRequest(ctx, ticket.id, {
        projectId: event.projectId,
        projectPath: event.projectPath,
        iid: event.iid,
        title: event.title,
        state: 'opened',
        source_branch: event.sourceBranch,
        target_branch: event.targetBranch,
        web_url: event.url,
        ...(event.author ? { author: { username: event.author } } : {}),
        updated_at: event.updatedAt,
      })
    }
  }
}

/** Builds idempotent outbound notices for non-GitLab channels (e.g. Feishu) when a ticket ends with its MR. */
export function mrEndNotices(
  ticket: Ticket,
  request: string,
  host: string,
  lookupProjectPath: (projectId: number) => string | undefined,
): OutboundMessage[] {
  const outcome = ticket.ended?.outcome
  const follows = (ticket.follows ?? []).filter(item => item.closed && mrRefOfThread(item.thread) !== undefined)
  const latest = (items: Follow[]) => [...items].sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if ((outcome !== 'merged' && outcome !== 'closed') || !follow) return []
  const { projectId, iid } = mrRefOfThread(follow.thread)!
  const projectPath = lookupProjectPath(projectId)
  const label = projectPath ? `[MR !${iid}](${gitlabPage(host, projectPath, 'mr', iid)})` : `MR !${iid}`
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `${label} 已合并。` : `${label} 已关闭，未合并。`
    : outcome === 'merged' ? `${label} has merged.` : `${label} was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(projectId), String(iid), channel.source, JSON.stringify(channel.address), outcome),
    channel,
    text,
    kind: 'notice',
    ticketId: ticket.id,
  }))
}
