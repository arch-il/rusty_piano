// Must match the `coach serve --port` value (default 8765).
import { defineConfig } from "vite";

export default defineConfig({
  // coach serve accepts POSTs only from these two ports and its own (DEV_ORIGIN_PORTS in
  // server.py), so Vite must not move to another port.
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8765" } },
  preview: { port: 4173, strictPort: true },
  // OpenSheetMusicDisplay (with VexFlow) is one ~1.4 MB chunk, loaded lazily by
  // score-view.ts on the first score open, so the page itself stays small; the
  // limit only silences the warning for that chunk.
  build: { chunkSizeWarningLimit: 1600 },
});
