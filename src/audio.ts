import type { TimelineEvent } from './music';

const LOOKAHEAD_SECONDS = 0.08;
const SCHEDULER_INTERVAL_MS = 25;
const VOICES = [150, 470, 690, 320];

export class AudioEngine {
  private context: AudioContext | null = null;
  private timer: number | undefined;
  private events: TimelineEvent[] = [];
  private cycleBeats = 1;
  private bpm = 120;
  private anchorTime = 0;
  private anchorBeat = 0;
  private pausedBeat = 0;
  private scheduledThroughBeat = -0.000001;
  private playing = false;
  private volume = 0.55;
  private masterEnabled = true;
  private muted = new Set<string>();
  private scheduled = new Map<AudioScheduledSourceNode, number>();

  get isPlaying() {
    return this.playing;
  }

  get currentBeat() {
    return this.beatAt(this.context?.currentTime ?? 0);
  }

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

  setTimeline(events: TimelineEvent[], cycleBeats: number) {
    const wasPlaying = this.playing;
    this.cancelFutureAudio();
    this.events = events;
    this.cycleBeats = Math.max(cycleBeats, 0.000001);
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
      this.scheduleAhead();
    }
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.refreshFutureAudio();
  }

  setMasterEnabled(enabled: boolean) {
    this.masterEnabled = enabled;
    this.refreshFutureAudio();
  }

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
        const absoluteBeat = cycle * this.cycleBeats + event.beat;
        if (absoluteBeat <= this.scheduledThroughBeat + 0.0000001 || absoluteBeat > horizonBeat + 0.0000001) continue;
        if (absoluteBeat < this.anchorBeat - 0.0000001 || this.muted.has(event.layerId) || !this.masterEnabled) continue;
        const at = this.anchorTime + (absoluteBeat - this.anchorBeat) * 60 / this.bpm;
        if (at >= context.currentTime - 0.002) this.scheduleClick(event, at);
      }
    }
    this.scheduledThroughBeat = Math.max(this.scheduledThroughBeat, horizonBeat);
  }

  private scheduleClick(event: TimelineEvent, at: number) {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const frequency = VOICES[event.layerIndex % VOICES.length];
    const strength = event.accent === 'primary' ? 0.75 : event.accent === 'secondary' ? 0.45 : 0.28;
    oscillator.type = event.layerIndex % 2 === 0 ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(60, frequency * 0.62), at + 0.055);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, this.volume * strength), at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.075);
    oscillator.connect(gain);
    gain.connect(context.destination);
    this.scheduled.set(oscillator, at);
    oscillator.onended = () => this.scheduled.delete(oscillator);
    oscillator.start(at);
    oscillator.stop(at + 0.08);
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
        try { source.stop(now); } catch { /* already ended */ }
        this.scheduled.delete(source);
      }
    }
  }

  private clearTimer() {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }
}
