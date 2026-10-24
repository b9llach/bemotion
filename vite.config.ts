import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: resolve(root, 'src/web'),
  publicDir: false,
  server: { fs: { allow: [root] } },
  build: {
    outDir: resolve(root, 'dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(root, 'src/web/index.html'),
        render: resolve(root, 'src/web/render.html'),
      },
    },
  },
});
