import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: the browser talks ONLY to the Vite origin; /api and /mcp are proxied to the gateway, so the session cookie is same-origin
// (exactly like production, where the Ingress serves dashboard + /api + /mcp from one host).
const gateway = process.env.VITE_GATEWAY_URL ?? 'http://localhost:8080';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: gateway, changeOrigin: false }, '/mcp': { target: gateway, changeOrigin: false } } },
  test: { environment: 'jsdom', setupFiles: ['./test/setup.js'], globals: true, include: ['test/**/*.test.{js,jsx}'] },
});
