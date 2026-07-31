import { ContainerClass, SlotKind, SlotSize, SlotTier, type ChassisDef } from './types.ts';

/**
 * Session 2 basic vehicle + Session 11 station grid
 * (4 basic caravan + 1 advanced caravan).
 */
export const BASIC_WAGON: ChassisDef = {
  id: 'basic_wagon',
  name: 'Basic wagon',
  slots: [
    { index: 0, kind: SlotKind.mount, size: SlotSize.medium, label: 'Mount' },
    { index: 1, kind: SlotKind.wheel, size: SlotSize.medium, label: 'Wheel FL' },
    { index: 2, kind: SlotKind.wheel, size: SlotSize.medium, label: 'Wheel FR' },
    { index: 3, kind: SlotKind.wheel, size: SlotSize.medium, label: 'Wheel RL' },
    { index: 4, kind: SlotKind.wheel, size: SlotSize.medium, label: 'Wheel RR' },
    { index: 5, kind: SlotKind.character, label: 'Driver' },
    { index: 6, kind: SlotKind.character, label: 'Seat 2' },
    { index: 7, kind: SlotKind.character, label: 'Seat 3' },
    { index: 8, kind: SlotKind.character, label: 'Seat 4' },
    {
      index: 9,
      kind: SlotKind.station,
      tier: SlotTier.basic,
      containerClass: ContainerClass.caravan,
      label: 'Station A',
    },
    {
      index: 10,
      kind: SlotKind.station,
      tier: SlotTier.basic,
      containerClass: ContainerClass.caravan,
      label: 'Station B',
    },
    {
      index: 11,
      kind: SlotKind.station,
      tier: SlotTier.basic,
      containerClass: ContainerClass.caravan,
      label: 'Station C',
    },
    {
      index: 12,
      kind: SlotKind.station,
      tier: SlotTier.basic,
      containerClass: ContainerClass.caravan,
      label: 'Station D',
    },
    {
      index: 13,
      kind: SlotKind.station,
      tier: SlotTier.advanced,
      containerClass: ContainerClass.caravan,
      label: 'Advanced station',
    },
  ],
};

const CHASSIS: Record<string, ChassisDef> = {
  [BASIC_WAGON.id]: BASIC_WAGON,
};

export function chassisById(id: string): ChassisDef | undefined {
  return CHASSIS[id];
}

export function allChassis(): ChassisDef[] {
  return Object.values(CHASSIS);
}
