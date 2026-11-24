/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#FDF6E3',
        ink: '#111111',
        lemon: '#FFDE59',
        lime: '#B8F53D',
        punch: '#FF6B9D',
        sky: '#7DD3FC',
        grape: '#C4B5FD',
        tang: '#FFA94D',
      },
      boxShadow: {
        neo: '4px 4px 0 0 #111111',
        'neo-sm': '2px 2px 0 0 #111111',
        'neo-lg': '8px 8px 0 0 #111111',
      },
      fontFamily: {
        sans: ['"Space Grotesk"', 'system-ui', '"PingFang SC"', '"Microsoft YaHei"', 'sans-serif'],
        mono: ['"Space Mono"', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};