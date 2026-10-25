import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Build used only for the portable single-file client.
 *
 * Classic IIFE output matters here: a `type="module"` script opened from
 * `file://` is at the mercy of browser module rules, while a plain inline
 * script always runs. That keeps "double-click the html" reliable.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2020',
    outDir: 'dist-single',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'app.[ext]',
      },
    },
  },
});
