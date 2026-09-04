/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    extend: {
      colors: {
        sakura: {
          50: '#FDF2F8',
          100: '#FCE7F3',
          200: '#FBCFE8',
          300: '#F9A8D4',
          400: '#F472B6',
          500: '#EC4899',
          600: '#DB2777',
        },
      },
      boxShadow: {
        float: '0 1px 2px rgba(0,0,0,0.04)',
        'float-lg': '0 8px 30px rgba(236,72,153,0.10), 0 1px 2px rgba(0,0,0,0.04)',
      },
      keyframes: {
        'bubble-in': {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'bubble-in': 'bubble-in 240ms cubic-bezier(0.16,1,0.3,1) both',
      },
    },
  },
  plugins: [],
}
