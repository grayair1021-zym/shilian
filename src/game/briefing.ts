import { hazardLine } from './content';
import { fieldPerceptions } from './atmosphere';
import { getRoom } from './engine';
import type { GameState } from './types';

export function oxygenCoarse(state: GameState): { text: string; level: 'ok' | 'warn' | 'bad' } {
  const o = state.oxygen;
  if (o > 60) return { text: '充足', level: 'ok' };
  if (o > 35) return { text: '偏低', level: 'warn' };
  if (o > 18) return { text: '告急', level: 'bad' };
  return { text: '临界', level: 'bad' };
}

export function fieldObservations(state: GameState): string[] {
  const room = getRoom(state, state.player.room);
  const out: string[] = [];
  const powered = state.zones[room.zone].powered;
  out.push(powered ? '舱内照明正常，通风在运转。' : '本舱断电，只有头灯的光。舱门无法自动开启。');
  if (room.hazard?.active) {
    out.push(hazardLine(room.hazard.kind, !room.hazard.visualHidden, room.id * 13 + (room.searched ? 5 : 0)));
  } else if (room.visualNoise) {
    out.push('冷凝雾很浓，你无法确认角落里有没有东西。');
  } else {
    out.push('就你看到的范围而言，这里没有明显危险。');
  }
  if (room.clue && room.searched) out.push(room.clue);
  if (room.sensorClueFound) out.push('这一舱的传感器状态可疑，远端读数未必可信。');
  const recent = fieldPerceptions(state).filter((e) => e.roomId === room.id && state.turn - e.turn <= 2).pop();
  if (recent) out.push(recent.text);
  return out;
}
