import { describe, expect, it } from 'vitest';
import {
  createPolymeter, createPolyrhythm, defaultGrouping, formatGrouping, lcmAll,
  parseGrouping, parseMeters, parseRatio,
  type MeterLayer, type RhythmLayer,
} from './music';

const rhythms = (values: number[]): RhythmLayer[] => values.map((divisions, i) => ({ id: `r${i}`, divisions, muted: false }));
const meters = (values: Array<[number, number, number[]?]>): MeterLayer[] => values.map(([numerator, denominator, grouping], i) => ({
  id: `m${i}`, numerator, denominator, grouping: grouping ?? defaultGrouping(numerator), muted: false,
}));

describe('polyrhythm timeline', () => {
  it.each([
    [[3, 2], 6], [[3, 4], 12], [[5, 7], 35], [[3, 4, 5], 60], [[7, 9, 11], 693],
  ])('%j uses a common subdivision grid of %i', (values, expected) => {
    const model = createPolyrhythm(rhythms(values as number[]));
    expect(model.commonTicks).toBe(expected as number);
    expect(model.cycleBeats).toBe(Math.min(...values as number[]));
    model.layers.forEach((layer) => {
      expect(layer.events).toHaveLength(layer.divisions);
      layer.events.forEach(({ beat }, index) => expect(beat / model.cycleBeats).toBeCloseTo(index / layer.divisions));
      expect(layer.events.at(-1)?.beat).toBeLessThan(model.cycleBeats);
    });
  });

  it('parses valid input and rejects invalid or oversized ratios', () => {
    expect(parseRatio(' 3 : 4 : 5 ')).toEqual([3, 4, 5]);
    expect(() => parseRatio('3:0')).toThrow(/between 1 and 32/);
    expect(() => parseRatio('3:4:5:6:7')).toThrow(/1–4/);
    expect(() => parseRatio('29:31:32')).toThrow(/1,024/);
  });

  it('calculates an exact LCM', () => {
    expect(lcmAll([3, 4, 5])).toBe(60);
  });
});

describe('polymeter timeline', () => {
  it.each([
    [[7, 8, 4, 4], 8, 7, 56],
    [[5, 8, 4, 4], 8, 5, 40],
    [[7, 8, 3, 4], 6, 7, 42],
  ])('%j realigns after %i bars of part one and %i bars of part two', (input, barsA, barsB, expectedPulses) => {
    const [a, b, c, d] = input as number[];
    const model = createPolymeter(meters([[a, b], [c, d]]));
    expect(model.cyclePulses).toBe(expectedPulses as number);
    expect(model.layers[0].barsInCycle).toBe(barsA as number);
    expect(model.layers[1].barsInCycle).toBe(barsB as number);
    expect(model.layers[0].barPulses * model.layers[0].barsInCycle).toBe(model.cyclePulses);
    expect(model.layers[1].barPulses * model.layers[1].barsInCycle).toBe(model.cyclePulses);
    expect(model.layers.every(({ events }) => events.length === expectedPulses)).toBe(true);
    expect(model.events.every(({ beat }) => beat < model.cycleBeats)).toBe(true);
  });

  it('uses a shared smallest pulse across denominators', () => {
    const model = createPolymeter(meters([[3, 4], [5, 8]]));
    expect(model.commonDenominator).toBe(8);
    expect(model.layers.map(({ barPulses }) => barPulses)).toEqual([6, 5]);
    expect(model.cyclePulses).toBe(30);
    expect(model.cycleBeats).toBe(15);
  });

  it('marks primary bars and grouped accents', () => {
    const model = createPolymeter(meters([[7, 8, [2, 2, 3]], [4, 4, [1, 1, 1, 1]]]));
    const sevenEight = model.layers[0].events.slice(0, 7).map(({ accent }) => accent);
    expect(sevenEight).toEqual(['primary', 'pulse', 'secondary', 'pulse', 'secondary', 'pulse', 'pulse']);
    expect(model.layers[1].events.slice(0, 8).map(({ accent }) => accent)).toEqual([
      'primary', 'pulse', 'secondary', 'pulse', 'secondary', 'pulse', 'secondary', 'pulse',
    ]);
  });

  it('validates meter and grouping input', () => {
    expect(parseMeters('7/8 × 4/4')).toEqual([{ numerator: 7, denominator: 8 }, { numerator: 4, denominator: 4 }]);
    expect(parseGrouping('2 + 2 + 3', 7)).toEqual([2, 2, 3]);
    expect(formatGrouping([2, 2, 3])).toBe('2 + 2 + 3');
    expect(() => parseGrouping('2 + 2 + 2', 7)).toThrow(/add up to 7/);
    expect(() => parseMeters('7/8 × 4/3')).toThrow(/denominator/);
  });
});
