/**
 * The search, and the asymmetry it exists to create (CLAUDE.md §16).
 *
 * Two halves. The first drives `SearchSystem` directly and checks the rules —
 * who may search, who may be searched, and what confiscation does to two
 * inventories. The second stands up a whole `GameServer` on fake sockets and
 * reads every byte it emits, because the one property that actually matters is
 * negative: the item list must appear in NO message addressed to anyone but the
 * officer, including the message sent to the man being searched. A rule like
 * that cannot be checked by looking at the happy path — it has to be checked by
 * looking at everything else.
 */
import { WebSocket, WebSocketServer } from 'ws';
import { GAME_CONFIG } from '../src/shared/constants';
import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../src/shared/net';
import { GUARD_WEAPON, NpcWorld } from '../src/shared/npc';
import { PlayerState } from '../src/server/PlayerState';
import { SearchSystem } from '../src/server/SearchSystem';
import { GameServer } from '../src/server/GameServer';
import { CONTAINERS, HIDDEN_PISTOL_SPOTS } from '../src/shared/mapData';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
}

const cfg = GAME_CONFIG.search;
const T0 = 1_000_000;

function officerAt(x: number, z: number): PlayerState {
  return new PlayerState(1, 'officer', 'security', x, 0, z, T0);
}
function targetAt(x: number, z: number, id = 2): PlayerState {
  return new PlayerState(id, 'target', 'doctor', x, 0, z, T0);
}

/** An NPC world with a real roster, so guards carry real rifles. */
function world(): NpcWorld {
  const w = new NpcWorld();
  w.reset();
  w.tick(1 / 30, 0, [], []);
  return w;
}

console.log('=== who may search, and who may be searched ===');
{
  const npcs = world();
  const doc = new PlayerState(1, 'doc', 'doctor', 0, 0, 0, T0);
  const mark = targetAt(0.5, 0);
  const s = new SearchSystem();
  check(
    'a Doctor may not search anybody',
    s.begin(doc, mark.id, true, [doc, mark], npcs, T0) === 'not-security',
  );
}
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(0.5, 0);
  const s = new SearchSystem();
  // The patrol is the ONLY thing that can take the ability away, and this is
  // the check that makes the patrol duty matter at all (CLAUDE.md §15).
  check(
    'an overdue patrol suspends the ability',
    s.begin(officer, mark.id, false, [officer, mark], npcs, T0) === 'patrol-overdue',
  );
  check('and nothing was started', s.current === null);
}
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(cfg.reach + 1, 0);
  const s = new SearchSystem();
  check(
    'out of arm’s reach is refused',
    s.begin(officer, mark.id, true, [officer, mark], npcs, T0) === 'out-of-reach',
    `${cfg.reach + 1} m vs reach ${cfg.reach}`,
  );
}
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(0.5, 0);
  const s = new SearchSystem();
  mark.alive = false;
  check('a corpse is not searched', s.begin(officer, mark.id, true, [officer, mark], npcs, T0) === 'dead');
}
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const s = new SearchSystem();
  check(
    'an id that is nobody is refused',
    s.begin(officer, 9999, true, [officer], npcs, T0) === 'no-target',
  );
}

console.log('\n=== one search per minute, per person ===');
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(0.5, 0);
  const players = [officer, mark];
  const s = new SearchSystem();

  const first = s.begin(officer, mark.id, true, players, npcs, T0);
  check('the first search starts', typeof first !== 'string');
  check('a second search while one is running is refused',
    s.begin(officer, mark.id, true, players, npcs, T0) === 'busy');

  s.end(players, T0 + 1000);
  check(
    'immunity starts when the hold ENDS, not when it began',
    mark.searchableAtMs === T0 + 1000 + cfg.immunitySeconds * 1000,
    `${mark.searchableAtMs - T0} ms`,
  );

  const again = s.begin(officer, mark.id, true, players, npcs, T0 + 2000);
  check('so a second search inside the window is refused', again === 'immune');

  const later = s.begin(officer, mark.id, true, players, npcs, T0 + 1000 + cfg.immunitySeconds * 1000 + 1);
  check('and allowed once it lapses', typeof later !== 'string');
}

console.log('\n=== the decision window closes on its own ===');
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(0.5, 0);
  const players = [officer, mark];
  const s = new SearchSystem();
  s.begin(officer, mark.id, true, players, npcs, T0);

  check('both parties are pinned', s.frozen(officer.id) && s.frozen(mark.id));
  check('a bystander is not', !s.frozen(99));
  check('and it does not time out early', s.tick(players, T0 + cfg.decisionSeconds * 1000 - 1) === null);
  check('but it does time out', s.tick(players, T0 + cfg.decisionSeconds * 1000) !== null);
  check('after which nobody is pinned', !s.frozen(officer.id) && !s.frozen(mark.id));
}
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(0.5, 0);
  const players = [officer, mark];
  const s = new SearchSystem();
  s.begin(officer, mark.id, true, players, npcs, T0);
  check('a disconnect on either side drops the hold', s.abort(mark.id, players, T0 + 500) !== null);
  check('and an unrelated disconnect does not', s.abort(77, players, T0 + 600) === null);
}

console.log('\n=== what the officer finds ===');
{
  const npcs = world();
  const officer = officerAt(0, 0);
  const mark = targetAt(0.5, 0);
  const players = [officer, mark];
  const s = new SearchSystem();

  // A concealed pistol is exactly the thing this ability exists to uncover.
  mark.inventory.add('pistol');
  mark.inventory.add('gauze');
  const search = s.begin(officer, mark.id, true, players, npcs, T0);
  if (typeof search === 'string') throw new Error('search refused: ' + search);

  const found = s.itemsOf(search, players, npcs);
  check('his whole inventory shows, concealed or not', found.includes('pistol') && found.includes('gauze'), found.join(', '));

  // Gauze is not standard issue for a Security Officer, so it goes in his pocket.
  check('taking something he does not carry moves it', s.confiscate('gauze', players, npcs) === 'taken');
  check('off the target', !mark.inventory.has('gauze'));
  check('and onto the officer', officer.inventory.has('gauze'));
  check('a second click on the same row does nothing', s.confiscate('gauze', players, npcs) === null);

  // A pistol IS standard issue, so the confiscated one has nowhere to go but
  // the floor — where anybody can pick it up. That is the officer's problem,
  // and it is deliberately the one visible consequence of a search.
  check(
    'confiscating a duplicate drops it at his feet instead',
    s.confiscate('pistol', players, npcs) === 'dropped',
  );
  check('and it still comes off the target', !mark.inventory.has('pistol'));
}
{
  // Searching a rifle out of a guard's hands is a real option, and the officer
  // has no way of knowing whether that guard is a person.
  const npcs = world();
  const officer = officerAt(0, 0);
  const guardId = npcs.snapshots().find((n) => n.kind === 'guard')!.id;
  const pos = npcs.positionOf(guardId)!;
  officer.x = pos.x;
  officer.z = pos.z;
  const s = new SearchSystem();
  const search = s.begin(officer, guardId, true, [officer], npcs, T0);
  if (typeof search === 'string') throw new Error('NPC search refused: ' + search);

  check('the search names the target as an NPC internally only', search.targetIsNpc);
  const items = s.itemsOf(search, [officer], npcs);
  check(`an NPC guard's list contains his ${GUARD_WEAPON}`, items.includes(GUARD_WEAPON), items.join(', '));
  // The officer is issued a rifle himself, so this one hits the floor — but it
  // still has to leave the guard, which is the part that matters.
  check('and it can be taken off him', s.confiscate(GUARD_WEAPON, [officer], npcs) === 'dropped');
  check('leaving him without one', !npcs.itemsOf(guardId).includes(GUARD_WEAPON));
}

// ---------------------------------------------------------------------------
// The asymmetry, end to end.
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
  /** Deliver a client message to the server, synchronously. */
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

console.log('\n=== the item list reaches the officer and nobody else ===');
{
  const wss = new FakeServer();
  const server = new GameServer(wss as unknown as WebSocketServer);

  // Three players: the officer, the man he searches, and a bystander standing
  // close enough to watch it happen. The bystander is the interesting one.
  const sockets = [wss.connect(), wss.connect(), wss.connect()];
  for (const [i, s] of sockets.entries()) {
    s.say({ t: 'join', protocol: PROTOCOL_VERSION, name: `p${i + 1}`, role: 'doctor' });
  }

  const ids = sockets.map((s) => {
    const welcome = s.sent.find((m) => m.t === 'welcome');
    return welcome && welcome.t === 'welcome' ? welcome.you.id : -1;
  });
  check('three players joined', ids.every((id) => id > 0), ids.join(', '));

  // Force the roles the scenario needs; the deal is random by design.
  sockets[0]!.say({ t: 'role', role: 'security' });
  sockets[1]!.say({ t: 'role', role: 'doctor' });
  sockets[2]!.say({ t: 'role', role: 'telegram' });
  // Stand them all together, well inside search reach and chat radius.
  for (const s of sockets) s.say({ t: 'teleport', x: 0, y: 0, z: 8 });
  // Give the target something worth finding.
  const mark = server['livePlayers']().find((p) => p.id === ids[1])!;
  mark.inventory.add('pistol');
  mark.inventory.add('gauze');
  // Grant the patrol standing directly — the patrol duty itself is duty-tests
  // business, and this test is about who hears what.
  server['duties'].set(ids[0]!, { searchEnabled: true } as never);

  for (const s of sockets) s.sent.length = 0;
  sockets[0]!.say({ t: 'searchStart', target: ids[1]! });

  const searchMsgs = sockets.map((s) => s.sent.filter((m) => m.t === 'search'));
  check('the officer is told', searchMsgs[0]!.length === 1);
  check('the man being searched is told', searchMsgs[1]!.length === 1);
  check('a bystander in earshot is told', searchMsgs[2]!.length === 1, 'two people standing still together is public');

  const officerMsg = searchMsgs[0]![0];
  check(
    'and only the officer is told what is in the pockets',
    officerMsg?.t === 'search' && officerMsg.items?.includes('pistol') === true,
    JSON.stringify(officerMsg),
  );

  // The negative property, asserted over EVERY byte sent to anyone else.
  const leaked = sockets
    .flatMap((s, i) => (i === 0 ? [] : s.sent.map((m) => JSON.stringify(m))))
    .filter((json) => json.includes('pistol') || json.includes('"items"'));
  check(
    'no message to anybody else mentions the find, in any form',
    leaked.length === 0,
    leaked.join(' | '),
  );

  // Confiscation is silent too: the target learns his pockets changed, and that
  // is all anyone learns.
  for (const s of sockets) s.sent.length = 0;
  sockets[0]!.say({ t: 'confiscate', item: 'gauze' });

  const bystanderLeak = sockets[2]!.sent
    .map((m) => JSON.stringify(m))
    .filter((json) => json.includes('gauze'));
  check(
    'a bystander is not told what was taken',
    bystanderLeak.length === 0,
    bystanderLeak.join(' | '),
  );

  // The one thing that IS public, and deliberately so: a confiscated duplicate
  // lands on the floor as a real object, and a pistol lying in the hall is
  // something anybody can see and pick up. The officer chooses to pay that.
  for (const s of sockets) s.sent.length = 0;
  sockets[0]!.say({ t: 'confiscate', item: 'pistol' });
  check(
    'but a duplicate dropped at his feet is a public object, by design',
    sockets[2]!.sent.some((m) => m.t === 'itemAdded'),
  );
  check(
    'and even then nobody is told whose it was',
    sockets[2]!.sent.every((m) => m.t !== 'search' || m.items === undefined),
  );
  const targetSaw = sockets[1]!.sent.filter((m) => m.t === 'inventory');
  check('the target is told his own inventory changed', targetSaw.length === 1);
  check(
    'and his copy of the search still carries no list',
    sockets[1]!.sent.every((m) => m.t !== 'search' || m.items === undefined),
  );

  // Release, and confirm the end message is equally quiet.
  for (const s of sockets) s.sent.length = 0;
  sockets[0]!.say({ t: 'searchRelease' });
  const ends = sockets.flatMap((s) => s.sent.filter((m) => m.t === 'search'));
  check('everyone who saw it start sees it end', ends.length === 3, `${ends.length}`);
  check(
    'and no end message carries a list',
    ends.every((m) => m.t === 'search' && m.items === undefined),
  );

  server.close();
}

console.log('\n=== hidden pistol spots must not overlap container reach ===');
{
  // containerReach and item reach are each 2.0 m, so any pistol within 4 m of a
  // container gives the E key an ambiguous target — the player intends to pick up
  // the pistol and ends up opening a search instead.
  const minSep = GAME_CONFIG.world.containerReach + GAME_CONFIG.items.reach;
  for (const spot of HIDDEN_PISTOL_SPOTS) {
    for (const cdef of CONTAINERS) {
      const dist = Math.hypot(spot.x - cdef.x, spot.z - cdef.z);
      check(
        `pistol (${spot.x},${spot.z}) is ≥${minSep}m from ${cdef.label}`,
        dist >= minSep,
        `${dist.toFixed(2)} m`,
      );
    }
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
