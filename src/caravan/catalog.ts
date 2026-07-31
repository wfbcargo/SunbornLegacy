import {
  ContainerClass,
  OccupantKind,
  SlotSize,
  SlotTier,
  type CatalogItem,
  type Occupant,
} from './types.ts';
import { START_SATED_UNTIL } from './food.ts';

const CATALOG: CatalogItem[] = [
  {
    id: 'crabbeast',
    name: 'Crabbeast',
    kind: OccupantKind.mount,
    size: SlotSize.medium,
    ticksPerTile: 12,
    blurb: 'Slow, durable draft mount. The starting puller.',
  },
  {
    id: 'basic_wheel',
    name: 'Basic wheel',
    kind: OccupantKind.wheel,
    size: SlotSize.medium,
    blurb: 'Wooden rim and iron hub. Fits a medium wheel slot.',
  },
  {
    id: 'cargo_chest',
    name: 'Cargo chest',
    kind: OccupantKind.station,
    tier: SlotTier.basic,
    containerClass: ContainerClass.caravan,
    constructionCost: 20,
    cargoCapacity: 200,
    blurb: 'Basic caravan cargo hold. Capacity 200 qty — mass accounting later.',
  },
  {
    id: 'food_grower',
    name: 'Food grower',
    kind: OccupantKind.station,
    tier: SlotTier.basic,
    containerClass: ContainerClass.caravan,
    constructionCost: 30,
    blurb: 'Tray garden. Staffed → produces rations on a timer.',
  },
  {
    id: 'water_collector',
    name: 'Water collector',
    kind: OccupantKind.station,
    tier: SlotTier.basic,
    containerClass: ContainerClass.caravan,
    constructionCost: 25,
    blurb: 'Condenser and cask. Basic caravan station.',
  },
  {
    id: 'med_station',
    name: 'Med station',
    kind: OccupantKind.station,
    tier: SlotTier.basic,
    containerClass: ContainerClass.caravan,
    constructionCost: 35,
    blurb: 'Bandages, salves, a cot. Basic caravan station.',
  },
  {
    id: 'solar_generator',
    name: 'Solar generator',
    kind: OccupantKind.station,
    tier: SlotTier.advanced,
    containerClass: ContainerClass.caravan,
    constructionCost: 80,
    blurb: 'Charges vehicle batteries. Needs the advanced station slot.',
  },
  {
    id: 'outpost_farm',
    name: 'Outpost farm',
    kind: OccupantKind.station,
    tier: SlotTier.basic,
    containerClass: ContainerClass.outpost,
    constructionCost: 50,
    blurb: 'Settled plot. Fits the basic outpost slot only.',
  },
  {
    id: 'wanderer',
    name: 'Wanderer',
    kind: OccupantKind.character,
    ticksPerTile: 8,
    blurb: 'Character template — on foot faster than a crabbeast wagon.',
  },
  {
    id: 'hand',
    name: 'Hand',
    kind: OccupantKind.character,
    ticksPerTile: 8,
    blurb: 'Character template — same pace as a wanderer this slice.',
  },
  {
    id: 'scrap_vest',
    name: 'Scrap vest',
    kind: OccupantKind.character,
    equipSlot: 'armor',
    blurb: 'Makeshift armor. Equips on a character; biases skirmish toward bastion.',
  },
  {
    id: 'hand_axe',
    name: 'Hand axe',
    kind: OccupantKind.character,
    equipSlot: 'tool',
    blurb: 'Camp tool. Equips on a character.',
  },
  {
    id: 'trail_kit',
    name: 'Trail kit',
    kind: OccupantKind.character,
    equipSlot: 'gear',
    blurb: 'Bedroll and kit. Equips on a character.',
  },
];

const BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

export function allCatalog(): readonly CatalogItem[] {
  return CATALOG;
}

export function catalogById(id: string): CatalogItem | undefined {
  return BY_ID.get(id);
}

let nextInstance = 1;

/** Test / lab reset so printed ids stay stable across `npm run caravan`. */
export function resetInstanceIds(start = 1): void {
  nextInstance = start;
}

export function spawnFromCatalog(catalogId: string, displayName?: string): Occupant {
  const item = BY_ID.get(catalogId);
  if (!item) {
    throw new Error(`unknown catalog id: ${catalogId}`);
  }
  const instanceId = `occ-${nextInstance++}`;
  return {
    instanceId,
    catalogId: item.id,
    name: displayName ?? item.name,
    kind: item.kind,
    size: item.size,
    tier: item.tier,
    containerClass: item.containerClass,
    ticksPerTile: item.ticksPerTile,
    satedUntilStep:
      item.kind === OccupantKind.character && !item.equipSlot
        ? START_SATED_UNTIL
        : undefined,
  };
}
