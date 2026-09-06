import { GAME_CONFIG } from '../../shared/constants';
import type { DutyStatus } from '../../shared/duty';
import { FACTION_NAME, type Faction } from '../../shared/factions';
import { ITEMS, type ItemId } from '../../shared/inventory';
import type { RoundPhase, ServerMessage } from '../../shared/net';
import { ROLE_STATS, type RoleStats } from '../../shared/roles';
import { WEAPONS } from '../../shared/weapons';
import type { WeaponSystem } from '../weapons/WeaponSystem';

const HITMARKER_MS = 140;
const HURT_MS = 90;
/** How long a guard's shout stays on screen. */
const ALERT_MS = 4000;
const MAX_ALERTS = 4;

/**
 * The local player's HUD (CLAUDE.md §10, §30).
 *
 * It shows YOUR health, YOUR stamina and what is in YOUR hands. It never shows
 * another player's health, and it never shows anybody's faction.
 */
export class HUD {
  private readonly roleLabel: HTMLElement;
  private readonly staminaFill: HTMLElement;
  private readonly staminaBar: HTMLElement;
  private readonly healthFill: HTMLElement;
  private readonly weaponLabel: HTMLElement;
  private readonly kitLabel: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly alerts: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly hurt: HTMLElement;
  private readonly death: HTMLElement;
  private readonly deathDetail: HTMLElement;
  private readonly round: HTMLElement;
  private readonly roundPhase: HTMLElement;
  private readonly roundClock: HTMLElement;
  private readonly roundFaction: HTMLElement;
  private readonly duty: HTMLElement;
  private readonly result: HTMLElement;
  private readonly resultWinner: HTMLElement;
  private readonly resultReason: HTMLElement;
  private readonly resultReveal: HTMLElement;
  private readonly reportPanel: HTMLElement;
  private readonly reportTruth: HTMLElement;
  private readonly reportList: HTMLElement;
  private reportOpen = false;
  private readonly inventoryPanel: HTMLElement;
  private readonly inventoryList: HTMLElement;
  private inventoryOpen = false;
  private inventoryItems: ItemId[] = [];
  private inventorySelected = 0;

  // chat
  private readonly chatLog: HTMLElement;
  private readonly chatInputRow: HTMLElement;
  private readonly chatPromptLabel: HTMLElement;
  private readonly chatInputText: HTMLElement;
  private readonly searchProgress: HTMLElement;
  private readonly searchLabel: HTMLElement;
  private readonly searchBarFill: HTMLElement;

  /**
   * YOUR allegiance. Kept here rather than passed in every frame because it is
   * told to you once, in a message addressed to you alone, and there is nowhere
   * else in this class it could come from.
   */
  private faction: Faction | null = null;
  private factionVisible = true;

  private hitmarkerTimer: ReturnType<typeof setTimeout> | null = null;
  private hurtTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPrompt = '';

  constructor(root: HTMLElement) {
    this.roleLabel = root.querySelector('#hud-role')!;
    this.staminaFill = root.querySelector('#hud-stamina-fill')!;
    this.staminaBar = root.querySelector('#hud-stamina')!;
    this.healthFill = root.querySelector('#hud-health-fill')!;
    this.weaponLabel = root.querySelector('#hud-weapon')!;
    this.kitLabel = root.querySelector('#hud-kit')!;
    this.prompt = document.getElementById('prompt')!;
    this.alerts = document.getElementById('alerts')!;
    this.hitmarker = document.getElementById('hitmarker')!;
    this.hurt = document.getElementById('hurt')!;
    this.death = document.getElementById('death')!;
    this.deathDetail = document.getElementById('death-detail')!;
    this.round = document.getElementById('round')!;
    this.roundPhase = document.getElementById('round-phase')!;
    this.roundClock = document.getElementById('round-clock')!;
    this.roundFaction = document.getElementById('round-faction')!;
    this.duty = document.getElementById('duty')!;
    this.result = document.getElementById('result')!;
    this.resultWinner = document.getElementById('result-winner')!;
    this.resultReason = document.getElementById('result-reason')!;
    this.resultReveal = document.getElementById('result-reveal')!;
    this.reportPanel = document.getElementById('report')!;
    this.reportTruth = document.getElementById('report-truth')!;
    this.reportList = document.getElementById('report-list')!;
    this.inventoryPanel = document.getElementById('inventory')!;
    this.inventoryList = document.getElementById('inventory-list')!;
    this.chatLog = document.getElementById('chat-log')!;
    this.chatInputRow = document.getElementById('chat-input-row')!;
    this.chatPromptLabel = document.getElementById('chat-prompt-label')!;
    this.chatInputText = document.getElementById('chat-input-text')!;
    this.searchProgress = document.getElementById('search-progress')!;
    this.searchLabel = document.getElementById('search-label')!;
    this.searchBarFill = document.getElementById('search-bar-fill')!;
  }

  // ---------------------------------------------------------------- the round

  /**
   * Phase, clock and — only if the player has asked for it with F4 — their own
   * allegiance. `secondsLeft` is computed by the caller against the server clock
   * so this class needs no notion of what time it is.
   */
  setRound(phase: RoundPhase, secondsLeft: number, players: number): void {
    this.round.classList.add('show');
    this.roundPhase.textContent =
      phase === 'lobby'
        ? `WAITING — ${players} PLAYER${players === 1 ? '' : 'S'}`
        : phase === 'active'
          ? 'ROUND IN PROGRESS'
          : 'ROUND OVER';
    this.roundClock.textContent = phase === 'lobby' ? '--:--' : clock(secondsLeft);
    this.renderFaction();
  }

  /**
   * The patrol line (CLAUDE.md §15). Unlike the faction this is always on show:
   * it is his job, he is allowed to know it, and the tension of the mechanic is
   * that he can see the clock running down while he is somewhere he would rather
   * be. `null` clears it — he is not the officer, or there is no round on.
   *
   * `dwell` counting up is worth showing. Without it, standing in the right room
   * for three seconds feels like nothing happening.
   */
  setDuty(duty: DutyStatus | null): void {
    if (!duty) {
      this.duty.textContent = '';
      this.duty.className = '';
      return;
    }

    const dwelling = duty.dwell > 0;
    const left = Math.ceil(GAME_CONFIG.duty.patrolDwellSeconds - duty.dwell);
    if (duty.secondsLeft === 0 && !dwelling) {
      // Non-security role: show label + optional detail
      this.duty.textContent = duty.detail ? `${duty.label}: ${duty.detail}` : duty.label;
      this.duty.className = '';
    } else {
      this.duty.textContent = dwelling
        ? `PATROL: ${duty.label} — HOLD ${Math.max(1, left)}`
        : duty.ok
          ? `PATROL: ${duty.label} — ${clock(duty.secondsLeft)}`
          : `PATROL OVERDUE: ${duty.label} — SEARCH DISABLED`;
      this.duty.className = dwelling ? 'arriving' : duty.ok ? '' : 'late';
    }
  }

  /**
   * Your own faction, from the one message that carries it. Never displayed
   * until F4 is pressed (CLAUDE.md §30, §38): the point of a hidden allegiance
   * is that it does not sit on your screen where a person behind you can read it.
   */
  setFaction(faction: Faction | null): void {
    this.faction = faction;
    this.renderFaction();
  }

  /** @returns whether it is now showing, for the debug readout. */
  toggleFaction(): boolean {
    this.factionVisible = !this.factionVisible;
    this.renderFaction();
    return this.factionVisible;
  }

  private renderFaction(): void {
    const show = this.factionVisible && this.faction !== null;
    this.roundFaction.textContent = show ? `YOU ARE ${FACTION_NAME[this.faction!]}` : '';
    this.roundFaction.className = show ? this.faction! : '';
  }

  /**
   * The scoreboard. Everybody's allegiance is on it, which is safe here and
   * nowhere else: by the time this arrives there is nothing left to deduce.
   */
  showResult(msg: Extract<ServerMessage, { t: 'roundOver' }>): void {
    this.result.classList.add('show');
    this.resultWinner.textContent = `${FACTION_NAME[msg.winner]}S WIN`;
    this.resultReason.textContent = msg.reason;
    this.resultReveal.replaceChildren(
      ...msg.reveal.map((r) => {
        const line = document.createElement('div');
        line.className = r.faction;
        line.textContent =
          `${r.name} — ${ROLE_STATS[r.role].name.toUpperCase()} — ${FACTION_NAME[r.faction]}`;
        return line;
      }),
    );
  }

  hideResult(): void {
    this.result.classList.remove('show');
  }

  setRole(stats: RoleStats): void {
    this.roleLabel.textContent = stats.name.toUpperCase();
  }

  update(
    staminaFraction: number,
    exhausted: boolean,
    sprinting: boolean,
    healthFraction: number,
    weapons: WeaponSystem,
  ): void {
    this.staminaFill.style.width = `${clamp01(staminaFraction) * 100}%`;
    this.staminaBar.classList.toggle('exhausted', exhausted);
    this.staminaBar.classList.toggle('draining', sprinting);
    this.healthFill.style.width = `${clamp01(healthFraction) * 100}%`;
    this.weaponLabel.innerHTML = weaponText(weapons);
  }

  /**
   * The G-key hint. Only ever describes YOUR own kit and what is at your feet —
   * it never names who dropped it.
   */
  setPrompt(text: string): void {
    if (text === this.lastPrompt) return;
    this.lastPrompt = text;
    this.prompt.textContent = text;
    this.prompt.classList.toggle('show', text !== '');
  }

  /** A guard shouting within earshot. Everyone nearby sees the same line. */
  showAlert(text: string): void {
    const line = document.createElement('div');
    line.className = 'alert';
    line.textContent = text;
    this.alerts.appendChild(line);
    while (this.alerts.childElementCount > MAX_ALERTS) {
      this.alerts.firstElementChild?.remove();
    }
    setTimeout(() => line.remove(), ALERT_MS);
  }

  /** Attacker-side confirmation that a shot connected. */
  showHitmarker(lethal: boolean): void {
    this.hitmarker.classList.toggle('lethal', lethal);
    this.hitmarker.classList.add('show');
    if (this.hitmarkerTimer) clearTimeout(this.hitmarkerTimer);
    this.hitmarkerTimer = setTimeout(() => this.hitmarker.classList.remove('show'), HITMARKER_MS);
  }

  showHurt(): void {
    this.hurt.classList.add('show');
    if (this.hurtTimer) clearTimeout(this.hurtTimer);
    this.hurtTimer = setTimeout(() => this.hurt.classList.remove('show'), HURT_MS);
  }

  setDeath(dead: boolean, detail = ''): void {
    this.death.classList.toggle('show', dead);
    this.deathDetail.textContent = detail;
  }

  // --------------------------------------------------------- inventory panel

  /** Update the item list shown in the inventory panel. */
  syncInventory(items: ItemId[]): void {
    this.inventoryItems = items;
    if (this.inventorySelected >= items.length) this.inventorySelected = 0;
    if (this.inventoryOpen) this.renderInventory();
    // Always update the kit line in the HUD.
    this.kitLabel.textContent = kitText(items);
  }

  /** Toggle or force open/closed. Returns the new state. */
  toggleInventory(forceOpen?: boolean): boolean {
    this.inventoryOpen = forceOpen !== undefined ? forceOpen : !this.inventoryOpen;
    this.inventoryPanel.classList.toggle('show', this.inventoryOpen);
    if (this.inventoryOpen) this.renderInventory();
    return this.inventoryOpen;
  }

  /** Move selection up or down and return the new selected ItemId (or null). */
  selectInventory(delta: number): ItemId | null {
    if (this.inventoryItems.length === 0) return null;
    this.inventorySelected = (this.inventorySelected + delta + this.inventoryItems.length) % this.inventoryItems.length;
    this.renderInventory();
    return this.inventoryItems[this.inventorySelected] ?? null;
  }

  /** The currently selected item (or null when inventory is empty). */
  selectedItem(): ItemId | null {
    return this.inventoryItems[this.inventorySelected] ?? null;
  }

  isInventoryOpen(): boolean {
    return this.inventoryOpen;
  }

  // --------------------------------------------------------------- the report

  /**
   * Open the signals report (CLAUDE.md §33).
   *
   * The truth line is what the intelligence actually says; the numbered list is
   * everyone the operator may denounce with it. Players and NPCs are mixed and
   * nothing here distinguishes them — the panel is deliberately unable to tell
   * the reader which candidates are human.
   */
  showReport(truth: string, candidates: readonly { id: number; label: string }[]): void {
    this.reportOpen = true;
    this.reportPanel.classList.add('show');
    this.reportTruth.textContent = `${truth} IS AN INFILTRATOR`;
    this.reportList.replaceChildren(
      ...candidates.slice(0, 9).map((c, i) => {
        const row = document.createElement('div');
        row.className = 'report-row';
        row.textContent = `[${i + 1}]  ${c.label}`;
        return row;
      }),
    );
  }

  hideReport(): void {
    this.reportOpen = false;
    this.reportPanel.classList.remove('show');
  }

  isReportOpen(): boolean {
    return this.reportOpen;
  }

  // ----------------------------------------------------------- chat

  /**
   * The text line at the bottom left. Proximity chat is off for this build, so
   * in practice its only caller is the telegram decipher (plan M6) — hence the
   * label, which used to be a hard-coded `~`.
   */
  showChatInput(show: boolean, buffer = '', label = '~'): void {
    this.chatInputRow.classList.toggle('show', show);
    this.chatPromptLabel.textContent = label;
    this.chatInputText.textContent = buffer + (show ? '|' : '');
  }

  addChatLine(name: string, text: string, channel: 'local' | 'broadcast'): void {
    const line = document.createElement('div');
    line.className = `chat-line${channel === 'broadcast' ? ' broadcast' : ''}`;
    line.textContent = channel === 'broadcast' ? `[TELEGRAPH] ${name}: ${text}` : `${name}: ${text}`;
    this.chatLog.prepend(line);
    // Fade after 8 seconds.
    setTimeout(() => line.classList.add('fading'), 7500);
    setTimeout(() => line.remove(), 8500);
    // Keep at most 8 lines.
    while (this.chatLog.childElementCount > 8) this.chatLog.lastElementChild?.remove();
  }

  // ---------------------------------------------------------- search progress

  setSearchProgress(fraction: number | null, label = 'SEARCHING…'): void {
    const show = fraction !== null;
    this.searchProgress.classList.toggle('show', show);
    if (show) {
      this.searchLabel.textContent = label;
      this.searchBarFill.style.width = `${Math.min(1, fraction!) * 100}%`;
    }
  }

  private renderInventory(): void {
    this.inventoryList.replaceChildren(
      ...this.inventoryItems.map((id, i) => {
        const row = document.createElement('div');
        row.className = `inv-row${i === this.inventorySelected ? ' selected' : ''}`;
        row.textContent = `[${i + 1}]  ${ITEMS[id].name.toUpperCase()}`;
        return row;
      }),
    );
    if (this.inventoryItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'inv-empty';
      empty.textContent = 'EMPTY';
      this.inventoryList.replaceChildren(empty);
    }
  }
}

function weaponText(weapons: WeaponSystem): string {
  if (!weapons.held) {
    return weapons.inventory.length ? 'HANDS EMPTY' : 'UNARMED';
  }

  const def = WEAPONS[weapons.held];
  const name = def.name.toUpperCase();
  if (!weapons.visible) return `<span class="conceal">${name} · CONCEALED</span>`;
  if (weapons.reloading) return `${name} · RELOADING`;

  const ammo = `${weapons.magazine} / ${def.magazine}`;
  return weapons.magazine === 0
    ? `${name} <span class="empty">${ammo} — R TO RELOAD</span>`
    : `${name} ${ammo}`;
}

/** Everything carried, held or not — visible to you alone (CLAUDE.md §16). */
function kitText(items: ItemId[]): string {
  if (items.length === 0) return 'CARRYING NOTHING';
  return `CARRYING ${items.map((id) => ITEMS[id].name.toUpperCase()).join(' · ')}`;
}

/** m:ss, floored at zero — a negative clock reads as a bug, not as overtime. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
