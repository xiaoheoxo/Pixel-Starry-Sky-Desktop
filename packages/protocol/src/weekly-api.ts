/** The same Codex account and quota window bracket both ends of a local usage sample. */
export interface WeeklyApiQuery {
  account: string
  plan: string | null
  resetsAt: number
  from: number
  to: number
}

export interface WeeklyApiSample {
  usd: number
  records: number
  incomplete: boolean
}
