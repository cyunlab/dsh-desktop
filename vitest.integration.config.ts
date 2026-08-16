import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['deepseek-harness/**', 'node_modules/**'],
    fileParallelism: false
  }
})
