/** @type {import('tailwindcss').Config} */
export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: '#0d1b12',
        panel: '#131c17',
        parchment: '#e8dcc0',
        seat0: '#56b4e9',
        seat1: '#e69f00',
        seat2: '#009e73',
        seat3: '#f0e442',
      },
    },
  },
  plugins: [],
};
