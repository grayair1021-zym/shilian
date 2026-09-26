import { buildReport } from '../game/report';
import type { GameState } from '../game/types';
import { Btn, Panel } from './ui';

export function ReportScreen({
  state,
  reportOverride,
  onRestartSameSeed,
  onNewSeed,
  onMenu,
  onRefreshReport,
}: {
  state: GameState;
  /** 联机模式下由服务端在任务结束后下发的完整结算数据（此时信息壁垒解除） */
  reportOverride?: ReturnType<typeof buildReport> | null;
  onRestartSameSeed: () => void;
  onNewSeed: () => void;
  onMenu: () => void;
  onRefreshReport?: () => void;
}) {
  if (state.atmosphere === null && !reportOverride) {
    return (
      <div className="mx-auto max-w-xl px-5 py-16">
        <h1 className="text-xl text-[#cdd5da]">正在调取任务记录</h1>
        <p className="mt-3 text-sm text-[#8d99a2]">结算以服务端记录为准。连接中断时不会用隐藏后的数据替代真实结果。</p>
        <div className="mt-5 flex gap-2"><Btn onClick={onRefreshReport}>重新调取</Btn><Btn onClick={onMenu}>返回主界面</Btn></div>
      </div>
    );
  }
  const report = reportOverride ?? buildReport(state);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1080px] flex-col gap-4 px-4 py-8">
      <header className="fade-in">
        <div className="text-[11px] tracking-[0.4em] text-[#5f6c75]">MISSION LOG</div>
        <h1
          className="mt-1 text-[28px] tracking-[0.2em]"
          style={{ color: report.success ? '#ecb154' : '#d68a80' }}
        >
          {report.title}
        </h1>
        <div className="title-rule mt-3 w-40" />
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="任务数据" bodyClass="p-0">
          <ul>
            {report.rows.map((r, i) => (
              <li
                key={r.label}
                className={`flex items-start justify-between gap-4 px-3 py-1.5 text-[12.5px] ${
                  i % 2 ? 'bg-[#10151b]' : ''
                }`}
              >
                <span className="shrink-0 text-[#6d7c85]">{r.label}</span>
                <span className="text-right text-[#cdd5da]">{r.value}</span>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-4">
          <Panel title="最危险的一次事件" bodyClass="p-3 text-[12.5px] leading-relaxed text-[#d68a80]">
            {report.worst}
          </Panel>

          <Panel title="全局关键决策（含远程操作）" bodyClass="p-3 text-[12.5px] leading-relaxed">
            <p className="mb-2 text-[#6d7c85]">优先选取目标推进、避险与资源变化，再按发生时间排列。</p>
            {report.decisions.length ? (
              <ul className="space-y-1 text-[#9aa7ae]">
                {report.decisions.map((d, i) => (
                  <li key={i}>· {d}</li>
                ))}
              </ul>
            ) : (
              <p className="text-[#6d7c85]">没有记录到需要商量的决定。</p>
            )}
          </Panel>
        </div>

        <Panel title="信息冲突记录" bodyClass="p-3 text-[12.5px] leading-relaxed">
          {report.conflicts.length ? (
            <ul className="space-y-1 text-[#d99a35]">
              {report.conflicts.map((d, i) => (
                <li key={i}>· {d}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[#6d7c85]">这一局里，现场与系统没有出现明显矛盾。</p>
          )}
          {report.misjudges.length > 0 && (
            <>
              <div className="mt-3 mb-1 text-[11px] tracking-[0.24em] text-[#63727b]">情报风险与指令失误</div>
              <ul className="space-y-1 text-[#d68a80]">
                {report.misjudges.map((d, i) => (
                  <li key={i}>· {d}</li>
                ))}
              </ul>
            </>
          )}
        </Panel>

        <Panel title="协作推进的时刻" bodyClass="p-3 text-[12.5px] leading-relaxed">
          {report.assists.length ? (
            <ul className="space-y-1 text-[#9dc0da]">
              {report.assists.map((d, i) => (
                <li key={i}>· {d}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[#6d7c85]">没有符合当前统计条件的协作推进记录。</p>
          )}
        </Panel>
      </div>

      {(report.pairedFragments?.length ?? 0) > 0 && (
        <Panel title="通讯结束后，两份记录放到一起" bodyClass="p-4">
          <p className="mb-3 text-[12px] text-[#718694]">同一回合的不同片段。没有补写、没有改写，也没有给它一个名字。</p>
          <div className="space-y-4">
            {report.pairedFragments.slice(-4).map((pair, i) => (
              <div key={`${pair.turn}-${i}`} className="border-t border-[#293540] pt-3">
                <div className="mb-2 text-[11px] text-[#667e8d]">第 {pair.turn} 回合 · {pair.roomId} 号舱附近</div>
                <div className="grid gap-4 sm:grid-cols-2 text-[13px] leading-relaxed">
                  <div><span className="mb-1 block text-[11px] text-[#b9a884]">现场员当时所见</span>{pair.field}</div>
                  <div><span className="mb-1 block text-[11px] text-[#88a4bc]">远程席当时收到</span>{pair.operator}</div>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="任务总结" bodyClass="p-4">
        <div className="space-y-1.5 text-[14px] leading-relaxed text-[#cdd5da]">
          {report.summary.map((s, i) => (
            <p key={i}>{s}</p>
          ))}
        </div>
      </Panel>

      <div className="flex flex-wrap gap-2 pb-6">
        <Btn variant="primary" onClick={onRestartSameSeed}>用相同种子重来</Btn>
        <Btn onClick={onNewSeed}>换一个种子再来一局</Btn>
        <Btn variant="ghost" onClick={onMenu}>
          返回主界面
        </Btn>
      </div>
    </div>
  );
}
