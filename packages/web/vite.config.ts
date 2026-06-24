import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// dev proxy:前端 `/api/*` → tiny_http server(同源、无 CORS,承 ADR-0022)。
// 打包形态(S10e)由 tiny_http 同端口服 dist + API,proxy 仅 dev 用。
const backend = process.env.UNDERSTAND_BOOK_ADDR
  ? `http://${process.env.UNDERSTAND_BOOK_ADDR}`
  : "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/api": {
        target: backend,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
