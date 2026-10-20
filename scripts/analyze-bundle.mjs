#!/usr/bin/env node
/**
 * Size analysis of the add-on bundle: replicates bundleAddon's esbuild
 * invocation but with `metafile: true`, then prints where the bytes go -
 * per package, and inside the biggest package per file.
 */
import { build as esbuild } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
        assetQueryPlugin, cssTextPlugin, dedupePlugin, sharedSourcePlugin,
        stubModulePlugin, tsExtensionPlugin, inlineWorkerPlugin,
} from '@oss-idle/addon-sdk/build';
import { resolveGameRoot } from './resolve-game.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = resolveGameRoot();
const sdkVersion = createRequire(import.meta.url)('@oss-idle/addon-sdk/package.json').version;

const sharedSrcOf = root => resolve(root, 'packages/shared/src');

// Mirror baseOptions from the SDK, minified, with legal comments inline.
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
                sharedSourcePlugin(sharedSrcOf(game.root)),
                tsExtensionPlugin(),
                stubModulePlugin({ 'shared/src/onboarding.ts': ['characterNameBody'] }),
                cssTextPlugin(),
        ],
});

// The worker is bundled separately as an IIFE string, exactly as the SDK does it.
const buildWorkerSource = async entry => {
        const result = await esbuild({
                ...baseOptions(),
                entryPoints: [entry],
                write: false,
                format: 'iife',
                metafile: true,
        });
        // Roll the worker's inputs into the analysis too.
        workerInputs.push(...Object.entries(result.metafile.inputs));
        return result.outputFiles?.[0]?.text ?? '';
};

const workerInputs = [];

const result = await esbuild({
        ...baseOptions(),
        define: { ...baseOptions().define, __OSS_IDLE_ADDON__: JSON.stringify({ sdkVersion }) },
        entryPoints: [resolve(pkgRoot, 'src/index.ts')],
        write: false,
        metafile: true,
        plugins: [
                inlineWorkerPlugin(buildWorkerSource),
                ...baseOptions().plugins,
        ],
});

// ---- aggregate per top-level origin ----------------------------------------
const groupOf = path => {
        if (path.startsWith('data:')) return 'rosu-pp wasm (base64)';
        if (path.includes('node_modules/react-dom/')) return 'react-dom';
        if (path.includes('node_modules/react/')) return 'react';
        if (path.includes('node_modules/osu-parsers/')) return 'osu-parsers';
        if (path.includes('node_modules/osu-classes/')) return 'osu-classes';
        if (path.includes('node_modules/osu-mania-stable/')) return 'osu-mania-stable';
        if (path.includes('node_modules/rosu-pp-js-web/')) return 'rosu-pp-js-web (js)';
        if (path.includes('node_modules/@oss-idle/addon-sdk/')) return 'addon-sdk';
        if (path.includes('vendor/oss-idle/packages/shared/src/')) return 'game shared (sim)';
        if (path.includes('/addon-sim/src/')) return 'addon own code';
        if (path.includes('node_modules/')) {
                const m = path.match(/node_modules\/((@[^/]+\/)?[^/]+)/);
                return m?.[1] ?? 'other node_modules';
        }
        return 'other';
};

const groups = new Map();
const allInputs = [...Object.entries(result.metafile.inputs), ...workerInputs];
for (const [path, info] of allInputs) {
        const g = groupOf(path);
        groups.set(g, (groups.get(g) ?? 0) + info.bytes);
}

const outBytes = result.outputFiles?.[0]?.text.length ?? 0;
console.log(`\nbundle: ${(outBytes / 1024).toFixed(1)} kB (minified)\n`);
console.log('by group (input bytes):');
for (const [g, bytes] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${(bytes / 1024).toFixed(1).padStart(9)} kB  ${g}`);
}

// ---- biggest individual inputs ---------------------------------------------
console.log('\n15 largest inputs:');
const inputs = allInputs.sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15);
for (const [path, info] of inputs) {
        console.log(`  ${(info.bytes / 1024).toFixed(1).padStart(9)} kB  ${path.replace(/^.*?(node_modules|vendor|addon-sim)\//, '$1/')}`);
}

// ---- how much of the output is the base64 wasm? ----------------------------
const code = result.outputFiles?.[0]?.text ?? '';
let dataUri = 0;
for (const m of code.matchAll(/"[A-Za-z0-9+/=]{2000,}"/g)) dataUri += m[0].length;
console.log(`\nbase64 blobs in output: ${(dataUri / 1024).toFixed(1)} kB`);

// license comments share (rough): block comments
let commentBytes = 0;
for (const m of code.matchAll(/\/\*[\s\S]*?\*\//g)) commentBytes += m[0].length;
console.log(`block comments in output: ${(commentBytes / 1024).toFixed(1)} kB`);
