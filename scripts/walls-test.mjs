/** Fail walls: the LN classes, the failure runs, and the walls they trip. */
import { build } from 'esbuild';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This repository's root, so nothing depends on where it is checked out. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');


const dir = join(REPO_ROOT, '.wallstest');
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'e.ts'), `
        export { lnBucket, lnBucketFromRatio, bucketLabel, lnRatioFromText, FailWalls, WALL_SPAN }
                from '../src/engine/walls.js';
`);
await build({
        entryPoints: [join(dir, 'e.ts')], outfile: join(dir, 'b.mjs'), bundle: true,
        format: 'esm', platform: 'neutral', mainFields: ['module', 'main'],
        conditions: ['import', 'default'],
        absWorkingDir: REPO_ROOT,
});
const { lnBucket, lnBucketFromRatio, bucketLabel, lnRatioFromText, FailWalls, WALL_SPAN } =
        await import(pathToFileURL(join(dir, 'b.mjs')).href);



let pass = 0, fail = 0;
const check = (n, c, x = '') => { c ? pass++ : (fail++, console.log('  FAIL:', n, x)); };

// the classes are the fifths of the LN share, snapping to 0/25/50/75/100%
check('all rice is class 0', lnBucket(500, 0) === 0);
check('all LN is class 4', lnBucket(0, 500) === 4);
check('a 60/40 split is class 2', lnBucket(60, 40) === 2, `${lnBucket(60, 40)}`);
check('missing counts are unmeasured', lnBucket(undefined, undefined) === -1);
check('no notes are unmeasured', lnBucket(0, 0) === -1);
check('a measured ratio snaps to a class', lnBucketFromRatio(0.3) === 1, `${lnBucketFromRatio(0.3)}`);
check('a ratio clamps at the top', lnBucketFromRatio(1.7) === 4);
check('labels read as LN share', bucketLabel(0) === '0% LN' && bucketLabel(4) === '100% LN');

// the ratio from chart text: taps are type bit 1, holds bit 128
const chart = notes => `[General]\nAudioFilename: a.mp3\n\n[HitObjects]\n${notes.join('\n')}`;
check('text ratio counts holds over all notes',
        lnRatioFromText(chart(['1,1,0,1,0', '2,1,100,128,0,50'])) === 0.5,
        `${lnRatioFromText(chart(['1,1,0,1,0', '2,1,100,128,0,50']))}`);
check('a later section ends the count',
        lnRatioFromText(`${chart(['1,1,0,1,0'])}\n[TimingPoints]\n1,1,1,1`) === 0);
check('empty chart is unmeasured', lnRatioFromText('[HitObjects]\n\n') === undefined);

// three consecutive failures trip a wall; a pass resets the run
{
        const w = new FailWalls(3, WALL_SPAN);
        check('nothing skipped before any wall', !w.shouldSkip(0, 10));
        w.report(0, 4.0, false);
        check('no wall from two fails', w.report(0, 4.1, false) === undefined);
        check('a pass resets the run', w.report(0, 4.2, true) === undefined);
        check('the run restarts from the pass', w.report(0, 4.3, false) === undefined);
        check('two after the pass is still no wall', w.report(0, 4.4, false) === undefined);
        const tripped = w.report(0, 4.5, false);
        check('three in a row trip the wall',
                tripped !== undefined && tripped.bucket === 0 && Math.abs(tripped.stars - 4.5) < 1e-9,
                JSON.stringify(tripped));
        check('above the wall is skipped', w.shouldSkip(0, 4.6));
        check('at the wall is not skipped', !w.shouldSkip(0, 4.5));
        check('below the wall is not skipped', !w.shouldSkip(0, 4.0));
        check('other classes are untouched', !w.shouldSkip(4, 9));
        check('unmeasured classes are never skipped', !w.shouldSkip(-1, 99));
        check('unstarred difficulties are never skipped', !w.shouldSkip(0, 0));
}

// one class's wall says nothing about the others - the whole point of the classes
{
        const w = new FailWalls(3, WALL_SPAN);
        w.report(0, 4.0, false);
        w.report(0, 4.1, false);
        w.report(0, 4.2, false);
        check('rice is walled', w.shouldSkip(0, 4.3));
        check('long notes are still scanned', !w.shouldSkip(4, 4.3));
}

// a run wider than the span is sparse evidence, not a wall
{
        const w = new FailWalls(3, WALL_SPAN);
        check('sparse failures do not wall',
                w.report(1, 2.0, false) === undefined
                && w.report(1, 5.0, false) === undefined
                && w.report(1, 9.0, false) === undefined);
        check('nothing skipped after sparse failures', !w.shouldSkip(1, 20));
        check('the sparse run restarts at its last failure', w.report(1, 9.1, false) === undefined);
        const tripped = w.report(1, 9.2, false);
        check('a cluster after the restart does wall',
                tripped !== undefined && Math.abs(tripped.stars - 9.2) < 1e-9, JSON.stringify(tripped));
}

// walls from outside merge by minimum and never loosen
{
        const w = new FailWalls(3, WALL_SPAN);
        check('merge applies a wall', w.merge({ bucket: 2, stars: 5.0 }));
        check('a merged wall skips', w.shouldSkip(2, 5.5));
        w.report(2, 4.0, false);
        w.report(2, 4.1, false);
        const tripped = w.report(2, 4.2, false);
        check('a newly tripped wall tightens',
                tripped !== undefined && Math.abs(tripped.stars - 4.2) < 1e-9, JSON.stringify(tripped));
        check('the tightened wall skips more', w.shouldSkip(2, 4.5));
        w.merge({ bucket: 2, stars: 6.0 });
        check('a looser wall changes nothing', w.shouldSkip(2, 4.5) && w.shouldSkip(2, 5.9));
        check('the list reads back', w.list.length === 1 && w.list[0].bucket === 2 && Math.abs(w.list[0].stars - 4.2) < 1e-9);
}

// the failure threshold is configurable
{
        const w = new FailWalls(1, WALL_SPAN);
        check('a threshold of one walls immediately', w.report(3, 3.0, false)?.stars === 3.0);
        const v = new FailWalls(1, WALL_SPAN);
        check('a cleared map never walls', v.report(3, 3.0, true) === undefined);
}

console.log(`\n${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
