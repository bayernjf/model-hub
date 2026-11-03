// Dev-only resolver: the TS sources use NodeNext-style `.js` specifiers,
// which only exist after `tsc` emits into dist/. Running `src/server.ts`
// directly therefore fails to resolve `./app.js` on Node 22+ (type stripping
// does not remap extensions). Redirect a relative `.js` import to its `.ts`
// sibling when the `.js` file is absent; build output is untouched because
// dist/ really does contain `.js`.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const target = new URL(specifier, context.parentURL);
      const tsTarget = new URL(target.href.replace(/\.js$/, '.ts'));
      if (!existsSync(fileURLToPath(target)) && existsSync(fileURLToPath(tsTarget))) {
        return { url: tsTarget.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});
