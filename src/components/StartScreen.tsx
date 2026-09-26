import { useState } from 'react';
import { DIFFICULTIES, type Difficulty } from '../game/types';
import { randomSeed } from '../game/rng';
import { InstrumentIcon } from './InstrumentIcon';
import { QuickStart } from './QuickStart';

export function StartScreen({ onStart, onStartOnline, initialSeed, serverUrl, onServerUrlChange, serverOnline, onProbe, onlineError, savedRunId, onRejoin, busy }: {
  onStart: (seed: string, difficulty: Difficulty) => void;
  onStartOnline: (seed: string, difficulty: Difficulty) => void;
  initialSeed: string;
  serverUrl: string;
  onServerUrlChange: (value: string) => void;
  serverOnline: boolean | null;
  onProbe: () => void;
  onlineError: string | null;
  savedRunId: string | null;
  onRejoin: () => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<'solo' | 'online'>(savedRunId ? 'online' : 'solo');
  const [difficulty, setDifficulty] = useState<Difficulty>('light');
  const [seed, setSeed] = useState(initialSeed);
  return (
    <div className="launch-page">
      <svg className="launch-blueprint" viewBox="0 0 1200 800" aria-hidden="true" fill="none">
        <g stroke="#638aa6"><path d="M0 440H780M445 0V800M0 330H630M740 0V800" strokeOpacity=".12" /><circle cx="490" cy="410" r="296" strokeDasharray="2 9" strokeOpacity=".2" /><circle cx="490" cy="410" r="262" strokeOpacity=".16" />
          <g strokeOpacity=".32" strokeWidth="1"><path d="M340 180h300v460H340ZM150 315h680v175H150Z" /><path d="M358 200h265v95H358ZM358 505h265v113H358ZM162 334h160v135H162ZM650 334h162v135H650Z" /><path d="M388 340h190v132H388ZM414 355h137v101H414Z" /></g>
          <path d="M490 0v96m0 555v149M0 410h110m740 0h350" strokeOpacity=".3" />
        </g>
      </svg>
      <main className="launch-content">
        <div className="launch-brand"><span>回声 7 号 / 生存协作实验</span><h1>失联之后</h1><p>一座正在失效的空间站。<br />看清现场，选好下一步，然后回家。</p></div>
        <section className="launch-setup" aria-label="新任务设置">
          <h2>选择你的任务</h2>
          {savedRunId && <div className="resume-notice"><p>发现未结束的对局，刷新后可以从这里接回。</p><button className="launch-resume" disabled={busy} onClick={onRejoin}>继续对局 {savedRunId}</button></div>}
          <div className="launch-instructions quick-start"><h3>第一次上站</h3><p>先在出生舱查看背包、翻找并联系搭档，再点击地图相邻舱室出发。查看和对讲不耗回合，行动才推进时间；完成任务后去逃生舱。</p><details><summary>展开初始玩法说明：操作、战斗与协作</summary><QuickStart /></details></div>
          <div className="launch-modes">
            <button type="button" aria-pressed={mode === 'solo'} onClick={() => setMode('solo')}><InstrumentIcon name="crosshair" size={21} /><strong>单人任务</strong><small>无需服务或搭档<br />你直接控制全部设备</small></button>
            <button type="button" aria-pressed={mode === 'online'} onClick={() => setMode('online')}><InstrumentIcon name="signal" size={21} /><strong>双人联机</strong><small>你在现场，搭档在远程席<br />交换线索，一起撤离</small></button>
          </div>
          <fieldset className="launch-difficulty"><legend>异常程度</legend><div>{Object.values(DIFFICULTIES).map((d) => <button key={d.key} aria-pressed={difficulty === d.key} onClick={() => setDifficulty(d.key)}>{d.name}</button>)}</div><p>{DIFFICULTIES[difficulty].desc}</p></fieldset>
          <details className="launch-advanced"><summary>种子{mode === 'online' ? ' / 联机设置' : ' / 重复体验同一座空间站'}</summary><div>
            <label>种子<input value={seed} maxLength={80} onChange={(e) => setSeed(e.target.value)} /><button onClick={() => setSeed(randomSeed())}>随机</button></label>
            {mode === 'online' && <><label>服务<input value={serverUrl} onChange={(e) => onServerUrlChange(e.target.value)} /><button onClick={onProbe}>检测</button></label><p>{serverOnline === true ? '服务在线' : serverOnline === false ? '未连接服务' : '尚未检测'}。先运行 node start-server.mjs，再连接游戏显示的 MCP 地址。</p></>}
          </div></details>
          {mode === 'online' && onlineError && <p className="launch-error" role="alert">{onlineError}</p>}
          <button className="launch-button" disabled={busy} onClick={() => mode === 'solo' ? onStart(seed, difficulty) : onStartOnline(seed, difficulty)}><span>{busy ? '连接中…' : mode === 'solo' ? '开始单人任务' : '建立双人任务'}</span><InstrumentIcon name="arrow" /></button>
          <p className="launch-tip">房间上走动，门标上选门。<br />翻找、静听和屏息，只用右侧设备上的三个按键。</p>
        </section>
      </main>
    </div>
  );
}
