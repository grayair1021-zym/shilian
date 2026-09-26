import { TRUST_ANCHORS } from '../game/atmosphere';
import { useState } from 'react';
import type { AtmosphereCheck } from '../game/atmosphereChecks';

export function TrustGuide() {
  const [checks, setChecks] = useState<AtmosphereCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  return (
    <section className="mt-5 border-t border-[#2a333d] pt-4 text-[13px] leading-relaxed text-[#a9b7c0]">
      <h3 className="mb-2 text-[#c6d8e4]">分清三种信息</h3>
      <p>仪表上的数值、你亲眼见到的东西、你对它的解释，不是同一种信息。</p>
      <dl className="mt-3 space-y-3">
        <div><dt className="text-[#99b6cb]">可依赖的底座</dt><dd>氧气、电力、最终门态、任务结果和消息署名。查看数据与发消息免费，不会为了催促你而偷偷快进时间。</dd></div>
        <div><dt className="text-[#bdb395]">需要交叉确认的片段</dt><dd>生命迹象、热源、运动信号、旧采样，以及你在雾里看到的轮廓。比较时间、位置和来源，不要把“没检测到”说成“保证没有”。</dd></div>
        <div><dt className="text-[#9eafbb]">可以不听的催促</dt><dd>旧值班模块会用真实的核验次数和消耗质疑你。它只是评估文字，不会下命令，也不知道你在想什么。</dd></div>
      </dl>
      <details className="mt-4 border border-[#2a333d] px-3 py-2">
        <summary className="cursor-pointer text-[#94aec1]">小队怎样把碎片拼起来</summary>
        <ol className="mt-3 list-decimal space-y-2 pl-5">
          <li>现场员报告“哪里、刚才、看见或听见什么”，先别替异常起名字。</li>
          <li>远程席对照同一位置、同一时间的采样，注明延迟或信号问题。</li>
          <li>若两边不一致，换一种来源：静听、换路、无人机，或等待搭档描述。不要机械重复同一个扫描。</li>
          <li>敲击出现时，可以不回应或离开。回应会产生噪声，留有后果，但不是一键触发死亡。</li>
        </ol>
      </details>
      <details className="mt-2 border border-[#2a333d] px-3 py-2">
        <summary className="cursor-pointer text-[#94aec1]">不会为了恐怖而打破的规则</summary>
        <ul className="mt-3 list-disc space-y-2 pl-5">{TRUST_ANCHORS.map((text) => <li key={text}>{text}</li>)}</ul>
      </details>
      <p className="mt-3 text-[11px] text-[#637c8c]">菜单可将氛围设为“减弱”或“关闭”。文字线索不丢失，玩法不受影响。</p>
      <details className="mt-3 border-t border-[#2a333d] pt-3">
        <summary className="cursor-pointer text-[11px] text-[#718b9a]">开发检查：事件与信息隔离</summary>
        <p className="my-2 text-[11px] text-[#637c8c]">使用独立测试局，不读取或修改当前任务。这不能代替真实设备的音画体验测试。</p>
        <button type="button" disabled={checking} className="border border-[#435969] px-3 py-2 text-[12px] text-[#b2cddd]" onClick={async () => {
          setChecking(true);
          try {
            const { runAtmosphereChecks } = await import('../game/atmosphereChecks');
            const { runDeviceChecks } = await import('../game/deviceChecks');
            setChecks([...runDeviceChecks(), ...runAtmosphereChecks()]);
          } catch {
            setChecks([{ name: '加载检查模块', passed: false, detail: '模块加载失败，请重试。' }]);
          } finally { setChecking(false); }
        }}>{checking ? '检查中' : '运行本地自检'}</button>
        {checks && <div className="mt-3" aria-live="polite">
          <p className="text-[12px] text-[#98b8ce]">通过 {checks.filter((r) => r.passed).length} / {checks.length}</p>
          <ul className="mt-2 space-y-1 text-[11px]">{checks.map((r) => <li key={r.name} className={r.passed ? 'text-[#899fab]' : 'text-[#d49b89]'}>{r.passed ? '通过' : '失败'} · {r.name}{r.detail ? `：${r.detail}` : ''}</li>)}</ul>
        </div>}
      </details>
    </section>
  );
}