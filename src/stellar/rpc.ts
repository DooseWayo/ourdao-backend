import { rpc } from '@stellar/stellar-sdk'
import { SpanStatusCode, type Span } from '@opentelemetry/api'
import { config } from '../config.js'
import { getTracer } from '../telemetry.js'

// Allow http:// for local/standalone RPC while defaulting to secure transport.
// `headers` (issue #284) lets a managed/private RPC provider (QuickNode and
// similar) require an API key or bearer token — only set when
// STELLAR_RPC_HEADERS is non-empty, since passing `headers: {}` is harmless
// but passing `undefined` more clearly reflects "not configured" if the SDK
// ever branches on the option's presence rather than its contents.
const rpcHeaders = config.stellar.rpcHeaders
export const server = new rpc.Server(config.stellar.rpcUrl, {
  allowHttp: config.stellar.rpcUrl.startsWith('http://'),
  ...(Object.keys(rpcHeaders).length > 0 ? { headers: rpcHeaders } : {}),
})

/** Issue #585: wraps `fn` in a span named `rpc.<spanName>`, nested under
 *  whatever span is active when it's called (e.g. `indexer.page`), so a
 *  trace can show how much of a poll iteration was RPC latency. Records the
 *  RPC method name and, for a call that goes through `withRateLimitRetry`,
 *  how many retries it took — and ends with `SpanStatusCode.ERROR` plus the
 *  recorded exception when `fn` ultimately throws, matching the error
 *  pattern `indexer.apply_event` already uses (src/indexer/handlers.ts). */
export async function withRpcSpan<T>(spanName: string, method: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return getTracer().startActiveSpan(`rpc.${spanName}`, async (span) => {
    span.setAttribute('rpc.method', method)
    try {
      return await fn(span)
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err))
      span.setStatus({ code: SpanStatusCode.ERROR })
      throw err
    } finally {
      span.end()
    }
  })
}

/** Issue #268: Retry with exponential backoff on HTTP 429 rate limit.
 *  Issue #585: the whole retry loop runs inside one `rpc.<spanName>` span
 *  (via `withRpcSpan`) so a trace shows one call's total latency including
 *  backoff, with `rpc.retry_count` distinguishing "one slow call" from
 *  "several retried calls". */
async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  operation: string,
  spanName: string,
  maxRetries = 5
): Promise<T> {
  return withRpcSpan(spanName, operation, async (span) => {
    let attempt = 0
    while (true) {
      try {
        const result = await fn()
        span.setAttribute('rpc.retry_count', attempt)
        return result
      } catch (err: unknown) {
        const isRateLimited =
          (err &&
            typeof err === 'object' &&
            (('code' in err && err.code === 429) ||
              ('status' in err && err.status === 429))) ||
          (err instanceof Error && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit')))

        if (!isRateLimited || attempt >= maxRetries) {
          span.setAttribute('rpc.retry_count', attempt)
          throw err
        }

        attempt++
        // Exponential backoff with jitter: base delay 2^attempt seconds, plus random jitter up to 1s
        const baseDelay = Math.min(1000 * 2 ** attempt, 32000)
        const jitter = Math.random() * 1000
        const delay = baseDelay + jitter

        console.warn(
          `[rpc] ${operation} rate-limited (429), retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms`
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  })
}

export async function getLatestLedger(): Promise<number> {
  return withRateLimitRetry(
    async () => {
      const res = await server.getLatestLedger()
      return res.sequence
    },
    'getLatestLedger',
    'get_latest_ledger'
  )
}

/** Latest-ledger sequence plus its hash (`id`) — used for the coarse rewind
 *  signal in reorg detection (issue #23). */
export async function getLatestLedgerInfo(): Promise<{ sequence: number; hash: string }> {
  return withRateLimitRetry(
    async () => {
      const res = await server.getLatestLedger()
      return { sequence: res.sequence, hash: res.id }
    },
    'getLatestLedgerInfo',
    'get_latest_ledger'
  )
}

/** Hash of a specific ledger by sequence. Soroban's `getEvents` exposes no
 *  per-event ledger hash, so this is how the poller learns the hash of the
 *  ledger it actually folded to (issue #127) and later re-checks it against
 *  what the RPC reports for that same sequence, to catch a same-height fork
 *  the sequence-only continuity check can't see (issue #128).
 *
 *  Resolves to null — never rejects — when the RPC can't answer: it throws
 *  (rather than returning an empty page) when `sequence` has aged out of its
 *  retention window, and a transient RPC/network error is just as
 *  unanswerable here. Either way, callers must treat null as "unverifiable",
 *  not as evidence of a fork; letting a hiccup on this best-effort check
 *  reject would otherwise wedge fetchOnce in permanent retry over a ledger
 *  whose events may already be safely folded and committed. */
export async function getLedgers(serverInstance: rpc.Server, startLedger: number, limit = 10): Promise<rpc.Api.GetLedgersResponse> {
  return withRateLimitRetry(
    async () => serverInstance.getLedgers({ startLedger, pagination: { limit } }),
    'getLedgers',
    'get_ledger_hash'
  )
}

export async function getLedgerHash(sequence: number): Promise<string | null> {
  try {
    const res = await getLedgers(server, sequence, 1)
    const ledger = res.ledgers[0]
    return ledger?.sequence === sequence ? ledger.hash : null
  } catch {
    return null
  }
}
