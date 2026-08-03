/**
 * Lets Node resolve the extensionless relative imports the app source uses
 * (Vite adds the extension; plain ESM does not). Only needed by the scripts in
 * this folder — the app itself never goes through Node's resolver.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CANDIDATES = ['.ts', '.tsx', '/index.ts'];

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || !context.parentURL) throw err;
      const base = new URL(specifier, context.parentURL).href;
      for (const ext of CANDIDATES) {
        const candidate = new URL(base + ext);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, format: 'module-typescript', shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
