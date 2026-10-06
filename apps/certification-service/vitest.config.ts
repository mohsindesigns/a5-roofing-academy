import { createVitestConfig } from '../../vitest.shared.js';

export default createVitestConfig({
  test: { fileParallelism: true, testTimeout: 60_000, hookTimeout: 120_000 },
});
