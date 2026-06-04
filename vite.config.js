import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // esbuild minify (default) + tree-shaking aktif otomatis di production.
    target: 'es2019',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // Pisahkan library berat ke chunk sendiri supaya:
        //  • bundle awal kecil (cepat di iPhone)
        //  • library yang jarang berubah bisa di-cache browser jangka panjang
        manualChunks: {
          react: ['react', 'react-dom'],
          charts: ['recharts'],
          supabase: ['@supabase/supabase-js'],
          xlsx: ['xlsx'],
          canvas: ['html2canvas'],
        },
      },
    },
  },
})
