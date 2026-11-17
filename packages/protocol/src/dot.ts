/** Dot 入口只对 ChatGPT Pro 系列订阅开放；Plus、团队及未知档位均不显示。 */
export const supportsChatGptDot = (plan: string | null | undefined): boolean =>
  ['pro', 'prolite', 'promax'].includes(plan?.trim().toLowerCase() ?? '')
