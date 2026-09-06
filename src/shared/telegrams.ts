/**
 * The Telegram Operator's work (CLAUDE.md §24, §33).
 *
 * Three correct deciphers earn a signals report. The report itself is NOT
 * produced here — it is an item, added to the operator's inventory by
 * `GameServer`, precisely so that the most valuable information in the round is
 * a physical thing that can be dropped, looted, or taken off him in a search.
 * This class only counts the work.
 */
import { GAME_CONFIG } from './constants';
import { shuffle } from './rng';

const chatCfg = GAME_CONFIG.chat;

const WORD_LIST = [
  'CRANE', 'MAPLE', 'RIVER', 'STONE', 'EMBER',
  'CLOUD', 'DUSK', 'FLAME', 'FROST', 'GROVE',
  'HAVEN', 'IRON', 'JADE', 'KITE', 'LOTUS',
];

export type PuzzleState = {
  id: number;
  word: string;
  scrambled: string;
  solved: boolean;
};

/** Server-side telegram and puzzle management. */
export class TelegramSystem {
  private decipherCount = new Map<number, number>(); // playerId → count
  private broadcastCooldown = new Map<number, number>(); // playerId → ms timestamp
  private puzzles = new Map<number, PuzzleState>(); // player → active puzzle
  private nextPuzzleId = 1;

  reset(): void {
    this.decipherCount.clear();
    this.broadcastCooldown.clear();
    this.puzzles.clear();
  }

  /** Give a player a puzzle. Returns the puzzle. */
  startPuzzle(playerId: number): PuzzleState {
    const word = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)]!;
    const scrambled = shuffle([...word]).join('');
    const puzzle: PuzzleState = { id: this.nextPuzzleId++, word, scrambled, solved: false };
    this.puzzles.set(playerId, puzzle);
    return puzzle;
  }

  /** How many telegrams this player has deciphered this round. */
  deciphers(playerId: number): number {
    return this.decipherCount.get(playerId) ?? 0;
  }

  /**
   * Validate an answer.
   *
   * `earnedReport` is true on the tick the count reaches
   * `deciphersForIntel` — once, not on every subsequent decipher, so an
   * operator cannot farm reports by sitting at the console all round.
   */
  answer(playerId: number, word: string): { correct: boolean; totalDeciphers: number; earnedReport: boolean } {
    const puzzle = this.puzzles.get(playerId);
    if (!puzzle || puzzle.solved) return { correct: false, totalDeciphers: this.deciphers(playerId), earnedReport: false };
    if (word.toUpperCase() !== puzzle.word) {
      return { correct: false, totalDeciphers: this.deciphers(playerId), earnedReport: false };
    }
    puzzle.solved = true;
    const count = (this.decipherCount.get(playerId) ?? 0) + 1;
    this.decipherCount.set(playerId, count);
    return {
      correct: true,
      totalDeciphers: count,
      earnedReport: count === GAME_CONFIG.telegram.deciphersForIntel,
    };
  }

  canBroadcast(playerId: number, now: number): boolean {
    const last = this.broadcastCooldown.get(playerId) ?? 0;
    return now - last >= chatCfg.broadcastCooldownSeconds * 1000;
  }

  setBroadcastUsed(playerId: number, now: number): void {
    this.broadcastCooldown.set(playerId, now);
  }
}
