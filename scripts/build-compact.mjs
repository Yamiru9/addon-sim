#!/usr/bin/env node
/**
 * The compact build: the same bundle `build-addon.mjs` makes, at a third of the
 * bytes, with nothing the add-on does removed.
 *
 * The workshop's editor rejects the full build as a paste, and four things make
 * it heavy - three of them code the add-on never executes, and one that just
 * travels badly:
 *
 * - **zod**, twice over (main bundle and worker): the game's `rate.ts` and
 *   `upgrades.ts` define API schemas with it, and every module that reaches
 *   either drags the whole library in. The add-on never parses anything, so
 *   zod is shimmed to an inert chainable proxy - load-safe everywhere, and
 *   throwing only if something the add-on never calls tries to `parse`.
 *
 * - **Lingui + messageformat + moo**, also twice: they arrive through
 *   `shared/src/i18n/translate.ts`, whose `__` resolves translations at
 *   runtime. The add-on's graph only ever imports `defineMessages` from that
 *   module - identity at runtime - so the whole module is shimmed to identity.
 *   An untranslated string reads as its English source, which is what an
 *   English catalog resolves to anyway.
 *
 * - **lzma**, via `osu-parsers`' replay decoder. The add-on decodes beatmaps
 *   only and never touches replays, so the lzma package is shimmed to throw.
 *
 * - **the rosu-pp wasm**, 808 kB embedded as 1.08 MB of base64. It is embedded
 *   instead as deflate-raw + base64 (~301 kB) and inflated at runtime with the
 *   browser's native `DecompressionStream` - no decompression library, no
 *   functionality change; see the marker handling in `engine/pp.ts`.
 *
 * Everything else is byte-identical in behavior: same sim, same React, same
 * worker, same tests. `npm run build:full` still produces the readable,
 * moderator-friendly unminified bundle upstream ships.
 */
import { build as esbuild } from 'esbuild';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
        assetQueryPlugin, cssTextPlugin, dedupePlugin, inlineWorkerPlugin,
        sharedSourcePlugin, stubModulePlugin, tsExtensionPlugin,
} from '@oss-idle/addon-sdk/build';
import { resolveGameRoot, gameVersion } from './resolve-game.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const config = JSON.parse(await readFile(resolve(pkgRoot, 'addon.config.json'), 'utf8'));
const { version } = JSON.parse(await readFile(resolve(pkgRoot, 'package.json'), 'utf8'));

const game = resolveGameRoot();
const builtAgainst = await gameVersion(game.root);
const sdkVersion = createRequire(import.meta.url)('@oss-idle/addon-sdk/package.json').version;

/** Marker the compressed wasm carries; `engine/pp.ts` reads it back. */
const DEFLATE_PREFIX = 'deflate1:';

/**
 * Replace heavy modules the add-on never executes.
 *
 * Unlike the SDK's throwing `stubModulePlugin`, these are **behavioral** shims:
 * the modules' load-time behavior is preserved exactly (zod's chainable schema
 * construction, `defineMessages`' identity) so nothing that merely *imports*
 * them can tell the difference. Only genuinely-unused code paths (parsing a
 * schema, decoding a replay) would throw - and the add-on's graph reaches none
 * of them.
 */
const shimPlugin = () => ({
        name: 'shim-heavy-deps',
        setup(build) {
                build.onResolve({ filter: /^zod$/ }, () => ({
                        path: 'zod-shim', namespace: 'shim',
                }));
                build.onResolve({ filter: /^lzma-js-simple-v2$/ }, () => ({
                        path: 'lzma-shim', namespace: 'shim',
                }));
                build.onLoad({ filter: /.*/, namespace: 'shim' }, args => {
                        if (args.path === 'zod-shim') return {
                                loader: 'js',
                                contents: `
                                        // Inert zod: every schema construction chains, nothing parses.
                                        const chain = new Proxy(function z() {}, {
                                                get: (_t, prop) => prop === 'parse' || prop === 'safeParse'
                                                        ? () => { throw new Error('zod was shimmed out of this add-on bundle'); }
                                                        : chain,
                                                apply: () => chain,
                                        });
                                        export const z = chain;
                                `,
                        };
                        return {
                                loader: 'js',
                                contents: `
                                        // lzma is only reachable through osu-parsers' replay decoder,
                                        // which this add-on never uses - it decodes beatmaps only.
                                        const refuse = name => () => { throw new Error('lzma was shimmed out of this add-on bundle'); };
                                        export const compress = refuse();
                                        export const decompress = refuse();
                                `,
                        };
                });
                // The game's translation module: identity in the add-on's world. The
                // graph only imports `defineMessages` (already identity); `__` returning
                // its source string is exactly what an English catalog does.
                build.onLoad({ filter: /shared\/src\/i18n\/translate\.ts$/ }, () => ({
                        loader: 'js',
                        contents: `
                                export const __ = (message) => message;
                                export const defineMessages = (messages) => messages;
                        `,
                }));
        },
});

/**
 * Embed `.wasm` imports as deflate-raw + base64, prefixed so `engine/pp.ts`
 * knows to inflate. Plugin onLoad beats esbuild's built-in base64 loader.
 */
const compressedWasmPlugin = () => ({
        name: 'compressed-wasm',
        setup(build) {
                build.onLoad({ filter: /\.wasm$/ }, async args => {
                        const wasm = await readFile(args.path);
                        const deflated = deflateRawSync(wasm, { level: 9 });
                        return {
                                loader: 'js',
                                contents: `export default "${DEFLATE_PREFIX}${deflated.toString('base64')}";`,
                        };
                });
        },
});

const baseOptions = () => ({
        bundle: true,
        format: 'esm',
        platform: 'browser',
        target: 'es2022',
        define: { 'process.env.NODE_ENV': '"production"' },
        jsx: 'automatic',
        legalComments: 'inline',
        loader: { '.wasm': 'base64' },
        minify: true,
        plugins: [
                assetQueryPlugin(),
                dedupePlugin(['react', 'react-dom', 'osu-classes', 'osu-parsers', 'osu-mania-stable'], pkgRoot),
                sharedSourcePlugin(resolve(game.root, 'packages/shared/src')),
                tsExtensionPlugin(),
                stubModulePlugin({ 'shared/src/onboarding.ts': ['characterNameBody'] }),
                cssTextPlugin(),
                shimPlugin(),
                compressedWasmPlugin(),
        ],
});

const buildWorkerSource = async entry => {
        const result = await esbuild({
                ...baseOptions(),
                entryPoints: [entry],
                write: false,
                format: 'iife',
        });
        return result.outputFiles?.[0]?.text ?? '';
};

const started = Date.now();
const result = await esbuild({
        ...baseOptions(),
        define: { ...baseOptions().define, __OSS_IDLE_ADDON__: JSON.stringify({
                name: config.name, version, gameVersion: builtAgainst,
                license: config.license, sdkVersion,
        }) },
        entryPoints: [resolve(pkgRoot, config.entry)],
        write: false,
        plugins: [
                inlineWorkerPlugin(buildWorkerSource),
                ...baseOptions().plugins,
        ],
});

const code = result.outputFiles?.[0]?.text ?? '';
const banner = [
        `// ${config.name} v${version} (compact build)`,
        `// built against oss!idle ${builtAgainst}`,
        `// ${config.license}`,
        `// Bundled with @oss-idle/addon-sdk v${sdkVersion}. Paste this file into the add-on editor.`,
        `// Compact: zod/i18n/lzma shimmed (unused here), wasm deflate-raw embedded.`,
].filter(Boolean).join('\n') + '\n\n';
const source = banner + code;

const outfile = resolve(pkgRoot, config.outfile);
await mkdir(dirname(outfile), { recursive: true });
await writeFile(outfile, source, 'utf8');

// Same shape assertion the SDK's own build runs.
if (!/export\s*\{[^}]*\bmount\b/.test(source) && !/export\s+(const|function)\s+mount\b/.test(source)) {
        throw new Error(`${outfile} does not export "mount" - the add-on runtime would load it and call nothing.`);
}

console.log(
        `built ${outfile}\n  ${(Buffer.byteLength(source, 'utf8') / 1024).toFixed(1)} kB (compact)` +
        `  |  oss!idle ${builtAgainst} (${game.label})  |  ${Date.now() - started}ms`,
);
