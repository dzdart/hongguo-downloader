import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 后端服务端口，可通过环境变量覆盖（默认 8080）
const BACKEND_PORT = process.env.BACKEND_PORT || '8080';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // 开发模式下将 API 与 SSE 请求代理到后端服务
      '/api': {
        target: `http://127.0.0.1:${BACKEND_PORT}`,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist-react',
    emptyOutDir: true,
  },
});
