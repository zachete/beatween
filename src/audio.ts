import type { TimelineEvent } from './music';

type Palette = 'studio' | 'soft' | 'bright';
type Voice = 'click' | 'wood' | 'pulse';
const LOOKAHEAD_SECONDS = 0.1;
const SCHEDULER_INTERVAL_MS = 25;
const PALETTES: Record<Palette, { click: number; wood: number; pulse: number }> = {
  studio: { click: 1, wood: 1, pulse: 1 },
  soft: { click: 0.68, wood: 0.78, pulse: 0.82 },
  bright: { click: 0.9, wood: 1.12, pulse: 1.08 },
};

export type SoundPalette = Palette;

export class AudioEngine {
  private context: AudioContext | null = null;
  private timer: number | undefined;
  private events: TimelineEvent[] = [];
  private alignmentBeats: number[] = [0];
  private cycleBeats = 1;
  private gridCells = 1;
  private bpm = 120;
  private anchorTime = 0;
  private anchorBeat = 0;
  private pausedBeat = 0;
  private scheduledThroughBeat = -0.000001;
  private playing = false;
  private volume = 0.55;
  private velocity = 1;
  private palette: Palette = 'studio';
  private masterEnabled = true;
  private gridEnabled = false;
  private alignmentEnabled = false;
  private ghostEnabled = true;
  private muted = new Set<string>();
  private layerVoices = new Map<string, Voice>();
  private soloId: string | null = null;
  private layerVolumes = new Map<string, number>();
  private layerPans = new Map<string, number>();
  private scheduled = new Map<AudioScheduledSourceNode, number>();

  get isPlaying() { return this.playing; }
  get currentBeat() { return this.beatAt(this.context?.currentTime ?? 0); }

  async play() {
    const context = this.getContext();
    if (context.state === 'suspended') await context.resume();
    if (this.playing) return;
    this.anchorBeat = this.pausedBeat;
    this.anchorTime = context.currentTime + 0.035;
    this.scheduledThroughBeat = this.pausedBeat - 0.000001;
    this.playing = true;
    this.timer = window.setInterval(() => this.scheduleAhead(), SCHEDULER_INTERVAL_MS);
    this.scheduleAhead();
  }

  pause() {
    if (!this.playing) return;
    this.pausedBeat = this.currentBeat;
    this.playing = false;
    this.clearTimer();
    this.cancelFutureAudio();
  }

  stop() {
    this.playing = false;
    this.pausedBeat = 0;
    this.anchorBeat = 0;
    this.scheduledThroughBeat = -0.000001;
    this.clearTimer();
    this.cancelFutureAudio();
  }

  setTimeline(events: TimelineEvent[], cycleBeats: number, gridCells: number) {
    const wasPlaying = this.playing;
    this.cancelFutureAudio();
    this.events = events;
    const layerCount = new Set(events.map(({ layerId }) => layerId)).size;
    const hasBarStructure = events.some(({ accent }) => accent === 'bar');
    const alignedLayersAtBeat = new Map<string, Set<string>>();
    for (const event of events) {
      if (hasBarStructure ? event.accent !== 'bar' : event.accent !== 'event') continue;
      const key = event.beat.toFixed(8);
      const layers = alignedLayersAtBeat.get(key) ?? new Set<string>();
      layers.add(event.layerId);
      alignedLayersAtBeat.set(key, layers);
    }
    this.alignmentBeats = [...alignedLayersAtBeat]
      .filter(([, layers]) => layers.size === layerCount)
      .map(([beat]) => Number(beat));
    if (!this.alignmentBeats.length) this.alignmentBeats = [0];
    this.cycleBeats = Math.max(cycleBeats, 0.000001);
    this.gridCells = Math.max(1, gridCells);
    this.pausedBeat = 0;
    this.anchorBeat = 0;
    this.scheduledThroughBeat = -0.000001;
    if (wasPlaying && this.context) {
      this.anchorTime = this.context.currentTime + 0.035;
      this.scheduleAhead();
    }
  }

  setBpm(bpm: number) {
    const beat = this.currentBeat;
    this.bpm = bpm;
    if (this.playing && this.context) {
      this.anchorBeat = beat;
      this.anchorTime = this.context.currentTime;
      this.scheduledThroughBeat = beat - 0.000001;
      this.cancelFutureAudio();
      this.scheduleAhead();
    }
  }

  setVolume(volume: number) { this.volume = volume; this.refreshFutureAudio(); }
  setVelocity(velocity: number) { this.velocity = velocity; this.refreshFutureAudio(); }
  setPalette(palette: Palette) { this.palette = palette; this.refreshFutureAudio(); }
  setMasterEnabled(enabled: boolean) { this.masterEnabled = enabled; this.refreshFutureAudio(); }
  setGridEnabled(enabled: boolean) { this.gridEnabled = enabled; this.refreshFutureAudio(); }
  setAlignmentEnabled(enabled: boolean) { this.alignmentEnabled = enabled; this.refreshFutureAudio(); }
  setGhostEnabled(enabled: boolean) { this.ghostEnabled = enabled; this.refreshFutureAudio(); }
  setSolo(layerId: string | null) { this.soloId = layerId; this.refreshFutureAudio(); }
  setLayerVolume(layerId: string, value: number) { this.layerVolumes.set(layerId, value); this.refreshFutureAudio(); }
  setLayerPan(layerId: string, value: number) { this.layerPans.set(layerId, value); this.refreshFutureAudio(); }

  setMuted(layerId: string, muted: boolean) {
    if (muted) this.muted.add(layerId);
    else this.muted.delete(layerId);
    this.refreshFutureAudio();
  }

  destroy() {
    this.stop();
    void this.context?.close();
    this.context = null;
  }

  private getContext() {
    if (this.context) return this.context;
    const AudioContextConstructor = window.AudioContext
      ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) throw new Error('This browser does not support Web Audio.');
    this.context = new AudioContextConstructor();
    return this.context;
  }

  private beatAt(audioTime: number) {
    if (!this.playing || !this.context) return this.pausedBeat;
    return Math.max(this.anchorBeat, this.anchorBeat + (audioTime - this.anchorTime) * this.bpm / 60);
  }

  private scheduleAhead() {
    const context = this.context;
    if (!context || !this.playing || !this.events.length) return;
    const horizon = context.currentTime + LOOKAHEAD_SECONDS;
    const horizonBeat = this.beatAt(horizon);
    const firstCycle = Math.max(0, Math.floor(this.scheduledThroughBeat / this.cycleBeats));
    const lastCycle = Math.floor(horizonBeat / this.cycleBeats);
    for (let cycle = firstCycle; cycle <= lastCycle; cycle += 1) {
      for (const event of this.events) {
        const beat = cycle * this.cycleBeats + event.beat;
        if (beat <= this.scheduledThroughBeat + 0.0000001 || beat > horizonBeat + 0.0000001) continue;
        if (beat < this.anchorBeat - 0.0000001 || !this.masterEnabled) continue;
        const at = this.anchorTime + (beat - this.anchorBeat) * 60 / this.bpm;
        if (at < context.currentTime - 0.002) continue;
        const ghost = this.soloId !== null && this.soloId !== event.layerId;
        if (this.muted.has(event.layerId)) continue;
        if (this.soloId && !ghost) this.scheduleEvent(event, at, 1);
        else if (ghost) this.scheduleEvent(event, at, this.ghostEnabled ? 0.16 : 0);
        else this.scheduleEvent(event, at, 1);
      }
      const cycleStart = cycle * this.cycleBeats;
      if (cycleStart > this.scheduledThroughBeat && cycleStart <= horizonBeat && this.masterEnabled) {
        const at = this.anchorTime + (cycleStart - this.anchorBeat) * 60 / this.bpm;
        if (at >= context.currentTime - 0.002) this.scheduleVoice('pulse', at, 0.85 * this.velocity, 0, 0);
      }
      if (this.alignmentEnabled && this.masterEnabled) {
        for (const offset of this.alignmentBeats) {
          const beat = cycle * this.cycleBeats + offset;
          if (beat <= this.scheduledThroughBeat || beat > horizonBeat) continue;
          const at = this.anchorTime + (beat - this.anchorBeat) * 60 / this.bpm;
          if (at >= context.currentTime - 0.002) this.scheduleAlignment(at);
        }
      }
    }
    if (this.gridEnabled) {
      const step = this.cycleBeats / this.gridCells;
      const first = Math.max(0, Math.floor(this.scheduledThroughBeat / step) + 1);
      const last = Math.floor(horizonBeat / step);
      for (let index = first; index <= last; index += 1) {
        const beat = index * step;
        if (beat < this.anchorBeat || !this.masterEnabled) continue;
        const at = this.anchorTime + (beat - this.anchorBeat) * 60 / this.bpm;
        if (at >= context.currentTime - 0.002) this.scheduleVoice('click', at, 0.12 * this.velocity, 0, 1);
      }
    }
    this.scheduledThroughBeat = Math.max(this.scheduledThroughBeat, horizonBeat);
  }

  private scheduleEvent(event: TimelineEvent, at: number, ghostLevel: number) {
    if (!ghostLevel) return;
    if (!this.layerVoices.has(event.layerId)) {
      this.layerVoices.set(event.layerId, ['click', 'wood', 'pulse'][event.layerIndex % 3] as Voice);
    }
    const voice = this.layerVoices.get(event.layerId)!;
    const accentLevel = event.accent === 'bar' ? 0.54 : event.accent === 'group' ? 0.48 : 0.4;
    const base = accentLevel * this.velocity * ghostLevel * (this.layerVolumes.get(event.layerId) ?? 1);
    const pan = this.layerPans.get(event.layerId) ?? 0;
    this.scheduleVoice(voice, at, base, pan, event.layerIndex);
    if (event.accent !== 'event') {
      const accentVoice: Voice = event.accent === 'bar'
        ? (voice === 'pulse' ? 'wood' : 'pulse')
        : (voice === 'click' ? 'wood' : 'click');
      this.scheduleVoice(
        accentVoice,
        at,
        (event.accent === 'bar' ? 0.28 : 0.2) * this.velocity * ghostLevel * (this.layerVolumes.get(event.layerId) ?? 1),
        pan,
        event.layerIndex,
      );
    }
  }

  private scheduleVoice(voice: Voice, at: number, level: number, pan: number, layerIndex: number) {
    const context = this.context!;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    const paletteLevel = PALETTES[this.palette][voice];
    const amplitude = Math.max(0.0002, this.volume * level * paletteLevel * (voice === 'pulse' ? 0.72 : 0.45));
    const duration = voice === 'click' ? 0.035 : voice === 'wood' ? 0.075 : 0.12;
    gain.gain.exponentialRampToValueAtTime(amplitude, at + 0.003);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    const panner = context.createStereoPanner();
    panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), at);
    gain.connect(panner);
    panner.connect(context.destination);

    if (voice === 'click') {
      const noise = this.noiseBuffer();
      const source = context.createBufferSource();
      const filter = context.createBiquadFilter();
      source.buffer = noise;
      filter.type = 'highpass';
      filter.frequency.value = 2600;
      source.connect(filter);
      filter.connect(gain);
      this.startSource(source, at, duration);
      return;
    }

    const oscillator = context.createOscillator();
    oscillator.type = voice === 'wood' ? 'triangle' : 'sine';
    if (voice === 'wood') {
      oscillator.frequency.setValueAtTime(voice === 'wood' ? 560 + layerIndex * 35 : 120, at);
      oscillator.frequency.exponentialRampToValueAtTime(240, at + duration);
    } else {
      oscillator.frequency.setValueAtTime(145, at);
      oscillator.frequency.exponentialRampToValueAtTime(82, at + duration);
    }
    oscillator.connect(gain);
    this.startSource(oscillator, at, duration);
  }

  private scheduleAlignment(at: number) {
    this.scheduleVoice('wood', at, 0.12 * this.velocity, 0, 1);
  }

  private noiseBuffer() {
    const context = this.context!;
    const buffer = context.createBuffer(1, Math.ceil(context.sampleRate * 0.04), context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) samples[i] = Math.random() * 2 - 1;
    return buffer;
  }

  private startSource(source: AudioScheduledSourceNode, at: number, duration: number) {
    this.scheduled.set(source, at);
    source.onended = () => this.scheduled.delete(source);
    source.start(at);
    source.stop(at + duration + 0.005);
  }

  private refreshFutureAudio() {
    if (!this.playing || !this.context) return;
    const beat = this.currentBeat;
    this.cancelFutureAudio();
    this.scheduledThroughBeat = beat - 0.000001;
    this.scheduleAhead();
  }

  private cancelFutureAudio() {
    const now = this.context?.currentTime ?? 0;
    for (const [source, at] of this.scheduled) {
      if (at > now + 0.002) {
        try { source.stop(now); } catch { /* source already ended */ }
        this.scheduled.delete(source);
      }
    }
  }

  private clearTimer() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
