import { createContext, useContext } from 'react'

export const DotKeyContext = createContext<string | null>(null)
export function useDotKey(): string {
  const key = useContext(DotKeyContext)
  if (!key) throw new Error('Dot conversation required')
  return key
}
