import { createVitestConfig } from '../../vitest.shared.js';

export default createVitestConfig({ test: { fileParallelism: true, testTimeout: 30_000 } });
