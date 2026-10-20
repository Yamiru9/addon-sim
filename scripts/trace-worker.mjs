#!/usr/bin/env node
/**
 * For the worker bundle: which *game shared* / addon-sdk modules sit on the
 * path into zod, and which of the game's modules import zod directly.
 */
import { build as esbuild } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	assetQueryPlugin, cssTextPlugin, dedupePlugin, sharedSourcePlugin,
	stubModulePlugin, tsExtensionPlugin,
} from '@oss-idle/addon-sdk/build';
import { resolveGameRoot } from './resolve-game.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const game = resolveGameRoot();
const sharedSrcOf = root => resolve(root, 'packages/shared/src');

const result = await esbuild({
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2022',
	define: { 'process.env.NODE_ENV': '"production"' },
	jsx: 'automatic',
	legalComments: 'inline',
	loader: { '.wasm': 'base64' },
	minify: true,
	entryPoints: [resolve(pkgRoot, 'src/engine/sim.worker.ts')],
	write: false,
	metafile: true,
	plugins: [
		assetQueryPlugin(),
		dedupePlugin(['react', 'react-dom', 'osu-classes', 'osu-parsers', 'osu-mania-stable'], pkgRoot),
		sharedSourcePlugin(sharedSrcOf(game.root)),
		tsExtensionPlugin(),
		stubModulePlugin({ 'shared/src/onboarding.ts': ['characterNameBody'] }),
		cssTextPlugin(),
	],
});

const inputs = result.metafile.inputs;
const short = p => p.replace(/^.*?(node_modules|vendor\/oss-idle\/packages|addon-sim\/src)\//, '$1/');

// Who imports zod's entry, directly?
console.log('\n=== direct importers of zod ===');
for (const [path, info] of Object.entries(inputs)) {
	if (/node_modules\/zod\//.test(path)) continue;
	if (info.imports.some(i => /node_modules\/zod\//.test(i.path))) {
		console.log(`  ${short(path)}  (${(info.bytes / 1024).toFixed(1)} kB)`);
	}
}

// All game-shared modules actually included, with sizes.
console.log('\n=== game shared modules in worker ===');
let sharedTotal = 0;
for (const [path, info] of Object.entries(inputs)) {
	if (path.includes('vendor/oss-idle/packages/shared/src/')) {
		sharedTotal += info.bytes;
		if (info.bytes > 3000) console.log(`  ${(info.bytes / 1024).toFixed(1).padStart(7)} kB  ${short(path)}`);
	}
}
console.log(`  total shared: ${(sharedTotal / 1024).toFixed(1)} kB`);

console.log(`\nworker output: ${((result.outputFiles?.[0]?.text.length ?? 0) / 1024).toFixed(1)} kB`);
