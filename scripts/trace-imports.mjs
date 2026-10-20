#!/usr/bin/env node
/**
 * Trace the import chains that pull heavy modules (zod, lzma, lingui, moo,
 * js-sha256) into the main bundle and the worker bundle.
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
const sharedSrcOf = root => resolve(root, 'packages/shared/src');

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

/** Print the chain main-entry -> ... -> target, walking the import graph. */
const traceTo = (metafile, targetPred, label) => {
	const inputs = metafile.inputs;
	// Map each module to the modules that import it (reverse edges).
	const importedBy = new Map();
	for (const [path, info] of Object.entries(inputs)) {
		for (const imp of info.imports) {
			if (imp.external) continue;
			const list = importedBy.get(imp.path) ?? [];
			list.push(path);
			importedBy.set(imp.path, list);
		}
	}

	const targets = Object.keys(inputs).filter(targetPred);
	console.log(`\n=== ${label}: ${targets.length} target module(s) ===`);
	for (const target of targets.slice(0, 3)) {
		// Walk up from target to the entry (a module nobody imports).
		let chain = [target];
		let frontier = [target];
		const seen = new Set(frontier);
		while (frontier.length) {
			const next = [];
			for (const node of frontier) {
				for (const parent of importedBy.get(node) ?? []) {
					if (seen.has(parent)) continue;
					seen.add(parent);
					next.push(parent);
				}
			}
			if (next.length) {
				chain = next; // keep the last layer
				frontier = next;
			} else break;
		}
		// Print a representative path: from a root down to target.
		const short = p => p.replace(/^.*?(node_modules|vendor\/oss-idle\/packages|addon-sim\/src)\//, '$1/');
		console.log(`  ${short(target)}`);
		let node = target;
		for (let depth = 0; depth < 12; depth++) {
			const parents = importedBy.get(node) ?? [];
			if (!parents.length) break;
			const parent = parents.find(p => !p.startsWith('addon-sim')) ?? parents[0];
			console.log(`   <- ${short(parent)}`);
			node = parent;
		}
	}
};

const workerMeta = [];
const buildWorkerSource = async entry => {
	const result = await esbuild({
		...baseOptions(),
		entryPoints: [entry],
		write: false,
		format: 'iife',
		metafile: true,
	});
	workerMeta.push(result.metafile);
	return result.outputFiles?.[0]?.text ?? '';
};

const result = await esbuild({
	...baseOptions(),
	define: { ...baseOptions().define, __OSS_IDLE_ADDON__: '"trace"' },
	entryPoints: [resolve(pkgRoot, 'src/index.ts')],
	write: false,
	metafile: true,
	plugins: [inlineWorkerPlugin(buildWorkerSource), ...baseOptions().plugins],
});

const isHeavy = p => /node_modules\/(zod|lzma-js-simple-v2|@lingui|moo|js-sha256|@messageformat)\//.test(p);

traceTo(result.metafile, isHeavy, 'MAIN bundle: heavy modules');
for (const [i, meta] of workerMeta.entries()) {
	traceTo(meta, isHeavy, `WORKER ${i}: heavy modules`);
}
