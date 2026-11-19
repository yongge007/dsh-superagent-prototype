import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitlabWebhookQueue, ensureWebhookToken, webhookQueuePath, webhookTokenPath } from '../src/webhook/gitlab-queue.ts'
import { MAX_WEBHOOK_BYTES, createGitlabWebhookServer, verifyGitlabToken } from '../src/webhook/gitlab-receiver.ts'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gitlab-webhook-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('GitlabWebhookQueue & token', () => {
  it('creates a 0600 64-hex token once and preserves it on subsequent calls', () => {
    const first = ensureWebhookToken(dir)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(statSync(webhookTokenPath(dir)).mode & 0o777).toBe(0o600)
    expect(ensureWebhookToken(dir)).toBe(first)
    expect(readFileSync(webhookTokenPath(dir), 'utf8').trim()).toBe(first)
  })

  it('persists events in WAL SQLite, deduplicates deliveryUuid, and prunes only old consumed rows', () => {
    const path = webhookQueuePath(dir)
    const queue = new GitlabWebhookQueue(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const a = queue.enqueue({ deliveryUuid: 'u-1', eventType: 'Note Hook', receivedAt: '2026-11-01T00:00:00.000Z', payload: '{"a":1}' })
    const dup = queue.enqueue({ deliveryUuid: 'u-1', eventType: 'Note Hook', receivedAt: '2026-11-01T00:01:00.000Z', payload: '{"a":1}' })
    const b = queue.enqueue({ deliveryUuid: 'u-2', eventType: 'Issue Hook', receivedAt: '2026-11-01T00:02:00.000Z', payload: '{"b":2}' })
    const c = queue.enqueue({ deliveryUuid: 'u-3', eventType: 'Note Hook', receivedAt: '2026-11-18T00:00:00.000Z', payload: '{"c":3}' })
    expect(a).toEqual({ seq: 1, duplicate: false })
    expect(dup).toEqual({ seq: 1, duplicate: true })
    expect(b.seq).toBe(2)
    expect(c.seq).toBe(3)
    expect(queue.pruneConsumed(1, '2026-11-10T00:00:00.000Z')).toBe(1)
    queue.close()

    const reopened = new GitlabWebhookQueue(path)
    expect(reopened.readAfter(0, 10).map(row => row.seq)).toEqual([2, 3])
    expect(reopened.readAfter(2, 10).map(row => row.seq)).toEqual([3])
    reopened.close()
  })
})

describe('createGitlabWebhookServer', () => {
  it('handles timing-safe token validation including mismatched lengths without throwing', () => {
    expect(verifyGitlabToken(undefined, 'secret123')).toBe(false)
    expect(verifyGitlabToken('', 'secret123')).toBe(false)
    expect(verifyGitlabToken('short', 'secret123')).toBe(false)
    expect(verifyGitlabToken('much-longer-token-value', 'secret123')).toBe(false)
    expect(verifyGitlabToken('secret124', 'secret123')).toBe(false)
    expect(verifyGitlabToken('secret123', 'secret123')).toBe(true)
  })

  it('serves /healthz, enforces auth/limits/JSON/event-header, and queues unique deliveries', async () => {
    const instance = createGitlabWebhookServer({ stateDir: dir, maxBytes: 1024 })
    await new Promise<void>(resolve => instance.server.listen(0, '127.0.0.1', resolve))
    const { port } = instance.server.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    try {
      const health = await fetch(`${base}/healthz`)
      expect(health.status).toBe(200)
      expect(await health.json()).toEqual({ ok: true, queued: 0 })

      const badToken = await fetch(`${base}/hooks/gitlab`, {
        method: 'POST', headers: { 'x-gitlab-token': 'short', 'x-gitlab-event': 'Note Hook' }, body: '{}',
      })
      expect(badToken.status).toBe(401)

      const noEvent = await fetch(`${base}/hooks/gitlab`, {
        method: 'POST', headers: { 'x-gitlab-token': instance.token }, body: '{}',
      })
      expect(noEvent.status).toBe(400)

      const badJson = await fetch(`${base}/hooks/gitlab`, {
        method: 'POST', headers: { 'x-gitlab-token': instance.token, 'x-gitlab-event': 'Note Hook' }, body: '{bad',
      })
      expect(badJson.status).toBe(400)

      const huge = await fetch(`${base}/hooks/gitlab`, {
        method: 'POST',
        headers: { 'x-gitlab-token': instance.token, 'x-gitlab-event': 'Note Hook' },
        body: JSON.stringify({ data: 'x'.repeat(2048) }),
      })
      expect(huge.status).toBe(413)

      const body = JSON.stringify({ object_kind: 'note', project: { id: 9 } })
      const ok = await fetch(`${base}/hooks/gitlab`, {
        method: 'POST',
        headers: { 'x-gitlab-token': instance.token, 'x-gitlab-event': 'Note Hook', 'x-gitlab-event-uuid': 'uuid-42' },
        body,
      })
      expect(ok.status).toBe(202)
      expect(await ok.json()).toEqual({ accepted: true, seq: 1, duplicate: false })

      const dup = await fetch(`${base}/hooks/gitlab`, {
        method: 'POST',
        headers: { 'x-gitlab-token': instance.token, 'x-gitlab-event': 'Note Hook', 'x-gitlab-event-uuid': 'uuid-42' },
        body,
      })
      expect(dup.status).toBe(202)
      expect(await dup.json()).toEqual({ accepted: true, seq: 1, duplicate: true })

      expect((await fetch(`${base}/hooks/gitlab`, { method: 'GET' })).status).toBe(405)
      expect((await fetch(`${base}/unknown`)).status).toBe(404)
      expect(MAX_WEBHOOK_BYTES).toBe(2 * 1024 * 1024)
    } finally {
      await instance.close()
    }
  })
})
