import type { CSSProperties } from 'react';

export type InstrumentIconName = 'search' | 'listen' | 'breath' | 'scan' | 'drone' | 'door' | 'power' | 'gear' | 'pause' | 'play' | 'arrow' | 'check' | 'oxygen' | 'bag' | 'crosshair' | 'close' | 'signal' | 'alert' | 'wrench' | 'medkit';
const paths: Record<InstrumentIconName, string> = {
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  listen: 'M7 11a5 5 0 1 1 9 3c-3 3-3 3-3 5a3 3 0 0 1-6 0M10 11a2 2 0 1 1 3 2M3 5C0 10 1 14 3 16M20 5c3 4 3 8 0 12',
  breath: 'M12 2v8M10 5C5 6 2 12 3 18c1 3 7 2 7-1V5M14 5c5 1 8 7 7 13-1 3-7 2-7-1V5',
  scan: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M2 12h20M8 8h8v8H8Z',
  drone: 'M8 9h8v7H8ZM5 5l4 5M19 5l-4 5M5 20l4-5M19 20l-4-5M2 3h6v4H2ZM16 3h6v4h-6ZM2 18h6v4H2ZM16 18h6v4h-6Z',
  door: 'M5 21V3h14v18M3 21h18M5 3l10 3v15M11 12h1',
  power: 'M12 2v10M6 5a9 9 0 1 0 12 0',
  gear: 'M9 2h6l1 4 4 1 2 5-3 3v4l-5 3-3-3-4 1-4-5 2-3-1-4 5-2ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  pause: 'M7 4v16M17 4v16', play: 'M6 3l15 9-15 9Z',
  arrow: 'M4 12h16M14 5l7 7-7 7', check: 'M4 12l5 5L21 5',
  oxygen: 'M8 6h8v15H8ZM10 2h4v4M8 14h8M11 9h2',
  bag: 'M6 7h12l2 14H4ZM9 7V3h6v4M8 13h8v5H8Z',
  crosshair: 'M12 2v4M12 18v4M2 12h4M18 12h4M19 12a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  close: 'M5 5l14 14M19 5L5 19', signal: 'M2 8a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8 16a6 6 0 0 1 8 0M12 20h.01',
  alert: 'M12 3l10 18H2ZM12 9v5M12 17h.01',
  wrench: 'M21 3l-4 4-3-3 4-4a7 7 0 0 0-8 9L3 17a3 3 0 0 0 4 4l8-8a7 7 0 0 0 6-10',
  medkit: 'M4 8h16v12H4ZM9 8V4h6v4M12 11v6M9 14h6',
};

export function InstrumentIcon({ name, size = 20, className, style }: { name: InstrumentIconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true"><path d={paths[name]} /></svg>;
}