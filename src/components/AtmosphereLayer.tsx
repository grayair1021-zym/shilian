import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { audio } from '../audio';
import { fieldPerceptions } from '../game/atmosphere';
import type { FieldPerception, GameState } from '../game/types';
import { Btn } from './ui';

export type AtmosphereMode = 'standard' | 'reduced' | 'off';
const STORAGE_KEY = 'shilian.atmosphere-mode';

function initialMode(): AtmosphereMode {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'off' || saved === 'reduced' || saved === 'standard') return saved;
  } catch { /* 隐私模式仍能使用默认设置。 */ }
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'standard';
}

export function useAtmosphere(
  state: GameState | null,
  session: string,
  running: boolean,
  soundOn: boolean,
) {
  const [mode, setMode] = useState<AtmosphereMode>(initialMode);
  const [visible, setVisible] = useState(() => !document.hidden);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [event, setEvent] = useState<FieldPerception | null>(null);
  const [inspected, setInspected] = useState<number | null>(null);
  const seen = useRef({ session: '', id: 0 });
  const lastPlayed = useRef(-Infinity);
  const lastAlarm = useRef(-Infinity);
  const effects = state ? fieldPerceptions(state) : [];
  const latestId = effects[effects.length - 1]?.id ?? 0;
  const active = running && visible && mode !== 'off';
  const lowOxygen = !!state && state.oxygen <= 30;
  const strength = mode === 'reduced' || reducedMotion ? 0.4 : 1;

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(media.matches);
    document.addEventListener('visibilitychange', onVisibility);
    media.addEventListener('change', onMotion);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      media.removeEventListener('change', onMotion);
    };
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* 设置仍在当前页面有效。 */ }
  }, [mode]);

  useEffect(() => {
    if (seen.current.session !== session) {
      // 重连只接收记录，不重播已经发生的惊扰。
      seen.current = { session, id: latestId };
      lastPlayed.current = -Infinity;
      lastAlarm.current = -Infinity;
      setEvent(null);
      return;
    }
    const prior = seen.current.id;
    seen.current.id = Math.max(prior, latestId);
    setEvent(null);
    if (!state || !active) return;
    const fresh = effects.filter((e) => e.id > prior && e.roomId === state.player.room && state.turn - e.turn <= 2);
    const alarm = fresh.find((e) => e.cue === 'suit') ?? fresh.find((e) => e.cue === 'fracture');
    const next = alarm ?? fresh.pop();
    if (!next) return;
    if (alarm) {
      if (Date.now() - lastAlarm.current < 1_000) return;
      lastAlarm.current = Date.now();
    } else if (Date.now() - lastPlayed.current < 18_000) return;
    else lastPlayed.current = Date.now();
    const beats: number[] = [];
    if (soundOn) {
      audio.atmosphere(next.cue, next.direction, strength);
      if (next.cue === 'suit') {
        audio.play('hit');
        beats.push(window.setTimeout(() => audio.play('heartbeat'), 450));
        beats.push(window.setTimeout(() => audio.play('heartbeat'), 1200));
      }
    }
    if (soundOn && next.cue === 'suit' && fresh.some((e) => e.cue === 'fracture')) {
      audio.atmosphere('fracture', '本舱', strength * 0.65);
    }
    // 声音先到，视觉随后；不是延迟网络或改写消息。
    const appear = window.setTimeout(() => setEvent(next), alarm ? 0 : 420);
    const finish = window.setTimeout(() => setEvent(null), alarm ? 2_200 : 5_200);
    return () => {
      window.clearTimeout(appear);
      window.clearTimeout(finish);
      beats.forEach((timer) => window.clearTimeout(timer));
      audio.stopAtmosphere();
    };
    // Only an actual event, a room change or a comfort-state change can trigger playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestId, session, active, state?.player.room, strength, soundOn]);

  useEffect(() => {
    if (!active || !soundOn) {
      audio.stopAtmosphere();
      return;
    }
    if (!lowOxygen) return;
    const interval = window.setInterval(() => audio.breathe(strength), 12_000);
    const start = window.setTimeout(() => audio.breathe(strength), 1_400);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(start);
      audio.stopAtmosphere();
    };
  }, [active, soundOn, lowOxygen, strength]);

  // 生命值过低时：缓慢心跳声，与呼吸声错开，不叠加刷屏
  const lowHealth = !!state && state.player.health <= 35 && state.status === 'playing';
  useEffect(() => {
    if (!active || !soundOn || !lowHealth) return;
    const beat = () => { audio.play('heartbeat'); };
    const interval = window.setInterval(beat, 9_000);
    const start = window.setTimeout(beat, 800);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(start);
    };
  }, [active, soundOn, lowHealth]);

  useEffect(() => () => audio.stopAtmosphere(), []);

  return {
    mode, setMode, event: active ? event : null, active,
    mapCue: active && event && effects.some((e) => e.cue === 'fracture' && e.turn === event.turn && e.roomId === event.roomId) ? 'fracture' as const : active ? event?.cue : undefined,
    reduced: mode === 'reduced' || reducedMotion,
    lowOxygen: active && lowOxygen,
    fog: active && !!state?.rooms.find((r) => r.id === state.player.room)?.visualNoise,
    dark: active && !!state && !state.zones[state.rooms.find((r) => r.id === state.player.room)!.zone].powered,
    glimpseDismissed: event?.id === inspected,
    dismissGlimpse: () => setInspected(event?.id ?? null),
  };
}

export function AtmosphereLayer({
  event, reduced, lowOxygen, dark, fog, glimpseDismissed,
}: {
  event: FieldPerception | null;
  reduced: boolean;
  lowOxygen: boolean;
  dark: boolean;
  fog: boolean;
  glimpseDismissed: boolean;
}) {
  return (
    <div
      className={`atmosphere-layer ${reduced ? 'atmosphere-reduced' : ''}`}
      aria-hidden="true"
      style={{ '--atmosphere-strength': reduced ? 0.4 : 1 } as CSSProperties}
    >
      <div className={`atmosphere-edge ${lowOxygen ? 'edge-oxygen' : dark ? 'edge-dark' : ''}`} />
      {fog && <div className="ambient-fog" />}
      {event?.cue === 'lamp' && <div key={event.id} className="lamp-dip" />}
      {event?.cue === 'suit' && <div key={event.id} className="suit-flash" />}
      {event?.cue === 'fracture' && <div key={event.id} className="hull-flash" />}
      {event?.cue === 'fog' && !glimpseDismissed && (
        <svg className="fog-glimpse" key={event.id} viewBox="0 0 120 230" fill="none">
          <path d="M30 8V224 M45 5V230 M93 10V222" stroke="currentColor" strokeWidth="5" />
          <path d="M64 87Q49 104 53 135L48 185M63 91Q81 104 78 142L81 188" stroke="currentColor" strokeWidth="12" />
          <path d="M61 56Q82 52 78 77Q69 96 61 76Z" fill="currentColor" />
        </svg>
      )}
      {event?.cue === 'glass' && !glimpseDismissed && (
        <svg className="glass-trace" key={event.id} viewBox="0 0 200 260" fill="none">
          <path d="M64 212L58 163Q22 145 31 130Q40 121 67 139L55 74Q52 55 62 55Q73 53 78 115L76 42Q78 24 87 29Q98 32 99 111L110 35Q115 20 122 33L120 122L139 65Q146 46 153 60L139 147Q143 192 126 207L133 249" stroke="currentColor" strokeWidth="8" strokeLinecap="round" />
          <path d="M78 168Q97 143 121 170M91 207L96 243" stroke="currentColor" strokeWidth="4" />
        </svg>
      )}
    </div>
  );
}

export function AtmosphereSettings({ mode, onChange }: { mode: AtmosphereMode; onChange: (mode: AtmosphereMode) => void }) {
  return (
    <fieldset className="comfort-setting">
      <legend>氛围强度</legend>
      <div>
        {(['standard', 'reduced', 'off'] as const).map((m) => (
          <button type="button" key={m} aria-pressed={mode === m} onClick={() => onChange(m)}>
            {m === 'standard' ? '标准' : m === 'reduced' ? '减弱' : '关闭'}
          </button>
        ))}
      </div>
      <p>只调节音画，不改变资源、事件或信息记录。</p>
    </fieldset>
  );
}

export function KnockChoice({
  pending, onAnswer, onIgnore,
}: {
  pending: GameState['pendingKnock'];
  onAnswer: () => void;
  onIgnore: () => void;
}) {
  if (!pending) return null;
  return (
    <section className="knock-choice" aria-label="现场抉择">
      <div><span />{pending.dir}，三短两长。</div>
      <p>声音停在墙的另一侧。现在还不需要回答。</p>
      <div className="knock-actions">
        <Btn onClick={onIgnore}>不回应 · 不耗回合</Btn>
        <Btn variant="danger" onClick={onAnswer}>敲回去 · 1 回合</Btn>
      </div>
      <small>敲击会制造噪声。离开此舱也可以；不会自动替你选择。</small>
    </section>
  );
}
