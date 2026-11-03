import { describe, expect, it } from 'vitest'

import { createNonce, documentContentSecurityPolicy, secureDocument } from '../src/server/security-headers'

const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name)
  if (!found) throw new Error(`The CSP is missing ${name}.`)
  return found.slice(1)
}

describe('document security headers', () => {
  it('runs only scripts that carry this document nonce, and what they load', () => {
    const policy = documentContentSecurityPolicy('abc123')
    expect(directive(policy, 'script-src')).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'"])
    expect(directive(policy, 'default-src')).toEqual(["'self'"])
  })

  it('names no script origin but its own, and never unsafe-inline or unsafe-eval for scripts', () => {
    const policy = documentContentSecurityPolicy('abc123')
    for (const name of ['default-src', 'script-src', 'worker-src']) {
      const sources = directive(policy, name)
      expect(sources.filter((source) => /^(https?:|wss?:|\*)|\./.test(source))).toEqual([])
      expect(sources).not.toContain("'unsafe-inline'")
      expect(sources).not.toContain("'unsafe-eval'")
    }
    expect(directive(policy, 'connect-src')).toEqual(["'self'"])
  })

  it('closes framing, plugins, base rebinding, and form posts beyond the two sign-in hosts', () => {
    const policy = documentContentSecurityPolicy('abc123')
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"])
    expect(directive(policy, 'frame-src')).toEqual(["'none'"])
    expect(directive(policy, 'object-src')).toEqual(["'none'"])
    expect(directive(policy, 'base-uri')).toEqual(["'self'"])
    expect(directive(policy, 'form-action')).toEqual(["'self'", 'https://accounts.google.com', 'https://my.tastytrade.com'])
  })

  it('sets the policy and the document defenses on HTML only', () => {
    const response = secureDocument(html(), 'abc123')
    expect(response.headers.get('content-security-policy')).toBe(documentContentSecurityPolicy('abc123'))
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')

    const json = new Response('{}', { headers: { 'content-type': 'application/json' } })
    expect(secureDocument(json, 'abc123')).toBe(json)
  })

  it('keeps a policy a route set for itself', () => {
    const own = "default-src 'none'"
    const response = secureDocument(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html', 'content-security-policy': own } }),
      'abc123',
    )
    expect(response.headers.get('content-security-policy')).toBe(own)
  })

  it('draws a fresh 128-bit nonce for every document', () => {
    const first = createNonce()
    expect(atob(first)).toHaveLength(16)
    expect(createNonce()).not.toBe(first)
    // Base64 never contains the quote or semicolon that would end the source expression.
    expect(first).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})
