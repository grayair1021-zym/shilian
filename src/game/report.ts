import { DIFFICULTIES, type GameState } from './types';
import { RELICS } from './content';
import { atmospherePairsForReport } from './atmosphere';
import { SAFE_READING_MAX_AGE } from './engine';

export interface ReportRow {
  label: string;
  value: string;
}

export interface MissionReport {
  success: boolean;
  title: string;
  rows: ReportRow[];
  decisions: string[];
  conflicts: string[];
  misjudges: string[];
  assists: string[];
  worst: string;
  summary: string[];
  pairedFragments: ReturnType<typeof atmospherePairsForReport>;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m} 分 ${String(s % 60).padStart(2, '0')} 秒`;
}

/** 使用全局评分选出关键远程操作，不根据结局附近的时间猜测因果。 */
function pivotalRemoteAction(state: GameState): string {
  const remote = rankedDecisions(state).filter((d) => d.includes('远端'));
  if (!remote.length) return '本局没有记录到关键的远程操作。';
  return `${remote[0]}（按目标推进、避险与资源变化评分）`;
}

function turnOf(text: string): number { return Number(text.match(/第\s*(\d+)\s*回合/)?.[1] ?? 0); }

export function rankedDecisions(state: GameState): string[] {
  const score = (d: string) => {
    const objective = state.goals.some((g) => g.doneTurn === turnOf(d)) ? 50 : 0;
    const protection = /封堵|隔离|固定|修复|重创|回应|无视/.test(d) ? 30 : 0;
    return Math.max(state.stats.decisionWeights?.[d] ?? 1, objective, protection);
  };
  return [...new Set(state.stats.decisions)].sort((a, b) => score(b) - score(a) || turnOf(a) - turnOf(b));
}

export function buildReport(state: GameState): MissionReport {
  const success = state.status === 'won';
  const explored = state.rooms.filter((r) => r.visited).length;
  const worstEvent = state.stats.dangerEvents.slice().sort((a, b) => b.severity - a.severity || b.turn - a.turn)[0];
  const trust = state.stats.trustEvents ?? [];
  const distorted = trust.filter((e) => e.outcome === 'distorted').length;
  const stale = trust.filter((e) => e.outcome === 'stale').length;
  const changed = trust.filter((e) => e.outcome === 'changed').length;
  const knocksTriggered = (state.atmosphere?.used.knock ?? 0) > 0 || !!state.pendingKnock || state.entity.answeredKnock || state.knocksIgnored > 0;
  const goalsDone = state.goals.filter((g) => g.done).length;

  const rows: ReportRow[] = [
    { label: '任务结果', value: success ? '成功脱离空间站' : '未能撤离' },
    { label: '结束原因', value: state.endReason ?? '记录中断' },
    { label: '存活时间', value: `${state.turn} 回合 ／ 实际用时 ${formatDuration(state.elapsedMs)}` },
    { label: '最终生命值', value: `${Math.round(state.player.health)}%` },
    { label: '剩余氧气', value: `${state.oxygen.toFixed(0)}%` },
    { label: '剩余电力', value: `${state.power.toFixed(0)}` },
    { label: '站体完整度', value: `${state.integrity.toFixed(0)}%` },
    { label: '探索区域', value: `${explored} / ${state.rooms.length} 个舱室` },
    { label: '任务目标达成', value: `${goalsDone} / ${state.goals.length} 项完成` },
    { label: '双端读数分歧', value: `${state.stats.conflicts} 次` },
    { label: '协作推进成功', value: `${state.stats.assists} 次（一次进入或目标配合计一次，多份依据合并）` },
    { label: '失真安全读数后遇险', value: `${distorted} 次` },
    { label: '过期安全情报后遇险', value: `${stale} 次（进入时采样已超过 ${SAFE_READING_MAX_AGE} 回合，优先归入本类）` },
    { label: '采样后变化／无法归因', value: `${changed} 次` },
    { label: '重复或无效指令', value: `${state.stats.misjudgments} 次` },
    { label: '远程设备调用', value: `${state.stats.remoteCommands} 次（含雷达/无人机扫描 ${state.stats.scans} 次）` },
    { label: '战术无线电记录', value: `${state.transmissions.length} 条` },
    { label: '敲击抉择记录', value: !knocksTriggered ? '本局未触发敲击抉择' : `${state.entity.answeredKnock ? '现场曾敲击回应' : state.knocksIgnored > 0 ? '选择不回应' : '曾听见敲击，未作明确选择'}（主动无视 ${state.knocksIgnored} 次）` },
    { label: '寻获的站员遗物', value: state.recoveredRelics.length ? `${state.recoveredRelics.length} 件（含隐秘彩蛋 ${state.recoveredRelics.filter((id) => RELICS[id]?.rare).length} 件）` : '未发现' },
    { label: '关键转折操作', value: pivotalRemoteAction(state) },
    { label: '任务代号 · 种子', value: `${DIFFICULTIES[state.difficulty].name} · ${state.seed}` },
  ];

  const summary: string[] = [];
  const attacks = state.stats.decisions.filter((d) => d.includes('【')).length;
  const encounters = state.stats.dangerEvents.filter((d) => d.text.includes('遭遇') || d.text.includes('反扑') || d.text.includes('扑咬')).length;
  if (success) {
    summary.push(`共用 ${state.turn} 回合走完 ${explored} 个舱室，完成 ${goalsDone}/${state.goals.length} 项目标后撤离。`);
  } else if (state.player.health <= 0) {
    summary.push(`第 ${state.turn} 回合，现场员在 ${explored} 个已探索舱室的记录中停止了生命体征（剩余氧气 ${state.oxygen.toFixed(0)}%）。`);
  } else if (state.oxygen <= 0) {
    summary.push(`第 ${state.turn} 回合氧气耗尽。已探索 ${explored} 个舱室，完成 ${goalsDone}/${state.goals.length} 项目标。`);
  } else {
    summary.push(`任务在第 ${state.turn} 回合中断。已探索 ${explored} 个舱室，完成 ${goalsDone}/${state.goals.length} 项目标。`);
  }

  if (state.entity.exists) {
    const parts: string[] = [];
    if (encounters > 0) parts.push(`与未知目标正面遭遇 ${encounters} 次`);
    if (attacks > 0) parts.push(`主动反击 ${attacks} 次`);
    if (state.entity.answeredKnock) parts.push('回应过一次敲击');
    if (state.knocksIgnored > 0) parts.push(`无视敲击 ${state.knocksIgnored} 次`);
    if (parts.length) summary.push(parts.join('，') + '。');
    if (state.entity.touchedHull) summary.push('观测窗外的痕迹与外壁热脉冲发生在同一时段，两份记录都已存档。');
  } else {
    summary.push('本局没有确认的移动目标；异常读数多半来自设备与结构本身。');
  }

  if (state.stats.conflicts > 0 || state.stats.assists > 0 || state.stats.misjudgments > 0 || trust.length > 0) {
    summary.push(`记录到 ${state.stats.conflicts} 次读数分歧、${state.stats.assists} 次协作推进。安全读数后遇险中，失真 ${distorted} 次、过期 ${stale} 次、采样后变化或无法归因 ${changed} 次。`);
  }
  if (state.stats.remoteCommands > 0) {
    summary.push(`远程席共执行 ${state.stats.remoteCommands} 次操作（含扫描 ${state.stats.scans} 次）。`);
  }
  if (state.recoveredRelics.length) {
    const last = RELICS[state.recoveredRelics[state.recoveredRelics.length - 1]];
    if (last) summary.push(`带走了 ${state.recoveredRelics.length} 件站员遗物，最近一件是${last.title.replace('遗留物：', '').replace('彩蛋：', '')}。`);
  }
  if (success && state.player.health < 50) {
    summary.push(`撤离时生命值仅剩 ${Math.round(state.player.health)}%，护服上全是豁口。`);
  }

  summary.push(...state.endingEcho);

  summary.push('情报统计根据进入行动、已有扫描与实际遭遇推断，不代表玩家主观信任；每次进入最多计一条，受伤后原地停留不会重复计数。');
  if (success) {
    summary.push('空间站失联，但两人的信号保持到了最后。');
  } else {
    summary.push('通讯没有中断，中断的是另一边的回答。');
  }

  return {
    success,
    title: success ? '任务记录 · 撤离完成' : '任务记录 · 未撤离',
    rows,
    decisions: rankedDecisions(state).slice(0, 12).sort((a, b) => turnOf(a) - turnOf(b)),
    conflicts: state.stats.conflictNotes.slice(-8),
    misjudges: state.stats.misjudgeNotes.slice(-8),
    assists: state.stats.assistNotes.slice(-8),
    worst: worstEvent ? `第 ${worstEvent.turn} 回合：${worstEvent.text}（事件严重度 ${worstEvent.severity}；按预设风险等级排序，非实际扣血量，同分取最近一次）` : '本次任务没有出现严重事故。',
    summary,
    pairedFragments: atmospherePairsForReport(state),
  };
}

export function reportToText(report: MissionReport): string {
  const L: string[] = [];
  L.push(`【失联之后 · ${report.title}】`);
  for (const r of report.rows) L.push(`${r.label}：${r.value}`);
  L.push('');
  L.push(`最危险的一次事件：${report.worst}`);
  if (report.decisions.length) {
    L.push('');
    L.push('关键决策：');
    report.decisions.forEach((d) => L.push(`- ${d}`));
  }
  if (report.conflicts.length) {
    L.push('');
    L.push('信息冲突记录：');
    report.conflicts.forEach((d) => L.push(`- ${d}`));
  }
  L.push('');
  L.push('任务总结：');
  report.summary.forEach((s) => L.push(s));
  return L.join('\n');
}
