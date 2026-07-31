/**
 * Modular caravan types — chassis slots and fit-able occupants.
 *
 * Session 2: mount / wheel / character / station layout.
 * Session 11: stations typed by tier × container class.
 */

export const SlotKind = {
  mount: 'mount',
  wheel: 'wheel',
  character: 'character',
  station: 'station',
} as const;
export type SlotKind = (typeof SlotKind)[keyof typeof SlotKind];

export const SlotSize = {
  small: 'small',
  medium: 'medium',
  large: 'large',
} as const;
export type SlotSize = (typeof SlotSize)[keyof typeof SlotSize];

export const SlotTier = {
  basic: 'basic',
  advanced: 'advanced',
} as const;
export type SlotTier = (typeof SlotTier)[keyof typeof SlotTier];

export const ContainerClass = {
  caravan: 'caravan',
  city: 'city',
  outpost: 'outpost',
} as const;
export type ContainerClass = (typeof ContainerClass)[keyof typeof ContainerClass];

/** One socket on a chassis. Station slots carry tier × container class. */
export interface SlotDef {
  index: number;
  kind: SlotKind;
  /** Required for mount / wheel. Ignored for character / station. */
  size?: SlotSize;
  /** Station slots only. */
  tier?: SlotTier;
  containerClass?: ContainerClass;
  /** Character slot 0 is the driver seat — display only this slice. */
  label?: string;
}

export interface ChassisDef {
  id: string;
  name: string;
  slots: readonly SlotDef[];
}

export const OccupantKind = {
  mount: 'mount',
  wheel: 'wheel',
  character: 'character',
  station: 'station',
} as const;
export type OccupantKind = (typeof OccupantKind)[keyof typeof OccupantKind];

/** Catalog entry that can occupy a matching slot. */
export interface CatalogItem {
  id: string;
  name: string;
  kind: OccupantKind;
  size?: SlotSize;
  tier?: SlotTier;
  containerClass?: ContainerClass;
  /** Ticks to cross one tile. Mounts and characters only. */
  ticksPerTile?: number;
  /** Station build cost in scrap units — used for mobilise refunds. */
  constructionCost?: number;
  /** Max total material qty this station can hold. Absent = not a cargo hold. */
  cargoCapacity?: number;
  /** If set, this item equips on a character — not fitted into chassis slots. */
  equipSlot?: 'armor' | 'tool' | 'gear';
  blurb: string;
}

export const Form = {
  caravan: 'caravan',
  outpost: 'outpost',
  derelict: 'derelict',
} as const;
export type Form = (typeof Form)[keyof typeof Form];

export interface MaterialStack {
  materialId: string;
  qty: number;
}

/** Live instance placed in a slot (may carry a rolled display name). */
export interface Occupant {
  /** Stable instance id within a caravan. */
  instanceId: string;
  /** Catalog id this was spawned from. */
  catalogId: string;
  name: string;
  kind: OccupantKind;
  size?: SlotSize;
  tier?: SlotTier;
  containerClass?: ContainerClass;
  ticksPerTile?: number;
  /** Characters only — step when food deadline expires. */
  satedUntilStep?: number;
  /** Characters only — equipped catalog ids (armor / tool / gear). */
  armor?: string;
  tool?: string;
  gear?: string;
}

export interface SlotState {
  def: SlotDef;
  occupant: Occupant | null;
}

export interface Vehicle {
  id: string;
  chassisId: string;
  slots: SlotState[];
}

export interface Caravan {
  id: string;
  name: string;
  form: Form;
  /** Parked tile when idle / before the first leg. */
  origin: TileCoord;
  legs: CaravanLeg[];
  /** Bumped on replan in a later spec; stays 0 this slice. */
  generation: number;
  vehicles: Vehicle[];
  /** Soft character→station staffing links. */
  assignments: StationAssignment[];
  /** One hold per fitted cargo station. */
  holds: CargoHold[];
  /** Stacks not in a hold (refunds without a chest, emptied on unfit). */
  loose: MaterialStack[];
  /** Last produce step per staffed food station instance id. */
  production: Record<string, number>;
  /** Stationary tile activity in progress, if any. */
  activity: TileActivity | null;
  /** Side-A battle deploy placements (4×6 zone). */
  deploy: DeployBag;
}

/** Remain-here-for-N-ticks work (Session 12). Survey only this slice. */
export interface TileActivity {
  kind: 'survey';
  tile: TileCoord;
  startStep: number;
  durationTicks: number;
}

/** One character’s cell in the Side-A deploy zone (cols 0–3, rows 0–5). */
export interface DeployPlacement {
  characterInstanceId: string;
  col: number;
  row: number;
}

export interface DeployBag {
  placements: DeployPlacement[];
}

/** Cargo contents of one fitted station. */
export interface CargoHold {
  stationInstanceId: string;
  stacks: MaterialStack[];
}

/** One character staffing one station (both must remain fitted). */
export interface StationAssignment {
  characterInstanceId: string;
  stationInstanceId: string;
}

export interface TileCoord {
  col: number;
  row: number;
}

export const LegState = {
  committed: 'committed',
  stalled: 'stalled',
} as const;
export type LegState = (typeof LegState)[keyof typeof LegState];

/** One immutable travel segment. tiles[0] = departure. */
export interface CaravanLeg {
  seq: number;
  tiles: TileCoord[];
  /** Slowest-member speed snapshotted at commit. */
  ticksPerTile: number;
  startStep: number;
  state: LegState;
}

export interface PositionAt {
  tile: TileCoord;
  travelling: boolean;
  legSeq: number | null;
  tileIndex: number;
}

export type LegOk = { ok: true; leg: CaravanLeg };
export type LegErr = { ok: false; reason: string };
export type LegResult = LegOk | LegErr;

export interface DerivedStats {
  /** Max ticksPerTile among fitted mounts and characters; null if none or outpost. */
  ticksPerTile: number | null;
  /** False while settled as an outpost. */
  mobile: boolean;
  form: Form;
  staffed: boolean;
  characterCount: number;
  mountCount: number;
  stationCount: number;
  /** Stations that currently have an assignee. */
  staffedStationCount: number;
  emptySlots: number;
}

export type FitOk = { ok: true };
export type FitErr = { ok: false; reason: string };
export type FitResult = FitOk | FitErr;

export type SettleOk = {
  ok: true;
  refunds: MaterialStack[];
  strippedStation: Occupant | null;
};
export type SettleErr = { ok: false; reason: string };
export type SettleResult = SettleOk | SettleErr;

/** Unfit may collapse an outpost when the last character leaves. */
export type UnfitOk = {
  ok: true;
  occupant: Occupant;
  collapsed: boolean;
  refunds: MaterialStack[];
  /** Station stripped from the destroyed outpost slot, if any. */
  strippedStation: Occupant | null;
};
export type UnfitResult = UnfitOk | FitErr;
