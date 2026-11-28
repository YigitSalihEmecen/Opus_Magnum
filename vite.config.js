import { defineConfig } from 'vite';

// relative asset URLs: the build works from any sub-path (GitHub Pages serves it at /<repo>/)
export default defineConfig({
  base: './',
  // three.js in a chunk of its own: it changes far less often than the game, so returning players keep it cached
  build: { rollupOptions: { output: { manualChunks: { three: ['three'] } } } },
});
