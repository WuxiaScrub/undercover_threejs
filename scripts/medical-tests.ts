/**
 * The medical ward (CLAUDE.md §28, §32) — the Doctor's reason to exist and the
 * compound's second way to lose.
 *
 * Three things here are worth a test rather than a playthrough:
 *
 *   - it is a LOOP. A treated patient goes stable for a while and then wounds
 *     again, so the doctor is never finished and "where was the doctor?" is
 *     always a fair question.
 *   - the ids are NPC ids. They used to be a private series of this class's
 *     own, which meant a shot patient was still counted as stable and a patient
 *     who died on the clock kept standing in the ward.
 *   - how a patient died is recorded, because that distinction is the whole
 *     accusation: neglect points at the Doctor, gunfire points at whoever was
 *     in the ward with a weapon.
 */
import { WebSocket, WebSocketServer } from 'ws';
import { GAME_CONFIG } from '../src/shared/constants';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/shared/net';
import { GameServer } from '../src/server/GameServer';
import { medicalStatus } from '../src/shared/duty';
import { PatientSystem } from '../src/shared/medical';
import { COMPOUND, PATIENT_POSTS } from '../src/shared/mapData';
import { NpcWorld } from '../src/shared/npc';
import { PlayerState } from '../src/server/PlayerState';
import { RoundSystem } from '../src/server/RoundSystem';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const cfg = GAME_CONFIG.medical;
const DT = 1 / 30;
/** Whoever the test shots are attributed to. Any player id will do. */
const SHOOTER = 1;

/** Run the ward forward, returning every death id reported along the way. */
function run(ward: PatientSystem, seconds: number): number[] {
  const deaths: number[] = [];
  for (let t = 0; t < seconds; t += DT) deaths.push(...ward.tick(DT).deaths);
  return deaths;
}

console.log('=== the ward starts with work in it ===');
{
  const ward = new PatientSystem();
  ward.reset();
  check(`there are ${PATIENT_POSTS.length} patients`, ward.all.length === PATIENT_POSTS.length);
  check(
    'and every one of them starts wounded, not stable',
    ward.all.every((p) => p.status === 'wounded'),
    ward.all.map((p) => p.status).join(', '),
  );
  check(
    'on staggered clocks, so they do not come due together',
    ward.all.every((p) => Math.abs(p.timer - cfg.woundedSeconds) <= cfg.startJitterSeconds),
    ward.all.map((p) => p.timer.toFixed(0)).join(', '),
  );
  check('nothing has died yet', ward.deadCount === 0 && ward.deathCauses.length === 0);
}

console.log('\n=== left alone, a patient deteriorates and dies ===');
{
  const ward = new PatientSystem();
  ward.reset();
  // Pin the clocks so the timing is the config's and not the jitter's.
  for (const p of ward.all) p.timer = cfg.woundedSeconds;

  run(ward, cfg.woundedSeconds - 1);
  check('still wounded just before the deadline', ward.all.every((p) => p.status === 'wounded'));

  run(ward, 2);
  check('critical just after it', ward.all.every((p) => p.status === 'critical'), ward.all.map((p) => p.status).join(', '));
  check('and not dead yet', ward.deadCount === 0);

  const deaths = run(ward, cfg.criticalSeconds + 1);
  check('dead once the critical window runs out too', ward.deadCount === 2, `${ward.deadCount} dead`);
  check('and each death is reported exactly once', deaths.length === 2, `${deaths.length} reports`);
  check(
    'with neglect recorded as the cause — which points at the Doctor',
    ward.deathCauses.join() === 'neglect,neglect',
    ward.deathCauses.join(', '),
  );
  check('a dead ward has no worst patient to report', ward.worst === null);
  check('and the duty line says so', medicalStatus(ward.worst).label === 'THE WARD IS LOST');
}

console.log('\n=== treatment buys time, and only time ===');
{
  const ward = new PatientSystem();
  ward.reset();
  const p = ward.all[0]!;
  p.timer = cfg.woundedSeconds;

  check('treating with the wrong supply does nothing', !ward.treat(p.id, p.need === 'gauze' ? 'morphine' : 'gauze'));
  check('the right one works', ward.treat(p.id, p.need));
  check('and the patient is stable', p.status === 'stable');
  check(`for ${cfg.stableSeconds}s`, Math.abs(p.timer - cfg.stableSeconds) < 1e-6, `${p.timer}`);
  check('treating a stable patient again is refused', !ward.treat(p.id, p.need));

  run(ward, cfg.stableSeconds + 1);
  check(
    're-wounds when the treatment lapses — the ward is a loop, not a checklist',
    p.status === 'wounded',
    p.status,
  );
  check('with a fresh full clock', Math.abs(p.timer - cfg.woundedSeconds) < 1, `${p.timer.toFixed(0)}s`);
}

console.log('\n=== an examination is told to one person ===');
{
  const ward = new PatientSystem();
  ward.reset();
  const p = ward.all[0]!;

  const need = ward.examine(p.id, 42);
  check('the examiner learns the need', need === p.need, `${need}`);
  check('and is the only one on the list', [...p.examinedBy].join() === '42', [...p.examinedBy].join());
  // The need is not on any snapshot: `publicUpdates` is what everyone sees.
  const shared = JSON.stringify(ward.publicUpdates());
  check(
    'the public ward status carries status only, never the need',
    !shared.includes('gauze') && !shared.includes('morphine'),
    shared,
  );

  ward.treat(p.id, p.need);
  check('treatment clears the examination — the next round of it is fresh work', p.examinedBy.size === 0);
  check('examining a dead patient returns nothing', (ward.kill(ward.all[1]!.id, 'gunfire'), ward.examine(ward.all[1]!.id, 42)) === null);
}

console.log('\n=== one id space: a shot patient is a dead patient ===');
{
  const npcs = new NpcWorld();
  npcs.reset();
  npcs.tick(DT, 0, [], COMPOUND.colliders);

  const ids = npcs.patientIds;
  check(`the NPC world has ${PATIENT_POSTS.length} patient bodies`, ids.length === PATIENT_POSTS.length, ids.join(', '));

  const ward = new PatientSystem();
  ward.reset(ids);
  check(
    'and the ward uses those ids, not a series of its own',
    ward.all.map((p) => p.id).join() === ids.join(),
    ward.all.map((p) => p.id).join(', '),
  );

  // Shoot one. This is the reconciliation GameServer.tickPatients performs
  // every tick: the body reports dead, so the ward records gunfire.
  let killed = false;
  for (let i = 0; i < 20 && !killed; i++) {
    killed = npcs.applyDamage(ids[0]!, 999, SHOOTER)?.killed ?? false;
  }
  check('the body goes down', killed && npcs.info(ids[0]!)?.alive === false);

  check('the ward records the kill', ward.kill(ids[0]!, 'gunfire'));
  check('with gunfire as the cause', ward.all[0]!.cause === 'gunfire', `${ward.all[0]!.cause}`);
  check('killing the same patient twice is refused', !ward.kill(ids[0]!, 'gunfire'));
  check('and he is no longer the worst patient — he is past helping', ward.worst?.id !== ids[0]);

  // The other direction: a neglect death has to lay the body down, which is
  // what `expire` is for — it kills without provoking anybody.
  ward.kill(ids[1]!, 'neglect');
  npcs.expire(ids[1]!);
  check('a neglect death lays the body down too', npcs.info(ids[1]!)?.alive === false);
  check(
    'and the two causes are told apart',
    ward.deathCauses.sort().join() === 'gunfire,neglect',
    ward.deathCauses.join(', '),
  );
}

console.log('\n=== losing the ward loses the round ===');
{
  const now = 1_000_000;
  const players = Array.from(
    { length: 3 },
    (_, i) => new PlayerState(i + 1, `p${i + 1}`, 'doctor', 0, 0, 0, now),
  );
  const round = new RoundSystem();
  round.start(players, now);

  const ward = new PatientSystem();
  ward.reset();
  const status = () => ({
    generalAlive: true,
    patientsDead: ward.deadCount,
    patientCauses: ward.deathCauses,
  });

  ward.kill(ward.all[0]!.id, 'neglect');
  check(
    'one patient down is survivable',
    round.tick(players, status(), now + 1000) === null,
    `${ward.deadCount} dead`,
  );

  ward.kill(ward.all[1]!.id, 'neglect');
  const lost = round.tick(players, status(), now + 2000);
  check(
    `${GAME_CONFIG.round.patientsLostToLose} down ends the round for the infiltrators`,
    lost?.winner === 'infiltrator',
    lost ? lost.reason : 'NO RESULT',
  );
  check(
    'and the reason names how they died',
    (lost?.reason ?? '').toLowerCase().includes('untreated'),
    lost?.reason ?? '',
  );
}

console.log('\n=== the duty line tracks the worst bed ===');
{
  const ward = new PatientSystem();
  ward.reset();
  check('a wounded ward reads WOUNDED', medicalStatus(ward.worst).label === 'PATIENT WOUNDED');

  ward.all[0]!.status = 'critical';
  const crit = medicalStatus(ward.worst);
  check('one critical patient outranks a wounded one', crit.label === 'PATIENT CRITICAL', crit.label);
  check('and the duty is not ok while he is', !crit.ok);

  for (const p of ward.all) {
    p.status = 'stable';
    p.timer = cfg.stableSeconds;
  }
  const calm = medicalStatus(ward.worst);
  check('an all-stable ward reads STABLE and ok', calm.label === 'WARD STABLE' && calm.ok);
}

// ---------------------------------------------------------------------------
// The two announcements, from a real server.
//
// The distinction between them is the accusation: "died" points at whoever was
// meant to be treating him, "shot" points at whoever was in the ward with a
// weapon. Getting them the wrong way round would quietly break the only social
// consequence the ward has.
// ---------------------------------------------------------------------------

/** A socket the server can talk to and the test can read back. */
class FakeSocket {
  readyState = 1;
  readonly sent: ServerMessage[] = [];
  private handlers = new Map<string, ((arg: unknown) => void)[]>();

  on(event: string, fn: (arg: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(): void {
    this.readyState = 3;
  }
  say(msg: ClientMessage): void {
    for (const fn of this.handlers.get('message') ?? []) fn(JSON.stringify(msg));
  }
}

class FakeServer {
  private onConnection: ((socket: WebSocket) => void) | null = null;
  on(event: string, fn: (socket: WebSocket) => void): this {
    if (event === 'connection') this.onConnection = fn;
    return this;
  }
  close(): void {}
  connect(): FakeSocket {
    const socket = new FakeSocket();
    this.onConnection?.(socket as unknown as WebSocket);
    return socket;
  }
}

console.log('\n=== the compound is told which kind of death it was ===');
{
  const wss = new FakeServer();
  const server = new GameServer(wss as unknown as WebSocketServer);
  const sockets = [wss.connect(), wss.connect()];
  for (const [i, s] of sockets.entries()) {
    s.say({ t: 'join', protocol: PROTOCOL_VERSION, name: `p${i + 1}`, role: 'doctor' });
  }

  const now = Date.now();
  const players = server['livePlayers']();
  server['startRound'](players, now);

  const npcs = server['guards'].world;
  const ward = server['patients'] as PatientSystem;
  const ids = npcs.patientIds;
  check('the round bridges the ward to the bodies', ward.all.map((p) => p.id).join() === ids.join());

  const texts = (): string[] =>
    sockets[1]!.sent.filter((m) => m.t === 'announce').map((m) => (m.t === 'announce' ? m.text : ''));

  // Shot: the body dies first, and the ward has to notice on its next tick.
  sockets[1]!.sent.length = 0;
  for (let i = 0; i < 20 && npcs.info(ids[0]!)?.alive !== false; i++) {
    npcs.applyDamage(ids[0]!, 999, SHOOTER);
  }
  server['tickPatients'](DT, now);
  check(
    'a shot patient announces that he was shot',
    texts().some((t) => t === 'A PATIENT HAS BEEN SHOT IN THE MEDICAL WARD'),
    texts().join(' | '),
  );
  check('and the ward agrees on the cause', ward.all[0]!.cause === 'gunfire');
  check('announced once, not once per tick', (server['tickPatients'](DT, now), texts().filter((t) => t.includes('SHOT')).length === 1));

  // Neglect: the clock runs out, and the body has to lie down without anybody
  // being blamed for shooting it.
  sockets[1]!.sent.length = 0;
  const second = ward.all[1]!;
  second.status = 'critical';
  second.timer = 0.01;
  server['tickPatients'](DT, now + 1000);
  check(
    'a neglected patient announces that he died',
    texts().some((t) => t === 'A PATIENT HAS DIED IN THE MEDICAL WARD'),
    texts().join(' | '),
  );
  check('the body lies down', npcs.info(second.id)?.alive === false);
  check('with neglect recorded', second.cause === 'neglect', `${second.cause}`);
  check(
    'and the two announcements are not the same sentence',
    !texts().some((t) => t.includes('SHOT')),
    texts().join(' | '),
  );

  // And that is the round: two beds empty is a loss.
  server['tickRound'](server['livePlayers'](), now + 2000);
  check('losing both patients ends the round', server['round'].phase === 'over', server['round'].phase);
  server.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
