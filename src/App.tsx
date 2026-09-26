import { useEffect, useRef, useState } from 'react';
import { audio } from './audio';
import { StartScreen } from './components/StartScreen';
import { ReportScreen } from './components/ReportScreen';
import { StationMap, type MapActivity } from './components/StationMap';
import { FieldHandset, type ActionFeedback } from './components/FieldHandset';
import { AtmosphereLayer, AtmosphereSettings, useAtmosphere } from './components/AtmosphereLayer';
import { InstrumentIcon } from './components/InstrumentIcon';
import { TrustGuide } from './components/TrustGuide';
import { QuickStart } from './components/QuickStart';
import { createGame } from './game/generator';
import { adjacency, readingText } from './game/engine';
import { applyFieldAction, applyOperatorAction, type FieldAction, type OperatorAction } from './game/actions';
import { deviceGuidance, sonarFresh, type DeviceSelection } from './game/deviceLogic';
import { randomSeed } from './game/rng';
import type { Difficulty, GameState } from './game/types';
import type { MissionReport } from './game/report';
import type { OperatorPresence, OperatorView } from './game/views';
import { OnlineClient, clearSession, defaultServerUrl, loadSession, rememberServerUrl, saveSession, type LinkStatus, type SyncPayload } from './net/client';
import './device.css';

export default function App() {
  const [screen, setScreen] = useState<'start' | 'play' | 'report'>('start');
  const [game, setGame] = useState<GameState | null>(null);
  const worldRef = useRef<GameState | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const [soundOn, setSoundOn] = useState(true);
  const [selection, setSelection] = useState<DeviceSelection | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const [mapActivity, setMapActivity] = useState<MapActivity | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [online, setOnline] = useState(false);
  const [link, setLink] = useState<LinkStatus>('offline');
  const [linkMessage, setLinkMessage] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [presence, setPresence] = useState<OperatorPresence | null>(null);
  const [opView, setOpView] = useState<OperatorView | null>(null);
  const [savedSession, setSavedSession] = useState(loadSession);
  const [session, setSession] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const [underAttack, setUnderAttack] = useState(false);
  const attackTimer = useRef<number | null>(null);
  const [report, setReport] = useState<MissionReport | null>(null);
  const [initialSeed] = useState(randomSeed);
  const client = useRef<OnlineClient | null>(null);
  const revision = useRef(-1);
  const round = useRef<string | null>(null);
  const riskConfirm = useRef<number | null>(null);
  const atmosphere = useAtmosphere(game, `${session}-${epoch}`, screen === 'play' && !paused && !settingsOpen && game?.status === 'playing' && link !== 'error', soundOn);
  const direct = !online || (!!opView && !presence?.connected);

  const triggerAttackVfx = () => {
    setUnderAttack(true);
    // 音频交给氛围层统一播放，避免同一次受伤播放两套心跳。
    if (attackTimer.current !== null) window.clearTimeout(attackTimer.current);
    attackTimer.current = window.setTimeout(() => setUnderAttack(false), 2400);
  };

  const publish = (next: GameState, playEffects = true) => {
    const prior = worldRef.current;
    if (playEffects && prior && next.status === 'playing') {
      const healthDrop = prior.player.health - next.player.health;
      const priorLast = prior.log[prior.log.length - 1];
      const nextLast = next.log[next.log.length - 1];
      const alertHit = nextLast && nextLast.id !== priorLast?.id && nextLast.side === 'alert' &&
         (nextLast.text.includes('反击失败') || nextLast.text.includes('撞了一下') || nextLast.text.includes('正面遭遇') || nextLast.text.includes('电弧擦过') || nextLast.text.includes('生命值 -'));
      if (healthDrop > 0.5 || alertHit) {
        triggerAttackVfx();
      }
    }
    worldRef.current = next;
    setGame(next);
  };
  const tell = (text: string, error = false) => setFeedback({ id: Date.now(), text, error });
  const setPause = (value: boolean) => { pausedRef.current = value; setPaused(value); };

  useEffect(() => { audio.enabled = soundOn; }, [soundOn]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSettingsOpen(false); setHelpOpen(false); setSelection(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (screen !== 'play' || paused || game?.status !== 'playing') return;
    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now(), current = worldRef.current;
      if (current?.status === 'playing' && !pausedRef.current) publish({ ...current, elapsedMs: current.elapsedMs + Math.min(2000, now - last) });
      last = now;
    }, 1000);
    return () => window.clearInterval(timer);
  }, [screen, paused, game?.status]);
  useEffect(() => {
    if (!mapActivity) return;
    const timer = window.setTimeout(() => setMapActivity(null), 1800);
    return () => window.clearTimeout(timer);
  }, [mapActivity]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), feedback.error ? 6500 : 3200);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    if (!online || game?.status === 'playing' || !game) return;
    const currentClient = client.current;
    const currentRound = round.current;
    let cancelled = false;
    void currentClient?.debrief().then((r) => { if (!cancelled && r && client.current === currentClient && round.current === currentRound) setReport(r as unknown as MissionReport); });
    return () => { cancelled = true; };
  }, [online, game?.status]);
  useEffect(() => () => { client.current?.close(); audio.stopAtmosphere(); if (attackTimer.current !== null) window.clearTimeout(attackTimer.current); }, []);

  const disconnect = () => {
    const previous = client.current;
    client.current = null;
    round.current = null;
    previous?.close();
    setOnline(false); setLink('offline'); setLinkMessage(null); setPresence(null); setOpView(null);
    busyRef.current = false; setBusy(false);
  };
  const reset = () => {
    worldRef.current = null;
    setUnderAttack(false);
    if (attackTimer.current !== null) window.clearTimeout(attackTimer.current);
    setPause(false); setSelection(null); riskConfirm.current = null;
    setSettingsOpen(false); setHelpOpen(false); setFeedback(null); setMapActivity(null);
    setReport(null); setSession((s) => s + 1); revision.current = -1;
  };
  const startSolo = (seed: string, difficulty: Difficulty) => {
    disconnect(); reset();
    publish(createGame(seed.trim() || randomSeed(), difficulty, 'solo'));
    setScreen('play'); audio.play('ping');
  };

  const sync = (payload: SyncPayload, source: OnlineClient) => {
    if (source !== client.current || payload.runId !== source.runId) return;
    if (payload.presentationBaseline) setEpoch((n) => n + 1);
    if (payload.revision <= revision.current) return;
    const changedRound = round.current !== null && round.current !== payload.roundId;
    if (changedRound) { reset(); setScreen('play'); }
    round.current = payload.roundId;
    revision.current = payload.revision;
    setPresence(payload.operator); setPause(payload.paused);
    if (payload.operator.connected || payload.operator.kind !== 'local') setOpView(null);
    const prior = worldRef.current;
    const next = { ...payload.state, elapsedMs: changedRound ? payload.state.elapsedMs : Math.max(payload.state.elapsedMs, prior?.elapsedMs ?? 0) };
    if (prior?.player.room !== next.player.room) { setSelection(null); riskConfirm.current = null; }
    publish(next, !payload.presentationBaseline && !changedRound);
  };
  const newClient = (base: string) => {
    const connection = new OnlineClient(base, {
      onSync: (p) => sync(p, connection),
      onPresence: (operator, isPaused) => {
        if (client.current !== connection) return;
        setPresence(operator); setPause(isPaused);
        if (operator.connected) setOpView(null);
      },
      onStatus: (status, message) => {
        if (client.current !== connection) return;
        setLink(status); setLinkMessage(status === 'error' ? message ?? '连接中断。不会在本地偷偷推进这局任务。' : null);
      },
    });
    client.current = connection;
    return connection;
  };
  const startOnline = async (seed: string, difficulty: Difficulty, rejoin = false) => {
    if (busyRef.current) return;
    setOnlineError(null);
    const saved = rejoin ? loadSession() : null;
    const base = (saved?.base ?? serverUrl).trim();
    busyRef.current = true; setBusy(true);
    try {
      if (!await OnlineClient.probe(base)) throw new Error('联机服务未启动。单人模式无需服务，仍然可以完整游玩。');
      disconnect(); reset(); setOnline(true); setServerOnline(true);
      busyRef.current = true; setBusy(true);
      const connection = newClient(base);
      const payload = saved ? await connection.joinRun(saved.runId, saved.token) : await connection.createRun(seed, difficulty);
      if (connection !== client.current) return;
      sync(payload, connection);
      saveSession({ base, runId: payload.runId, token: connection.fieldToken, at: Date.now() });
      setSavedSession(loadSession()); rememberServerUrl(base); setServerUrl(base);
      setScreen('play'); audio.play('ping');
    } catch (error) {
      const err = error as Error & { code?: number };
      if (err.code === 404 || err.code === 403) { clearSession(); setSavedSession(null); }
      setOnlineError(err.message); disconnect(); setScreen('start');
    } finally { busyRef.current = false; setBusy(false); }
  };

  const restartOnline = async (seed: string, difficulty: Difficulty) => {
    const connection = client.current;
    if (!connection || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      const payload = await connection.restartRun(seed, difficulty);
      if (client.current !== connection) return;
      sync(payload, connection);
      setScreen('play'); audio.play('ping');
    } catch (error) { tell(`重开失败：${(error as Error).message}`, true); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const dispatch = async (action: FieldAction) => {
    const current = worldRef.current;
    if (!current || current.status !== 'playing' || pausedRef.current || busyRef.current) return;
    const connection = client.current;
    const origin = current.player.room;
    if (online && (!connection || link !== 'connected')) { tell('连接尚未恢复。这局不会在本地另行推进。', true); return; }
    busyRef.current = true; setBusy(true);
    try {
      let success = false;
      if (connection && online) {
        const result = await connection.fieldAction(action);
        if (client.current !== connection) return;
        success = result.ok;
        if (result.sync) sync(result.sync, connection);
        if (!result.ok) tell(result.message, true);
      } else {
        const next = structuredClone(current);
        const result = applyFieldAction(next, action);
        success = result.ok;
        if (success) publish(next);
        else tell(result.message, true);
      }
      if (success) {
        setFeedback(null);
        audio.play(action.t === 'move' ? 'door' : action.t === 'listen' ? 'listen' : action.t === 'attack' ? 'attack' : 'click');
        if (action.t === 'move') { setSelection(null); riskConfirm.current = null; }
        if (action.t === 'use' || action.t === 'drop') setSelection(null);
        if (action.t === 'listen') setMapActivity({ key: Date.now(), kind: 'scan', roomId: origin });
      } else audio.play('error');
    } catch { tell('暂时没收到操作确认，结果可能已执行。恢复连接后再次点击会先核实上一条，不会额外扣费。', true); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const operate = async (action: OperatorAction) => {
    const current = worldRef.current;
    if (!current || current.status !== 'playing' || pausedRef.current || busyRef.current || !direct) return;
    const connection = client.current;
    busyRef.current = true; setBusy(true);
    try {
      let ok = false, text = '';
      if (connection && online) {
        const result = await connection.operatorAction(action);
        if (client.current !== connection) return;
        ok = result.ok; text = result.message;
        if (result.sync) sync(result.sync, connection);
        if (result.operatorView) setOpView(result.operatorView);
        if (result.locked) setOpView(null);
        if (ok && action.t === 'scan') {
          const reading = result.operatorView?.readings.find((r) => r.room === action.room && r.ageTurns <= 2);
          if (reading) text = reading.summary + (result.message.includes('⚠') ? '\n' + result.message.slice(result.message.indexOf('⚠')) : '');
        }
      } else {
        const next = structuredClone(current);
        const result = applyOperatorAction(next, action, '本地操作员');
        ok = result.ok; text = result.message;
        if (ok && (action.t === 'scan' || action.t === 'drone')) {
          const target = next.rooms.find((r) => r.id === (action.t === 'drone' ? next.drone.room : action.room));
          if (target?.lastScan?.turn === current.turn) text = readingText(target, target.lastScan, next.turn) + (result.message.includes('⚠') ? '\n' + result.message.slice(result.message.indexOf('⚠')) : '');
        }
        if (ok && action.t === 'trace') {
          const track = next.log.slice().reverse().find((e) => e.side === 'remote' && e.text.startsWith('追踪完成'));
          if (track) text = track.text + (result.message.includes('⚠') ? '\n' + result.message.slice(result.message.indexOf('⚠')) : '');
        }
        publish(next);
      }
      tell(text, !ok);
      if (ok) {
        audio.play(action.t === 'door' ? 'door' : 'scan');
        setMapActivity({ key: Date.now(), kind: action.t === 'scan' || action.t === 'trace' ? 'scan' : action.t === 'door' ? 'door' : action.t === 'drone' ? 'drone' : 'power', roomId: 'room' in action ? action.room : undefined, doorId: action.t === 'door' ? action.door : undefined });
      }
    } catch { tell('控制指令未能送达，请重试。', true); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const clickRoom = (id: number, inspectOnly = false) => {
    const current = worldRef.current;
    if (!current || pausedRef.current || busyRef.current || settingsOpen) return;
    if (inspectOnly) { setSelection({ type: 'room', id }); return; }
    const linkTo = adjacency(current, current.player.room).find((a) => a.room.id === id);
    if (!linkTo) { setSelection({ type: 'room', id }); return; }
    const { door, room } = linkTo;
    if (door.braced || (door.status === 'locked' && !door.remoteBroken)) {
      setSelection({ type: 'door', id: door.id });
      tell(door.braced ? `先在设备上收回 ${door.id} 门的压差楔。` : `${door.id} 已锁定。${direct ? '设备已选中此门，点击解锁。' : '在设备上请求远程席解锁。'}`);
      return;
    }
    const cautious = (sonarFresh(current) && current.sonar?.doorId === door.id) || (room.visited && room.fieldVerdict === 'danger');
    if (cautious && riskConfirm.current !== id) {
      riskConfirm.current = id;
      setSelection({ type: 'room', id });
      tell('这条路线有危险线索。确认要进去时，再点一次该舱室。', true);
      return;
    }
    void dispatch({ t: 'move', room: id });
  };
  const togglePause = async () => {
    if (busyRef.current) return;
    const connection = client.current;
    if (online && connection) {
      try { const response = await connection.setPaused(!pausedRef.current); if (response) sync(response, connection); }
      catch { tell('暂停请求未送达，请检查连接。', true); }
    } else setPause(!pausedRef.current);
  };
  const leave = async () => {
    if (busyRef.current) return;
    try {
      if (online && client.current) await client.current.leaveRun();
      clearSession(); setSavedSession(null); disconnect(); reset(); setScreen('start');
    } catch { tell('暂时无法结束旧局，请恢复连接后再试。', true); }
  };

  if (screen === 'start' || !game) return <StartScreen onStart={startSolo} onStartOnline={(seed, difficulty) => void startOnline(seed, difficulty)} initialSeed={initialSeed} serverUrl={serverUrl} onServerUrlChange={setServerUrl} serverOnline={serverOnline} onProbe={() => void OnlineClient.probe(serverUrl).then(setServerOnline)} onlineError={onlineError} savedRunId={savedSession?.runId ?? null} onRejoin={() => void startOnline('', 'unstable', true)} busy={busy} />;
  if (screen === 'report') return <ReportScreen state={game} reportOverride={report} onRestartSameSeed={() => online ? void restartOnline(game.seed, game.difficulty) : startSolo(game.seed, game.difficulty)} onNewSeed={() => online ? void restartOnline(randomSeed(), game.difficulty) : startSolo(randomSeed(), game.difficulty)} onMenu={leave} onRefreshReport={() => { void client.current?.debrief().then((r) => { if (r) setReport(r as unknown as MissionReport); }); }} />;
  const advice = deviceGuidance(game, direct);

  return (
    <div className={`play-shell ${underAttack && atmosphere.mode === 'standard' && !atmosphere.reduced ? 'attack-shake-active' : ''}`} data-atmosphere-mode={atmosphere.mode === 'off' ? 'off' : atmosphere.reduced ? 'reduced' : 'standard'} onPointerDown={() => audio.unlock()} onKeyDownCapture={() => audio.unlock()}>
      {underAttack && atmosphere.mode !== 'off' && !atmosphere.reduced && <div className="heartbeat-vignette" aria-hidden="true" />}
      <main className="play-layout">
        <section className="map-area" onPointerMove={atmosphere.dismissGlimpse}>
          <StationMap key={session} state={game} selectedRoom={selection?.type === 'room' ? selection.id : null} selectedDoor={selection?.type === 'door' ? selection.id : null} objective={advice.roomId} activity={mapActivity} perceptionCue={atmosphere.mapCue} onRoom={clickRoom} onDoor={(id) => { riskConfirm.current = null; setSelection({ type: 'door', id }); }} />
          <AtmosphereLayer event={atmosphere.event} reduced={atmosphere.reduced} lowOxygen={atmosphere.lowOxygen} dark={atmosphere.dark} fog={atmosphere.fog} glimpseDismissed={atmosphere.glimpseDismissed} />
        </section>
        <div className="handset-dock">
          <FieldHandset key={session} state={game} selection={selection} direct={direct} online={online} operator={presence} operatorView={opView} link={link} paused={paused} busy={busy || settingsOpen} feedback={feedback} onSelect={setSelection} onField={(a) => void dispatch(a)} onOperator={(a) => void operate(a)} onPause={() => void togglePause()} onSettings={() => setSettingsOpen(true)} />
          {settingsOpen && <section className="device-settings" role="dialog" aria-modal="true" aria-label="任务设置">
            <header><h2>{helpOpen ? '操作说明' : '任务设置'}</h2><button onClick={() => { setSettingsOpen(false); setHelpOpen(false); }} aria-label="关闭设置"><InstrumentIcon name="close" /></button></header>
            <div className="settings-content">
              {helpOpen ? <><QuickStart /><TrustGuide /></> : <>
                <div className="settings-mode"><span>当前任务</span><b>{online ? '双人协作' : '单人 · 离线可玩'}</b></div>
                <button className="setting-row" onClick={() => setSoundOn((v) => !v)}>音效<span>{soundOn ? '开启' : '关闭'}</span></button>
                <AtmosphereSettings mode={atmosphere.mode} onChange={atmosphere.setMode} />
                <button className="setting-row" onClick={() => setHelpOpen(true)}>操作说明<span>查看</span></button>
                {online && <><p>{linkMessage ?? (presence?.connected ? `${presence.name} 正在远程席` : '等待远程操作员接入。')}</p>{!presence?.connected && <button className="setting-row" onClick={async () => { const connection = client.current; if (!connection) return; try { const result = await connection.claimSeat(!direct); if (result.sync) sync(result.sync, connection); setOpView(result.operatorView ?? null); setSettingsOpen(false); } catch { tell('无法接管远程席。', true); } }}>{direct ? '交还远程控制' : '暂时自行控制设备'}</button>}{link === 'error' && <button className="setting-row" onClick={() => client.current?.retryNow()}>重新连接</button>}<details><summary>联机 / 开发设置</summary><p>对局编号：{client.current?.runId}</p><input readOnly value={`${serverUrl.replace(/\/+$/, '')}/mcp`} aria-label="MCP 服务地址" /><p>启动服务：node start-server.mjs</p></details></>}
                <div className="settings-seed">种子：{game.seed}</div>
                <button className="setting-row" onClick={() => { if (window.confirm('重新开始会结束当前操作。确定吗？')) online ? void restartOnline(game.seed, game.difficulty) : startSolo(game.seed, game.difficulty); }}>重新开始</button>
                <button className="setting-row" onClick={leave}>返回开始界面</button>
              </>}
            </div>
          </section>}
        </div>
      </main>
      {game.status !== 'playing' && <div className="mission-ended"><span>失联之后 / 任务归档</span><h2>{game.status === 'won' ? '你离开了空间站' : '通讯记录到此结束'}</h2><p>{game.endReason}</p><button onClick={() => setScreen('report')}>查看任务记录 <InstrumentIcon name="arrow" size={18} /></button></div>}
    </div>
  );
}
