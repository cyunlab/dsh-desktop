import { describe, expect, it } from 'vitest'
import { NavigationPolicy } from '../../../src/main/window/navigation-policy.js'

describe('navigation policy', () => {
  it('allows only the startup document and exact assigned Host origin', () => {
    const policy = new NavigationPolicy('file:///app/startup/index.html')
    expect(policy.decide('file:///app/startup/index.html')).toBe('allow')
    expect(policy.decide('file:///etc/passwd')).toBe('deny')
    policy.setHostOrigin('http://127.0.0.1:43123')
    expect(policy.decide('http://127.0.0.1:43123/workspaces?a=1')).toBe('allow')
    expect(policy.decide('http://localhost:43123/')).toBe('external')
    expect(policy.decide('http://127.0.0.1:43124/')).toBe('external')
  })
  it('opens only http(s) destinations externally and rejects unsafe schemes', () => {
    const policy = new NavigationPolicy('file:///app/startup/index.html')
    expect(policy.decide('https://docs.example.test/')).toBe('external')
    expect(policy.decide('mailto:user@example.test')).toBe('deny')
    expect(policy.decide('javascript:alert(1)')).toBe('deny')
    expect(() => policy.setHostOrigin('https://127.0.0.1:1')).toThrow()
    expect(() => policy.setHostOrigin('http://localhost:1')).toThrow()
  })
})
