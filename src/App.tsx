import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, CSSProperties } from 'react';
import { AudioEngine, type SoundPalette } from './audio';
import {
  createPolymeter, createPolyrhythm, defaultGrouping, formatGrouping, formatMeters,
  formatRatio, parseGrouping, parseMeters, parseRatio,
  type MeterLayer, type PolymeterModel, type PolyrhythmModel, type RhythmLayer,
} from './music';

type Mode = 'explore' | 'meter';

const COLORS = ['#a9f4cb', '#87b9ff', '#ffc978', '#e9a8ff'];
const CENTER = 300;

function makeId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

function polar(radius: number, phase: number) {
  const angle = (phase * Math.PI * 2) - Math.PI / 2;
  return { x: CENTER + Math.cos(angle) * radius, y: CENTER + Math.sin(angle) * radius };
}

function eventMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

function PolyrhythmPresets({ onChoose }: { onChoose: (values: number[]) => void }) {
  return <div className="preset-row" aria-label="Polyrhythm presets">
    <span className="micro-label">START WITH</span>
    {[[3, 2], [3, 4], [5, 7], [7, 9, 11]].map((values) => <button key={values.join(':')} className="preset-button" onClick={() => onChoose(values)}>
      {values.join(' : ')}
    </button>)}
  </div>;
}

function PolymeterPresets({ onChoose }: { onChoose: (values: Array<[number, number]>) => void }) {
  return <div className="preset-row" aria-label="Polymeter presets">
    <span className="micro-label">START WITH</span>
    {[[[7, 8], [4, 4]], [[5, 8], [4, 4]], [[7, 8], [3, 4]]].map((values) => <button key={values.map(([n, d]) => `${n}/${d}`).join('x')} className="preset-button" onClick={() => onChoose(values as Array<[number, number]>)}>
      {values.map(([n, d]) => `${n}/${d}`).join(' × ')}
    </button>)}
  </div>;
}

function Orbit({
  layer, layerIndex, radius, selected, mode, model, onSelect, markerRef,
}: {
  layer: PolyrhythmModel['layers'][number] | PolymeterModel['layers'][number];
  layerIndex: number;
  radius: number;
  selected: boolean;
  mode: Mode;
  model: PolyrhythmModel | PolymeterModel;
  onSelect: () => void;
  markerRef: (element: SVGGElement | null) => void;
}) {
  const isMeter = mode === 'meter';
  const count = isMeter ? (model as PolymeterModel).cyclePulses : (layer as PolyrhythmModel['layers'][number]).divisions;
  const markers = isMeter
    ? (layer as PolymeterModel['layers'][number]).events
    : (layer as PolyrhythmModel['layers'][number]).events;
  const color = COLORS[layerIndex % COLORS.length];
  const meterLayer = isMeter ? layer as PolymeterModel['layers'][number] : null;
  const layerTitle = isMeter
    ? `${layer.label}, ${(layer as PolymeterModel['layers'][number]).barsInCycle} bars over the common cycle`
    : `Rhythm ${layer.label}, ${(layer as PolyrhythmModel['layers'][number]).divisions} events over one common cycle`;
  const keyActivate = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };

  return <g
    ref={markerRef}
    className={`orbit-layer${selected ? ' is-selected' : ''}`}
    style={{ '--layer-color': color } as CSSProperties}
    role="button"
    tabIndex={0}
    aria-label={`${layerTitle}. Select this layer.`}
    aria-pressed={selected}
    onClick={onSelect}
    onKeyDown={keyActivate}
  >
    <circle className="orbit-track" cx={CENTER} cy={CENTER} r={radius} />
    {meterLayer && markers.map((event) => {
      const phase = event.markerIndex / count;
      const point = polar(radius, phase);
      const boundary = event.accent === 'bar';
      const groupBoundary = event.accent === 'group';
      const inner = polar(radius - (boundary ? 10 : groupBoundary ? 7 : 3), phase);
      const outer = polar(radius + (boundary ? 11 : groupBoundary ? 8 : 3), phase);
      return <g key={event.markerIndex} className="meter-pulse" data-marker-index={event.markerIndex}>
        <line x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} className={boundary ? 'bar-mark' : groupBoundary ? 'group-mark' : 'pulse-mark'} />
        <circle cx={point.x} cy={point.y} r={boundary ? (selected ? 6.5 : 5.8) : groupBoundary ? 4.3 : 2.1} className={`rhythm-marker ${boundary ? 'primary-marker' : groupBoundary ? 'secondary-marker' : ''}`} data-marker-index={event.markerIndex} aria-hidden="true" />
      </g>;
    })}
    {!meterLayer && markers.map((event) => {
      const phase = event.markerIndex / count;
      const point = polar(radius, phase);
      return <circle
        key={event.markerIndex}
        cx={point.x}
        cy={point.y}
        r={event.markerIndex === 0 ? (selected ? 8 : 7) : (selected ? 5.5 : 4.6)}
        className={`rhythm-marker${event.markerIndex === 0 ? ' primary-marker' : ''}`}
        data-marker-index={event.markerIndex}
        aria-hidden="true"
      />;
    })}
  </g>;
}

function RhythmVisualization({
  mode, model, selectedId, onSelect, playing, bpm, engine,
}: {
  mode: Mode;
  model: PolyrhythmModel | PolymeterModel;
  selectedId: string;
  onSelect: (id: string) => void;
  playing: boolean;
  bpm: number;
  engine: AudioEngine;
}) {
  const playhead = useRef<SVGGElement>(null);
  const layerGroups = useRef(new Map<string, SVGGElement>());
  const [subdivisionVisible, setSubdivisionVisible] = useState(true);
  const gridCount = mode === 'meter' ? (model as PolymeterModel).cyclePulses : (model as PolyrhythmModel).commonTicks;
  const radii = model.layers.map((_, i) => model.layers.length === 1 ? 178 : 136 + i * (78 / (model.layers.length - 1)));
  const outerRadius = Math.max(...radii);
  const cycleBeats = model.cycleBeats;

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const beat = engine.currentBeat;
      let progress = ((beat % cycleBeats) + cycleBeats) % cycleBeats / cycleBeats;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const steps = Math.min(gridCount, 64);
        progress = Math.floor(progress * steps) / steps;
      }
      playhead.current?.setAttribute('transform', `rotate(${progress * 360} ${CENTER} ${CENTER})`);
      if (engine.isPlaying) {
        for (const [id, group] of layerGroups.current) {
          const layer = model.layers.find((item) => item.id === id);
          if (!layer) continue;
          const count = mode === 'meter' ? (model as PolymeterModel).cyclePulses : (layer as PolyrhythmModel['layers'][number]).divisions;
          const markerIndex = Math.round(progress * count) % count;
          const markerPhase = markerIndex / count;
          const delta = Math.min(Math.abs(progress - markerPhase), 1 - Math.abs(progress - markerPhase));
          const previous = group.querySelector('.is-active');
          previous?.classList.remove('is-active');
          if (delta * cycleBeats <= bpm / 60 * 0.075) {
            group.querySelector(`[data-marker-index="${markerIndex}"]`)?.classList.add('is-active');
          }
        }
      } else {
        layerGroups.current.forEach((group) => group.querySelector('.is-active')?.classList.remove('is-active'));
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [bpm, cycleBeats, gridCount, mode, model]);

  const setMarkerGroup = (id: string, element: SVGGElement | null) => {
    if (element) layerGroups.current.set(id, element);
    else layerGroups.current.delete(id);
  };

  const description = mode === 'meter'
    ? `Polymeter ${model.layers.map(({ label }) => label).join(' by ')}. Shared ${4 / (model as PolymeterModel).commonDenominator === 0.5 ? 'eighth' : `1/${(model as PolymeterModel).commonDenominator}`} note pulse. The bar boundaries realign after ${(model as PolymeterModel).cyclePulses} shared pulses.`
    : `Polyrhythm ${model.layers.map(({ label }) => label).join(' to ')}. ${model.layers.map(({ label }) => `${label} events`).join(' and ')} share one common cycle.`;

  return <section className="visual-stage" aria-label="Rhythm visualization">
    <div className="stage-heading">
      <div>
        <span className="eyebrow">{mode === 'meter' ? 'TIME SIGNATURES' : 'HITS PER SHARED CYCLE'}</span>
        <div className="ratio-readout" aria-hidden="true">{model.layers.map(({ label }, index) => <span key={index} style={{ color: COLORS[index % COLORS.length] }}>{index > 0 && <i className="ratio-separator">{mode === 'meter' ? '×' : ':'}</i>}{label}</span>)}</div>
      </div>
      {playing && <span className="cycle-badge"><span className="status-dot is-live" />PLAYING</span>}
    </div>

    <svg className="rhythm-visual" viewBox="0 0 600 600" role="group" aria-label={description}>
      <circle className="cycle-boundary" cx={CENTER} cy={CENTER} r={outerRadius + 27} />
      {subdivisionVisible && Array.from({ length: gridCount }, (_, index) => {
        const phase = index / gridCount;
        const inner = polar(outerRadius + 22, phase);
        const outer = polar(outerRadius + (index % Math.max(1, Math.round(gridCount / 24)) === 0 ? 30 : 26), phase);
        return <line key={index} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} className={index % Math.max(1, Math.round(gridCount / 24)) === 0 ? 'grid-tick major' : 'grid-tick'} aria-hidden="true" />;
      })}
      {model.layers.map((layer, index) => <Orbit
        key={layer.id}
        layer={layer}
        layerIndex={index}
        radius={radii[index]}
        selected={selectedId === layer.id}
        mode={mode}
        model={model}
        onSelect={() => onSelect(layer.id)}
        markerRef={(element) => setMarkerGroup(layer.id, element)}
      />)}
      <g ref={playhead} className="playhead" aria-hidden="true">
        <line x1={CENTER} y1={CENTER - outerRadius - 25} x2={CENTER} y2={CENTER} />
        <circle cx={CENTER} cy={CENTER - outerRadius - 25} r="4.5" />
      </g>
      <circle className="hub-outer" cx={CENTER} cy={CENTER} r="39" />
      <circle className="hub-inner" cx={CENTER} cy={CENTER} r="31" />
      <circle className="hub-center" cx={CENTER} cy={CENTER} r="3" />
    </svg>

    <div className="stage-footer">
      <div className="cycle-legend">
        <span><i className="legend-line" />CYCLE START</span>
        <span><i className="legend-dot" />{mode === 'meter' ? 'BAR / GROUP ACCENT' : 'RHYTHM EVENT'}</span>
      </div>
      <button className={`grid-toggle${subdivisionVisible ? ' is-on' : ''}`} aria-pressed={subdivisionVisible} onClick={() => setSubdivisionVisible((value) => !value)}>
        <span className="micro-label">SUBDIVISION</span><span>{subdivisionVisible ? 'ON' : 'OFF'} <i aria-hidden="true">◌</i></span>
      </button>
    </div>
  </section>;
}

export default function App() {
  const [mode, setMode] = useState<Mode>('explore');
  const [rhythms, setRhythms] = useState<RhythmLayer[]>([
    { id: 'rhythm-a', divisions: 5, muted: false },
    { id: 'rhythm-b', divisions: 7, muted: false },
  ]);
  const [meters, setMeters] = useState<MeterLayer[]>([
    { id: 'meter-a', numerator: 7, denominator: 8, grouping: [2, 2, 3], muted: false },
    { id: 'meter-b', numerator: 4, denominator: 4, grouping: [1, 1, 1, 1], muted: false },
  ]);
  const [ratioDraft, setRatioDraft] = useState('5 : 7');
  const [meterDraft, setMeterDraft] = useState('7/8 × 4/4');
  const [groupDrafts, setGroupDrafts] = useState<Record<string, string>>({ 'meter-a': '2 + 2 + 3', 'meter-b': '1 + 1 + 1 + 1' });
  const [ratioError, setRatioError] = useState('');
  const [meterError, setMeterError] = useState('');
  const [groupErrors, setGroupErrors] = useState<Record<string, string>>({});
  const [bpm, setBpm] = useState(120);
  const [volume, setVolume] = useState(0.55);
  const [masterAudio, setMasterAudio] = useState(true);
  const [palette, setPalette] = useState<SoundPalette>('studio');
  const [velocity, setVelocity] = useState(0.8);
  const [gridSound, setGridSound] = useState(false);
  const [alignmentSound, setAlignmentSound] = useState(false);
  const [ghostSound, setGhostSound] = useState(true);
  const [soloId, setSoloId] = useState<string | null>(null);
  const [layerAudio, setLayerAudio] = useState<Record<string, { volume: number; pan: number }>>({});
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState('rhythm-a');
  const [audioError, setAudioError] = useState('');
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const rhythmShape = rhythms.map(({ id, divisions }) => `${id}:${divisions}`).join('|');
  const meterShape = meters.map(({ id, numerator, denominator, grouping }) => `${id}:${numerator}/${denominator}:${grouping.join('+')}`).join('|');
  const polyrhythm = useMemo(() => createPolyrhythm(rhythms.map((layer) => ({ ...layer, muted: false }))), [rhythmShape]);
  const polymeter = useMemo(() => createPolymeter(meters.map((layer) => ({ ...layer, muted: false }))), [meterShape]);
  const model = mode === 'explore' ? polyrhythm : polymeter;
  const activeLayers = mode === 'explore' ? rhythms : meters;
  const selectedLayer = activeLayers.find(({ id }) => id === selectedId) ?? activeLayers[0];

  useEffect(() => {
    const gridCells = mode === 'meter' ? (model as PolymeterModel).cyclePulses : (model as PolyrhythmModel).commonTicks;
    engine.setTimeline(model.events, model.cycleBeats, gridCells);
    setPlaying(engine.isPlaying);
  }, [engine, model, mode]);

  useEffect(() => {
    engine.setBpm(bpm);
  }, [bpm, engine]);

  useEffect(() => {
    engine.setVolume(volume);
    engine.setMasterEnabled(masterAudio);
    engine.setPalette(palette);
    engine.setVelocity(velocity);
    engine.setGridEnabled(gridSound);
    engine.setAlignmentEnabled(alignmentSound);
    engine.setGhostEnabled(ghostSound);
    engine.setSolo(soloId);
    for (const layer of [...rhythms, ...meters]) engine.setMuted(layer.id, layer.muted);
    for (const layer of activeLayers) {
      engine.setLayerVolume(layer.id, layerAudio[layer.id]?.volume ?? 1);
      engine.setLayerPan(layer.id, layerAudio[layer.id]?.pan ?? 0);
    }
  }, [activeLayers, alignmentSound, engine, ghostSound, gridSound, layerAudio, masterAudio, meters, palette, rhythms, soloId, velocity, volume]);

  useEffect(() => () => engine.destroy(), [engine]);

  useEffect(() => {
    if (!activeLayers.some(({ id }) => id === selectedId)) setSelectedId(activeLayers[0]?.id ?? '');
  }, [activeLayers, selectedId]);

  useEffect(() => {
    if (soloId && !activeLayers.some(({ id }) => id === soloId)) setSoloId(null);
  }, [activeLayers, soloId]);

  const applyRhythms = (values: number[]) => {
    const next = values.map((divisions, index) => ({
      id: rhythms[index]?.id ?? makeId('rhythm'),
      divisions,
      muted: rhythms[index]?.muted ?? false,
    }));
    createPolyrhythm(next);
    setRhythms(next);
    setRatioDraft(formatRatio(next));
    setRatioError('');
    if (!next.some(({ id }) => id === selectedId)) setSelectedId(next[0].id);
  };

  const editRatio = (value: string) => {
    setRatioDraft(value);
    try {
      const values = parseRatio(value);
      const next = values.map((divisions, index) => ({
        id: rhythms[index]?.id ?? makeId('rhythm'),
        divisions,
        muted: rhythms[index]?.muted ?? false,
      }));
      createPolyrhythm(next);
      setRhythms(next);
      setRatioError('');
      if (!next.some(({ id }) => id === selectedId)) setSelectedId(next[0].id);
    } catch (error) {
      setRatioError(eventMessage(error));
    }
  };

  const changeRhythm = (id: string, change: Partial<RhythmLayer>) => {
    const next = rhythms.map((layer) => layer.id === id ? { ...layer, ...change } : layer);
    try {
      createPolyrhythm(next);
      setRhythms(next);
      setRatioDraft(formatRatio(next));
      setRatioError('');
    } catch (error) {
      setRatioError(eventMessage(error));
    }
  };

  const chooseMeterValues = (values: Array<[number, number]>) => {
    const next = values.map(([numerator, denominator], index) => ({
      id: meters[index]?.id ?? makeId('meter'),
      numerator,
      denominator,
      grouping: meters[index]?.numerator === numerator && meters[index]?.grouping.reduce((sum, n) => sum + n, 0) === numerator
        ? meters[index].grouping
        : defaultGrouping(numerator),
      muted: meters[index]?.muted ?? false,
    }));
    createPolymeter(next);
    setMeters(next);
    setMeterDraft(formatMeters(next));
    setGroupDrafts(Object.fromEntries(next.map(({ id, grouping }) => [id, formatGrouping(grouping)])));
    setMeterError('');
    setGroupErrors({});
    if (!next.some(({ id }) => id === selectedId)) setSelectedId(next[0].id);
  };

  const editMeterText = (value: string) => {
    setMeterDraft(value);
    try {
      const values = parseMeters(value);
      const next = values.map(({ numerator, denominator }, index) => ({
        id: meters[index]?.id ?? makeId('meter'),
        numerator,
        denominator,
        grouping: meters[index]?.numerator === numerator && meters[index]?.grouping.reduce((sum, n) => sum + n, 0) === numerator
          ? meters[index].grouping
          : defaultGrouping(numerator),
        muted: meters[index]?.muted ?? false,
      }));
      createPolymeter(next);
      setMeters(next);
      setGroupDrafts(Object.fromEntries(next.map(({ id, grouping }) => [id, formatGrouping(grouping)])));
      setMeterError('');
      setGroupErrors({});
      if (!next.some(({ id }) => id === selectedId)) setSelectedId(next[0].id);
    } catch (error) {
      setMeterError(eventMessage(error));
    }
  };

  const changeMeter = (id: string, patch: Partial<MeterLayer>) => {
    const next = meters.map((layer) => {
      if (layer.id !== id) return layer;
      const updated = { ...layer, ...patch };
      if (patch.numerator !== undefined && updated.grouping.reduce((sum, n) => sum + n, 0) !== updated.numerator) {
        updated.grouping = defaultGrouping(updated.numerator);
      }
      return updated;
    });
    try {
      createPolymeter(next);
      setMeters(next);
      setMeterDraft(formatMeters(next));
      setGroupDrafts(Object.fromEntries(next.map(({ id: layerId, grouping }) => [layerId, formatGrouping(grouping)])));
      setMeterError('');
    } catch (error) {
      setMeterError(eventMessage(error));
    }
  };

  const editGrouping = (layer: MeterLayer, value: string) => {
    setGroupDrafts((drafts) => ({ ...drafts, [layer.id]: value }));
    try {
      const grouping = parseGrouping(value, layer.numerator);
      const next = meters.map((part) => part.id === layer.id ? { ...part, grouping } : part);
      createPolymeter(next);
      setMeters(next);
      setGroupErrors((errors) => ({ ...errors, [layer.id]: '' }));
    } catch (error) {
      setGroupErrors((errors) => ({ ...errors, [layer.id]: eventMessage(error) }));
    }
  };

  const addMeter = () => {
    if (meters.length >= 4) return;
    const layer: MeterLayer = { id: makeId('meter'), numerator: 3, denominator: 4, grouping: [1, 1, 1], muted: false };
    const next = [...meters, layer];
    try {
      createPolymeter(next);
      setMeters(next);
      setMeterDraft(formatMeters(next));
      setGroupDrafts((drafts) => ({ ...drafts, [layer.id]: formatGrouping(layer.grouping) }));
      setSelectedId(layer.id);
    } catch (error) { setMeterError(eventMessage(error)); }
  };

  const removeMeter = (id: string) => {
    if (meters.length <= 2) return;
    const next = meters.filter((layer) => layer.id !== id);
    setMeters(next);
    setMeterDraft(formatMeters(next));
    setGroupDrafts((drafts) => Object.fromEntries(Object.entries(drafts).filter(([key]) => key !== id)));
    if (selectedId === id) setSelectedId(next[0].id);
  };

  const play = async () => {
    setAudioError('');
    try {
      await engine.play();
      setPlaying(true);
    } catch (error) { setAudioError(eventMessage(error)); }
  };

  const cycleSeconds = model.cycleBeats * 60 / bpm;
  const cycleDescription = mode === 'meter'
    ? `${(model as PolymeterModel).cyclePulses} shared ${(model as PolymeterModel).commonDenominator === 8 ? 'eighth' : `1/${(model as PolymeterModel).commonDenominator}`} notes · ${model.layers.map((layer) => `${(layer as PolymeterModel['layers'][number]).barsInCycle} bars`).join(' / ')}`
    : `${model.cycleBeats} quarter notes · ${ (model as PolyrhythmModel).commonTicks } shared subdivisions`;

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="#top" aria-label="Beatween home">
        <svg viewBox="0 0 34 34" className="brand-mark" aria-hidden="true"><circle cx="17" cy="17" r="12" /><circle cx="17" cy="17" r="7" /><path d="M17 3v14l10 10" /></svg>
        <span><strong>BEATWEEN</strong></span>
      </a>
      <div className="topbar-right">
        <span className="instrument-label"><span className="status-dot" />VISUAL INSTRUMENT</span>
        <div className="mode-switch" role="group" aria-label="Rhythm mode">
          <button className={mode === 'explore' ? 'active' : ''} aria-pressed={mode === 'explore'} onClick={() => setMode('explore')}>POLYRHYTHM</button>
          <button className={mode === 'meter' ? 'active' : ''} aria-pressed={mode === 'meter'} onClick={() => setMode('meter')}>POLYMETER</button>
        </div>
      </div>
    </header>

    <main id="top">
      <div className="instrument-layout">
        <div className="instrument-intro">
          <div className="intro-copy">
            <h1>{mode === 'explore' ? 'Build a polyrhythm' : 'Build a polymeter'}</h1>
            <p>{mode === 'explore' ? 'Set the number of hits in each part, then play them together.' : 'Choose time signatures and hear how their bars line up.'}</p>
          </div>
          <div className="cycle-readout"><span className="micro-label">CYCLE LENGTH</span><strong>{cycleSeconds.toFixed(cycleSeconds < 10 ? 2 : 1)}<small> sec</small></strong><span>{cycleDescription}</span></div>
        </div>

        <RhythmVisualization
          mode={mode}
          model={model}
          selectedId={selectedLayer.id}
          onSelect={setSelectedId}
          playing={playing}
          bpm={bpm}
          engine={engine}
        />

        <section className="transport" aria-label="Transport and tempo">
          <div className="transport-actions">
            <button className="play-button" onClick={playing ? () => { engine.pause(); setPlaying(false); } : play} aria-label={playing ? 'Pause rhythm' : 'Play rhythm'}>
              <span aria-hidden="true">{playing ? 'Ⅱ' : '▶'}</span>{playing ? 'PAUSE' : 'PLAY'}
            </button>
            <button className="stop-button" onClick={() => { engine.stop(); setPlaying(false); }} aria-label="Stop and return to cycle start" title="Stop">
              <span aria-hidden="true" />
            </button>
          </div>
          <div className="tempo-control">
            <label htmlFor="bpm-slider"><span className="micro-label">TEMPO</span><strong>{bpm}<small> BPM</small></strong></label>
            <input id="bpm-slider" type="range" min="40" max="240" step="1" value={bpm} onChange={(event) => setBpm(Number(event.target.value))} style={{ '--range-progress': `${((bpm - 40) / 200) * 100}%` } as CSSProperties} />
            <div className="range-labels"><span>40</span><span>240</span></div>
          </div>
          <div className="volume-control">
            <button className={`audio-toggle${masterAudio ? ' enabled' : ''}`} onClick={() => setMasterAudio((value) => !value)} aria-pressed={masterAudio} aria-label={masterAudio ? 'Turn master audio off' : 'Turn master audio on'} title={masterAudio ? 'Audio on' : 'Audio off'}>
              <span aria-hidden="true">{masterAudio ? '◖))' : '◖×'}</span>
            </button>
            <label htmlFor="volume-slider" className="micro-label">VOLUME</label>
            <input id="volume-slider" aria-label="Master volume" type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => setVolume(Number(event.target.value))} style={{ '--range-progress': `${volume * 100}%` } as CSSProperties} />
          </div>
        </section>
        <details className="audio-design" open>
          <summary><span className="eyebrow">SOUND DESIGN</span><span className="audio-design-hint">VOICES · ACCENTS · SPACE</span></summary>
          <div className="audio-options">
            <label className="audio-option"><span className="micro-label">PALETTE</span><select value={palette} onChange={(event) => setPalette(event.target.value as SoundPalette)}>
              <option value="studio">Studio</option><option value="soft">Soft</option><option value="bright">Bright</option>
            </select></label>
            <label className="audio-option velocity-option"><span className="micro-label">ACCENT STRENGTH</span><input type="range" min="0.4" max="1.4" step="0.01" value={velocity} onChange={(event) => setVelocity(Number(event.target.value))} style={{ '--range-progress': `${((velocity - 0.4) / 1) * 100}%` } as CSSProperties} /></label>
            <label className="audio-check"><input type="checkbox" checked={gridSound} onChange={(event) => setGridSound(event.target.checked)} />GRID SOUND</label>
            <label className="audio-check"><input type="checkbox" checked={alignmentSound} onChange={(event) => setAlignmentSound(event.target.checked)} />ALIGNMENT CUE</label>
            <label className="audio-check"><input type="checkbox" checked={ghostSound} onChange={(event) => setGhostSound(event.target.checked)} />GHOST OTHER LAYERS</label>
          </div>
          <div className="audio-layer-list">
            {activeLayers.map((layer, index) => <div className="audio-layer" key={layer.id}>
              <span className="audio-layer-name"><i className="layer-color" style={{ backgroundColor: COLORS[index % COLORS.length] }} />{mode === 'explore' ? `RHYTHM ${index + 1}` : `PART ${index + 1}`}</span>
              <button className={`solo-button${soloId === layer.id ? ' active' : ''}`} aria-pressed={soloId === layer.id} onClick={() => setSoloId((current) => current === layer.id ? null : layer.id)}>SOLO</button>
              <label><span className="micro-label">LEVEL</span><input aria-label={`${mode === 'explore' ? 'Rhythm' : 'Part'} ${index + 1} volume`} type="range" min="0" max="1" step="0.01" value={layerAudio[layer.id]?.volume ?? 1} onChange={(event) => setLayerAudio((current) => ({ ...current, [layer.id]: { volume: Number(event.target.value), pan: current[layer.id]?.pan ?? 0 } }))} style={{ '--range-progress': `${(layerAudio[layer.id]?.volume ?? 1) * 100}%` } as CSSProperties} /></label>
              <label><span className="micro-label">PAN</span><input aria-label={`${mode === 'explore' ? 'Rhythm' : 'Part'} ${index + 1} stereo position`} type="range" min="-1" max="1" step="0.01" value={layerAudio[layer.id]?.pan ?? 0} onChange={(event) => setLayerAudio((current) => ({ ...current, [layer.id]: { volume: current[layer.id]?.volume ?? 1, pan: Number(event.target.value) } }))} style={{ '--range-progress': `${((layerAudio[layer.id]?.pan ?? 0) + 1) * 50}%` } as CSSProperties} /></label>
            </div>)}
          </div>
        </details>
        {audioError && <p className="error-message" role="alert">{audioError}</p>}

        <section className="control-deck" aria-label={mode === 'explore' ? 'Polyrhythm controls' : 'Polymeter controls'}>
          <div className="relationship-controls">
            <div className="control-heading">
              <div><span className="eyebrow">{mode === 'explore' ? 'BUILD A RELATIONSHIP' : 'BUILD A POLYMETER'}</span><h2>{mode === 'explore' ? 'Rhythm ratio' : 'Meter relationship'}</h2></div>
            </div>
            {mode === 'explore' ? <>
              <label className="input-with-prefix" htmlFor="ratio-input"><span aria-hidden="true">{rhythms.length > 2 ? 'n:' : 'a:b'}</span><input id="ratio-input" value={ratioDraft} onChange={(event) => editRatio(event.target.value)} aria-describedby={ratioError ? 'ratio-error' : undefined} aria-invalid={!!ratioError} spellCheck={false} autoComplete="off" /></label>
              {ratioError && <p className="error-message" id="ratio-error" role="alert">{ratioError}</p>}
              <PolyrhythmPresets onChoose={applyRhythms} />
              <div className="layer-list">
                {rhythms.map((layer, index) => <div key={layer.id} className={`layer-control${selectedId === layer.id ? ' focused-layer' : ''}`}>
                  <button className="layer-select" onClick={() => setSelectedId(layer.id)} aria-pressed={selectedId === layer.id}>
                    <i className="layer-color" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
                    <span>RHYTHM {index + 1}</span><strong>{layer.divisions}</strong>
                  </button>
                  <div className="stepper" aria-label={`Rhythm ${index + 1} divisions`}>
                    <button aria-label={`Decrease rhythm ${index + 1}`} disabled={layer.divisions <= 1} onClick={() => changeRhythm(layer.id, { divisions: layer.divisions - 1 })}>−</button>
                    <button aria-label={`Increase rhythm ${index + 1}`} disabled={layer.divisions >= 32} onClick={() => changeRhythm(layer.id, { divisions: layer.divisions + 1 })}>+</button>
                  </div>
                  <button className={`mute-button${layer.muted ? ' muted' : ''}`} onClick={() => changeRhythm(layer.id, { muted: !layer.muted })} aria-pressed={!layer.muted} aria-label={`${layer.muted ? 'Enable' : 'Mute'} rhythm ${index + 1}`}>
                    <span aria-hidden="true">{layer.muted ? '×' : '●'}</span>{layer.muted ? 'MUTED' : 'SOUND'}
                  </button>
                  {rhythms.length > 1 && <button className="remove-layer" aria-label={`Remove rhythm ${index + 1}`} onClick={() => applyRhythms(rhythms.filter(({ id }) => id !== layer.id).map(({ divisions }) => divisions))}>×</button>}
                </div>)}
              </div>
              {rhythms.length < 4 && <button className="add-layer" onClick={() => applyRhythms([...rhythms.map(({ divisions }) => divisions), 3])}>＋ ADD RHYTHM</button>}
            </> : <>
              <label className="input-with-prefix meter-input" htmlFor="meter-input"><span aria-hidden="true">n/d</span><input id="meter-input" value={meterDraft} onChange={(event) => editMeterText(event.target.value)} aria-describedby={meterError ? 'meter-error' : undefined} aria-invalid={!!meterError} spellCheck={false} autoComplete="off" /></label>
              {meterError && <p className="error-message" id="meter-error" role="alert">{meterError}</p>}
              <PolymeterPresets onChoose={chooseMeterValues} />
              <div className="meter-parts">
                {meters.map((part, index) => <div key={part.id} className={`meter-part${selectedId === part.id ? ' focused-layer' : ''}`}>
                  <div className="meter-part-heading">
                    <button className="layer-select" onClick={() => setSelectedId(part.id)} aria-pressed={selectedId === part.id}>
                      <i className="layer-color" style={{ backgroundColor: COLORS[index % COLORS.length] }} /><span>PART {index + 1}</span>
                    </button>
                    <button className={`mute-button${part.muted ? ' muted' : ''}`} onClick={() => changeMeter(part.id, { muted: !part.muted })} aria-pressed={!part.muted} aria-label={`${part.muted ? 'Enable' : 'Mute'} part ${index + 1}`}>
                      <span aria-hidden="true">{part.muted ? '×' : '●'}</span>{part.muted ? 'MUTED' : 'SOUND'}
                    </button>
                    {meters.length > 2 && <button className="remove-layer" aria-label={`Remove part ${index + 1}`} onClick={() => removeMeter(part.id)}>×</button>}
                  </div>
                  <div className="meter-values">
                    <label><span className="micro-label">NUMERATOR</span><input type="number" min="1" max="32" value={part.numerator} onChange={(event) => changeMeter(part.id, { numerator: Math.max(1, Math.min(32, Number(event.target.value) || 1)) })} aria-label={`Part ${index + 1} numerator`} /></label>
                    <span className="meter-slash">/</span>
                    <label><span className="micro-label">DENOMINATOR</span><select value={part.denominator} onChange={(event) => changeMeter(part.id, { denominator: Number(event.target.value) })} aria-label={`Part ${index + 1} denominator`}>
                      {[1, 2, 4, 8, 16].map((denominator) => <option value={denominator} key={denominator}>{denominator}</option>)}
                    </select></label>
                  </div>
                  <label className="grouping-control"><span className="micro-label">GROUPING</span><input value={groupDrafts[part.id] ?? formatGrouping(part.grouping)} onChange={(event) => editGrouping(part, event.target.value)} aria-label={`Part ${index + 1} beat grouping`} aria-invalid={!!groupErrors[part.id]} aria-describedby={groupErrors[part.id] ? `group-error-${part.id}` : undefined} />{groupErrors[part.id] && <span className="group-error" id={`group-error-${part.id}`} role="alert">{groupErrors[part.id]}</span>}</label>
                </div>)}
              </div>
              {meters.length < 4 && <button className="add-layer" onClick={addMeter}>＋ ADD PART</button>}
            </>}
          </div>

          <aside className="layer-summary" aria-label="Current rhythm layers">
            <div className="summary-heading"><span className="eyebrow">IN THE CYCLE</span><span className="summary-count">{activeLayers.length.toString().padStart(2, '0')} LAYERS</span></div>
            {activeLayers.map((layer, index) => <button key={layer.id} className={`summary-layer${selectedId === layer.id ? ' selected' : ''}`} onClick={() => setSelectedId(layer.id)} aria-pressed={selectedId === layer.id}>
              <span className="summary-swatch" style={{ backgroundColor: COLORS[index % COLORS.length] }} />
              <span className="summary-name">{mode === 'explore' ? `RHYTHM ${index + 1}` : `PART ${index + 1}`}<strong>{mode === 'explore' ? `${(layer as RhythmLayer).divisions} events` : `${(layer as MeterLayer).numerator}/${(layer as MeterLayer).denominator} · ${(polymeter.layers[index]).barsInCycle} bars`}</strong></span>
              <span className={`summary-audio${layer.muted ? ' off' : ''}`} aria-label={layer.muted ? 'muted' : 'audible'}>{layer.muted ? '×' : '●'}</span>
            </button>)}
            <p className="summary-note">{mode === 'explore' ? 'Every layer shares one start and one return.' : 'Bar lines move at different lengths over one shared pulse.'}</p>
          </aside>
        </section>
      </div>
    </main>
    <footer className="app-footer"><span>BEATWEEN</span><span>{mode === 'explore' ? `${(selectedLayer as RhythmLayer).divisions} divisions` : `${(selectedLayer as MeterLayer).numerator}/${(selectedLayer as MeterLayer).denominator}`} · {bpm} BPM</span></footer>
  </div>;
}
