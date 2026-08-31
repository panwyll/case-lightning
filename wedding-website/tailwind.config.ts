import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './content/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Warm paper stock, deep forest ink, a single brass accent.
        paper: '#FAF6EF',
        'paper-deep': '#F1EADD',
        card: '#FFFDF9',
        ink: '#1C2B25',
        'ink-soft': '#5B6B63',
        line: '#E2D9C8',
        brass: {
          DEFAULT: '#A67C3D',
          dark: '#84602C',
          soft: '#F3E9D8',
        },
        forest: '#24463A',
      },
      fontFamily: {
        display: ['var(--font-display)', 'Cormorant Garamond', 'Georgia', 'serif'],
        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(28,43,37,0.04), 0 16px 40px -24px rgba(28,43,37,0.35)',
      },
      borderRadius: {
        xl2: '1.25rem',
      },
    },
  },
  plugins: [],
};

export default config;
