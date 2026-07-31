import { activityProgress } from './activity.ts';
import { chassisById } from './chassis.ts';
import { deriveStats } from './derive.ts';
import { formatTile, positionAt } from './legs.ts';
import type { Caravan, MaterialStack } from './types.ts';

export function formatRefunds(refunds: readonly MaterialStack[]): string {
  if (!refunds.length) return 'none';
  return refunds.map((r) => `${r.qty} ${r.materialId}`).join(', ');
}

export function formatCaravan(caravan: Caravan, step = 0): string {
  const lines: string[] = [];
  lines.push(`Caravan: ${caravan.name} (${caravan.id})`);
  const stats = deriveStats(caravan);
  const pos = positionAt(caravan, step);
  lines.push(
    `Form: ${stats.form}  mobile=${stats.mobile}  ` +
      `ticks/tile=${stats.ticksPerTile ?? 'immobile'}  staffed=${stats.staffed}`,
  );
  lines.push(
    `Position @${step}: ${formatTile(pos.tile)}  travelling=${pos.travelling}` +
      (pos.legSeq != null ? `  leg=${pos.legSeq}  tileIndex=${pos.tileIndex}` : ''),
  );
  const act = activityProgress(caravan, step);
  if (act.ok) {
    const p = act.progress;
    lines.push(
      `Activity: ${p.kind} @${formatTile(p.tile)}  ${p.elapsed}/${p.durationTicks}` +
        (p.done ? '  done' : ''),
    );
  }
  if (caravan.deploy.placements.length) {
    lines.push(`Deploy (${caravan.deploy.placements.length}):`);
    for (const p of caravan.deploy.placements) {
      lines.push(`  ${p.characterInstanceId} @ ${p.col},${p.row}`);
    }
  }
  lines.push(
    `Counts: chars=${stats.characterCount} mounts=${stats.mountCount} ` +
      `stations=${stats.stationCount} staffedStations=${stats.staffedStationCount} ` +
      `empty=${stats.emptySlots}`,
  );
  if (caravan.assignments.length) {
    lines.push(`Assignments (${caravan.assignments.length}):`);
    for (const a of caravan.assignments) {
      lines.push(`  ${a.characterInstanceId} → ${a.stationInstanceId}`);
    }
  }
  if (caravan.holds.length || caravan.loose.length) {
    lines.push('Inventory:');
    for (const h of caravan.holds) {
      const stacks =
        h.stacks.length === 0
          ? 'empty'
          : h.stacks.map((s) => `${s.qty} ${s.materialId}`).join(', ');
      lines.push(`  hold ${h.stationInstanceId}: ${stacks}`);
    }
    if (caravan.loose.length) {
      lines.push(
        `  loose: ${caravan.loose.map((s) => `${s.qty} ${s.materialId}`).join(', ')}`,
      );
    }
  }
  if (caravan.legs.length) {
    lines.push(`Legs (${caravan.legs.length}):`);
    for (const leg of caravan.legs) {
      const path = leg.tiles.map(formatTile).join('→');
      lines.push(
        `  #${leg.seq} ${leg.state}  tpt=${leg.ticksPerTile}  start=${leg.startStep}  ${path}`,
      );
    }
  }

  for (const vehicle of caravan.vehicles) {
    const chassis = chassisById(vehicle.chassisId);
    lines.push(
      `Vehicle: ${vehicle.id}  chassis=${chassis?.name ?? vehicle.chassisId} (${vehicle.chassisId})`,
    );
    for (const slot of vehicle.slots) {
      const label = slot.def.label ?? `${slot.def.kind}#${slot.def.index}`;
      const typing =
        slot.def.kind === 'station'
          ? ` ${slot.def.tier}/${slot.def.containerClass}`
          : slot.def.size
            ? ` ${slot.def.size}`
            : '';
      if (slot.occupant) {
        const o = slot.occupant;
        const speed =
          o.ticksPerTile != null ? `  ticks/tile=${o.ticksPerTile}` : '';
        const sated =
          o.kind === 'character' && o.satedUntilStep != null
            ? `  satedUntil=${o.satedUntilStep}`
            : '';
        lines.push(
          `  [${String(slot.def.index).padStart(2, ' ')}] ${label}${typing}: ` +
            `${o.name} (${o.catalogId})${speed}${sated}`,
        );
      } else {
        lines.push(`  [${String(slot.def.index).padStart(2, ' ')}] ${label}${typing}: —`);
      }
    }
  }
  return lines.join('\n');
}
