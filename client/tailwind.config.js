/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Sora"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      colors: {
        ink: {
          950: '#06060b',
          900: '#0b0b14',
          850: '#10101c',
          800: '#161624',
        },
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(129,140,248,0.25), 0 10px 40px -10px rgba(99,102,241,0.55)',
        card: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 20px 50px -20px rgba(0,0,0,0.7)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'fade-up': { from: { opacity: '0', transform: 'translateY(8px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'scale-in': { from: { opacity: '0', transform: 'scale(0.96)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(24px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'float-up': {
          '0%': { opacity: '0', transform: 'translateY(0) scale(0.6)' },
          '15%': { opacity: '1', transform: 'translateY(-20px) scale(1.1)' },
          '100%': { opacity: '0', transform: 'translateY(-260px) scale(1)' },
        },
        shimmer: { from: { backgroundPosition: '200% 0' }, to: { backgroundPosition: '-200% 0' } },
      },
      animation: {
        'fade-in': 'fade-in 200ms ease-out both',
        'fade-up': 'fade-up 300ms ease-out both',
        'scale-in': 'scale-in 180ms ease-out both',
        'slide-in-right': 'slide-in-right 260ms cubic-bezier(0.22,1,0.36,1) both',
        'float-up': 'float-up 3s ease-out forwards',
        shimmer: 'shimmer 6s linear infinite',
      },
    },
  },
  plugins: [],
}
