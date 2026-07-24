import {defineConfig} from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [preact({prefreshEnabled: false})],
  // Expose the package version + repository URL to the app (shown on the main menu).
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __REPO_URL__: JSON.stringify(pkg.homepage),
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: {
    port: 2141,
    strictPort: true,
    host: true,
    hmr: false,
    // Multiplayer backend lives in the Worker/Durable Object (`pnpm dev:net`, :8787).
    // Proxy the room API + WebSocket there so the HMR dev page (:2141) can reach it —
    // run both `pnpm dev` and `pnpm dev:net`, then use :2141. If :8787 isn't up these
    // just fail (same as no backend); nothing else is affected.
    proxy: {
      '/api': {target: 'http://localhost:8787', changeOrigin: true},
      '/room': {target: 'http://localhost:8787', changeOrigin: true, ws: true},
    },
  },
});
