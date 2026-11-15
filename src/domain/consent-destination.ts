/**
 * Where an approval on the consent page actually goes, read from the authorization request.
 *
 * Registration is open, so a client's id and its self-chosen `client_name` say nothing about who
 * runs it: anyone can register "Claude Code" with a redirect to a server they own and mail a member
 * the authorization link. The one fact a member can check is where the authorization code will be
 * sent, and the provider has already matched `redirect_uri` against the client's registration and
 * signed it into the query this page receives, so a tampered value fails when the answer is
 * posted. The client name is deliberately not shown: it is attacker-chosen text that would only
 * make a phishing request look familiar.
 *
 * A request without a readable destination yields `null`, and the page refuses to offer Approve
 * rather than describing a destination it could not read.
 */
export type ConsentDestination =
  /** An agent listening on this computer, which is how a local MCP client receives its code. */
  | { kind: 'this-computer'; port: string }
  /** A native app that registered its own URL scheme, such as an editor. */
  | { kind: 'app'; scheme: string }
  /** A website, which receives the code on its own servers rather than on this computer. */
  | { kind: 'website'; host: string }

/** RFC 8252 §7.3 loopback redirects: `localhost`, any 127/8 address, or IPv6 `::1`. */
function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
}

export function readConsentDestination(rawQuery: string): ConsentDestination | null {
  const redirect = new URLSearchParams(rawQuery).get('redirect_uri')
  if (!redirect) return null
  let url: URL
  try {
    url = new URL(redirect)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (isLoopbackHost(url.hostname)) return { kind: 'this-computer', port: url.port }
    // Plain http to a remote host is not something the provider should have registered; it is
    // still shown for what it is rather than hidden, since the member is the one deciding.
    return { kind: 'website', host: url.host }
  }
  // A scheme with no authority (RFC 8252 §7.1 private-use, e.g. `com.example.app:/cb`) or one
  // with a host (`cursor://…`). Either way the code goes to whichever app claims the scheme.
  const scheme = url.protocol.slice(0, -1)
  if (scheme === 'javascript' || scheme === 'data') return null
  return { kind: 'app', scheme }
}
