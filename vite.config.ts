import {defineConfig} from 'vite';
import preact from '@preact/preset-vite';
import pkg from './package.json' with {type: 'json'};
import {renderShell} from './src/shell.ts';
import {freePort, pruneDist} from './vite.plugins.ts';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  plugins: [
    preact({prefreshEnabled: false}),
    {name: 'shell-copy', transformIndexHtml: renderShell},
    freePort(),
    pruneDist(),
  ],
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
    hmr: false,
    host: true,
    proxy: {
      '/api': {target: 'http://localhost:8787', changeOrigin: true},
      '/room': {target: 'http://localhost:8787', changeOrigin: true, ws: true},
    },
  },
});
