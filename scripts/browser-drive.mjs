/**
 * Drives the REAL client in headless Chrome over CDP — no Playwright, plain Node.
 * Start `npm run play` first; this connects to the Vite dev server on :5173,
 * drops the page into solo mode and then plays it with synthetic key, mouse and
 * wheel events, checking what the game actually does rather than what it exports.
 *
 * Screenshots land in .shots/. Two traps worth remembering:
 *   - HUD alerts self-destruct after 4 s, so read them at the moment they fire;
 *   - R respawns, and respawning is what clears a guard's grudge, so a memory
 *     test that presses it is testing nothing.
 */
import fs from 'node:fs';
import { launch } from './cdp.mjs';

const OUT = '.shots';
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? `   ${detail}` : ''}`);
};

const page = await launch('http://127.0.0.1:5173/');

await page.evaluate(`
  await new Promise(r => setTimeout(r, 3000));
  const { game } = window.__game;
  game.net.disconnect();
  game.input.pointerLocked = true;
  await new Promise(r => setTimeout(r, 800));

  const frames = (n = 6) => new Promise(res => {
    let left = n;
    const tick = () => (--left <= 0 ? res() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  const t = {
    frames,
    key: async (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
      await frames(4);
      window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
      await frames(4);
    },
    mouse: async (button) => {
      document.dispatchEvent(new MouseEvent('mousedown', { button, bubbles: true }));
      await frames(4);
      document.dispatchEvent(new MouseEvent('mouseup', { button, bubbles: true }));
      await frames(4);
    },
    wheel: async (deltaY) => {
      document.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      await frames(6);
    },
    place: async (x, z, yaw) => {
      game.player.body.position.x = x;
      game.player.body.position.z = z;
      game.player.body.velocity.x = 0;
      game.player.body.velocity.z = 0;
      if (yaw !== undefined) game.rig.yaw = yaw;
      await frames(8);
    },
    /** Empty the hands and the bag. Leaves the floor alone. */
    bare: async () => {
      for (const w of game.weapons.inventory.slice()) game.weapons.discard(w);
      game.discardMenu = null;
      await frames(4);
    },
    /** F5 cycles the public role, which also hands out that role's starting kit. */
    role: async (id) => {
      for (let i = 0; i < 8 && game.player.stats.id !== id; i++) await t.key('F5');
      await t.bare();
    },
    reset: async () => {
      game.items.clear();
      await t.bare();
      await t.key('F8');            // heal, revive, and put every guard back on patrol
      document.getElementById('alerts').innerHTML = '';
      await frames(4);
    },
    state: () => ({
      role: game.player.stats.id,
      pos: { x: +game.player.body.position.x.toFixed(2), z: +game.player.body.position.z.toFixed(2) },
      held: game.weapons.held,
      visible: game.weapons.visible,
      inv: game.weapons.inventory.slice(),
      menu: game.discardMenu ? game.discardMenu.slice() : null,
      prompt: (document.getElementById('prompt')?.textContent ?? '').trim(),
      alerts: Array.from(document.getElementById('alerts')?.children ?? []).map(e => e.textContent.trim()),
      health: game.health,
      maxHealth: game.maxHealth,
      alive: game.alive,
      floor: game.items.list().map(i => i.weapon),
      guards: game.npcs.snapshots().filter(n => n.kind === 'guard').map(n => n.mode),
    }),
  };
  window.__t = t;
  return true;
`);

const ev = (src) => page.evaluate(`const { game } = window.__game; const t = window.__t; ${src}`);

console.log('\n=== boot ===');
{
  const s = await ev('return t.state();');
  check('the game is up and playing solo', s.alive && s.health > 0, `${s.role}, ${s.health} HP at ${JSON.stringify(s.pos)}`);
  await page.screenshot(`${OUT}/01-compound.png`);
}

// ------------------------------------------------------------------ item 3
console.log('\n=== item 3: only the Security Officer may take a rifle ===');
{
  const r = await ev(`
    await t.reset();
    await t.role('doctor');
    await t.place(0, 20, Math.PI);
    const p = game.player.body.position;
    game.items.spawn('rifle', p.x, 0, p.z);
    await t.frames(8);
    const standingOverIt = t.state();
    await t.key('KeyE');
    const doctorTried = t.state();

    await t.role('security');          // clears the starting kit too
    await t.frames(8);
    await t.key('KeyE');
    const officerTook = t.state();
    return { standingOverIt, doctorTried, officerTook };
  `);
  check(
    'the doctor is refused it and it stays on the floor',
    r.doctorTried.inv.length === 0 && r.doctorTried.floor.includes('rifle'),
    `inv ${JSON.stringify(r.doctorTried.inv)}, floor ${JSON.stringify(r.doctorTried.floor)}`,
  );
  check(
    'and he is told why, rather than the key doing nothing',
    /only the Security Officer/i.test(r.standingOverIt.prompt),
    JSON.stringify(r.standingOverIt.prompt),
  );
  check(
    'the Security Officer picks that same rifle up',
    r.officerTook.inv.join() === 'rifle' && r.officerTook.floor.length === 0,
    `inv ${JSON.stringify(r.officerTook.inv)}, floor ${JSON.stringify(r.officerTook.floor)}`,
  );
  check('and picking it up did NOT put it on show', r.officerTook.visible === false);
}

// ------------------------------------------------------------------ item 4
console.log('\n=== item 4: E / RMB / scroll / G ===');
{
  const r = await ev(`
    await t.reset();
    await t.role('doctor');
    await t.place(0, 20, Math.PI);
    const p = game.player.body.position;
    game.items.spawn('pistol', p.x, 0, p.z);
    await t.frames(8);
    const offered = t.state();
    await t.key('KeyE');
    const picked = t.state();
    await t.mouse(2);
    const drawn = t.state();
    await t.mouse(2);
    const putAway = t.state();
    return { offered, picked, drawn, putAway };
  `);
  check('the prompt offers E for the pistol at your feet', /\[E\]\s*pick up/i.test(r.offered.prompt), JSON.stringify(r.offered.prompt));
  check('E takes it, concealed', r.picked.inv.includes('pistol') && !r.picked.visible);
  check('RMB draws it', r.drawn.visible === true && r.drawn.held === 'pistol');
  check('RMB again puts it away', r.putAway.visible === false && r.putAway.held === 'pistol');
  check('and the prompt then talks about drawing, not about numbers', /\[RMB\]/.test(r.putAway.prompt), JSON.stringify(r.putAway.prompt));

  const w = await ev(`
    // A Security Officer with both, so scrolling has somewhere to go.
    await t.reset();
    await t.role('security');
    const p = game.player.body.position;
    game.items.spawn('pistol', p.x, 0, p.z);
    await t.frames(6); await t.key('KeyE');
    game.items.spawn('rifle', p.x, 0, p.z);
    await t.frames(6); await t.key('KeyE');
    const two = t.state();
    await t.wheel(120);
    const scrolled = t.state();
    await t.wheel(-120);
    const back = t.state();
    await t.mouse(2);
    const shown = t.state();
    await t.wheel(120);
    const whileDrawn = t.state();
    return { two, scrolled, back, shown, whileDrawn };
  `);
  check('carrying two weapons', w.two.inv.length === 2, JSON.stringify(w.two.inv));
  check('scroll switches the selected weapon', w.scrolled.held !== w.two.held, `${w.two.held} → ${w.scrolled.held}`);
  check('and scrolling back returns to the first', w.back.held === w.two.held, w.back.held);
  check(
    'scrolling while a weapon is drawn keeps it drawn — switching is not a tell',
    w.shown.visible === true && w.whileDrawn.visible === true && w.whileDrawn.held !== w.shown.held,
    `${w.shown.held} → ${w.whileDrawn.held}, visible ${w.whileDrawn.visible}`,
  );

  const g = await ev(`
    const heldBefore = game.weapons.held;   // drawn, from the block above
    await t.key('KeyG');
    const thrown = t.state();
    return { heldBefore, thrown };
  `);
  check(
    'G with a weapon in hand throws THAT one away, with no menu',
    g.thrown.menu === null &&
      g.thrown.inv.length === 1 &&
      !g.thrown.inv.includes(g.heldBefore) &&
      g.thrown.floor.join() === g.heldBefore,
    `threw ${g.heldBefore}, kept ${JSON.stringify(g.thrown.inv)}`,
  );

  const menu = await ev(`
    await t.reset();
    await t.role('security');
    const p = game.player.body.position;
    game.items.spawn('pistol', p.x, 0, p.z);
    await t.frames(6); await t.key('KeyE');
    game.items.spawn('rifle', p.x, 0, p.z);
    await t.frames(6); await t.key('KeyE');
    if (game.weapons.visible) await t.mouse(2);
    await t.key('KeyG');
    const opened = t.state();
    await t.key('Escape');
    const cancelled = t.state();
    await t.key('KeyG');
    const reopened = t.state();
    await t.key('Digit1');
    const chose = t.state();
    return { opened, cancelled, reopened, chose };
  `);
  check('empty-handed with two in the bag, G asks which', menu.opened.menu?.length === 2, JSON.stringify(menu.opened.menu));
  check('and the question is drawn in the prompt line', /DISCARD/.test(menu.opened.prompt), JSON.stringify(menu.opened.prompt));
  check('Escape cancels it and you keep everything', menu.cancelled.menu === null && menu.cancelled.inv.length === 2);
  check(
    'picking [1] discards exactly that one',
    menu.chose.menu === null &&
      menu.chose.inv.length === 1 &&
      menu.chose.floor.join() === menu.reopened.menu[0],
    `dropped ${JSON.stringify(menu.chose.floor)}, kept ${JSON.stringify(menu.chose.inv)}`,
  );
  await page.screenshot(`${OUT}/02-discard-menu.png`);
}

// ------------------------------------------------------------------ item 2
console.log("\n=== item 2: the General's office ===");
{
  const approach = await ev(`
    await t.reset();
    await t.role('doctor');
    await t.place(0, -9, Math.PI);
    await t.frames(3);
    return t.state();
  `);
  check(
    'a doctor at the HQ door is warned off before anything else happens',
    approach.alerts.some((a) => /RESTRICTED|TURN BACK/i.test(a)),
    JSON.stringify(approach.alerts.slice(-2)),
  );
  await page.screenshot(`${OUT}/03-hq-approach.png`);

  const inside = await ev(`
    await t.place(0, -15, Math.PI);
    await t.frames(3);
    const entered = t.state();
    let hurtAfterMs = null;
    const start = performance.now();
    while (performance.now() - start < 10000) {
      await t.frames(20);
      if (!game.alive || game.health < game.maxHealth) { hurtAfterMs = performance.now() - start; break; }
    }
    return { entered, hurtAfterMs, after: t.state() };
  `);
  check(
    'stepping inside says plainly that they will fire',
    inside.entered.alerts.some((a) => /FIRE ON SIGHT/i.test(a)),
    JSON.stringify(inside.entered.alerts.slice(-2)),
  );
  check(
    'and the detail does fire on an intruding doctor',
    inside.hurtAfterMs !== null,
    inside.hurtAfterMs === null
      ? `unharmed, guards ${JSON.stringify(inside.after.guards)}`
      : `first hit after ${(inside.hurtAfterMs / 1000).toFixed(1)} s, ${inside.after.health}/${inside.after.maxHealth} HP`,
  );
  check(
    'with no warning stage in between',
    !inside.after.alerts.some((a) => /put the weapon away/i.test(a)),
    JSON.stringify(inside.after.alerts.slice(-3)),
  );
  await page.screenshot(`${OUT}/04-hq-inside.png`);

  const secretary = await ev(`
    await t.reset();
    await t.role('secretary');
    await t.key('F8');
    await t.place(0, -15, Math.PI);
    let hurt = false;
    const start = performance.now();
    while (performance.now() - start < 8000) {
      await t.frames(20);
      if (!game.alive || game.health < game.maxHealth) { hurt = true; break; }
    }
    return { hurt, s: t.state() };
  `);
  check(
    'the unarmed Secretary walks into the same room untouched',
    !secretary.hurt && secretary.s.guards.every((m) => m === 'patrol'),
    `${secretary.s.health}/${secretary.s.maxHealth} HP, guards ${JSON.stringify(secretary.s.guards)}`,
  );
  await page.screenshot(`${OUT}/05-secretary-inside.png`);
}

// ------------------------------------------------------------------ item 5
console.log('\n=== item 5: guards come to look at a gunshot ===');
{
  const r = await ev(`
    await t.reset();
    await t.role('security');
    await t.place(0, 22, Math.PI);
    const p = game.player.body.position;
    game.items.spawn('pistol', p.x, 0, p.z);
    await t.frames(8); await t.key('KeyE');
    if (!game.weapons.visible) await t.mouse(2);
    await t.frames(20);
    const before = t.state().guards;
    await t.mouse(0);
    await t.frames(20);
    const after = t.state().guards;
    return { before, after };
  `);
  check('before the shot everyone is on their rounds', r.before.every((m) => m === 'patrol'), JSON.stringify(r.before));
  check(
    'the shot sends guards to look',
    r.after.filter((m) => m === 'investigating').length > 0,
    JSON.stringify(r.after),
  );
  check(
    "but not all of them — the General's detail stays put",
    r.after.filter((m) => m === 'patrol').length >= 3,
    `${r.after.filter((m) => m === 'patrol').length} still on station`,
  );
  await page.screenshot(`${OUT}/06-investigating.png`);
}

// ------------------------------------------------------------------ item 1
console.log('\n=== item 1: a guard remembers the face ===');
{
  const r = await ev(`
    await t.reset();
    await t.role('doctor');
    await t.place(0, -4.5, Math.PI);
    const p = game.player.body.position;
    game.items.spawn('pistol', p.x, 0, p.z);
    await t.frames(8); await t.key('KeyE');
    if (!game.weapons.visible) await t.mouse(2);

    // Stand in front of the door sentries with it out until they mean it.
    let provoked = false;
    let start = performance.now();
    while (performance.now() - start < 9000) {
      await t.frames(20);
      if (game.npcs.snapshots().some(n => n.kind === 'guard' && n.mode === 'hostile')) { provoked = true; break; }
    }
    const whenProvoked = t.state();

    // Do everything right: put it away, get out of sight, wait it out.
    if (game.weapons.visible) await t.mouse(2);
    await t.place(-8, -5, Math.PI);
    const wasKilled = !game.alive;
    game.setAlive(true); game.health = game.maxHealth;   // NOT a respawn
    start = performance.now();
    while (performance.now() - start < 9000) await t.frames(30);
    const calmed = t.state();

    // Walk back out, empty-handed.
    game.setAlive(true); game.health = game.maxHealth;
    await t.place(0, -4.5, Math.PI);
    let reengagedAfterMs = null;
    start = performance.now();
    while (performance.now() - start < 4000) {
      await t.frames(5);
      game.health = game.maxHealth;
      if (game.npcs.snapshots().some(n => n.kind === 'guard' && n.mode === 'hostile')) {
        reengagedAfterMs = performance.now() - start;
        break;
      }
    }
    const returned = t.state();

    // And once he is killed, the slate really is wiped.
    await t.key('KeyR');
    await t.place(0, -4.5, Math.PI);
    start = performance.now();
    while (performance.now() - start < 3000) { await t.frames(5); game.health = game.maxHealth; }
    const forgiven = t.state();
    return { provoked, whenProvoked, wasKilled, calmed, returned, reengagedAfterMs, forgiven };
  `);
  check(
    'brandishing a pistol as a doctor gets you shot at',
    r.provoked,
    `guards ${JSON.stringify(r.whenProvoked.guards)}`,
  );
  check(
    'putting it away and breaking line of sight calms them',
    r.calmed.guards.filter((m) => m === 'hostile').length === 0,
    JSON.stringify(r.calmed.guards),
  );
  check(
    'but walking back into view unarmed is enough to be engaged again',
    r.returned.guards.includes('hostile'),
    r.reengagedAfterMs === null
      ? JSON.stringify(r.returned.guards)
      : `re-engaged after ${(r.reengagedAfterMs / 1000).toFixed(1)} s, no second warning`,
  );
  check(
    'and respawning is what clears it',
    !r.forgiven.guards.includes('hostile'),
    JSON.stringify(r.forgiven.guards),
  );
  await page.screenshot(`${OUT}/07-remembered.png`);
}

console.log('\n=== console ===');
const bad = page.logs.filter((l) => l.level === 'error' || l.level === 'exception');
check('no console errors', bad.length === 0, bad.map((b) => b.text).join(' | ').slice(0, 600));

console.log(failures === 0 ? '\nDRIVE PASSED\n' : `\n${failures} DRIVE CHECK(S) FAILED\n`);
page.close();
process.exit(failures === 0 ? 0 : 1);
