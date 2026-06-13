import { build } from 'esbuild';
import { resolve } from 'node:path';

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['open'],
  packages: 'external',
  sourcemap: true,
  banner: {
    js: 'var __esbuild_import_meta_url = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__esbuild_import_meta_url',
  },
};

// Main server bundle (used by both CLI and Electron)
await build({
  ...shared,
  entryPoints: ['src/server/index.ts'],
  outfile: 'dist/electron-server.cjs',
});

// Daemon bundle (headless server for Swift menu bar app)
await build({
  ...shared,
  entryPoints: ['src/server/daemon.ts'],
  outfile: 'dist/daemon.cjs',
});
