// 날짜는 'YYYY-MM-DD' 문자열. 영업일은 월~금, 공휴일 없음 [A05 §2].
const DAY_MS = 86400000;

export function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`날짜 형식이 아닙니다: ${s}`);
  return new Date(`${s}T00:00:00Z`);
}
export const fmt = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => fmt(new Date(parseDate(s).getTime() + n * DAY_MS));
export const weekday = (s) => parseDate(s).getUTCDay(); // 0=일 … 6=토
export const isBusinessDay = (s) => { const w = weekday(s); return w !== 0 && w !== 6; };

// n영업일 뒤(음수면 앞). 시작일 자체는 세지 않는다. 07-17 −1 → 07-16
export function addBusinessDays(s, n) {
  let d = s;
  const step = n >= 0 ? 1 : -1;
  for (let left = Math.abs(n); left > 0;) {
    d = addDays(d, step);
    if (isBusinessDay(d)) left -= 1;
  }
  return d;
}
export const nextBusinessDay = (s) => addBusinessDays(s, 1);

// a 다음 날부터 b까지의 영업일 수(b가 앞이면 음수)
export function businessDaysBetween(a, b) {
  if (a === b) return 0;
  const [lo, hi, sign] = a < b ? [a, b, 1] : [b, a, -1];
  let count = 0;
  for (let d = addDays(lo, 1); d <= hi; d = addDays(d, 1)) if (isBusinessDay(d)) count += 1;
  return count * sign;
}

// 그 주의 월요일(주 격자 week_start)
export const weekStart = (s) => addDays(s, -((weekday(s) + 6) % 7));

// a 다음 날부터 b까지의 영업일 목록
export function businessDaysAfter(a, b) {
  const out = [];
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (isBusinessDay(d)) out.push(d);
  return out;
}
