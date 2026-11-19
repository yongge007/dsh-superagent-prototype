/** Subprocess wrapper for running gh, lark-cli, and git commands under the deployment's configured accounts. */
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { Deployment } from '../deployment.ts'

const exec = promisify(execFile)
const TIMEOUT_MS = 90_000
/**
 * Error thrown by Commands when a CLI invocation fails, capturing stderr diagnostics, API error codes, and exit status without echoing command arguments.
 * Source channels and pollers inspect its code to distinguish deleted conversations from retryable failures.
 */
export class CliError extends Error {
  constructor(message: string, readonly code?: number, readonly exitCode?: number) { super(message) }
}
/** Extracts a sanitized error from a failed subprocess without echoing argv, which may contain message text. */
export function commandError(error: unknown, program = 'command'): Error {
  if (error instanceof Error && error.name === 'AbortError') return error
  const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number' ? error.code : undefined
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = error.stderr.trim()
    let parsed: { error?: { code?: number; message?: string } } | undefined
    try { parsed = JSON.parse(stderr.slice(stderr.indexOf('{'))) as typeof parsed }
    catch { /* Non-JSON CLI diagnostics are retained below. */ }
    const code = parsed?.error?.code
    if (parsed?.error?.message) return new CliError(`${parsed.error.message}${code ? ` (${code})` : ''}`, code, exitCode)
    // `gh` and `glab` exit non-zero on HTTP errors (such as `gh: Not Found (HTTP 404)`, `gh: HTTP 304`, or `GET ...: 404 {message: ...}`).
    if (stderr) {
      const status = /\bHTTP (\d{3})\b/.exec(stderr)?.[1]
        ?? /:\s*([45]\d{2})(?:\s|\{|$)/.exec(stderr)?.[1]
        ?? /\b([45]\d{2})\s+(?:Bad Request|Unauthorized|Forbidden|Not Found|Gone|Unprocessable|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable)\b/i.exec(stderr)?.[1]
      return new CliError(stderr.slice(0, 2000), Number(status) || undefined, exitCode)
    }
  }
  return new CliError(`${basename(program)} ${ended(error)}`, undefined, exitCode)
}
function ended(error: unknown): string {
  const { killed, signal, code } = (error ?? {}) as { killed?: boolean; signal?: string | null; code?: unknown }
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'printed more output than it may'
  // `execFile` timeout terminates the process with SIGTERM and sets `killed: true`.
  if (killed && signal === 'SIGTERM') return `timed out after ${TIMEOUT_MS / 1000} s`
  if (signal) return `was stopped by ${signal}`
  if (typeof code === 'number') return `exited with code ${code}`
  return typeof code === 'string' ? `could not run: ${code}` : 'failed'
}
export interface Tally { skipped: number }
/** Parses array elements against a schema, skipping invalid items and incrementing `tally.skipped`. */
export function validItems<T>(item: z.ZodType<T>, list: readonly unknown[], tally?: Tally): T[] {
  const items = list.flatMap(value => { const parsed = item.safeParse(value); return parsed.success ? [parsed.data] : [] })
  if (tally) tally.skipped += list.length - items.length
  return items
}
/** Rewrites Feishu error 232011 (bot not in chat) with remediation instructions. */
function membership(error: unknown): unknown {
  if (!(error instanceof CliError) || error.code !== 232011) return error
  const hint = 'The Feishu bot is not a member of the chat. Add the bot in the chat settings, then retry.'
  return new CliError(hint, error.code, error.exitCode)
}
/**
 * Executes gh, lark-cli, and git subprocesses with deployment account credentials, timeouts, and abort signals.
 * Restricts GitHub API calls to the configured repository and translates CLI failures into CliError instances for Sources, MasterAssessor, Outbox, and Settings.
 */
export class Commands {
  /**
   * @param resolved - returns the resolved deployment setup, or throws while setup is still pending.
   * @param environment - variables overriding `process.env` for every command (such as isolated git settings).
   */
  constructor(private readonly resolved: () => Deployment, private readonly environment: Record<string, string | undefined>, private readonly signal: AbortSignal) {}
  get deployment(): Deployment { return this.resolved() }
  get repository(): string {
    const repo = this.deployment.repository
    if (!repo) throw new Error('The GitHub Source is not configured')
    return repo
  }
  withSignal(signal?: AbortSignal): Commands { return signal ? new Commands(this.resolved, this.environment, AbortSignal.any([this.signal, signal])) : this }
  async run(program: string, args: string[], cwd?: string, extraEnv?: Record<string, string | undefined>): Promise<string> {
    try {
      const { stdout } = await exec(program, args, { cwd, signal: this.signal, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...this.environment, ...extraEnv, GH_PROMPT_DISABLED: '1', LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } })
      return stdout
    } catch (error) { throw commandError(error, program) }
  }
  /** Runs the agent's GitHub CLI and parses its JSON output; callers should prefer `api`, which is restricted to the configured repository and validates output. */
  async gh<T>(args: string[]): Promise<T> {
    const github = this.deployment.github
    if (!github) throw new Error('The GitHub Source is not configured')
    return JSON.parse(await this.run(github.cli, args)) as T
  }
  /**
   * Calls the GitHub API on a path within the configured repository, validating JSON output when a schema is provided
   * or returning raw CLI output (such as raw files or `--include` headers) when omitted.
   * @throws CliError with GitHub's HTTP status as `code` on failure.
   */
  async api<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async api(path: string, ...flags: string[]): Promise<string>
  async api<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    const github = this.deployment.github
    if (!github) throw new Error('The GitHub Source is not configured')
    if (typeof schema === 'string') return this.run(github.cli, ['api', this.path(schema), ...rest])
    const [path = '', ...flags] = rest
    return schema.parse(await this.gh(['api', this.path(path), ...flags]))
  }
  /** Fetches all pages of a GitHub API list within the configured repository, skipping items that fail schema validation. */
  async pages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const pages = z.array(z.array(z.unknown())).parse(await this.gh(['api', this.path(path), '--paginate', '--slurp']))
    return validItems(item, pages.flat(), tally)
  }
  private path(path: string): string {
    const outside = /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)/i.test(path)
    if (outside) throw new Error('GitHub calls are restricted to the configured repository')
    return path ? `repos/${this.repository}/${path}` : `repos/${this.repository}`
  }
  private gitlabEnv(): { cli: string; env: Record<string, string> } {
    const gitlab = this.deployment.gitlab
    if (!gitlab) throw new Error('The GitLab Source is not configured')
    return { cli: gitlab.cli, env: { GITLAB_HOST: gitlab.host, NO_PROMPT: '1' } }
  }
  private gitlabPath(path: string): string {
    const outside = !path || /^\/|^[a-z]+:|(^|\/)\.\.?(\/|\?|$)|%2e%2e/i.test(path)
    if (outside) throw new Error('GitLab API calls must use relative v4 API paths')
    return path
  }
  /** Runs the agent's GitLab CLI (`glab`) with GITLAB_HOST bound to the configured instance and parses its JSON output. */
  async glab<T>(args: string[]): Promise<T> {
    const { cli, env } = this.gitlabEnv()
    return JSON.parse(await this.run(cli, args, undefined, env)) as T
  }
  /**
   * Calls the GitLab REST API v4 on a relative path, validating JSON output when a schema is provided or returning raw CLI output.
   * @throws CliError with GitLab's HTTP status as `code` on failure.
   */
  async gitlabApi<T>(schema: z.ZodType<T>, path: string, ...flags: string[]): Promise<T>
  async gitlabApi(path: string, ...flags: string[]): Promise<string>
  async gitlabApi<T>(schema: z.ZodType<T> | string, ...rest: string[]): Promise<T | string> {
    const { cli, env } = this.gitlabEnv()
    if (typeof schema === 'string') return this.run(cli, ['api', this.gitlabPath(schema), ...rest], undefined, env)
    const [path = '', ...flags] = rest
    return schema.parse(JSON.parse(await this.run(cli, ['api', this.gitlabPath(path), ...flags], undefined, env)))
  }
  /** Fetches pages of a GitLab REST API list (up to 20 pages of 100 items), skipping items that fail schema validation. */
  async gitlabPages<T>(item: z.ZodType<T>, path: string, tally?: Tally): Promise<T[]> {
    const clean = this.gitlabPath(path)
    const out: T[] = []
    for (let page = 1; page <= 20; page++) {
      const sep = clean.includes('?') ? '&' : '?'
      const raw = await this.gitlabApi(z.array(z.unknown()), `${clean}${sep}per_page=100&page=${page}`)
      out.push(...validItems(item, raw, tally))
      if (raw.length < 100) break
    }
    return out
  }
  /**
   * Runs the Feishu bot's `lark-cli` and returns the JSON `data` payload.
   * @throws CliError with Feishu's error code on failure (rewriting 232011 when the bot is not in the chat).
   */
  async lark<T>(args: string[], cwd?: string): Promise<T> {
    const bot = this.deployment.feishu
    if (!bot) throw new Error('The Feishu Source has no working bot CLI')
    const output = await this.run(bot.cli, [...args, '--as', 'bot', '--format', 'json'], cwd)
      .catch((error: unknown) => { throw membership(error) })
    const result = JSON.parse(output) as { ok: boolean; data: T; error?: { code?: number; message?: string } }
    const code = result.error?.code
    if (!result.ok) throw membership(new CliError(`${result.error?.message ?? 'Feishu command failed'}${code ? ` (${code})` : ''}`, code))
    return result.data
  }
  /** Runs `git` on PATH using the agent's isolated git environment and credential helper. */
  async git(args: string[], cwd: string): Promise<string> { return this.run('git', args, cwd) }
}
