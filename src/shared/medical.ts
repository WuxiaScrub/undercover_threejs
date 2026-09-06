/**
 * The medical ward's two patients (CLAUDE.md §28, §32).
 *
 * This is the Doctor's reason to exist, and it is built as a LOOP rather than a
 * checklist: patients start wounded, deteriorate on a clock, and a treated
 * patient goes stable only for `stableSeconds` before deteriorating again. The
 * doctor is therefore never finished, so being somewhere else for two minutes
 * always costs something — which is what makes "where was the doctor?" a
 * question worth asking.
 *
 * The ids here are the NPC ids of the patient bodies (`NpcWorld.patientIds`),
 * passed into `reset`. They used to be a private 2000-series of this class's
 * own, which meant a patient could be shot dead as an NPC while this system
 * happily counted him as stable, and could die on the clock here while his body
 * kept standing in the ward. One id space, one patient.
 */
import { GAME_CONFIG } from './constants';
import type { ItemId } from './inventory';
import { PATIENT_POSTS } from './mapData';

export type PatientStatus = 'stable' | 'wounded' | 'critical' | 'dead';
export type PatientNeed = 'gauze' | 'morphine';

/**
 * How a patient died. The distinction is the entire accusation: neglect points
 * at the Doctor, gunfire points at whoever was in the ward with a weapon.
 */
export type PatientCause = 'neglect' | 'gunfire';

export type PatientState = {
  id: number;
  x: number;
  z: number;
  status: PatientStatus;
  need: PatientNeed;
  timer: number;
  cause: PatientCause | null;
  /** Player who examined this patient; null = unexamined. Server-side list only. */
  examinedBy: Set<number>;
};

export type PatientUpdate = {
  id: number;
  status: PatientStatus;
};

const cfg = GAME_CONFIG.medical;

function jitter(base: number): number {
  return base + (Math.random() * 2 - 1) * cfg.startJitterSeconds;
}

export class PatientSystem {
  private patients: PatientState[] = [];

  /**
   * @param ids the NPC ids of the patient bodies, in `PATIENT_POSTS` order.
   *   Defaults to a synthetic series so offline solo mode and the tests can
   *   build a ward without an `NpcWorld` — but the server always passes real
   *   ones, because a death here has to lay a body down.
   */
  reset(ids: readonly number[] = PATIENT_POSTS.map((_, i) => 2000 + i)): void {
    this.patients = PATIENT_POSTS.map((p, i) => ({
      id: ids[i] ?? 2000 + i,
      x: p.x,
      z: p.z,
      // Wounded from the first second — a ward of stable patients gives the
      // doctor nothing to do for the first two minutes of the round, which is
      // exactly the window in which everyone is deciding who to watch.
      status: 'wounded' as PatientStatus,
      need: (Math.random() < 0.5 ? 'gauze' : 'morphine') as PatientNeed,
      // Staggered, so the two never come due together and the doctor has to
      // choose which bed to be at.
      timer: Math.max(20, jitter(cfg.woundedSeconds)),
      cause: null,
      examinedBy: new Set<number>(),
    }));
  }

  get all(): readonly PatientState[] {
    return this.patients;
  }

  get deadCount(): number {
    return this.patients.filter((p) => p.status === 'dead').length;
  }

  get deathCauses(): PatientCause[] {
    return this.patients.flatMap((p) => (p.cause ? [p.cause] : []));
  }

  /** The patient in the most trouble, for the doctor's duty line. */
  get worst(): PatientState | null {
    const rank: Record<PatientStatus, number> = { dead: 0, critical: 3, wounded: 2, stable: 1 };
    let best: PatientState | null = null;
    for (const p of this.patients) {
      if (p.status === 'dead') continue;
      if (!best || rank[p.status] > rank[best.status]) best = p;
    }
    return best;
  }

  tick(dt: number): { updates: PatientUpdate[]; deaths: number[] } {
    const updates: PatientUpdate[] = [];
    const deaths: number[] = [];
    for (const p of this.patients) {
      if (p.status === 'dead') continue;
      p.timer -= dt;
      if (p.timer > 0) continue;

      if (p.status === 'stable') {
        // The treatment held for as long as it was going to. Re-wound with a
        // fresh need, so the doctor cannot stockpile one supply and be done.
        p.status = 'wounded';
        p.timer = cfg.woundedSeconds;
        p.need = Math.random() < 0.5 ? 'gauze' : 'morphine';
        p.examinedBy.clear();
        updates.push({ id: p.id, status: 'wounded' });
      } else if (p.status === 'wounded') {
        p.status = 'critical';
        p.timer = cfg.criticalSeconds;
        updates.push({ id: p.id, status: 'critical' });
      } else {
        p.status = 'dead';
        p.timer = 0;
        p.cause = 'neglect';
        updates.push({ id: p.id, status: 'dead' });
        deaths.push(p.id);
      }
    }
    return { updates, deaths };
  }

  /**
   * Kill a patient outright, recording why. Called when the NPC body takes
   * lethal damage, so a shot patient stops being counted as a living one.
   * @returns false if the id is not a patient, or was already dead.
   */
  kill(id: number, cause: PatientCause): boolean {
    const p = this.patients.find((p) => p.id === id);
    if (!p || p.status === 'dead') return false;
    p.status = 'dead';
    p.timer = 0;
    p.cause = cause;
    return true;
  }

  /** Reveal need to one examiner. Returns the need, or null if not found. */
  examine(patientId: number, playerId: number): PatientNeed | null {
    const p = this.patients.find((p) => p.id === patientId);
    if (!p || p.status === 'dead') return null;
    p.examinedBy.add(playerId);
    return p.need;
  }

  /** Apply treatment. Returns true if successful (item matched need). */
  treat(patientId: number, item: ItemId): boolean {
    const p = this.patients.find((p) => p.id === patientId);
    if (!p || p.status === 'dead' || p.status === 'stable') return false;
    if (p.need !== item) return false;
    p.status = 'stable';
    p.timer = cfg.stableSeconds;
    p.examinedBy.clear();
    return true;
  }

  publicUpdates(): PatientUpdate[] {
    return this.patients.map((p) => ({ id: p.id, status: p.status }));
  }

  nearest(x: number, z: number, reach: number): PatientState | null {
    let best: PatientState | null = null;
    let bestDist = Infinity;
    for (const p of this.patients) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < reach && d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }
}
