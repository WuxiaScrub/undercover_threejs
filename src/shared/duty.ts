/**
 * The Security Officer's patrol (CLAUDE.md §15, §32).
 *
 * The officer is the only armed role and the only one who may legitimately
 * stand around with a rifle out, which makes "camp beside the General for the
 * whole match" his strongest and most boring play. The patrol is the answer:
 * every two or three minutes the compound expects him somewhere else, and if he
 * does not go, his search ability switches off until he does.
 *
 * Two rules from CLAUDE.md §15 shape the whole thing:
 *
 *   - Missing the deadline disables search TEMPORARILY. The checkpoint does not
 *     roll over on expiry — it stays put until he actually walks to it, and the
 *     ability comes back the moment he arrives. There is no state this can get
 *     into where an officer is permanently unable to search.
 *   - It exists to give him a legitimate reason to be elsewhere. That is also
 *     why the failure is visible to him and to nobody else: other players are
 *     meant to notice he skipped his patrol by watching where he is, not by
 *     reading it off a HUD (CLAUDE.md §34).
 *
 * Lives in shared/ so offline solo mode runs this exact class rather than a
 * second implementation that drifts.
 */
import { GAME_CONFIG } from './constants';
import { PATROL_CHECKPOINTS, insideCheckpoint, type PatrolCheckpoint } from './mapData';

const cfg = GAME_CONFIG.duty;

export type DutyStatus = {
  /** Room name in caps, e.g. `STORAGE`. */
  label: string;
  /** Seconds until the deadline; negative once it is missed. */
  secondsLeft: number;
  /** Whether the search ability is currently available. */
  ok: boolean;
  /** Seconds stood inside the box so far, out of `patrolDwellSeconds`. */
  dwell: number;
};

export class PatrolDuty {
  private index = -1;
  private dueAtMs = 0;
  private dwellMs = 0;
  private ok = true;

  /** `rand` is injectable so the tests can pin the checkpoint order. */
  constructor(private readonly rand: () => number = Math.random) {}

  get checkpoint(): PatrolCheckpoint {
    return PATROL_CHECKPOINTS[Math.max(0, this.index)];
  }

  /** False while the officer owes the compound a patrol. */
  get searchEnabled(): boolean {
    return this.ok;
  }

  start(now: number): void {
    this.ok = true;
    this.dwellMs = 0;
    this.assign(now);
  }

  /**
   * @returns true when anything the officer can see has changed — a new
   * checkpoint, the ability going away or coming back, dwell progress starting
   * or stopping — so the caller knows when to send a message. The clock itself
   * is not a change; the client counts that down on its own.
   */
  tick(x: number, z: number, now: number, dtMs: number): boolean {
    if (this.index < 0) return false;

    const inside = insideCheckpoint(this.checkpoint, x, z);
    const dwellWas = this.dwellMs;
    // Leaving resets the timer. Standing in the doorway for two seconds six
    // times is not a patrol.
    this.dwellMs = inside ? this.dwellMs + dtMs : 0;

    if (this.dwellMs >= cfg.patrolDwellSeconds * 1000) {
      // Arriving always restores the ability, whether or not he was late. This
      // is the "never permanently removed" rule, and it is the only place the
      // ability is switched back on.
      this.ok = true;
      this.dwellMs = 0;
      this.assign(now);
      return true;
    }

    if (this.ok && now > this.dueAtMs) {
      this.ok = false;
      return true;
    }

    // Only report dwell changes at the edges: started standing, or gave up.
    return (dwellWas === 0) !== (this.dwellMs === 0);
  }

  status(now: number): DutyStatus {
    return {
      label: this.checkpoint.label,
      secondsLeft: (this.dueAtMs - now) / 1000,
      ok: this.ok,
      dwell: this.dwellMs / 1000,
    };
  }

  /** Next checkpoint, never the one he just did, with a jittered deadline. */
  private assign(now: number): void {
    const choices = PATROL_CHECKPOINTS.map((_, i) => i).filter((i) => i !== this.index);
    this.index = choices[Math.floor(this.rand() * choices.length) % choices.length];
    const jitter = (this.rand() * 2 - 1) * cfg.patrolJitterSeconds;
    this.dueAtMs = now + (cfg.patrolIntervalSeconds + jitter) * 1000;
  }
}
