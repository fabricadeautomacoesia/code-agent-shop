import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        magenta: { DEFAULT: '#EC4899', glow: '#F472B6' },
        violet:  { deep: '#7C3AED' },
      },
      fontFamily: {
        sans: ['Inter','system-ui','sans-serif'],
        mono: ['JetBrains Mono','monospace'],
        display: ['Space Grotesk','Inter','sans-serif'],
      },
      animation: { 'pulse-slow': 'pulse 3s ease-in-out infinite' },
    },
  },
  plugins: [],
};
export default config;
