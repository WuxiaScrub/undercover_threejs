import { Game } from './game/Game';
import { COMPOUND } from '../shared/mapData';
import { defaultServerUrl } from './net/Connection';
import { NetPanel } from './ui/NetPanel';

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const overlay = document.getElementById('overlay')!;
const debugElement = document.getElementById('debug')!;
const hudElement = document.getElementById('hud')!;
const netElement = document.getElementById('net-panel')!;

const game = new Game(canvas, overlay, debugElement, hudElement);
const panel = new NetPanel(netElement, defaultServerUrl());

panel.onConnect = (url, name) => game.connect(url, name);
panel.onDisconnect = () => game.disconnect();
game.onNetStatus = (status, detail, count) => panel.setStatus(status, detail, count);

game.start();

// Whoever served this page is almost certainly hosting the game too, so try it
// straight away. Failing that, the compound is perfectly playable solo.
game.connect(defaultServerUrl(), panel.name);

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__game = { game, COMPOUND };
}
