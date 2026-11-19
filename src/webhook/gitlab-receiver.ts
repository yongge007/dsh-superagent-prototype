/** Standalone HTTP receiver for self-hosted GitLab webhooks; verifies X-Gitlab-Token and appends events to a WAL SQLite queue. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitlabWebhookQueue, ensureWebhookToken, webhookQueuePath } from './gitlab-queue.ts'

export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024

export function verifyGitlabToken(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false
  const left = Buffer.from(provided, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
  res.end(JSON.stringify(body))
}

/** Sentinel error thrown when an incoming webhook request body exceeds `MAX_WEBHOOK_BYTES`. */
class BodyTooLarge extends Error {}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > maxBytes) throw new BodyTooLarge()
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name.toLowerCase()]
  return typeof raw === 'string' ? raw.trim() : Array.isArray(raw) ? raw[0]?.trim() : undefined
}

export function createGitlabWebhookServer(options: { stateDir: string; token?: string; maxBytes?: number }): {
  server: Server
  queue: GitlabWebhookQueue
  token: string
  close(): Promise<void>
} {
  const token = options.token ?? ensureWebhookToken(options.stateDir)
  const maxBytes = options.maxBytes ?? MAX_WEBHOOK_BYTES
  const queue = new GitlabWebhookQueue(webhookQueuePath(options.stateDir))
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      if (pathname === '/healthz') {
        if (req.method !== 'GET') { sendJson(res, 405, { error: 'Method not allowed' }); return }
        sendJson(res, 200, { ok: true, queued: queue.count() })
        return
      }
      if (pathname !== '/hooks/gitlab') {
        sendJson(res, 404, { error: 'Not found' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }
      if (!verifyGitlabToken(headerValue(req, 'x-gitlab-token'), token)) {
        sendJson(res, 401, { error: 'Invalid webhook token' })
        return
      }
      const eventType = headerValue(req, 'x-gitlab-event')
      if (!eventType) {
        sendJson(res, 400, { error: 'Missing X-Gitlab-Event header' })
        return
      }
      const contentLength = Number(headerValue(req, 'content-length'))
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        sendJson(res, 413, { error: 'Payload too large' }, { connection: 'close' })
        res.once('finish', () => { req.destroy() })
        return
      }
      let raw: string
      try { raw = await readBody(req, maxBytes) }
      catch (error) {
        if (error instanceof BodyTooLarge) {
          sendJson(res, 413, { error: 'Payload too large' }, { connection: 'close' })
          res.once('finish', () => { req.destroy() })
          return
        }
        sendJson(res, 500, { error: 'Failed reading request body' }); return
      }
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { sendJson(res, 400, { error: 'Body must be valid JSON' }); return }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendJson(res, 400, { error: 'Body must be a JSON object' })
        return
      }
      const deliveryUuid = headerValue(req, 'x-gitlab-event-uuid') || randomUUID()
      const { seq, duplicate } = queue.enqueue({ deliveryUuid, eventType, payload: raw })
      sendJson(res, 202, { accepted: true, seq, duplicate })
    } catch {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' })
    }
  })
  const close = () => new Promise<void>(resolveClose => {
    server.close(() => { queue.close(); resolveClose() })
  })
  return { server, queue, token, close }
}

function parseCliArgs(argv: readonly string[]): { stateDir: string; host: string; port: number } {
  let stateDir = process.env.DSH_SUPERAGENT_STATE_DIR ?? ''
  let host = process.env.DSH_SUPERAGENT_GITLAB_WEBHOOK_HOST ?? '0.0.0.0'
  let port = Number(process.env.DSH_SUPERAGENT_GITLAB_WEBHOOK_PORT ?? '3083')
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--state-dir' && argv[i + 1]) stateDir = argv[++i]!
    else if (arg.startsWith('--state-dir=')) stateDir = arg.slice('--state-dir='.length)
    else if (arg === '--host' && argv[i + 1]) host = argv[++i]!
    else if (arg.startsWith('--host=')) host = arg.slice('--host='.length)
    else if (arg === '--port' && argv[i + 1]) port = Number(argv[++i]!)
    else if (arg.startsWith('--port=')) port = Number(arg.slice('--port='.length))
  }
  if (!stateDir || !stateDir.startsWith('/')) throw new Error('--state-dir must be an absolute path')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer between 1 and 65535')
  return { stateDir, host, port }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const { stateDir, host, port } = parseCliArgs(process.argv.slice(2))
  const instance = createGitlabWebhookServer({ stateDir })
  const stop = () => { void instance.close().then(() => process.exit(0)) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  instance.server.on('error', error => {
    console.error(`dsh-superagent gitlab-webhook error: ${error.message}`)
    instance.queue.close()
    process.exit(1)
  })
  instance.server.listen(port, host, () => {
    console.log(`dsh-superagent gitlab-webhook listening on http://${host}:${port}/hooks/gitlab`)
  })
}
