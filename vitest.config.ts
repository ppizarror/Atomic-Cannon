import {defineConfig, mergeConfig} from 'vitest/config';
import viteConfig from './vite.config';

// Tests reuse the app's Vite config (Preact JSX transform + the __APP_VERSION__
// define) so a test can import any src module exactly as the app builds it. They
// run in a plain Node environment — the game code that touches the DOM (canvas,
// Image) is fed the minimal headless stubs installed by tests/_setup.ts.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      setupFiles: ['tests/_setup.ts'],
    },
  }),
);
