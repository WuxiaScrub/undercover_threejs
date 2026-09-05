import * as THREE from 'three';
import punch1Url from '../../../assets/sounds/sfx_punch1.mp3?url';
import punch2Url from '../../../assets/sounds/sfx_punch2.mp3?url';
import punch3Url from '../../../assets/sounds/sfx_punch3.mp3?url';
import pistolUrl from '../../../assets/sounds/sfx_pistol.mp3?url';
import rifleUrl from '../../../assets/sounds/sfx_rifle.mp3?url';
import pickUrl from '../../../assets/sounds/sfx_item_pick.mp3?url';
import landUrl from '../../../assets/sounds/sfx_land.mp3?url';
import looking1Url from '../../../assets/sounds/guard_voiceovers/sfx_looking_1.mp3?url';
import looking2Url from '../../../assets/sounds/guard_voiceovers/sfx_looking_2.mp3?url';
import looking3Url from '../../../assets/sounds/guard_voiceovers/sfx_looking_3.mp3?url';
import warn1Url from '../../../assets/sounds/guard_voiceovers/sfx_warn_1.mp3?url';
import warn2Url from '../../../assets/sounds/guard_voiceovers/sfx_warn_2.mp3?url';
import warn3Url from '../../../assets/sounds/guard_voiceovers/sfx_warn_3.mp3?url';
import warn4Url from '../../../assets/sounds/guard_voiceovers/sfx_warn_4.mp3?url';
import warn5Url from '../../../assets/sounds/guard_voiceovers/sfx_warn_5.mp3?url';
import warn6Url from '../../../assets/sounds/guard_voiceovers/sfx_warn_6.mp3?url';
import hostile1Url from '../../../assets/sounds/guard_voiceovers/sfx_hostile_1.mp3?url';
import hostile2Url from '../../../assets/sounds/guard_voiceovers/sfx_hostile_2.mp3?url';
import hostile3Url from '../../../assets/sounds/guard_voiceovers/sfx_hostile_3.mp3?url';
import neutralized1Url from '../../../assets/sounds/guard_voiceovers/sfx_threat_neutralized_1.mp3?url';
import neutralized2Url from '../../../assets/sounds/guard_voiceovers/sfx_threat_neutralized_2.mp3?url';
import neutralized3Url from '../../../assets/sounds/guard_voiceovers/sfx_threat_neutralized_3.mp3?url';
import { GAME_CONFIG } from '../../shared/constants';
import type { GuardVoiceCue } from '../../shared/npc';
import type { Vec3 } from '../../shared/types';
import type { WeaponId } from '../../shared/weapons';

/**
 * Weapon and melee sound (the user's supplied sfx).
 *
 * Positional, not flat 2D: in a social-deduction game a gunshot is information —
 * which direction it came from and roughly how far away tells you where to run
 * and who to suspect. THREE.PositionalAudio does the falloff for us off the
 * camera's listener.
 *
 * Voices are pooled. A firefight must not allocate, and a browser will not thank
 * us for one AudioBufferSourceNode per bullet.
 */
const VOICES = 14;

/**
 * Guard speech gets its own small pool. On the shared one a firefight — which
 * is exactly when a guard has something to say — cycles fourteen voices in
 * about a second and cuts him off mid-sentence.
 */
const SPEECH_VOICES = 4;

/** The supplied lines, several per cue; one is picked at random per event. */
const VOICE_FILES: Record<GuardVoiceCue, string[]> = {
  looking: [looking1Url, looking2Url, looking3Url],
  warn: [warn1Url, warn2Url, warn3Url, warn4Url, warn5Url, warn6Url],
  hostile: [hostile1Url, hostile2Url, hostile3Url],
  threat_neutralized: [neutralized1Url, neutralized2Url, neutralized3Url],
};

/** Full volume out to here, silent past MAX_DISTANCE. A rifle carries. */
const REF_DISTANCE = 7;
const MAX_DISTANCE = 70;

/** Speech reaches exactly as far as the shout text does, and no further. */
const SPEECH_DISTANCE = GAME_CONFIG.guards.shoutRadius;

export class Audio {
  readonly listener = new THREE.AudioListener();

  private readonly voices: THREE.PositionalAudio[] = [];
  private cursor = 0;
  private readonly speech: THREE.PositionalAudio[] = [];
  private speechCursor = 0;
  private readonly lines: Record<GuardVoiceCue, AudioBuffer[]> = {
    looking: [],
    warn: [],
    hostile: [],
    threat_neutralized: [],
  };
  private readonly shots: Partial<Record<WeaponId, AudioBuffer>> = {};
  private readonly punches: AudioBuffer[] = [];
  private pick?: AudioBuffer;
  private land?: AudioBuffer;

  constructor(scene: THREE.Scene) {
    const makeVoice = (maxDistance: number): THREE.PositionalAudio => {
      const voice = new THREE.PositionalAudio(this.listener);
      voice.setRefDistance(REF_DISTANCE);
      voice.setMaxDistance(maxDistance);
      voice.setDistanceModel('linear');
      voice.setRolloffFactor(1);
      scene.add(voice);
      return voice;
    };

    for (let i = 0; i < VOICES; i++) this.voices.push(makeVoice(MAX_DISTANCE));
    // A shout carries as far as the text does and no further, so what you hear
    // and what you read agree.
    for (let i = 0; i < SPEECH_VOICES; i++) this.speech.push(makeVoice(SPEECH_DISTANCE));

    const loader = new THREE.AudioLoader();
    const load = (url: string, onDone: (buffer: AudioBuffer) => void) => {
      // A missing or unplayable file must never take the game down with it.
      loader.load(url, onDone, undefined, () => console.warn(`[audio] could not load ${url}`));
    };

    load(pistolUrl, (b) => (this.shots.pistol = b));
    load(rifleUrl, (b) => (this.shots.rifle = b));
    load(pickUrl, (b) => (this.pick = b));
    load(landUrl, (b) => (this.land = b));
    for (const url of [punch1Url, punch2Url, punch3Url]) {
      load(url, (b) => this.punches.push(b));
    }
    for (const cue of Object.keys(VOICE_FILES) as GuardVoiceCue[]) {
      for (const url of VOICE_FILES[cue]) load(url, (b) => this.lines[cue].push(b));
    }
  }

  /**
   * Browsers start the audio context suspended until the user interacts. The
   * click that grabs pointer lock is that interaction, so this is called there.
   */
  resume(): void {
    const ctx = this.listener.context;
    if (ctx.state === 'suspended') void ctx.resume();
  }

  gunshot(weapon: WeaponId, at: Vec3): void {
    this.play(this.shots[weapon], at, 1);
  }

  /** A landed punch. One of the three supplied clips, chosen at random. */
  punch(at: Vec3): void {
    if (this.punches.length === 0) return;
    this.play(this.punches[Math.floor(Math.random() * this.punches.length)], at, 0.9);
  }

  /**
   * A guard saying one of his four lines out loud, from where he is standing.
   * Which recording of the cue is uniformly random per event, so two guards
   * reacting together rarely say the same words in unison.
   */
  guardVoice(cue: GuardVoiceCue, at: Vec3): void {
    const takes = this.lines[cue];
    if (takes.length === 0) return;
    const buffer = takes[Math.floor(Math.random() * takes.length)];

    const voice = this.speech[this.speechCursor++ % SPEECH_VOICES];
    if (voice.isPlaying) voice.stop();
    voice.position.set(at.x, at.y, at.z);
    voice.setBuffer(buffer);
    voice.setVolume(1);
    voice.play();
  }

  /** Something taken off the floor. Quiet — it should not carry down a corridor. */
  pickup(at: Vec3): void {
    this.play(this.pick, at, 0.7);
  }

  /** Landing from a jump. Feedback for the movement, not information for others. */
  landed(at: Vec3): void {
    this.play(this.land, at, 0.5);
  }

  private play(buffer: AudioBuffer | undefined, at: Vec3, volume: number): void {
    if (!buffer) return; // still loading, or failed to load

    const voice = this.voices[this.cursor++ % VOICES];
    if (voice.isPlaying) voice.stop();
    voice.position.set(at.x, at.y, at.z);
    voice.setBuffer(buffer);
    voice.setVolume(volume);
    voice.play();
  }
}
