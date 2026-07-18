import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    assetsDir: 'assets'
  },
  server: {
    port: 2141,
    strictPort: true
  }
});
