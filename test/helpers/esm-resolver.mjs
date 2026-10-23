// ESM resolver hook: let plain `node` import the renderer's modules the way Vite does.
//
// The renderer imports its own files extensionless (`import { api } from './api'`). Vite resolves
// that; node's ESM resolver does not, and throws ERR_MODULE_NOT_FOUND. Without this hook no React
// module under src/ can be loaded outside a bundler, which is why the renderer half of the app has
// only ever been provable by static source grep or by building dist/ and driving it in jsdom.
//
// This hook only ever ADDS a fallback: a specifier that resolves normally is passed through
// untouched, so it cannot change how any working import behaves. It tries the extensions Vite tries,
// in the same order, and rethrows the original error if none of them land.
//
// Usage (from a .mjs test, before importing anything under src/):
//   const { register } = await import('node:module');
//   register('./helpers/esm-resolver.mjs', import.meta.url);
//
// The file lives as .mjs on purpose: the repo's package.json has no "type": "module", so a .js hook
// would be treated as CommonJS and `register` would reject it.

const EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.json'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (originalError) {
    // Relative and bare-local specifiers are the only ones Vite would have extension-resolved.
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      throw originalError;
    }
    for (const ext of EXTENSIONS) {
      try {
        return await nextResolve(specifier + ext, context);
      } catch {
        /* try the next extension */
      }
    }
    // A directory import (`./utils`) resolves through its index file, which Vite also supports.
    for (const ext of EXTENSIONS) {
      try {
        return await nextResolve(`${specifier}/index${ext}`, context);
      } catch {
        /* try the next extension */
      }
    }
    throw originalError;
  }
}
