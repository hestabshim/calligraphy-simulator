import { defineConfig } from 'vite';

// Relative base so the build works at any path, including GitHub Pages' /<repo>/.
export default defineConfig({ base: './' });
