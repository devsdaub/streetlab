import { defineConfig } from 'vite';

// ES2022 für top-level await (asynchrones Laden aus IndexedDB beim Start)
export default defineConfig({
  build: { target: 'es2022' },
  esbuild: { target: 'es2022' },
});
