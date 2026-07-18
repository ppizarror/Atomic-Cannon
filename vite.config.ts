import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [preact()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    port: 2141,
    strictPort: true
  }
});
