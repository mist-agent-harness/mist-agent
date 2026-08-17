/**
 * Token gate for remote access (mist#49 maintainer directive: unlike dsh's
 * loopback-only posture, mist serving supports non-loopback binds guarded by
 * an auto-generated token).
 *
 * Modes:
 * - no token configured (loopback default): gate inactive — dev ergonomics,
 *   reverse proxies keep their own auth.
 * - token configured (explicitly, or auto-generated whenever the bind is
 *   non-loopback): every route requires it. Browser flow needs zero client
 *   changes: open `/?token=<t>` once → HttpOnly cookie → same-origin fetch/WS
 *   carry it from then on. Bearer `Authorization` works for non-browser calls.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export const TOKEN_COOKIE = 'mist_dev_token'

export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

export function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

function cookieToken(headers: IncomingHttpHeaders): string | undefined {
  const cookies = headers.cookie
  if (cookies === undefined) return undefined
  for (const pair of cookies.split(';')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    if (pair.slice(0, eq).trim() === TOKEN_COOKIE) return pair.slice(eq + 1).trim()
  }
  return undefined
}

function bearerToken(headers: IncomingHttpHeaders): string | undefined {
  const authorization = headers.authorization
  if (typeof authorization !== 'string') return undefined
  const match = /^Bearer (\S+)$/i.exec(authorization)
  return match?.[1]
}

export interface AuthDecision {
  ok: boolean
  /** Set when a valid ?token= query arrived: respond with this Set-Cookie and redirect. */
  setCookie?: string
}

/**
 * Browser-origin fence (大审① · upstream api-request-trust parity, simplified):
 * a cross-site page must not reach the API or the event sockets even when the
 * token gate is off (tokenless loopback dev). Rules:
 * - `Host` must be a loopback authority or an explicitly trusted host
 *   (reverse-proxy names go in `trustedHosts`) — DNS-rebinding defense: Host is
 *   the one header a rebound browser request cannot forge.
 * - When `Origin` is present (browser fetch/WS), its authority must equal the
 *   request's Host authority. Non-browser clients (no Origin) pass on Host alone.
 */
export function originAllowed(
  headers: IncomingHttpHeaders,
  trustedHosts: readonly string[],
): boolean {
  const hostHeader = headers.host
  if (hostHeader === undefined) return false
  const hostName = hostHeader.replace(/:\d+$/, '')
  if (!isLoopback(hostName) && !trustedHosts.includes(hostName) && !trustedHosts.includes(hostHeader)) {
    return false
  }
  const origin = headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostHeader
  } catch {
    return false
  }
}

/**
 * Decide one request. Query token is accepted anywhere (it is how a browser
 * enters), and upgrades to a cookie so later same-origin requests pass silently.
 */
export function authorize(
  expected: string | undefined,
  headers: IncomingHttpHeaders,
  url: URL,
): AuthDecision {
  if (expected === undefined) return { ok: true }
  const query = url.searchParams.get('token')
  if (query !== null && constantTimeEquals(query, expected)) {
    return { ok: true, setCookie: `${TOKEN_COOKIE}=${expected}; Path=/; HttpOnly; SameSite=Strict` }
  }
  const presented = cookieToken(headers) ?? bearerToken(headers)
  if (presented !== undefined && constantTimeEquals(presented, expected)) return { ok: true }
  return { ok: false }
}
