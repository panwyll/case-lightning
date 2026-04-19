import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          // neon yellow – primary accent / headlines
          50: '#fffce0',
          100: '#fff799',
          400: '#ffe600',
          500: '#ffe600',
          600: '#cdb800',
          700: '#a39200',
          // neon pink – primary CTA
          pink: '#ff2d78',
          'pink-dim': '#cc0050',
          // neon blue – secondary accent
          blue: '#00d4ff',
          'blue-dim': '#0099bb',
        },
      },
      boxShadow: {
        'glow-yellow': '0 0 30px rgba(255,230,0,0.35)',
        'glow-pink': '0 0 25px rgba(255,45,120,0.45)',
        'glow-blue': '0 0 20px rgba(0,212,255,0.35)',
      },
    },
  },
  plugins: [],
};

export default config;
