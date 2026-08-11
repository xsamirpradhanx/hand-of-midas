import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 20000,
    include: ['src/**/*.test.{ts,js}', 'src/**/*.spec.{ts,js}'],
    exclude: ['node_modules', 'dist'],
  },
});
