import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Match the offline-manifest tools and keep verification builds isolated from native packaging.
  build: { outDir: process.env.PDF_CHEF_DIST_DIR || 'dist' },
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      'framer-motion': path.resolve(__dirname, 'lib/framer-motion-shim.tsx'),
    }
  }
});
