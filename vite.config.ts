import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import obfuscator from "rollup-plugin-obfuscator";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async ({ command }) => {
  const isProd = command === "build";

  return {
    plugins: [
      react(),
      isProd && obfuscator({
        global: true,
        options: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.4,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        disableConsoleOutput: true,
        selfDefending: true,
      },
    }),
  ],
  clearScreen: false,
  resolve: {
    dedupe: ["@zflix/desktop-core"],
  },
  server: {
    port: 1440,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1441 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
};});
