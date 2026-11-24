import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'

/** A stand-in Worker on an ephemeral loopback port; `handler` sees each request with its whole body. */
export async function listenLoopback(
  handler: (request: IncomingMessage, body: string, response: ServerResponse) => void,
): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => handler(request, Buffer.concat(chunks).toString(), response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // SAFETY: this server was just listened on a TCP port, which is the case where Node returns
  // an AddressInfo rather than a pipe path or null.
  return { port: (server.address() as AddressInfo).port, server }
}

/** Closes a stand-in, dropping any kept-alive connection so the close cannot hang a test. */
export function closeLoopback(server: Server | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.closeAllConnections()
    server.close(() => resolve())
  })
}
