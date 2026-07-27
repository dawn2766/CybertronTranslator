import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: [
        'icons/apple-touch-icon.png',
        'icons/pwa-icon-192.png',
        'icons/pwa-icon-512.png',
        'icons/pwa-icon-maskable-512.png',
      ],
      manifest: {
        name: '塞伯坦翻译器',
        short_name: '塞伯坦翻译器',
        description: '支持汽车人与霸天虎字形的离线塞伯坦翻译工具',
        lang: 'zh-CN',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'any',
        background_color: '#e9eae7',
        theme_color: '#e9eae7',
        categories: ['utilities', 'education'],
        icons: [
          {
            src: 'icons/pwa-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icons/pwa-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icons/pwa-icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{html,css,js,png,jpg,woff2,webmanifest}'],
        cleanupOutdatedCaches: true,
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});