import { defineConfig } from 'vite';

/**
 * Build used only for the portable single-file client.
 *
 * Classic IIFE output matters here: a `type="module"` script opened from
 * `file://` is at the mercy of browser module rules, while a plain inline
 * script always runs. That keeps "double-click the html" reliable.
 */
export default defineConfig({
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
