import { describe, expect, it } from 'vitest'
import { isAbsolute, relative, sep } from 'node:path'
import { createLaunchSpec, releaseLaunchPaths } from './launch.js'
import { interactiveBanner, interactiveTurnArgs } from './interactive.js'

describe('Mythos 启动器', () => {
  it('以 loopback 和固定端口安全启动 Web Profile', () => {
    const spec = createLaunchSpec('web', [], {})
    expect(spec.args).toContain('mythos-web')
    expect(spec.args).toContain('127.0.0.1')
    expect(spec.args).toContain('33180')
    expect(spec.args).toContain('--no-open')
    expect(spec.env.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(spec.env.DEEPSEEK_BASE_URL).toBe('https://d.llmapi.pro:99')
    expect(spec.env).not.toHaveProperty('DEEPSEEK_API_KEY')
  })

  it('允许显式打开浏览器且不覆盖调用者端口', () => {
    const spec = createLaunchSpec('web', ['--open', '--port', '34000'], {})
    expect(spec.args).not.toContain('--no-open')
    expect(spec.args.filter(value => value === '--port')).toHaveLength(1)
    expect(spec.args).toContain('34000')
  })

  it('为 Headless 选择 Mythos Profile 并保留任务参数', () => {
    const spec = createLaunchSpec('headless', ['修复测试'], {})
    expect(spec.args.slice(-3)).toEqual(['--profile', 'mythos', '修复测试'])
  })

  it('交互模式展示产品身份并在后续轮次复用 resume', () => {
    expect(interactiveBanner('0.1.1', '/workspace', 'read-only')).toContain('MYTHOS Agent 0.1.1')
    expect(interactiveBanner('0.1.1', '/workspace', 'read-only')).toContain('claude-sonnet-5')
    expect(interactiveBanner('0.1.1', '/workspace', 'read-only')).toContain('/workspace')
    expect(interactiveTurnArgs('first')).toEqual(['--emit-session-id', 'first'])
    expect(interactiveTurnArgs('second', 'session-cold-1')).toEqual(['--resume', 'session-cold-1', 'second'])
  })

  it('拒绝缺少任务和不安全的 API 地址', () => {
    expect(() => createLaunchSpec('headless', [], {})).toThrow('任务内容')
    expect(() => createLaunchSpec('web', [], { DEEPSEEK_BASE_URL: 'http://example.test' })).toThrow('HTTPS')
    expect(() => createLaunchSpec('web', [], { DEEPSEEK_BASE_URL: 'https://secret@example.test' })).toThrow('凭据')
  })

  it('从解包根加载 runtime/home，但保留调用者工作目录', () => {
    const root = '/outside-consumer/mythos-agent'
    const workspace = '/outside-consumer/user-workspace'
    const paths = releaseLaunchPaths(root, workspace)
    const spec = createLaunchSpec('headless', ['--dump-config'], {}, paths)
    for (const runtimePath of [paths.cli, paths.home, spec.env.DSH_HOME]) {
      expect(runtimePath).toBeDefined()
      const child = relative(root, runtimePath ?? '')
      expect(isAbsolute(child)).toBe(false)
      expect(child).not.toBe('..')
      expect(child.startsWith(`..${sep}`)).toBe(false)
    }
    expect(spec.args[0]).toBe('/outside-consumer/mythos-agent/runtime/dsh/lib/bin.js')
    expect(paths.cwd).toBe(workspace)
    expect(spec.cwd).toBe(workspace)
  })
})
