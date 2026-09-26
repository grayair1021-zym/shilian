import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { InstrumentIcon, type InstrumentIconName } from './InstrumentIcon';
import { ITEMS } from '../game/content';
import { deviceGuidance, sonarFresh, type DeviceSelection } from '../game/deviceLogic';
import { fieldObservations, oxygenCoarse } from '../game/briefing';
import { canFieldAttack, doorStatusText, getRoom, interactOptions } from '../game/engine';
import type { FieldAction, OperatorAction } from '../game/actions';
import type { GameState } from '../game/types';
import type { OperatorPresence, OperatorView } from '../game/views';
import type { LinkStatus } from '../net/client';

export interface ActionFeedback { id: number; text: string; error: boolean }

export function FieldHandset({
  state, selection, direct, online, operator, operatorView, link, paused, busy,
  feedback, onSelect, onField, onOperator, onPause, onSettings,
}: {
  state: GameState;
  selection: DeviceSelection | null;
  direct: boolean;
  online: boolean;
  operator: OperatorPresence | null;
  operatorView: OperatorView | null;
  link: LinkStatus;
  paused: boolean;
  busy: boolean;
  feedback: ActionFeedback | null;
  onSelect: (selection: DeviceSelection | null) => void;
  onField: (action: FieldAction) => void;
  onOperator: (action: OperatorAction) => void;
  onPause: () => void;
  onSettings: () => void;
}) {
  const here = getRoom(state, state.player.room);
  const [groundPage, setGroundPage] = useState(0);
  const [message, setMessage] = useState('');
  const [transfer, setTransfer] = useState(false);
  const guidance = deviceGuidance(state, direct);
  const blocked = busy || paused || state.status !== 'playing' || (online && link !== 'connected');
  const room = selection?.type === 'room' ? getRoom(state, selection.id) : here;
  const door = selection?.type === 'door' ? state.doors[selection.id] : null;
  const item = selection?.type === 'item' ? state.player.inventory[selection.index] : undefined;
  const currentItem = item ? ITEMS[item] : null;
  const powered = state.zones[room.zone].powered;
  const ox = oxygenCoarse(state);
  const exact = !online;
  const notes = state.fieldNotes ?? fieldObservations(state);
  const sonar = sonarFresh(state) ? state.sonar : null;
  const ready = state.fieldInteractions ?? interactOptions(state);
  const full = state.player.inventory.length >= state.player.capacity;
  const groundItems = [...new Set(here.items)];
  const page = Math.min(groundPage, Math.max(0, Math.ceil(groundItems.length / 3) - 1));

  // 模式切换：'instrument' 仪表模式 / 'comms' 战术对讲打字模式
  const [panelMode, setPanelMode] = useState<'instrument' | 'comms'>('instrument');
  const messagesRef = useRef<HTMLDivElement>(null);
  const lastMessageId = state.transmissions.at(-1)?.id;
  useLayoutEffect(() => {
    const box = messagesRef.current;
    if (panelMode === 'comms' && box) box.scrollTop = box.scrollHeight;
  }, [panelMode, lastMessageId]);
  const [expandEvents, setExpandEvents] = useState(false);
  const attackBlocked = blocked || !(online ? state.fieldAttackAvailable === true : canFieldAttack(state));

  const stateLabel = here.fieldVerdict === 'danger' ? '已见危险' : !state.zones[here.zone].powered ? '照明中断' : here.fieldVerdict === 'unknown' ? '视野不清' : '未见明显危险';

  // 事件流
  const events = useMemo(() => {
    const visible = state.log.filter((e) => exact || (e.audience !== 'operator' && e.side !== 'remote'));
    return visible.slice(-30);
  }, [state.log, exact]);

  const sendRequest = (text: string) => onField({ t: 'transmit', text });
  const remoteAction = (action: OperatorAction, request: string) => direct ? onOperator(action) : sendRequest(request);
  const lastScan = online ? operatorView?.readings.find((r) => r.room === room.id)?.summary : room.lastScan
    ? [room.lastScan.life && '生命信号', room.lastScan.heat && '热源', room.lastScan.hazard && '环境异常'].filter(Boolean).join(' / ') || '未检出异常' : null;

  return (
    <aside className={`handset ${here.fieldVerdict === 'danger' ? 'handset-alert' : ''}`} aria-label="现场员随身操作设备">
      <div className="handset-antenna" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <div className="handset-knobs">
        <span className="unit-serial">野外作业终端 / 07</span>
        <button className={`rotary-knob ${paused ? 'is-off' : ''}`} onClick={onPause} title={paused ? '继续任务' : '暂停任务'} aria-label={paused ? '继续任务' : '暂停任务'}><i /></button>
      </div>

      {/* 图二区域：对讲机右侧物理对讲 / 仪表切换推钮 */}
      <div
        className={`handset-ptt-rocker ${panelMode === 'comms' ? 'is-comms' : ''}`}
        onClick={() => setPanelMode(panelMode === 'comms' ? 'instrument' : 'comms')}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPanelMode(panelMode === 'comms' ? 'instrument' : 'comms'); } }}
        title={panelMode === 'comms' ? '点击切换回作战仪表' : '【图二按键】点击进入战术无线电对讲打字频道'}
        role="button"
        tabIndex={0}
        aria-label={panelMode === 'comms' ? '切换回作战仪表' : '切换到战术对讲'}
      >
        <span className="ptt-led" />
        <span className="ptt-vertical-label">{panelMode === 'comms' ? '仪表' : '对讲'}</span>
        <div className="ptt-ridges" />
      </div>

      {/* 常驻侧键：仅在目标可触及且装备可用时点亮 */}
        <div className="handset-combat-sidekeys" aria-label="侧边战术反击按键">
          <button
            type="button"
            className="side-combat-btn"
            disabled={attackBlocked}
            onClick={() => onField({ t: 'attack', weapon: 'fist' })}
            title="【徒手反击】命中率 30%。造成轻伤并争取喘息，累积伤势延长退避；落空会损失生命、氧气并破损护服。"
          >
            <span className="side-combat-label">拳击</span>
          </button>
          <button
            type="button"
            className="side-combat-btn"
            disabled={attackBlocked || !state.player.inventory.includes('crowbar')}
            onClick={() => onField({ t: 'attack', weapon: 'crowbar' })}
            title={state.player.inventory.includes('crowbar') ? "【撬棍重击】命中率 65%。造成重伤并逼退，累积伤势会延长停止追击的时间。" : "需背包携带液压撬棍"}
          >
            <span className="side-combat-label">撬棍</span>
          </button>
          <button
            type="button"
            className="side-combat-btn"
            disabled={attackBlocked || !state.player.inventory.includes('sealant')}
            onClick={() => onField({ t: 'attack', weapon: 'sealant' })}
            title={state.player.inventory.includes('sealant') ? "【喷射密封胶】命中率 85%。命中后干扰感官、争取撤离时间；命中消耗1罐胶。" : "需背包携带密封胶"}
          >
            <span className="side-combat-label">封胶</span>
          </button>
        </div>

      <div className="handset-body">
        <span className="case-screw screw-tl" aria-hidden="true" /><span className="case-screw screw-tr" aria-hidden="true" />
        <header className="handset-header">
          <div className="speaker-slits" aria-hidden="true"><i /><i /><i /><i /></div>
          <div className="device-identity">
            <b>现场员</b>
            <span>{online ? `${operator?.name ?? '远程席'} · ${operator?.connected ? '已连接' : link === 'error' ? '连接中断' : '等待接入'}` : '单人任务 · 全部控制已接通'}</span>
          </div>
          <button
            className={`comms-toggle-badge ${panelMode === 'comms' ? 'active' : ''}`}
            onClick={() => setPanelMode(panelMode === 'comms' ? 'instrument' : 'comms')}
            title="模式切换"
          >
            {panelMode === 'comms' ? '返回仪表' : '对讲模式'}
          </button>
          <span className={`device-led ${state.player.suitLeak > 0 ? 'led-red' : ''}`} title={state.player.suitLeak > 0 ? '护服泄漏' : '设备运行中'} />
        </header>

        {panelMode === 'comms' ? (
          /* ══════════ 全尺寸对讲打字通信终端 ══════════ */
          <div className="comms-view">
            <div className="comms-header">
              <span><i className="status-lamp" />战术无线电 · 频道 01</span>
              <button onClick={() => setPanelMode('instrument')} style={{ color: '#8bb3d1', fontSize: '11px' }}>
                返回仪表 ✕
              </button>
            </div>
            <div className="comms-messages" ref={messagesRef} role="log" aria-label="对讲记录" aria-live="polite">
              {state.transmissions.length === 0 && (
                <p style={{ color: '#5b7891', fontSize: '11px', textAlign: 'center', marginTop: '20px' }}>
                  无线电频道畅通。可以在下方打字，或使用预设战术短语与远程席沟通。
                </p>
              )}
              {state.transmissions.map((t) => (
                <div key={t.id} className={`comms-bubble ${t.source === 'field' ? 'from-field' : 'from-operator'}`}>
                  <div className="comms-bubble-meta">
                    {t.source === 'field' ? '现场员' : operator?.name ?? '远程席'} · 回合 {t.turn}
                  </div>
                  <div>{t.text}</div>
                </div>
              ))}
            </div>
            <div className="comms-presets">
              <button type="button" className="comms-preset-btn" onClick={() => sendRequest(`我在 ${here.id} 号 ${here.name}，请求开门支援。`)}>
                请求开门
              </button>
              <button type="button" className="comms-preset-btn" onClick={() => sendRequest(`请求扫描 ${here.id} 号舱，确认环境与生命体。`)}>
                请求扫描
              </button>
              <button type="button" className="comms-preset-btn" onClick={() => sendRequest(`发现未知生物活动！请提高警惕！`)}>
                发现生物
              </button>
              <button type="button" className="comms-preset-btn" onClick={() => sendRequest('收到，正在按计划前往下一个目标。')}>
                收到前往
              </button>
            </div>
            <form
              className="comms-input-bar"
              onSubmit={(e) => {
                e.preventDefault();
                if (message.trim()) {
                  sendRequest(message);
                  setMessage('');
                }
              }}
            >
              <input
                className="comms-input"
                aria-label="输入对讲消息"
                value={message}
                maxLength={180}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="输入无线电消息内容（回车发送）…"
              />
              <button className="comms-send-btn" disabled={blocked || !message.trim()} type="submit">
                发送
              </button>
            </form>
          </div>
        ) : (
          /* ══════════ 作战仪表主视图 ══════════ */
          <div className="device-display">
            <div className="display-topline">
              <span><i />{paused ? '任务已暂停' : busy ? '正在执行' : '现场链路'}</span>
              <span>回合 {String(state.turn).padStart(2, '0')}<em> / </em>{clock(state.elapsedMs)}</span>
            </div>
            {/* 图三：生命值血条（红色字体与红光指示）置于氧气前面 */}
            <div className="display-vitals">
              <Vital
                name="生命"
                text={`${Math.round(state.player.health)}%`}
                level={state.player.health}
                danger={state.player.health <= 40}
                isHealth
              />
              <Vital
                name="氧气"
                text={exact ? `${Math.round(state.oxygen)}%` : ox.text}
                level={exact ? state.oxygen : ox.level === 'ok' ? 75 : ox.level === 'warn' ? 45 : 15}
                danger={ox.level === 'bad'}
              />
              <Vital
                name="电力"
                text={exact ? Math.round(state.power).toString() : operatorView ? `${Math.round(operatorView.resources.power)}` : '远端监测'}
                level={exact ? state.power / 1.3 : operatorView ? operatorView.resources.power / 1.3 : null}
              />
              <Vital
                name="完整度"
                text={exact ? `${Math.round(state.integrity)}%` : operatorView ? `${operatorView.resources.integrityPercent}%` : '远端监测'}
                level={exact ? state.integrity : operatorView?.resources.integrityPercent ?? null}
                danger={exact && state.integrity < 40}
              />
            </div>

            {/* 彻底解决图一重叠：流式弹性布局，不再 absolute 叠字！ */}
            <section className="display-position">
              <div>
                <span className="lcd-label">当前位置</span>
                <span className={`position-condition ${here.fieldVerdict === 'danger' ? 'condition-bad' : ''}`}>
                  {state.player.suitLeak > 0 ? '护服泄漏' : stateLabel}
                </span>
              </div>
              <h2><span>{String(here.id).padStart(2, '0')}</span>{here.name}</h2>
              <p title={notes.join(' ')}>{sonar ? `${sonar.doorId ?? sonar.dir}：${sonar.label}` : notes[1] ?? '等待现场观察。'}</p>
              {state.player.quietSteps > 0 && (
                <div className="quiet-benefit-pill">
                  <InstrumentIcon name="listen" size={12} />
                  <span>轻步预判 × {state.player.quietSteps}（可避开一次扑咬）</span>
                </div>
              )}
            </section>

            <section className="display-mission">
              <div className="lcd-heading">
                <span>撤离清单</span>
                <span>{state.goals.filter((g) => g.done).length}/{state.goals.length}</span>
              </div>
              <ol>{state.goals.map((g) => <li key={g.kind} className={g.done ? 'done' : ''}><i>{g.done ? <InstrumentIcon name="check" size={9} /> : ''}</i><span>{g.title}</span></li>)}</ol>
              <div className="next-advice">
                <span>下一步建议</span>
                <strong>{guidance.title}</strong>
                <p title={guidance.detail}>{guidance.detail}</p>
              </div>
            </section>

            <section className="display-context" aria-label="选中目标操作">
              {selection && <button className="context-dismiss" onClick={() => onSelect(null)} aria-label="取消选中"><InstrumentIcon name="close" size={12} /></button>}
              <strong className="context-name" title={lastScan ?? undefined}>
                {currentItem ? currentItem.name : door ? `${door.id} · ${door.braced ? '压差楔固定' : doorStatusText(door.status)}` : `${String(room.id).padStart(2, '0')} · ${room.name}`}
              </strong>
              {currentItem && selection?.type === 'item' ? (
                <>
                  <p className="context-detail" title={currentItem.desc}><span style={{ color: '#8fb4c7' }}>[{itemRole(item!)}] </span>{currentItem.desc}</p>
                  <div className="softkeys">
                    {currentItem.use && <SoftKey disabled={blocked} onClick={() => onField({ t: 'use', item: item! })}>{currentItem.use}</SoftKey>}
                    <SoftKey disabled={blocked} onClick={() => { onField({ t: 'drop', index: selection.index, item }); onSelect(null); }}>放下</SoftKey>
                  </div>
                </>
              ) : door ? (
                <>
                  <p className="context-detail">{door.remoteBroken ? '控制回路损坏。携带撬棍可从相邻舱室通过。' : '单击目标房间移动；锁定时先在这里解锁。'}</p>
                  <div className="softkeys">
                    <SoftKey disabled={blocked || door.braced || door.remoteBroken || door.status === 'jammed'} onClick={() => remoteAction({ t: 'door', door: door.id, action: door.status === 'locked' ? 'unlock' : 'lock' }, `请求${door.status === 'locked' ? '解锁' : '锁定'} ${door.id} 舱门。`)} icon="door">{direct ? '' : '请求'}{door.status === 'locked' ? '解锁 · 8电' : '锁定 · 4电'}</SoftKey>
                    {(door.a === here.id || door.b === here.id) && (door.braced || state.player.inventory.includes('wedge')) && <SoftKey disabled={blocked} onClick={() => onField({ t: 'brace', door: door.id, remove: door.braced })}>{door.braced ? '收回压差楔' : '安装压差楔'}</SoftKey>}
                  </div>
                </>
              ) : state.pendingKnock ? (
                <>
                  <p className="context-detail">{state.pendingKnock.dir}，三短两长。回应会发出噪声。</p>
                  <div className="softkeys">
                    <SoftKey disabled={blocked} onClick={() => onField({ t: 'ignoreKnock' })}>不回应</SoftKey>
                    <SoftKey disabled={blocked} onClick={() => onField({ t: 'answerKnock' })}>敲回去 · 1回合</SoftKey>
                  </div>
                </>
              ) : (
                <>
                  <div className="power-line">
                    <span>{room.zone} 区供电</span>
                    <button role="switch" aria-checked={powered} aria-label={`${room.zone} 区供电${powered ? '切断' : '接通'}`} disabled={blocked} onClick={() => remoteAction({ t: 'power', zone: room.zone, action: powered ? 'off' : 'on' }, `请求${powered ? '切断' : '接通'} ${room.zone} 区供电。`)}>
                      <i className={powered ? 'switch-on' : ''} />{powered ? '接通' : '断开'}
                    </button>
                    {direct && <button className="transfer-button" disabled={blocked} onClick={() => setTransfer((v) => !v)}>{transfer ? '取消转供' : '转供'}</button>}
                  </div>
                  {transfer && direct && (
                    <div className="transfer-zones">
                      <span>从哪区转入：</span>
                      {Object.keys(state.zones).filter((z) => z !== room.zone).map((z) => (
                        <button key={z} disabled={blocked || !state.zones[z].powered} onClick={() => { onOperator({ t: 'power', zone: z, action: 'reroute', target: room.zone }); setTransfer(false); }}>{z}</button>
                      ))}
                    </div>
                  )}
                  {(!transfer || !direct) && (
                    <div className="softkeys">
                      <SoftKey icon="scan" disabled={blocked} onClick={() => remoteAction({ t: 'scan', room: room.id }, `请求扫描 ${room.id} 号舱。`)}>{direct ? '扫描 · 6电' : '请求扫描'}</SoftKey>
                      <SoftKey icon="drone" disabled={blocked} onClick={() => remoteAction({ t: 'drone', room: room.id }, `请求无人机前往 ${room.id} 号舱。`)}>{direct ? '无人机 · 10电' : '派无人机'}</SoftKey>
                      {direct && !state.drone.lost && (
                        <SoftKey
                          icon="drone"
                          disabled={blocked || state.drone.charge <= 0 || state.power < 15}
                          title="无人机过载战术冲击：限无人机当前舱或通行相邻舱；目标确在该舱时命中率75%，耗15电力。伤势累积延长退避，40%过载损毁；落空也消耗一回合"
                          onClick={() => onOperator({ t: 'drone_attack', room: room.id })}
                        >
                          冲击 · 15电
                        </SoftKey>
                      )}
                      <SoftKey disabled={blocked} onClick={() => remoteAction({ t: 'trace', room: room.id }, `请求追踪 ${room.id} 号舱附近信号。`)}>追踪</SoftKey>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* 事件记录：独立滚动，可展开下拉查看更多 */}
            <section className={`display-events${expandEvents ? ' expanded' : ''}`} aria-label="事件记录">
              <div className="lcd-heading">
                <span>事件记录</span>
                <div>
                  <button onClick={() => setExpandEvents(!expandEvents)} style={{ fontSize: '10px', color: '#8bb3d1' }}>
                    {expandEvents ? '收起 ▴' : '全部下拉 ▾'}
                  </button>
                  <span style={{ fontSize: '10px', opacity: 0.7 }}>{events.length}条</span>
                </div>
              </div>
              <div className="display-events-scrollbox">
                {feedback && <p className={feedback.error ? 'event-danger' : ''}>› {feedback.text}</p>}
                {(expandEvents ? events.slice(-20) : events.slice(-5)).map((e) => (
                  <p key={e.id} className={e.side === 'alert' ? 'event-danger' : ''}>
                    · [{e.turn}R] {e.text}
                  </p>
                ))}
              </div>
            </section>
          </div>
        )}

        <div className="device-cargo">
          <div className="cargo-line">
            <span>地面</span>
            <div className="ground-items">
              {groundItems.length ? groundItems.slice(page * 3, page * 3 + 3).map((it) => (
                <button key={it} disabled={blocked || full} title={`${ITEMS[it]?.desc} 点击拾取`} onClick={() => onField({ t: 'pickup', item: it })}>
                  {ITEMS[it]?.name}<b>＋</b>
                </button>
              )) : <small>{here.searched ? '已搜完，无剩余物资' : '还未发现物资'}</small>}
            </div>
            {groundItems.length > 3 && <button aria-label="下一组地面物资" onClick={() => setGroundPage((page + 1) % Math.ceil(groundItems.length / 3))}>›</button>}
          </div>
          <div className="cargo-line">
            <span>背包</span>
            <div className="bag-slots">
              {Array.from({ length: state.player.capacity }, (_, index) => {
                const it = state.player.inventory[index];
                return (
                  <button
                    key={index}
                    disabled={!it}
                    className={selection?.type === 'item' && selection.index === index ? 'selected' : ''}
                    onClick={() => onSelect({ type: 'item', index })}
                    title={it ? `${ITEMS[it].name}：${ITEMS[it].desc}` : '空位'}
                    aria-label={it ? `背包：${ITEMS[it].name}` : '空位'}
                  >
                    {it ? <><InstrumentIcon name={itemIcon(it)} size={17} /><small>{shortItem(it)}</small></> : <span>·</span>}
                  </button>
                );
              })}
            </div>
            <small>{state.player.inventory.length}/{state.player.capacity}</small>
          </div>
        </div>

        {ready.length > 0 && (
          <div className="facility-actions">
            {ready.map((o) => (
              <button key={o.id} disabled={blocked || !o.enabled} title={`${o.label}。${o.hint}`} onClick={() => onField({ t: 'interact', id: o.id })}>
                <InstrumentIcon name="wrench" size={13} />
                <span>{o.label}</span>
                <small>{o.enabled ? '就绪' : o.hint}</small>
              </button>
            ))}
          </div>
        )}

        <div className="device-keys" aria-label="现场行动按键">
          <ActionKey name="search" label="翻找" sub={here.searched ? '本舱已搜完' : '物资与线索'} disabled={blocked || here.searched} recommended={guidance.action === 'search'} onClick={() => onField({ t: 'search' })} />
          <ActionKey name="listen" label="静听" sub={state.player.quietSteps ? `轻步剩 ${state.player.quietSteps} 次` : '定位来路 · 轻步'} disabled={blocked || (!!sonar && state.turn - sonar.turn <= 1)} recommended={guidance.action === 'listen'} onClick={() => onField({ t: 'listen' })} />
          <ActionKey name="breath" label="屏息" sub="省氧 · 稳住呼吸" disabled={blocked} recommended={state.player.composure < 40} onClick={() => onField({ t: 'wait' })} />
        </div>
        <div className="device-footer">
          <span>拾取、对讲不耗回合</span>
          <button
            style={{ fontSize: '10px', color: panelMode === 'comms' ? '#ffcc44' : '#8bb3d1' }}
            onClick={() => setPanelMode(panelMode === 'comms' ? 'instrument' : 'comms')}
          >
            {panelMode === 'comms' ? '返回仪表模式' : '切换对讲打字'}
          </button>
          <button className="gear-key" onClick={onSettings} title="任务设置" aria-label="任务设置">
            <InstrumentIcon name="gear" size={17} />
          </button>
        </div>
        <span className="case-screw screw-bl" aria-hidden="true" /><span className="case-screw screw-br" aria-hidden="true" />
      </div>
    </aside>
  );
}

function Vital({ name, text, level, danger, isHealth }: { name: string; text: string; level: number | null; danger?: boolean; isHealth?: boolean }) {
  return (
    <div className={`device-vital ${danger ? 'vital-low' : ''} ${isHealth ? 'vital-health' : ''}`}>
      <span>{name}</span>
      <strong style={isHealth ? { color: '#ff5c4c' } : undefined}>{text}</strong>
      <div>
        {Array.from({ length: 10 }, (_, i) => (
          <i
            key={i}
            className={level !== null && level > i * 10 ? 'filled' : ''}
            style={isHealth && level !== null && level > i * 10 ? { background: '#e64030' } : undefined}
          />
        ))}
      </div>
    </div>
  );
}
function ActionKey({ name, label, sub, disabled, recommended, onClick }: { name: InstrumentIconName; label: string; sub: string; disabled?: boolean; recommended?: boolean; onClick: () => void }) {
  return <button type="button" className={`device-action ${recommended ? 'recommended' : ''}`} disabled={disabled} onClick={onClick} aria-label={label}><InstrumentIcon name={name} size={24} /><strong>{label}</strong><small>{sub}</small></button>;
}
function SoftKey({ children, disabled, icon, title, onClick }: { children: ReactNode; disabled?: boolean; icon?: InstrumentIconName; title?: string; onClick: () => void }) {
  return <button type="button" title={title} disabled={disabled} onClick={onClick}>{icon && <InstrumentIcon name={icon} size={13} />}{children}</button>;
}
function itemIcon(item: string): InstrumentIconName { return item === 'o2' ? 'oxygen' : item === 'battery' || item === 'torchcell' ? 'power' : item === 'toolkit' || item === 'crowbar' ? 'wrench' : item === 'idcard' || item === 'navcore' ? 'scan' : item === 'adrenaline' || item === 'energygel' ? 'medkit' : 'bag'; }
function itemRole(item: string): string {
  switch (item) {
    case 'o2': return '补给';
    case 'battery': return '能源';
    case 'sealant': return '修补/战斗';
    case 'crowbar': return '破障/战斗';
    case 'toolkit': return '维修关键';
    case 'idcard': return '逃生关键';
    case 'navcore': return '逃生关键';
    case 'relay': return '校准';
    case 'schema': return '侦察';
    case 'torchcell': return '照明';
    case 'wedge': return '封门';
    case 'recorder': return '安抚';
    case 'charm': return '信物';
    case 'adrenaline': return '急救';
    case 'energygel': return '恢复';
    default: return '物资';
  }
}
function shortItem(item: string) { return ({ o2: '氧气', battery: '电池', sealant: '密封胶', crowbar: '撬棍', toolkit: '工具', idcard: '身份卡', navcore: '核心', relay: '中继', schema: '线路图', torchcell: '头灯', wedge: '门楔', recorder: '录音', charm: '工牌', adrenaline: '肾上腺素', energygel: '能量胶' } as Record<string, string>)[item] ?? '物品'; }
function clock(ms: number) { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
