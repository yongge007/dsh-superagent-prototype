/** WAL-mode SQLite queue and 0600 token file helpers shared between the standalone GitLab webhook receiver and the gitlab Source. */
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const webhookTokenPath = (stateDir: string): string => join(stateDir, 'gitlab-webhook.token')
export const webhookQueuePath = (stateDir: string): string => join(stateDir, 'gitlab-webhook-queue.sqlite')

export function readWebhookToken(stateDir: string): string | undefined {
  const path = webhookTokenPath(stateDir)
  if (!existsSync(path)) return undefined
  const token = readFileSync(path, 'utf8').trim()
  return token || undefined
}

export function ensureWebhookToken(stateDir: string): string {
  const existing = readWebhookToken(stateDir)
  if (existing) return existing
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const token = randomBytes(32).toString('hex')
  const path = webhookTokenPath(stateDir)
  try {
    writeFileSync(path, `${token}\n`, { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
    return token
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const raced = readWebhookToken(stateDir)
      if (raced) return raced
    }
    throw error
  }
}

export interface QueuedGitlabEvent {
  seq: number
  deliveryUuid: string
  eventType: string
  receivedAt: string
  payload: string
}

/** Persistent WAL-mode SQLite queue storing verified GitLab webhook deliveries with monotonic sequence IDs and UUID deduplication. */
export class GitlabWebhookQueue {
  private readonly db: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=FULL;
        PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          delivery_uuid TEXT UNIQUE,
          event_type TEXT NOT NULL,
          received_at TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `)
      for (const file of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(file)) chmodSync(file, 0o600)
      }
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  enqueue(input: { deliveryUuid: string; eventType: string; receivedAt?: string; payload: string }): { seq: number; duplicate: boolean } {
    const existing = this.db.prepare('SELECT seq FROM events WHERE delivery_uuid = ?').get(input.deliveryUuid) as { seq: number } | undefined
    if (existing) return { seq: Number(existing.seq), duplicate: true }
    const receivedAt = input.receivedAt ?? new Date().toISOString()
    const inserted = this.db.prepare(
      'INSERT OR IGNORE INTO events (delivery_uuid, event_type, received_at, payload) VALUES (?, ?, ?, ?)',
    ).run(input.deliveryUuid, input.eventType, receivedAt, input.payload)
    if (inserted.changes > 0) return { seq: Number(inserted.lastInsertRowid), duplicate: false }
    const raced = this.db.prepare('SELECT seq FROM events WHERE delivery_uuid = ?').get(input.deliveryUuid) as { seq: number } | undefined
    return { seq: Number(raced?.seq ?? 0), duplicate: true }
  }

  readAfter(cursor: number, limit = 100): QueuedGitlabEvent[] {
    const rows = this.db.prepare(
      'SELECT seq, delivery_uuid, event_type, received_at, payload FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?',
    ).all(cursor, limit) as { seq: number; delivery_uuid: string; event_type: string; received_at: string; payload: string }[]
    return rows.map(row => ({
      seq: Number(row.seq),
      deliveryUuid: row.delivery_uuid,
      eventType: row.event_type,
      receivedAt: row.received_at,
      payload: row.payload,
    }))
  }

  pruneConsumed(consumedCursor: number, olderThanIso: string): number {
    const result = this.db.prepare('DELETE FROM events WHERE seq <= ? AND received_at < ?').run(consumedCursor, olderThanIso)
    return Number(result.changes)
  }

  count(afterSeq = 0): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM events WHERE seq > ?').get(afterSeq) as { count: number }
    return Number(row.count)
  }

  close(): void { this.db.close() }
}
