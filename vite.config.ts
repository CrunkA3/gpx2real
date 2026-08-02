import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'ELEVATION_');
  const elevationProxyTarget = env.ELEVATION_PROXY_TARGET || 'https://api.opentopodata.org';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/elevation': {
          target: elevationProxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/elevation/, '') || '/',
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks: {
            three: ['three'],
            react: ['react', 'react-dom'],
          },
        },
      },
    },
  };
});
