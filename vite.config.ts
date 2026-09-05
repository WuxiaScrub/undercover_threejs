import { defineConfig } from 'vite';

// Bind to every interface so other PCs on the LAN can load the client.
export default defineConfig({
  // The imported models live in assets/. Serving that as the public directory
  // is what gets them COPIED INTO A BUILD — `vite build` emits only the module
  // graph plus publicDir, so without this the game works under `npm run dev`
  // and then loads no art at all from `dist/`.
  //
  // Note the URL shape this implies: assets/3d/foo.fbx is fetched as /3d/foo.fbx,
  // with `assets/` stripped. See CharacterAssets.ts, the only place that builds
  // one of these URLs.
  publicDir: 'assets',
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
