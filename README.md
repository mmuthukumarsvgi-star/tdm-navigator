# TDM Navigator

React + TypeScript + Vite + Tailwind (v3) app.

## Run
```bash
npm install
npm run dev      # then open http://localhost:5173
npm run build    # production build into dist/
```
Requires Node.js 18+.

## Structure
- `src/TDMNavigator.tsx` – main UI and PK engine
- `src/drugData.ts` – drug database (with unit conversion factors)
- `src/pk.ts` – steady-state concentration helpers
