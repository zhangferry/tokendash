import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/electron-server.cjs',
  external: ['electron', 'open'],
  packages: 'external',
  sourcemap: true,
  banner: {
    // Provide import.meta.url for CJS output using native __filename
    js: 'var __esbuild_import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__esbuild_import_meta_url',
  },
});
