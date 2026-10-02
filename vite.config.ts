import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()],
  base: './',
  build: { target: 'es2022' },
  server: { proxy: { '/api': { target: process.env.REPORTING_DEV_API_URL || 'http://127.0.0.1:5174', changeOrigin: true } } },
});
