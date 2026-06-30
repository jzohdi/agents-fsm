import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// vitePreprocess enables <script lang="ts"> in .svelte components.
export default { preprocess: vitePreprocess() };
