import { arenaCol, arenaRow, ARENA_WIDTH } from './arena.ts';
import type { BattleResult, FighterSnapshot } from './types.ts';
import { Side } from './types.ts';

function cellGlyph(fighters: readonly FighterSnapshot[], cell: number, width: number): string {
  for (const f of fighters) {
    if (f.alive && f.cell === cell) {
      return f.glyph.length <= 2 ? f.glyph : f.glyph.slice(0, 2);
    }
  }
  const col = cell % width;
  if (col >= 4 && col <= 5) return '·';
  return ' ';
}

export function formatBoard(
  fighters: readonly FighterSnapshot[],
  height = 6,
  width = ARENA_WIDTH,
): string {
  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    let line = row & 1 ? ' ' : '';
    for (let col = 0; col < width; col++) {
      const cell = row * width + col;
      const g = cellGlyph(fighters, cell, width);
      line += g.padEnd(2, ' ');
      line += ' ';
    }
    lines.push(line.trimEnd());
  }
  return lines.join('\n');
}

export function formatResult(result: BattleResult): string {
  const last = result.frames[result.frames.length - 1]!;
  const height = result.arena?.height ?? 6;
  const width = result.arena?.width ?? ARENA_WIDTH;
  const lines: string[] = [];
  lines.push(`${result.title}  [${result.battleId}]`);
  lines.push(`${result.turnsPlayed} turns — ${result.outcome === 'draw' ? 'draw' : `side ${result.outcome} wins`} · arena ${width}×${height}`);
  lines.push('');
  if (height <= 12) {
    lines.push(formatBoard(last.fighters, height, width));
    lines.push('');
  }
  for (const f of last.fighters) {
    const pos = `${arenaCol(f.cell)},${arenaRow(f.cell)}`;
    const status = !f.alive ? 'DEAD' : `hp ${f.health}/${f.maxHealth} armor ${f.armor}`;
    const side = f.side === Side.A ? 'A' : 'B';
    lines.push(`  ${f.glyph} ${f.name} (${f.role}, ${side}) @ ${pos}  ${status}`);
  }
  lines.push('');
  for (const s of result.summary) lines.push(`  · ${s}`);
  return lines.join('\n');
}
