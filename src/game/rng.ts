// 可复现的随机数系统：相同种子生成相同局面

export function hashSeed(str: string): number {
  let h = 2166136261 >>> 0;
  const s = str.trim() === '' ? '默认航线' : str.trim();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class RNG {
  state: number;
  constructor(state: number) {
    this.state = state >>> 0;
  }
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  sample<T>(arr: T[], n: number): T[] {
    return this.shuffle(arr).slice(0, n);
  }
}

const SEED_WORDS_A = ['寂静', '冷却', '轨道', '灰河', '长夜', '深潜', '回声', '锈蚀', '南极星', '黑砂'];
const SEED_WORDS_B = ['七号', '一二三', '第九次', '备份', '尾迹', '边界', '零点', '残响', '断线', '归航'];

export function randomSeed(): string {
  const a = SEED_WORDS_A[Math.floor(Math.random() * SEED_WORDS_A.length)];
  const b = SEED_WORDS_B[Math.floor(Math.random() * SEED_WORDS_B.length)];
  const n = Math.floor(Math.random() * 900 + 100);
  return `${a}${b}-${n}`;
}
