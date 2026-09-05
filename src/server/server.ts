/**
 * LAN game server. Binds every interface so other PCs on the network can reach
 * it (CLAUDE.md §1) — no port forwarding, no matchmaking, no accounts.
 *
 *   npm run server      # this file
 *   npm run dev         # the client
 *   npm run play        # both at once
 */
import { networkInterfaces } from 'node:os';
import { WebSocketServer } from 'ws';
import { NET_CONFIG } from '../shared/net';
import { GameServer } from './GameServer';

const port = Number(process.env.PORT ?? NET_CONFIG.port);
const wss = new WebSocketServer({ host: '0.0.0.0', port });
const game = new GameServer(wss);

wss.on('listening', () => {
  const addresses = lanAddresses();
  console.log(`compound server listening on 0.0.0.0:${port}`);
  console.log('');
  if (addresses.length === 0) {
    console.log('  no LAN address found — only this machine can connect');
  } else {
    console.log('  tell the other players to open:');
    for (const ip of addresses) console.log(`    http://${ip}:5173`);
    console.log('');
    console.log('  the client auto-connects to the host it was loaded from,');
    console.log(`  i.e. ws://${addresses[0]}:${port}`);
  }
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log('\nshutting down');
    game.close();
    process.exit(0);
  });
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}
