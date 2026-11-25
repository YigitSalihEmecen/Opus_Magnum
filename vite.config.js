import { defineConfig } from 'vite';

// relative asset URLs: the build works from any sub-path (GitHub Pages serves it at /<repo>/)
export default defineConfig({ base: './' });
