import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  type AppUpdateCapability,
  createUnavailableAppUpdateCapability,
} from '../src/index.js'
import { createInMemoryAppUpdateCapability } from '../src/testing.js'

describe('AppUpdateCapability public surface', () => {
  it('has exactly observe and open at type and runtime boundaries', () => {
    expectTypeOf<keyof AppUpdateCapability>().toEqualTypeOf<'observe' | 'open'>()
    const capabilities = [
      createUnavailableAppUpdateCapability(),
      createInMemoryAppUpdateCapability({ kind: 'none' }).capability,
    ]

    for (const capability of capabilities) {
      expect(Object.keys(capability).sort()).toEqual(['observe', 'open'])
      expect('invoke' in capability).toBe(false)
      expect('publish' in capability).toBe(false)
      expect('download' in capability).toBe(false)
      expect('install' in capability).toBe(false)
      expect('restart' in capability).toBe(false)
    }
  })
})
