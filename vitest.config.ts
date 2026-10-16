import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    env: { CURSOR_CHAT_FTS: '0' }, // keep tests independent of any local FTS index
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist'],
  },
});