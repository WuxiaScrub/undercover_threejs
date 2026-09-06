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
import { GENERAL_POST, PATROL_CHECKPOINTS, insideCheckpoint, type PatrolCheckpoint } from './mapData';
import type { PatientState } from './medical';

const cfg = GAME_CONFIG.duty;

export type DutyStatus = {
  /** Room name or task, e.g. `STORAGE` or `DECIPHER TELEGRAMS`. */
  label: string;
  /** Extra detail line, or empty string. */
  detail?: string;
  /** Seconds until the deadline; negative once it is missed. */
  secondsLeft: number;
  /** Whether the primary ability is currently available. */
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

/**
 * The Secretary's dispatch run (CLAUDE.md §32).
 *
 * Collect a dispatch from the telegram room, carry it to the General's desk.
 * That is deliberately the same errand the NPC Secretary walks on her routine
 * and at the same pace, so a human doing her job and a human using the job as
 * cover to be standing in HQ look identical from outside — which is the whole
 * point of a public occupation (CLAUDE.md §2).
 *
 * The punishment for missing it is the interesting part. Nothing shoots her and
 * nothing scores her: after `deliveryMissesBeforeBan` misses HQ simply stops
 * letting her in for the rest of the round, and from then on the guards treat
 * her at the HQ door exactly as they would treat a Doctor. A secretary who has
 * lost her access has lost her cover story, which is a far worse outcome for an
 * infiltrator than for a loyalist — and everyone else can see it happen.
 */
export const TELEGRAM_COLLECT_POINT = { x: -8.0, z: 5.0 };

export type DeliveryPhase = 'collect' | 'deliver';

export class DeliveryDuty {
  phase: DeliveryPhase = 'collect';
  misses = 0;

  private dueAtMs = 0;
  private holdMs = 0;

  start(now: number): void {
    this.phase = 'collect';
    this.misses = 0;
    this.holdMs = 0;
    this.dueAtMs = now + cfg.deliverySeconds * 1000;
  }

  /** True once she has missed enough deadlines to lose HQ access. */
  get banned(): boolean {
    return this.misses >= cfg.deliveryMissesBeforeBan;
  }

  /** Where the current leg has to be performed. */
  get point(): { x: number; z: number } {
    return this.phase === 'collect'
      ? TELEGRAM_COLLECT_POINT
      : { x: GENERAL_POST.x, z: GENERAL_POST.z };
  }

  /**
   * @param holding whether she currently has a dispatch in hand.
   * @returns true when something the player can see changed.
   */
  tick(x: number, z: number, holding: boolean, now: number, dtMs: number): boolean {
    // Losing the dispatch (dropped it, or it was confiscated) puts her back to
    // the start of the run rather than failing her — the deadline is punishment
    // enough, and a search that ends the duty outright would make the officer's
    // ability a weapon rather than an investigation.
    if (this.phase === 'deliver' && !holding) {
      this.phase = 'collect';
      this.holdMs = 0;
      return true;
    }

    if (!this.banned && now > this.dueAtMs) {
      this.misses++;
      this.dueAtMs = now + cfg.deliverySeconds * 1000;
      this.holdMs = 0;
      return true;
    }

    const target = this.point;
    const near = Math.hypot(x - target.x, z - target.z) <= cfg.deliveryReach;
    const was = this.holdMs;
    this.holdMs = near ? this.holdMs + dtMs : 0;
    return (was === 0) !== (this.holdMs === 0);
  }

  /** Seconds stood on the spot so far, out of `deliveryHoldSeconds`. */
  get hold(): number {
    return this.holdMs / 1000;
  }

  /** True once she has stood there long enough for the leg to complete. */
  get holdComplete(): boolean {
    return this.holdMs >= cfg.deliveryHoldSeconds * 1000;
  }

  /** Called by the server when a leg actually completes. */
  advance(now: number): void {
    this.holdMs = 0;
    if (this.phase === 'collect') {
      this.phase = 'deliver';
      return;
    }
    this.phase = 'collect';
    this.dueAtMs = now + cfg.deliverySeconds * 1000;
  }

  status(now: number): DutyStatus {
    if (this.banned) {
      return { label: 'HQ ACCESS REVOKED', detail: 'REPORT TO ADMIN', secondsLeft: 0, ok: false, dwell: 0 };
    }
    return {
      label: this.phase === 'collect' ? 'COLLECT FROM SIGNALS' : 'DELIVER TO THE GENERAL',
      detail: this.misses > 0 ? `MISSED ${this.misses}` : '',
      secondsLeft: (this.dueAtMs - now) / 1000,
      ok: true,
      dwell: this.hold,
    };
  }
}

/**
 * The Doctor's duty line. Unlike the other two this holds no state of its own —
 * the ward IS the duty, and `PatientSystem` already owns it. Keeping it as a
 * pure read means a doctor cannot fail a duty and then be safe; the patients go
 * on deteriorating whatever the HUD says.
 */
export function medicalStatus(worst: PatientState | null): DutyStatus {
  if (!worst) {
    return { label: 'THE WARD IS LOST', detail: '', secondsLeft: 0, ok: false, dwell: 0 };
  }
  const label =
    worst.status === 'critical'
      ? 'PATIENT CRITICAL'
      : worst.status === 'wounded'
        ? 'PATIENT WOUNDED'
        : 'WARD STABLE';
  return {
    label,
    detail: worst.status === 'stable' ? '' : 'EXAMINE, THEN TREAT',
    secondsLeft: worst.timer,
    ok: worst.status !== 'critical',
    dwell: 0,
  };
}
