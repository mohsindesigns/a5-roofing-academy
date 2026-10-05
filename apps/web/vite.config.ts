/// <reference types="vitest/config" />
import { defineConfig, defaultClientConditions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const gateway = process.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Workspace packages resolve to TypeScript sources during development.
    conditions: ['@a5/source', ...defaultClientConditions],
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: gateway, changeOrigin: false, ws: false },
    },
  },
  preview: { port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('hls.js')) return 'hls';
            if (id.includes('react-router') || id.includes('/react-dom/') || id.includes('/react/')) return 'react';
            if (id.includes('@tanstack')) return 'query';
            if (id.includes('radix-ui') || id.includes('@radix-ui')) return 'radix';
            if (id.includes('zod')) return 'zod';
          }
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
