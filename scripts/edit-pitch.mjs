// Edit a completed capture into a silent, subtitle-free, 118-second submission film.
// Preserves the source and every intermediate. Usage: node scripts/edit-pitch.mjs <capture-directory>
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = resolve(process.argv[2]);
const metadata = JSON.parse(readFileSync(join(directory, 'capture.json'), 'utf8'));
if (!metadata.rawPath || metadata.errors.length) throw new Error('Capture is incomplete or has browser errors.');
const output = join(directory, 'runners-2min.mp4');
if (existsSync(output)) throw new Error('Output already exists. Use a fresh capture directory.');
const parts = join(directory, 'edit-parts');
mkdirSync(parts, { recursive: true });
const beat = id => {
  const found = metadata.beats.find(b => b.id === id);
  if (!found) throw new Error(`Missing beat ${id}`);
  return found.seconds;
};
const caught = metadata.captions.find(c => c.text.startsWith('Caught at the next hand-off:'));
if (!caught) throw new Error('The run did not demonstrate loss detection.');
const skim = metadata.captions.find(c => c.text.startsWith('An insider takes'));
if (!skim) throw new Error('The run did not inject the theft.');

// Each range is chronological and plays at its recorded speed. Gaps only remove waiting.
const scenes = [
  ['Opening', beat('intro') + 5, 4],
  ['Hawassa and comparison', beat('map') + 1, 10],
  ['Central dispatch', beat('clipboard') + 1, 7],
  ['Injected theft', Math.max(beat('theft') + .5, skim.seconds + .3), 7],
  ['Local agent decisions', beat('black-box') + .6, 15],
  ['Loss detected', Math.max(beat('handoff') + .7, caught.seconds + .4), 11],
  ['Central device', beat('breach-today') + .5, 7],
  ['Runners device', beat('breach-runners') + .5, 8],
  ['Offline coordination', beat('network-down') + .5, 17],
  ['Outage result', beat('outage') + .5, 7],
  ['Reconnection', beat('network-up') + .5, 5],
  ['Auditor access', beat('glass-box') + .7, 9],
  ['Results', beat('scoreboard') + .7, 8],
  ['Close', beat('title') + .7, 3],
];

const run = args => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.status}`);
};
let elapsed = 0;
const edits = [];
for (const [i, [title, start, duration]] of scenes.entries()) {
  const file = `part-${String(i).padStart(2, '0')}.mp4`;
  const filters = ['fps=25', 'setsar=1'];
  // Hold the last loss-proof frame if the next chapter arrives before its reading time is over.
  const available = title === 'Loss detected' ? Math.min(duration, beat('breach-today') - .3 - start) : duration;
  if (available <= 0) throw new Error('Loss proof appeared too late for this edit.');
  if (available < duration) filters.push(`tpad=stop_mode=clone:stop_duration=${duration - available}`);
  if (i === 0) filters.push('fade=t=in:st=0:d=0.3');
  if (i === scenes.length - 1) filters.push(`fade=t=out:st=${duration - .5}:d=0.5`);
  run(['-ss', String(start), '-t', String(available), '-i', metadata.rawPath, '-t', String(duration), '-an', '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p', '-threads', '4', join(parts, file)]);
  edits.push({ title, start: elapsed, end: elapsed + duration, sourceStart: start, holdLastFrame: duration - available, file });
  elapsed += duration;
  console.log(`${title}: ${duration}s encoded`);
}
const list = join(parts, 'concat.txt');
writeFileSync(list, edits.map(e => `file '${e.file}'`).join('\n'));
run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output]);
writeFileSync(join(directory, 'edit.json'), JSON.stringify({ output, duration: elapsed, subtitles: false, audio: false, scenes: edits }, null, 2));
console.log(`FINAL ${output} (${elapsed}s)`);
