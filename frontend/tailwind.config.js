/** @type {import('tailwindcss').Config} */
export default {
  prefix: 'spw-',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'sagix-bg': '#0a0a0a',
        'sagix-card': '#1a1a1a',
        'sagix-border': '#333333',
        'sagix-text': '#e8e8e8',
        'sagix-muted': '#888888',
        'sagix-gold': '#d4a017',
        'sagix-positive': '#7dce7d',
        'sagix-negative': '#ce7d7d',
      },
    },
  },
  plugins: [],
};
