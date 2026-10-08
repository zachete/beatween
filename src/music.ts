export const MAX_LAYERS = 4;
export const MAX_VALUE = 32;
export const MAX_CYCLE_UNITS = 1024;
export const DENOMINATORS = [1, 2, 4, 8, 16] as const;

export type Accent = 'event' | 'group' | 'bar';

export type RhythmLayer = {
  id: string;
  divisions: number;
  muted: boolean;
};

export type MeterLayer = {
  id: string;
  numerator: number;
  denominator: number;
  grouping: number[];
  muted: boolean;
};

export type TimelineEvent = {
  beat: number;
  layerId: string;
  layerIndex: number;
  accent: Accent;
  markerIndex: number;
};

export type PolyrhythmModel = {
  commonTicks: number;
  cycleBeats: number;
  layers: Array<RhythmLayer & { label: string; events: TimelineEvent[] }>;
  events: TimelineEvent[];
};

export type PolymeterModel = {
  commonDenominator: number;
  cyclePulses: number;
  cycleBeats: number;
  layers: Array<MeterLayer & {
    label: string;
    barPulses: number;
    barsInCycle: number;
    events: TimelineEvent[];
  }>;
  events: TimelineEvent[];
};

export function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

export function lcm(a: number, b: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) {
    throw new Error('LCM values must be positive integers.');
  }
  return (a / gcd(a, b)) * b;
}

export function lcmAll(values: number[]): number {
  if (!values.length) throw new Error('At least one value is required.');
  return values.reduce(lcm);
}

export function formatRatio(layers: RhythmLayer[]): string {
  return layers.map(({ divisions }) => divisions).join(' : ');
}

export function parseRatio(input: string): number[] {
  const value = input.trim();
  if (!/^\d+(?:\s*:\s*\d+){0,3}$/.test(value)) {
    throw new Error('Enter 1–4 positive integers separated by colons, like 5 : 7.');
  }
  const divisions = value.split(':').map((part) => Number(part.trim()));
  if (divisions.some((n) => !Number.isSafeInteger(n) || n < 1 || n > MAX_VALUE)) {
    throw new Error('Each rhythm must be between 1 and 32.');
  }
  const commonTicks = lcmAll(divisions);
  if (commonTicks > MAX_CYCLE_UNITS) {
    throw new Error(`This relationship needs ${commonTicks.toLocaleString()} common subdivisions. Keep the grid at 1,024 or fewer.`);
  }
  return divisions;
}

export function createPolyrhythm(layers: RhythmLayer[]): PolyrhythmModel {
  if (!layers.length || layers.length > MAX_LAYERS) throw new Error('Use 1–4 rhythm layers.');
  for (const { divisions } of layers) {
    if (!Number.isInteger(divisions) || divisions < 1 || divisions > MAX_VALUE) {
      throw new Error('Each rhythm must be between 1 and 32.');
    }
  }
  const commonTicks = lcmAll(layers.map(({ divisions }) => divisions));
  if (commonTicks > MAX_CYCLE_UNITS) throw new Error('The common grid cannot exceed 1,024 subdivisions.');
  // The slowest stream supplies the quarter-note BPM reference for the shared cycle.
  const referenceBeats = Math.min(...layers.map(({ divisions }) => divisions));
  const builtLayers = layers.map((layer, layerIndex) => {
    const events = Array.from({ length: layer.divisions }, (_, markerIndex) => ({
      beat: (markerIndex / layer.divisions) * referenceBeats,
      layerId: layer.id,
      layerIndex,
      accent: 'event' as Accent,
      markerIndex,
    }));
    return { ...layer, label: String(layer.divisions), events };
  });
  return {
    commonTicks,
    cycleBeats: referenceBeats,
    layers: builtLayers,
    events: builtLayers.flatMap(({ events }) => events).sort((a, b) => a.beat - b.beat || a.layerIndex - b.layerIndex),
  };
}

export function defaultGrouping(numerator: number): number[] {
  const familiar: Record<number, number[]> = {
    5: [3, 2], 6: [3, 3], 7: [2, 2, 3], 8: [2, 2, 2, 2],
    9: [3, 3, 3], 10: [3, 3, 2, 2], 11: [3, 3, 3, 2], 12: [3, 3, 3, 3],
  };
  return [...(familiar[numerator] ?? Array.from({ length: numerator }, () => 1))];
}

export function parseGrouping(input: string, numerator: number): number[] {
  const parts = input.trim().split(/\s*\+\s*/);
  if (!input.trim() || parts.some((part) => !/^\d+$/.test(part))) {
    throw new Error('Use positive group sizes separated by +, like 2 + 2 + 3.');
  }
  const grouping = parts.map(Number);
  if (grouping.some((n) => !Number.isSafeInteger(n) || n < 1) || grouping.reduce((sum, n) => sum + n, 0) !== numerator) {
    throw new Error(`Groups must add up to ${numerator}.`);
  }
  return grouping;
}

export function formatGrouping(grouping: number[]): string {
  return grouping.join(' + ');
}

export function formatMeters(layers: MeterLayer[]): string {
  return layers.map(({ numerator, denominator }) => `${numerator}/${denominator}`).join(' × ');
}

export function parseMeters(input: string): Array<{ numerator: number; denominator: number }> {
  const parts = input.trim().split(/\s*(?:×|x|X|\*)\s*/);
  if (parts.length < 2 || parts.length > MAX_LAYERS || parts.some((part) => !/^\d+\s*\/\s*\d+$/.test(part))) {
    throw new Error('Enter 2–4 meters, like 7/8 × 4/4.');
  }
  return parts.map((part) => {
    const [n, d] = part.split('/').map((value) => Number(value.trim()));
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_VALUE) throw new Error('Meter numerators must be between 1 and 32.');
    if (!(DENOMINATORS as readonly number[]).includes(d)) throw new Error('Use a denominator of 1, 2, 4, 8, or 16.');
    return { numerator: n, denominator: d };
  });
}

export function createPolymeter(layers: MeterLayer[]): PolymeterModel {
  if (layers.length < 2 || layers.length > MAX_LAYERS) throw new Error('Use 2–4 meter parts.');
  for (const layer of layers) {
    if (!Number.isInteger(layer.numerator) || layer.numerator < 1 || layer.numerator > MAX_VALUE) {
      throw new Error('Meter numerators must be between 1 and 32.');
    }
    if (!(DENOMINATORS as readonly number[]).includes(layer.denominator)) {
      throw new Error('Use a denominator of 1, 2, 4, 8, or 16.');
    }
    if (layer.grouping.reduce((sum, group) => sum + group, 0) !== layer.numerator || layer.grouping.some((group) => !Number.isInteger(group) || group < 1)) {
      throw new Error(`The grouping for ${layer.numerator}/${layer.denominator} must add up to ${layer.numerator}.`);
    }
  }
  const commonDenominator = Math.max(...layers.map(({ denominator }) => denominator));
  const bars = layers.map(({ numerator, denominator }) => numerator * (commonDenominator / denominator));
  const cyclePulses = lcmAll(bars);
  if (cyclePulses > MAX_CYCLE_UNITS) throw new Error('The common cycle cannot exceed 1,024 shared pulses.');
  const cycleBeats = cyclePulses * (4 / commonDenominator);
  const builtLayers = layers.map((layer, layerIndex) => {
    const scale = commonDenominator / layer.denominator;
    const barPulses = layer.numerator * scale;
    const groupStarts = new Set<number>();
    let cumulative = 0;
    for (const group of layer.grouping.slice(0, -1)) {
      cumulative += group * scale;
      groupStarts.add(cumulative);
    }
    const events: TimelineEvent[] = Array.from({ length: cyclePulses }, (_, markerIndex) => {
      const inBar = markerIndex % barPulses;
      return {
        beat: markerIndex * (4 / commonDenominator),
        layerId: layer.id,
        layerIndex,
        accent: inBar === 0 ? 'bar' : groupStarts.has(inBar) ? 'group' : 'event',
        markerIndex,
      };
    });
    return { ...layer, label: `${layer.numerator}/${layer.denominator}`, barPulses, barsInCycle: cyclePulses / barPulses, events };
  });
  return {
    commonDenominator,
    cyclePulses,
    cycleBeats,
    layers: builtLayers,
    events: builtLayers.flatMap(({ events }) => events).sort((a, b) => a.beat - b.beat || a.layerIndex - b.layerIndex),
  };
}
