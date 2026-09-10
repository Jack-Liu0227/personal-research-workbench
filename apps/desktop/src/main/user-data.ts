import { isAbsolute, parse, resolve } from 'node:path'

const userDataArgument = '--prw-user-data-dir='

export function requestedUserDataPath(
  isPackaged: boolean,
  argv: readonly string[],
  developmentE2ePath: string | undefined
): string | undefined {
  const argumentsWithPath = argv.filter((argument) => argument.startsWith(userDataArgument))
  if (argumentsWithPath.length > 1) {
    throw new Error('Only one --prw-user-data-dir argument may be supplied.')
  }
  const explicit = argumentsWithPath[0]?.slice(userDataArgument.length)
  const candidate = explicit || (isPackaged ? undefined : developmentE2ePath)
  if (candidate === undefined) return undefined
  if (!isAbsolute(candidate)) throw new Error('The workbench user-data directory must be an absolute path.')
  const normalized = resolve(candidate)
  if (parse(normalized).root === normalized) {
    throw new Error('The workbench user-data directory must not be a filesystem root.')
  }
  return normalized
}
