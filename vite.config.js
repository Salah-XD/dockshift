import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  // Relative asset paths so the packaged renderer (loaded over `file://` from
  // `dist/index.html`) can find its own JS/CSS bundles. Default `'/'` resolves
  // to the drive root under `file://` and the renderer comes up blank — that's
  // why the packaged dock window appeared invisible.
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
