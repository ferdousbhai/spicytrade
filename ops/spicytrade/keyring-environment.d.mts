import type { Stats } from 'node:fs'

export function keyringEnvironment(
  env?: NodeJS.ProcessEnv,
  inspect?: (path: string) => Promise<Pick<Stats, 'uid' | 'mode' | 'isDirectory' | 'isSocket'>>,
): Promise<NodeJS.ProcessEnv>
