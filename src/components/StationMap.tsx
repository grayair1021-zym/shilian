import { useEffect, useRef, useState } from 'react';
import type { GameState, PerceptionCue, Room } from '../game/types';
import { adjacency, doorStatusText, getRoom } from '../game/engine';
import { fieldRoute, sonarFresh } from '../game/deviceLogic';
import { InstrumentIcon } from './InstrumentIcon';

const W = 132, H = 96, GAP_X = 60, GAP_Y = 46, PAD = 48;
export interface MapActivity { key: number; kind: 'scan' | 'door' | 'drone' | 'power' | 'other'; roomId?: number; doorId?: string }

export function StationMap({ state, selectedRoom, selectedDoor, objective, activity, perceptionCue, onRoom, onDoor }: {
  state: GameState;
  selectedRoom: number | null;
  selectedDoor: string | null;
  objective?: number;
  activity: MapActivity | null;
  perceptionCue?: PerceptionCue;
  onRoom: (id: number, inspectOnly?: boolean) => void;
  onDoor: (id: string) => void;
}) {
  const minX = Math.min(...state.rooms.map((r) => r.x));
  const minY = Math.min(...state.rooms.map((r) => r.y));
  const vw = PAD * 2 + (Math.max(...state.rooms.map((r) => r.x)) - minX + 1) * (W + GAP_X) - GAP_X;
  const vh = PAD * 2 + (Math.max(...state.rooms.map((r) => r.y)) - minY + 1) * (H + GAP_Y) - GAP_Y;
  const px = (r: Room) => PAD + (r.x - minX) * (W + GAP_X);
  const py = (r: Room) => PAD + (r.y - minY) * (H + GAP_Y);
  const here = getRoom(state, state.player.room);
  const adj = adjacency(state, here.id);
  const known = new Set([here.id, state.podRoom, ...adj.map((a) => a.room.id), ...state.rooms.filter((r) => r.visited).map((r) => r.id)]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [camera, setCamera] = useState({ cx: vw / 2, cy: vh / 2, zoom: 1 });
  const cam = useRef(camera); cam.current = camera;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  const inspected = useRef(false);
  const cancelPress = () => { if (longPress.current) window.clearTimeout(longPress.current.timer); longPress.current = null; };
  const fresh = sonarFresh(state);
  const route = objective ? fieldRoute(state, objective) : [];
  const viewW = vw / camera.zoom, viewH = vh / camera.zoom;
  const viewX = camera.cx - viewW / 2, viewY = camera.cy - viewH / 2;
  const setView = (cx: number, cy: number, zoom: number) => setCamera({ cx: Math.max(0, Math.min(vw, cx)), cy: Math.max(0, Math.min(vh, cy)), zoom: Math.max(0.85, Math.min(2.5, zoom)) });
  const focusPlayer = () => setView(px(here) + W / 2, py(here) + H / 2, 1.6);

  useEffect(() => {
    const node = svg.current;
    if (!node) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const current = cam.current;
      setCamera({ ...current, zoom: Math.max(0.85, Math.min(2.5, current.zoom * (e.deltaY > 0 ? 0.9 : 1.1))) });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  useEffect(() => () => cancelPress(), []);

  return (
    <div className="station-map">
      <div className="map-heading"><div><span className="map-overline">回声 7 号 / 科研空间站</span><h1>失联之后<span>现场地图</span></h1></div><span className="map-scale-label">{String(state.rooms.filter((r) => r.visited).length).padStart(2, '0')} / {state.rooms.length}<small>已探索舱室</small></span></div>
      <div className="map-canvas">
        <svg ref={svg} viewBox={`${viewX} ${viewY} ${viewW} ${viewH}`} className={perceptionCue === 'fracture' ? 'station-fracture' : perceptionCue === 'tremor' ? 'station-tremor' : ''} role="group" aria-label="空间站地图，点击相邻房间移动" style={{ touchAction: 'pan-y' }}
          onPointerDown={(e) => {
            if (e.pointerType === 'touch' || (e.target as Element).closest('[data-map-target]')) return;
            drag.current = { x: e.clientX, y: e.clientY, cx: camera.cx, cy: camera.cy };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!drag.current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const ratio = Math.min(rect.width / viewW, rect.height / viewH);
            setView(drag.current.cx - (e.clientX - drag.current.x) / ratio, drag.current.cy - (e.clientY - drag.current.y) / ratio, camera.zoom);
          }}
          onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
          <defs>
            <pattern id="deck-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#93afc1" strokeOpacity=".07" strokeWidth=".5" /></pattern>
            <pattern id="deck-unlit" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><path d="M0 0V6" stroke="#7c8f9b" strokeWidth="1" strokeOpacity=".18" /></pattern>
          </defs>
          <rect x={-500} y={-500} width={vw + 1000} height={vh + 1000} fill="url(#deck-grid)" pointerEvents="none" />
          <rect x={17} y={17} width={vw - 34} height={vh - 34} rx="28" fill="none" stroke="#2b3c48" strokeDasharray="2 7" pointerEvents="none" />
          <text x={27} y={32} fill="#405767" fontSize="9" letterSpacing="3" pointerEvents="none">舱体结构 / 非等比示意</text>
          {Object.values(state.doors).map((d) => {
            const a = getRoom(state, d.a), b = getRoom(state, d.b);
            const x1 = px(a) + W / 2, y1 = py(a) + H / 2, x2 = px(b) + W / 2, y2 = py(b) + H / 2;
            const x = (x1 + x2) / 2, y = (y1 + y2) / 2;
            const seen = a.visited || b.visited || state.mode === 'solo';
            const focused = d.a === hovered || d.b === hovered || selectedDoor === d.id;
            const caution = fresh && state.sonar?.doorId === d.id;
            const onRoute = route.some((id, i) => i < route.length - 1 && ((id === d.a && route[i + 1] === d.b) || (id === d.b && route[i + 1] === d.a)));
            const color = caution ? '#d8a268' : !seen ? '#293743' : d.braced || d.status === 'locked' ? '#9f8156' : d.status === 'jammed' ? '#a65f59' : focused || onRoute ? '#94b5ce' : '#465b6b';
            return <g key={d.id}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#111b24" strokeWidth={13} />
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={focused ? 2.5 : 1.5} strokeDasharray={d.status === 'open' && seen ? '' : '4 5'} className="map-link" />
              {onRoute && <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="#a4c5df" strokeWidth="1" strokeDasharray="3 10" opacity=".7" pointerEvents="none" />}
              <g data-map-target="door" role="button" tabIndex={0} aria-label={`${d.id} 舱门，${seen ? doorStatusText(d.status) : '尚未确认状态'}，点击查看操作`} onClick={(e) => { e.stopPropagation(); onDoor(d.id); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onDoor(d.id); } }} className="door-target">
                <rect x={x - 18} y={y - 18} width="36" height="36" fill="transparent" />
                <rect x={x - 8} y={y - 10} width="16" height="20" rx="2" stroke={color} fill="#101922" strokeWidth={selectedDoor === d.id ? 2 : 1} />
                <path d={d.braced ? `M${x - 4} ${y - 5}l8 10m0-10l-8 10` : d.status === 'open' ? `M${x - 4} ${y - 5}v10m8-10v10` : `M${x} ${y - 6}v12`} stroke={color} strokeWidth={d.status === 'open' ? 1 : 2.5} className="door-leaves" />
                <text x={x} y={y - 16} textAnchor="middle" fontSize="10" fill={focused ? '#cbdde9' : '#607a8e'}>{seen ? d.id : ''}</text>
                {caution && <circle key={state.sonar?.turn} cx={x + 10} cy={y + 10} r="3.5" fill="#d8a268" className="sonar-marker" />}
              </g>
            </g>;
          })}
          {state.rooms.map((r) => {
            const x = px(r), y = py(r);
            const isHere = r.id === here.id, isAdjacent = adj.some((a) => a.room.id === r.id);
            const named = known.has(r.id) || state.mode === 'solo';
            const powered = state.zones[r.zone].powered;
            const danger = r.visited && r.fieldVerdict === 'danger';
            const isSelected = selectedRoom === r.id;
            const guide = objective === r.id && r.id !== here.id;
            const pings = state.pings.filter((p) => p.room === r.id);
            const alarm = danger ? '#b8766b' : isHere ? '#c4dfef' : isSelected ? '#8dafc9' : '#405567';
            return <g key={r.id} data-map-target="room" className={`room-target ${isHere ? 'is-here' : ''} ${isAdjacent ? 'is-adjacent' : ''}`} role="button" tabIndex={0}
              aria-label={`${r.id} 号${named ? r.name : '未探索区域'}${isAdjacent ? '，点击前往' : '，点击查看'}`}
              onPointerEnter={() => setHovered(r.id)} onPointerLeave={() => setHovered(null)} onFocus={() => setHovered(r.id)} onBlur={() => setHovered(null)}
              onPointerDown={(e) => {
                if (e.pointerType !== 'touch') return;
                cancelPress(); inspected.current = false;
                longPress.current = { x: e.clientX, y: e.clientY, timer: window.setTimeout(() => { inspected.current = true; onRoom(r.id, true); }, 450) };
              }}
              onPointerMove={(e) => { if (longPress.current && Math.abs(e.clientX - longPress.current.x) + Math.abs(e.clientY - longPress.current.y) > 10) cancelPress(); }}
              onPointerUp={cancelPress} onPointerCancel={cancelPress}
              onContextMenu={(e) => { e.preventDefault(); cancelPress(); onRoom(r.id, true); }}
              onClick={(e) => { if (inspected.current) { inspected.current = false; return; } onRoom(r.id, e.shiftKey); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRoom(r.id, e.shiftKey); } }}>
              <path d={`M${x + 8} ${y}H${x + W - 8}L${x + W} ${y + 8}V${y + H - 8}L${x + W - 8} ${y + H}H${x + 8}L${x} ${y + H - 8}V${y + 8}Z`} fill={r.visited ? '#14222f' : '#101b25'} stroke={alarm} strokeWidth={isHere || isSelected ? 1.8 : 1} strokeDasharray={!r.visited && !isAdjacent ? '4 5' : ''} className="room-shell" />
              <path d={`M${x + 8} ${y + 25}H${x + W - 8}M${x + 8} ${y + H - 22}H${x + W - 8}`} stroke="#2a4052" strokeWidth=".6" pointerEvents="none" />
              <rect x={x + 2} y={y + 2} width={W - 4} height={H - 4} rx="5" fill="url(#deck-unlit)" style={{ opacity: named && !powered ? 0.85 : 0 }} className="room-power" pointerEvents="none" />
              <text x={x + 10} y={y + 16} fontSize="10" fill="#6e889d">{String(r.id).padStart(2, '0')}</text><text x={x + W - 10} y={y + 16} fontSize="9" textAnchor="end" fill="#506b82">{r.zone} 区</text>
              <text x={x + W / 2} y={y + 52} fontSize="13" fontWeight={isHere ? 600 : 400} textAnchor="middle" fill={isHere ? '#e2f2fd' : named ? '#9db5c8' : '#4c667c'}>{named ? r.name : '未探索区域'}</text>
              <text x={x + 10} y={y + H - 9} fontSize="9" fill={isAdjacent ? '#8faec9' : '#516d84'}>{isHere ? '你在这里' : isAdjacent ? '点击前往' : r.visited ? '已探索' : '未知现场'}</text>
              <text x={x + W - 10} y={y + H - 9} textAnchor="end" fontSize="9" fill={danger ? '#c98a7e' : named && !powered ? '#ab8e63' : '#506b82'}>{danger ? '危险' : named && !powered ? '断电' : r.visited && r.items.length ? '有物资' : ''}</text>
              {isHere && <g pointerEvents="none"><path d={`M${x - 5} ${y + 18}v-15h15m${W - 20} 0h15v15M${x - 5} ${y + H - 18}v15h15m${W - 20} 0h15v-15`} fill="none" stroke="#a8cbe7" strokeWidth="2" /><circle cx={x + W / 2} cy={y + 12} r="3" fill="#d5e8f8" /></g>}
              {guide && <g pointerEvents="none"><circle cx={x + W - 12} cy={y + 36} r="4" fill="none" stroke="#d3b57a" /><path d={`M${x + W - 12} ${y + 29}v14m-7-7h14`} stroke="#d3b57a" strokeWidth=".7" /></g>}
              {state.drone.room === r.id && !state.drone.lost && (r.visited || state.mode === 'solo') && <path d={`M${x + 11} ${y + 34}l6 6-6 6-6-6Z`} fill="none" stroke="#6d99c0" />}
              {pings.length > 0 && <circle cx={x + W / 2} cy={y - 8} r="4" fill={pings.some((p) => p.kind === 'danger') ? '#b76760' : '#83a8c9'} pointerEvents="none" />}
              {activity?.roomId === r.id && (activity.kind === 'scan' || activity.kind === 'drone') && <circle key={activity.key} cx={x + W / 2} cy={y + H / 2} r="12" className="scan-wave" fill="none" stroke="#a7c9e2" strokeWidth="1.2" pointerEvents="none" />}
            </g>;
          })}
        </svg>
      </div>
      <footer className="map-footer"><div className="map-legend"><span><i className="legend-player" />当前位置</span><span><i className="legend-route" />点击前往</span><span><i className="legend-warning" />可疑来路 / 锁定</span><span>右键或长按：观察目标</span></div><div className="map-controls"><button onClick={() => setView(camera.cx, camera.cy, camera.zoom / 1.2)} aria-label="缩小地图">−</button><button onClick={() => setView(vw / 2, vh / 2, 1)} aria-label="显示全图">全图</button><button onClick={() => setView(camera.cx, camera.cy, camera.zoom * 1.2)} aria-label="放大地图">＋</button><button onClick={focusPlayer} aria-label="定位当前位置"><InstrumentIcon name="crosshair" size={15} /></button></div></footer>
    </div>
  );
}