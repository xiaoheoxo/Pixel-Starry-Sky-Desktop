// 启动引擎时的环境变量（审查报告 2026-10-14：CLAUDE_CODE_* 原来整类丢掉，用户的配置类变量也没了）
import { describe, expect, it } from 'vitest'
import { engineEnv, systemProxyEnv } from '../src/env'
import { ClaudeAdapter } from '../src/claude'
import { CodexAdapter } from '../src/codex'
import { PixelAdapter } from '../src/pixel'

describe('engineEnv', () => {
  it('丢掉「自己是别的 Claude Code 子会话」的标记和其他程序自己的变量', () => {
    const env = engineEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_EXECPATH: 'x',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: 'sock',
      CLAUDE_CODE_MESSAGING_TOKEN: 't',
      CLAUDE_CODE_SESSION_ATTENDED: '1',
      CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true',
      CLAUDE_PID: '1',
      CLAUDE_EFFORT: 'high',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      MIRASIM_X: '1',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: 'x',
      PATH: 'p',
    })
    expect(env).toEqual({ PATH: 'p' })
  })
  it('保留用户的配置类 CLAUDE_CODE_*（git-bash 位置、token 登录、Bedrock / Vertex 等）', () => {
    const keep = {
      CLAUDE_CODE_GIT_BASH_PATH: 'C:/Git/bin/bash.exe',
      CLAUDE_CODE_OAUTH_TOKEN: 'tok',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8000',
      CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
      ANTHROPIC_API_KEY: 'k',
    }
    expect(engineEnv(keep)).toEqual(keep)
  })
})

// 系统代理补给引擎（docs：设置 › 本机引擎「使用系统代理」）：Claude Code、Codex、像素星空引擎只认环境变量
describe('systemProxyEnv', () => {
  const proxy = 'http://127.0.0.1:7890'
  it('没开代理不补', () => {
    expect(systemProxyEnv({ PATH: 'x' }, {}, null)).toEqual({})
  })
  it('补 HTTPS_PROXY、HTTP_PROXY，本机地址不走代理（平台会话连本机网关）', () => {
    expect(systemProxyEnv({ PATH: 'x' }, {}, proxy)).toEqual({
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
    })
  })
  it('系统环境或引擎设置里有任何代理变量（大小写都算，空值也算）：按用户的，不补', () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      expect(systemProxyEnv({ [key]: 'http://u:1' }, {}, proxy), key).toEqual({})
      expect(systemProxyEnv({}, { [key]: 'http://u:1' }, proxy), key).toEqual({})
    }
    expect(systemProxyEnv({ HTTPS_PROXY: '' }, {}, proxy)).toEqual({})
  })
  it('用户原有的 NO_PROXY 保留，只在后面补缺的本机地址；键名沿用用户的大小写；引擎设置里的优先', () => {
    expect(systemProxyEnv({ no_proxy: '.corp.example,LOCALHOST' }, {}, proxy)).toMatchObject({
      no_proxy: '.corp.example,LOCALHOST,127.0.0.1,::1',
    })
    expect(systemProxyEnv({ NO_PROXY: 'a' }, { NO_PROXY: 'b' }, proxy)).toMatchObject({
      NO_PROXY: 'b,localhost,127.0.0.1,::1',
    })
  })
  it('三个引擎启动时都带上；引擎设置里的 NO_PROXY 不会把本机地址冲掉', () => {
    const opts = {
      env: { PATH: 'x' },
      extraEnv: () => ({ NO_PROXY: 'internal' }),
      systemProxy: () => proxy,
    }
    for (const adapter of [new ClaudeAdapter(opts), new CodexAdapter(opts), new PixelAdapter(opts)]) {
      const env = (adapter as unknown as { env(): NodeJS.ProcessEnv }).env()
      expect(env).toMatchObject({
        PATH: 'x',
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        NO_PROXY: 'internal,localhost,127.0.0.1,::1',
      })
    }
    // 没给 systemProxy（远程机器的宿主）：不补
    const remote = new ClaudeAdapter({ env: { PATH: 'x' } }) as unknown as { env(): NodeJS.ProcessEnv }
    expect(remote.env().HTTPS_PROXY).toBeUndefined()
  })
})
