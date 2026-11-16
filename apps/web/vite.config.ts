import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    proxy: {
      // 前端只认 /api 与 /realtime，后端换实现（直连/Kafka）前端无感
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: true },
      '/realtime': { target: 'http://127.0.0.1:8080', changeOrigin: true, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks: {
          cesium: ['cesium'],
          three: ['three'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['cesium', 'three'],
  },
})
