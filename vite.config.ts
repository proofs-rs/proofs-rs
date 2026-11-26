import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  build: { outDir: 'dist', emptyOutDir: true },
  plugins: [{
    name: 'public-report-writing-skill',
    apply: 'build',
    generateBundle() {
      const path = 'skills/write-proofs-report/SKILL.md';
      this.emitFile({
        type: 'asset', fileName: path,
        source: readFileSync(new URL(path, import.meta.url), 'utf8'),
      });
    },
  }],
});
