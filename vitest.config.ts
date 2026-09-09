import { defineConfig } from 'vitest/config';
import path from 'path';
export default defineConfig({
  resolve: {
    alias: {
      '@cedh-lab/engine': path.resolve(__dirname, 'packages/engine/src/index.ts'),
      '@cedh-lab/cards': path.resolve(__dirname, 'packages/cards/src/index.ts'),
      '@cedh-lab/ai': path.resolve(__dirname, 'packages/ai/src/index.ts'),
    },
  },
  test: { include: ['packages/*/test/**/*.test.ts'], testTimeout: 15000 },
});
