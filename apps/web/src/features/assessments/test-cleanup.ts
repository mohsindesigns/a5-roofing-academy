// Importing this file unmounts rendered components after each test (Vitest globals are off, so
// Testing Library does not register its own cleanup).
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(cleanup);
