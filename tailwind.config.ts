import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Editorial palette: warm paper, deep ink, one confident violet.
        paper: '#F4F1EA',
        'paper-soft': '#FBFAF6',
        ink: '#15101F',
        'ink-soft': '#544E60',
        line: '#E5E0D4',
        violet: {
          DEFAULT: '#5A27E0',
          dark: '#4A1FBE',
          soft: '#EDE7FB',
        },
      },
      fontFamily: {
        serif: ['var(--font-fraunces)', 'Georgia', 'Times New Roman', 'serif'],
        sans: ['var(--font-manrope)', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(21,16,31,0.04), 0 12px 30px -18px rgba(21,16,31,0.25)',
        violet: '0 10px 30px -12px rgba(90,39,224,0.5)',
      },
    },
  },
  plugins: [],
};

export default config;
