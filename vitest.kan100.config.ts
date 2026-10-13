import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'node', setupFiles: [], include: ['tests/kan100-*.test.ts'],
    fileParallelism: false, testTimeout: 120_000, hookTimeout: 20_000 },
});
