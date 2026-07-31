/**
 * Battle CLI — list or run authored scenarios (multi-round engagements).
 *
 *   npm run battle
 *   npm run battle -- --list
 *   npm run battle -- --id field-20
 *   npm run battle -- --all
 */

import { Arena, heightForForce } from './arena.ts';
import { DEFAULT_MAX_ROUNDS, runEngagement } from './engagement.ts';
import { formatResult } from './report.ts';
import { allScenarios, scenarioById } from './scenarios.ts';
import { Side } from './types.ts';

function main(argv: string[]): void {
  if (argv.includes('--list')) {
    for (const s of allScenarios()) {
      const a = s.fighters.filter((f) => f.side === Side.A).length;
      const b = s.fighters.filter((f) => f.side === Side.B).length;
      const h = s.arenaHeight ?? heightForForce(a, b);
      console.log(`${s.id.padEnd(16)} ${s.title}`);
      console.log(`                 ${a}v${b} · arena 10×${h} · max ${s.maxRounds ?? DEFAULT_MAX_ROUNDS} rounds`);
      console.log(`                 ${s.blurb}`);
      console.log('');
    }
    return;
  }

  const idIdx = argv.lastIndexOf('--id');
  const id = idIdx >= 0 ? argv[idIdx + 1] : undefined;
  const runAll = argv.includes('--all');
  const showLog = argv.includes('--log');

  const scenarios = runAll
    ? allScenarios().filter((s) => s.fighters.length <= 40) // --all skips 50/100 unless asked
    : id
      ? (() => {
          const s = scenarioById(id);
          if (!s) {
            console.error(`Unknown scenario "${id}". Try --list.`);
            process.exit(1);
          }
          return [s];
        })()
      : allScenarios().filter((s) => !s.id.startsWith('field-') || s.id === 'field-20');

  for (const s of scenarios) {
    const a = s.fighters.filter((f) => f.side === Side.A).length;
    const b = s.fighters.filter((f) => f.side === Side.B).length;
    const height = s.arenaHeight ?? heightForForce(a, b);
    console.log(`Resolving ${s.title} (${a}v${b}, 10×${height})…`);
    const t0 = performance.now();
    const eng = runEngagement({
      engagementId: s.id,
      title: s.title,
      fighters: s.fighters,
      arena: new Arena(height),
      maxRounds: s.maxRounds ?? DEFAULT_MAX_ROUNDS,
    });
    const ms = performance.now() - t0;

    // Determinism check
    const eng2 = runEngagement({
      engagementId: s.id,
      title: s.title,
      fighters: s.fighters,
      arena: new Arena(height),
      maxRounds: s.maxRounds ?? DEFAULT_MAX_ROUNDS,
    });
    if (JSON.stringify(eng.summary) !== JSON.stringify(eng2.summary)) {
      console.error(`DETERMINISM FAIL on ${s.id}`);
      process.exit(1);
    }

    console.log(eng.summary.map((l) => `  · ${l}`).join('\n'));
    console.log(`  rounds: ${eng.roundsPlayed}  (${ms.toFixed(0)} ms)`);
    for (const r of eng.rounds) {
      console.log(
        `    round ${r.round}: ${r.result.outcome} in ${r.result.turnsPlayed}t` +
          ` → alive A ${r.aliveA} / B ${r.aliveB}`,
      );
    }
    const last = eng.rounds[eng.rounds.length - 1];
    if (last && s.fighters.length <= 12) {
      console.log('');
      console.log(formatResult(last.result));
    }
    if (showLog && last) {
      console.log('--- last-round events (no waits) ---');
      for (const e of last.result.events) {
        if (e.kind === 'wait') continue;
        console.log(`t${e.turn} ${e.text}`);
      }
    }
    console.log('determinism: ok');
    console.log('─'.repeat(60));
  }
}

main(process.argv.slice(2));
