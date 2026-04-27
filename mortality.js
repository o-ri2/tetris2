/**
 * 통계청 기반 연령별 사망 확률 q_x (% 단위, 연간 위험).
 * 1~85세: 키포인트 선형 보간, 85세 초과: Gompertz형 가중.
 */

export const qxData = {
  1: 0.012,
  10: 0.008,
  20: 0.035,
  30: 0.055,
  40: 0.118,
  50: 0.286,
  60: 0.721,
  70: 1.844,
  80: 6.915,
  85: 13.371
};

const QX_AGES = Object.keys(qxData)
  .map(Number)
  .sort((a, b) => a - b);

/** 1~85세: 구간 선형 보간 (85는 키값으로만 사용, 초과는 호출측에서 Gompertz) */
export function getInterpolatedProbability(age) {
  const a = Math.max(1, age);
  if (a <= QX_AGES[0]) return qxData[QX_AGES[0]];
  if (a >= 85) return qxData[85];
  let i = 0;
  while (i < QX_AGES.length - 1 && QX_AGES[i + 1] < a) i++;
  const x0 = QX_AGES[i];
  const x1 = QX_AGES[i + 1];
  const y0 = qxData[x0];
  const y1 = qxData[x1];
  const t = (a - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/** 사망 확률 p (%), 0~100 클램프 */
export function getDeathProbabilityPercentForAge(age) {
  const a = Math.max(1, Math.floor(age));
  let p;
  if (a <= 85) {
    p = getInterpolatedProbability(a);
  } else {
    p = Math.min(100, 13.371 * Math.pow(1.11, a - 85));
  }
  return Math.min(100, Math.max(0, p));
}

export function checkSurvival(age) {
  const p = getDeathProbabilityPercentForAge(age);
  return Math.random() * 100 > p;
}

/** 해당 연령 1년 연간 생존 확률(%) = 100 − q_x — HUD「이번 층 생존」과 동일 */
export function getAnnualSurvivalPercentForAge(age) {
  return 100 - getDeathProbabilityPercentForAge(age);
}

/** 완료한 정수 연도 1..survivedYears 각 연말 생존의 곱 → "동일·이상 연령" 누적 생존 비율 (0~1) */
export function cumulativeSurvivalRatio(survivedYears) {
  if (survivedYears < 1) return 1;
  let prod = 1;
  for (let t = 1; t <= survivedYears; t++) {
    prod *= 1 - getDeathProbabilityPercentForAge(t) / 100;
  }
  return Math.max(0, Math.min(1, prod));
}

/** 출생 코호트 기준 누적 생존율(%) — 매 연령 (1−q)의 곱 */
export function cumulativeCohortSurvivalPercent(survivedYears) {
  return cumulativeSurvivalRatio(survivedYears) * 100;
}

/** 장수 상위 % 표시용(레거시): 누적 생존율×100 (소수점 둘째 자리) */
export function longevityTopPercentLabel(survivedYears) {
  return cumulativeCohortSurvivalPercent(survivedYears).toFixed(2);
}
