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
  },
});
