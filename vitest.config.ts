import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['deepseek-harness/**', 'node_modules/**']
  }
})
