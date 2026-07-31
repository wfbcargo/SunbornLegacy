import { heightForForce } from './arena.ts';
import {
  MIX_HOST,
  MIX_RAID,
  packArmy,
  resetFighterIds,
  spawn,
} from './roster.ts';
import type { Scenario } from './types.ts';
import { Side } from './types.ts';

/**
 * Hand-authored encounters + packed mass battles. Each names what it probes.
 */
export function allScenarios(): Scenario[] {
  resetFighterIds(1);
  return [
    glassRoadAmbush(),
    saltFlatDuel(),
    arrowCorridor(),
    wardTrial(),
    caravanEscort(),
    nightMarketBrawl(),
    bastionBreach(),
    hexAndHold(),
    massBattle('field-20', 'Field of Twenty', 20, 8),
    massBattle('field-50', 'Field of Fifty', 50, 10),
    massBattle('field-100', 'Field of a Hundred', 100, 12),
  ];
}

export function scenarioById(id: string): Scenario | undefined {
  return allScenarios().find((s) => s.id === id);
}

function massBattle(
  id: string,
  title: string,
  n: number,
  maxRounds: number,
): Scenario {
  resetFighterIds(1);
  const host = packArmy(Side.A, n, MIX_HOST, 'Host-');
  const raid = packArmy(Side.B, n, MIX_RAID, 'Raid-');
  return {
    id,
    title,
    blurb: `${n} vs ${n} on a ${heightForForce(n, n)}-row arena. Host mix vs raid mix.`,
    probes:
      `Mass combat + multi-round engagement — does the ${n}v${n} grind resolve before the round cap, ` +
      'and does the taller board change closing / targeting?',
    fighters: [...host, ...raid],
    arenaHeight: heightForForce(n, n),
    maxRounds,
  };
}

/** 2v2 — dodge blades into a plate wall. */
function glassRoadAmbush(): Scenario {
  resetFighterIds(1);
  return {
    id: 'glass-road',
    title: 'Glass Road Ambush',
    blurb: 'Reedstep and Mirage jump Ashplate and Slagguard on the fused highway.',
    probes: 'Can dodge-skirmishers out-trade pure bastions before armor resets the math?',
    biomeKey: 'glass',
    fighters: [
      spawn('reedstep', Side.A, 3, 1),
      spawn('mirage', Side.A, 3, 4),
      spawn('ashplate', Side.B, 6, 1),
      spawn('slagguard', Side.B, 6, 4),
    ],
  };
}

/** 1v1 — speed vs plate. */
function saltFlatDuel(): Scenario {
  resetFighterIds(1);
  return {
    id: 'salt-duel',
    title: 'Salt-Flat Duel',
    blurb: 'A single Reedstep challenges Ashplate in the open white.',
    probes: '1v1 close-range: does dodge + feint beat raw armor, or does crush win by attrition?',
    biomeKey: 'desert',
    fighters: [
      spawn('reedstep', Side.A, 3, 2, 'Reedstep the Claimant'),
      spawn('ashplate', Side.B, 6, 3, 'Ashplate the Still'),
    ],
  };
}

/** 2v2 — backline archers vs advancing bruisers. */
function arrowCorridor(): Scenario {
  resetFighterIds(1);
  return {
    id: 'arrow-corridor',
    title: 'Arrow Corridor',
    blurb: 'Sunstring and Glass-eye hold a lane; Dustpike and Wagon-ram must close it.',
    probes: 'Deployment depth and move cooldown — can melee cross the neutral zone under fire?',
    biomeKey: 'forest',
    fighters: [
      spawn('sunstring', Side.A, 1, 1),
      spawn('glasseye', Side.A, 0, 4),
      spawn('dustpike', Side.B, 6, 2),
      spawn('wagonram', Side.B, 7, 4),
    ],
  };
}

/** 2v2 — ward / weaken support, no HP restore. */
function wardTrial(): Scenario {
  resetFighterIds(1);
  return {
    id: 'ward-trial',
    title: 'Ward Trial',
    blurb: 'Each side brings a bruiser and a warder. Damage sticks — armor only buys time.',
    probes: 'Ward/weaken vs damage cadence — can you read who dies without heal math?',
    fighters: [
      spawn('wagonram', Side.A, 3, 2),
      spawn('saltwise', Side.A, 1, 3),
      spawn('dustpike', Side.B, 6, 2),
      spawn('choir', Side.B, 8, 3),
    ],
  };
}

/** 3v3 — mixed caravan fight. */
function caravanEscort(): Scenario {
  resetFighterIds(1);
  return {
    id: 'caravan-escort',
    title: 'Caravan Escort',
    blurb: 'Escort (bastion, archer, warder) vs raiders (skirmisher, hexer, crossbow).',
    probes: 'Classic composition triangle — front, range, support vs tempo and disruption.',
    fighters: [
      spawn('ashplate', Side.A, 3, 1, 'Ashplate (escort)'),
      spawn('sunstring', Side.A, 1, 3, 'Sunstring (roof)'),
      spawn('saltwise', Side.A, 0, 4, 'Saltwise (ward)'),
      spawn('reedstep', Side.B, 6, 1, 'Reedstep (raid)'),
      spawn('cindertongue', Side.B, 8, 2, 'Cinder-tongue'),
      spawn('bolsister', Side.B, 9, 4, 'Bolt-sister'),
    ],
  };
}

/** 2v3 — outnumbered but supported. */
function nightMarketBrawl(): Scenario {
  resetFighterIds(1);
  return {
    id: 'night-market',
    title: 'Night Market Brawl',
    blurb: 'Two bodyguards and a Choir hold a stall against three cutpurses.',
    probes: 'Outnumber vs support — does a warder make 2v3 viable on a short arena?',
    fighters: [
      spawn('wagonram', Side.A, 3, 1, 'Stall Guard'),
      spawn('choir', Side.A, 1, 3, 'Choir'),
      spawn('reedstep', Side.B, 6, 0, 'Cutpurse'),
      spawn('mirage', Side.B, 6, 3, 'Pickpocket'),
      spawn('cindertongue', Side.B, 8, 5, 'Lookout'),
    ],
  };
}

/** 4v4 — the large fight the arena was sized for. */
function bastionBreach(): Scenario {
  resetFighterIds(1);
  return {
    id: 'bastion-breach',
    title: 'Bastion Breach',
    blurb: 'A four-wide assault on a held line — tanks, reach, arrows, and a hexer.',
    probes: 'Large-battle clutter: targeting priority, AoE value, and whether backline wards matter.',
    fighters: [
      spawn('ashplate', Side.A, 3, 0, 'Gate Ashplate'),
      spawn('dustpike', Side.A, 3, 2, 'Wall Pike'),
      spawn('bolsister', Side.A, 1, 3, 'Wall Bolt'),
      spawn('saltwise', Side.A, 0, 5, 'Keep Mender'),
      spawn('slagguard', Side.B, 6, 1, 'Breach Slag'),
      spawn('wagonram', Side.B, 6, 4, 'Breach Ram'),
      spawn('sunstring', Side.B, 8, 2, 'Breach Bow'),
      spawn('cindertongue', Side.B, 9, 5, 'Breach Hex'),
    ],
  };
}

/** 3v3 — root/weaken control focus. */
function hexAndHold(): Scenario {
  resetFighterIds(1);
  return {
    id: 'hex-and-hold',
    title: 'Hex and Hold',
    blurb: 'Control mages try to freeze a push while archers punish rooted feet.',
    probes: 'Root + ranged: is lockdown enough to let fragile DPS win without a real front line?',
    fighters: [
      spawn('cindertongue', Side.A, 2, 1),
      spawn('glasseye', Side.A, 0, 3),
      spawn('mirage', Side.A, 3, 5),
      spawn('ashplate', Side.B, 6, 1),
      spawn('wagonram', Side.B, 6, 3),
      spawn('choir', Side.B, 8, 4),
    ],
  };
}
