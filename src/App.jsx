import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, Legend
} from "recharts";

// ============================================================
// 룰 초기값 (수정 K안)
// ============================================================
const INITIAL_RULES = {
  hp: 100,
  resources: {
    staminaStart: 4, staminaMax: 8,
    focusStart: 4, focusMax: 8,
    baseRecover: 1,
    probeRecoverBonus: 0, // 견제 비용 1로 변경됨에 따라 회복 보너스 제거
    blockRecoverBonus: 1, // 방어는 여전히 무료, 보너스 유지
    restRecoverBonus: 3,
  },
  attack: {
    probe:  { enabled: true,  cost: 1, damage: 5,  rollFormula: { str: 8,  agi: 4, base: 40 } },
    normal: { enabled: true,  cost: 2, damage: 15, rollFormula: { str: 10, agi: 0, base: 50 } },
    heavy:  { enabled: true,  cost: 3, damage: 28, rollFormula: { str: 10, agi: 0, base: 40 } },
    rest:   { enabled: true },
  },
  defense: {
    block:   { enabled: true, cost: 0, damageMult: 0.6 },
    dodge:   { enabled: true, cost: 2, rollFormula: { str: 0, agi: 10, base: 30 } },
    counter: { enabled: true, cost: 4, rollFormula: { str: 3, agi: 7,  base: 30 } },
  },
  combo: {
    doubleEnabled: true,
    doubleThreshold: 4,
    secondRollBonus: 10,
    secondDamageBonus: 0.2,
    defenseDoublePenalty: -10,
  },
  initiative: "random",
  roundLimit: 30,
};

const INITIAL_CHAR_A = { name: "A", str: 5, agi: 1 };
const INITIAL_CHAR_B = { name: "B", str: 1, agi: 5 };

// ============================================================
// 시뮬 엔진
// ============================================================
function evalRoll(formula, str, agi) {
  // 굴림 목표값 (target). 클램프 5~95
  const val = formula.str * str + formula.agi * agi + formula.base;
  return Math.max(5, Math.min(95, val));
}

function rollD100() { return Math.floor(Math.random() * 100) + 1; }

// === AI 로직 v2 ===
// 상황 판정: HP 비율 기반 4단계
function judgeSituation(self, opponent, rules) {
  const myRatio = self.hp / rules.hp;
  const oppRatio = opponent.hp / rules.hp;

  // 위기 — 절대 HP 30 미만
  if (self.hp < 30) return "crisis";
  // 우세 — 본인 HP가 상대보다 30% 이상 많음
  if (self.hp > opponent.hp * 1.3) return "dominant";
  // 열세 — 본인 HP가 상대보다 30% 이상 적음
  if (self.hp * 1.3 < opponent.hp) return "losing";
  // 그 외
  return "even";
}

// 빌드 역할 판정
function judgeRole(self) {
  if (self.str >= 4) return "aggressor";
  if (self.agi >= 4) return "evader";
  return "balanced";
}

// 반격 사용 가능 여부 (근+회 ≥ 5)
function canUseCounter(self) {
  return self.str + self.agi >= 5;
}

// 빌드 정체성 + 상황 기반 AI: 공격 선택
// 반환: [행동키, ...] (1개 또는 2개)
// 추가 반환: thinking 텍스트 (1:1 모드에서 사용)
function chooseAttacks(self, opponent, rules) {
  const role = judgeRole(self);
  const situation = judgeSituation(self, opponent, rules);
  const A = rules.attack;
  const stam = self.stamina;

  // 자원으로 가능한 행동 헬퍼
  const canAfford = (k) => A[k].enabled && stam >= A[k].cost;
  const canAffordCombo = (k1, k2) => A[k1].enabled && A[k2].enabled && stam >= A[k1].cost + A[k2].cost;

  // 위기 모드 — 모든 빌드 공통: 강공 강행, 자원 부족하면 강행 페널티 감수
  if (situation === "crisis") {
    if (canAffordCombo("heavy", "normal")) return ["heavy", "normal"];
    if (canAfford("heavy")) return ["heavy"];
    if (canAfford("normal")) return ["normal"];
    if (A.heavy.enabled) return ["heavy"]; // 강행 (자원 마이너스)
    if (canAfford("probe")) return ["probe"];
    return ["probe"];
  }

  // 우세 모드 — 자원 모으기 우선
  if (situation === "dominant") {
    // 자원 거의 가득 차면 더블로 마무리 시도
    if (stam >= rules.resources.staminaMax - 1) {
      if (role === "aggressor" && canAffordCombo("heavy", "normal")) return ["heavy", "normal"];
      if (role === "aggressor" && canAffordCombo("heavy", "probe")) return ["heavy", "probe"];
      if (canAffordCombo("normal", "normal")) return ["normal", "normal"];
    }
    // 평소엔 견제 (자원 모으기) — 단 휴식 옵션 있고 자원 적으면 휴식
    if (A.rest.enabled && stam <= 2) return ["rest"];
    if (canAfford("probe")) return ["probe"];
    if (canAfford("normal")) return ["normal"];
    return ["probe"];
  }

  // 열세 모드 — 즉시 데미지 우선
  if (situation === "losing") {
    if (role === "aggressor") {
      if (canAffordCombo("heavy", "normal")) return ["heavy", "normal"];
      if (canAfford("heavy")) return ["heavy"];
    }
    if (canAfford("heavy")) return ["heavy"];
    if (canAfford("normal")) return ["normal"];
    if (canAfford("probe")) return ["probe"];
    return ["probe"];
  }

  // 균형 모드 — 빌드 역할별 기본 패턴 + 자원량별 동적 콤보
  if (rules.combo.doubleEnabled && stam >= rules.combo.doubleThreshold) {
    if (role === "aggressor") {
      // 자원 6+ : 강공+일반 / 자원 5+ : 강공+견제 / 자원 4+ : 일반+일반
      if (stam >= 6 && canAffordCombo("heavy", "normal")) return ["heavy", "normal"];
      if (stam >= 5 && canAffordCombo("heavy", "probe")) return ["heavy", "probe"];
      if (stam >= 4 && canAffordCombo("normal", "normal")) return ["normal", "normal"];
    }
    if (role === "evader") {
      // 자원 5+ : 견제+일반 / 자원 4+ : 견제+견제 (저비용 회전)
      if (stam >= 5 && canAffordCombo("probe", "normal")) return ["probe", "normal"];
      if (stam >= 4 && canAffordCombo("probe", "probe")) return ["probe", "probe"];
    }
    if (role === "balanced") {
      if (stam >= 6 && canAffordCombo("normal", "normal")) return ["normal", "normal"];
      if (stam >= 5 && canAffordCombo("heavy", "probe")) return ["heavy", "probe"];
    }
  }

  // 균형 모드 단발
  if (role === "aggressor") {
    if (canAfford("heavy")) return ["heavy"];
    if (canAfford("normal")) return ["normal"];
    if (canAfford("probe")) return ["probe"];
  }
  if (role === "evader") {
    // 회피형 평소엔 견제로 모으기, 자원 풍부하면 일반공
    if (stam >= 4 && canAfford("normal")) return ["normal"];
    if (canAfford("probe")) return ["probe"];
    if (canAfford("normal")) return ["normal"];
  }
  // balanced
  if (canAfford("normal")) return ["normal"];
  if (canAfford("probe")) return ["probe"];

  // 자원 부족 — 휴식 또는 견제 강행
  if (A.rest.enabled) return ["rest"];
  return ["probe"];
}

// 빌드 정체성 + 상황 기반 AI: 방어 선택
// incomingAttacks: 들어오는 공격 키 배열 (예: ["heavy", "normal"])
function chooseDefense(self, opponent, rules, incomingAttacks) {
  const D = rules.defense;
  const role = judgeRole(self);
  const situation = judgeSituation(self, opponent, rules);
  const counterOk = canUseCounter(self);

  const choices = [];
  for (let i = 0; i < incomingAttacks.length; i++) {
    const usedFocus = choices.reduce((s, c) => s + (D[c]?.cost || 0), 0);
    const foc = self.focus - usedFocus;
    const incoming = incomingAttacks[i];
    const dmg = rules.attack[incoming]?.damage || 0;

    // 위기 모드 — 반격 우선 (러브샷 카운터)
    if (situation === "crisis") {
      if (counterOk && D.counter.enabled && foc >= D.counter.cost) {
        choices.push("counter"); continue;
      }
      if (D.dodge.enabled && foc >= D.dodge.cost) {
        choices.push("dodge"); continue;
      }
      choices.push("block");
      continue;
    }

    // 들어오는 공격 데미지 기반 결정
    // 강공급 (dmg >= 25) — 가장 위험, 회피·반격 우선
    if (dmg >= 25) {
      if (role === "evader" && counterOk && D.counter.enabled && foc >= D.counter.cost) {
        choices.push("counter"); continue;
      }
      if (D.dodge.enabled && foc >= D.dodge.cost) {
        choices.push("dodge"); continue;
      }
      choices.push("block");
      continue;
    }

    // 일반공급 (10 <= dmg < 25) — 빌드별 차이
    if (dmg >= 10) {
      if (role === "evader") {
        if (counterOk && situation !== "dominant" && D.counter.enabled && foc >= D.counter.cost) {
          choices.push("counter"); continue;
        }
        if (D.dodge.enabled && foc >= D.dodge.cost) {
          choices.push("dodge"); continue;
        }
      }
      if (role === "aggressor") {
        // 공격형은 자원 아끼기 우선 — 다음 공격에 쓰려고
        if (situation === "losing" && D.dodge.enabled && foc >= D.dodge.cost) {
          choices.push("dodge"); continue;
        }
        choices.push("block");
        continue;
      }
      // balanced
      if (D.dodge.enabled && foc >= D.dodge.cost) {
        choices.push("dodge"); continue;
      }
      choices.push("block");
      continue;
    }

    // 견제급 (dmg < 10) — 작은 데미지 받고 자원 보존
    choices.push("block");
  }
  return choices;
}

// 한 공격에 대한 한 방어 처리. 데미지 반환.
function resolveOne(attacker, defender, attackKey, defenseKey, rules, isSecondAttack, isSecondDefense) {
  const A = rules.attack[attackKey];

  // 공격 굴림
  let target = evalRoll(A.rollFormula, attacker.str, attacker.agi);
  if (isSecondAttack) target += rules.combo.secondRollBonus;
  target = Math.max(5, Math.min(95, target));
  const atkRoll = rollD100();
  const atkHit = atkRoll <= target;

  if (!atkHit) {
    // 공격 빗나감 — 방어자가 미리 선언했으므로 자원은 소모됨
    // 회피·방어: 받을 게 없으므로 굴림 안 함 (defResult: no_trigger)
    // 반격: 회피 + 자기 공격으로 구성되므로 공격이 빗나가도 자기 반격 공격 굴림은 발동
    if (defenseKey === "counter") {
      const counterAtkTarget = evalRoll(rules.attack.normal.rollFormula, defender.str, defender.agi);
      const counterRoll = rollD100();
      const counterHit = counterRoll <= counterAtkTarget;
      return {
        hit: false, damage: 0,
        atkRoll, atkTarget: target,
        defKey: "counter",
        defResult: "no_trigger_counter", // 공격 빗나갔지만 반격 굴림은 발동
        counter: counterHit ? rules.attack.normal.damage : 0,
        counterRoll, counterTarget: counterAtkTarget,
      };
    }
    return {
      hit: false, damage: 0,
      atkRoll, atkTarget: target,
      defKey: defenseKey,
      defResult: "no_trigger",
    };
  }

  // 명중 — 데미지 산정
  let dmg = A.damage;
  if (isSecondAttack) dmg = dmg * (1 + rules.combo.secondDamageBonus);

  // 방어 처리
  if (defenseKey === "block") {
    dmg = dmg * rules.defense.block.damageMult;
    return { hit: true, damage: Math.round(dmg), atkRoll, atkTarget: target, defKey: "block", defResult: "block" };
  }
  // 회피 / 반격 굴림
  const D = rules.defense[defenseKey];
  let defTarget = evalRoll(D.rollFormula, defender.str, defender.agi);
  if (isSecondDefense) defTarget += rules.combo.defenseDoublePenalty;
  defTarget = Math.max(5, Math.min(95, defTarget));
  const defRoll = rollD100();
  const defSuccess = defRoll <= defTarget;

  if (defSuccess) {
    // 회피 성공 — 데미지 0
    if (defenseKey === "counter") {
      // 반격: 즉시 반격 굴림 (간소화: counter 공격은 일반공격 데미지로 처리)
      const counterAtkTarget = evalRoll(rules.attack.normal.rollFormula, defender.str, defender.agi);
      const counterRoll = rollD100();
      const counterHit = counterRoll <= counterAtkTarget;
      return {
        hit: true, damage: 0, atkRoll, atkTarget: target,
        defKey: "counter", defResult: "success",
        defRoll, defTarget,
        counter: counterHit ? rules.attack.normal.damage : 0,
        counterRoll, counterTarget: counterAtkTarget,
      };
    }
    return { hit: true, damage: 0, atkRoll, atkTarget: target, defKey: defenseKey, defResult: "success", defRoll, defTarget };
  }

  // 방어 실패
  if (defenseKey === "counter") {
    dmg = dmg * 1.3; // 반격 실패 시 데미지 1.3배
  }
  return { hit: true, damage: Math.round(dmg), atkRoll, atkTarget: target, defKey: defenseKey, defResult: "fail", defRoll, defTarget };
}

// 한 캐릭터의 행동 + 상대의 방어 — 한 "행동 페이즈"
// 반환: { defensesUsed: [...] } — 이번 페이즈에서 target이 사용한 방어 목록
function performActions(actor, target, attacks, rules, log, forceComplete = false) {
  // 휴식이면 회복만
  if (attacks.length === 1 && attacks[0] === "rest") {
    log.push({ type: "rest", actor: actor.name });
    actor.stamina = Math.min(rules.resources.staminaMax, actor.stamina + rules.resources.restRecoverBonus + rules.resources.baseRecover);
    actor.actionCounts.rest++;
    return { defensesUsed: [] };
  }

  // 자원 차감 + 액션 카운트
  for (const k of attacks) {
    actor.stamina -= rules.attack[k].cost;
    actor.actionCounts[k]++;
  }
  if (attacks.length > 1) actor.actionCounts.double++;

  // 방어 선택 — 방어자(target)가 공격자(actor)의 공격(attacks)을 보고 결정
  const defenses = chooseDefense(target, actor, rules, attacks);

  // 각 공격 처리
  for (let i = 0; i < attacks.length; i++) {
    const result = resolveOne(actor, target, attacks[i], defenses[i], rules, i > 0, i > 0);
    target.hp -= result.damage;
    if (result.counter) actor.hp -= result.counter;

    log.push({
      type: "action",
      actor: actor.name,
      attack: attacks[i],
      defense: defenses[i],
      ...result,
    });
    if (!forceComplete && (target.hp <= 0 || actor.hp <= 0)) {
      // 방어 자원도 사용된 만큼만 차감
      for (let j = 0; j <= i; j++) {
        target.focus -= rules.defense[defenses[j]].cost;
        target.actionCounts[defenses[j]]++;
      }
      return { defensesUsed: defenses.slice(0, i + 1) };
    }
  }

  // 방어 자원 차감 + 카운트
  for (const d of defenses) {
    target.focus -= rules.defense[d].cost;
    target.actionCounts[d]++;
  }
  return { defensesUsed: defenses };
}

// 라운드 끝: 회복 처리
function endOfRound(self, actionsTaken, rules) {
  let stamRec = rules.resources.baseRecover;
  let focRec = rules.resources.baseRecover;

  // 공격 행동 기반 추가 회복
  if (actionsTaken.attack.length === 1 && actionsTaken.attack[0] === "probe") {
    stamRec += rules.resources.probeRecoverBonus;
  }
  // 방어 행동 기반 추가 회복: 모든 방어가 block이면 보너스
  const allBlock = actionsTaken.defense.length > 0 && actionsTaken.defense.every(d => d === "block");
  if (allBlock) focRec += rules.resources.blockRecoverBonus;

  self.stamina = Math.min(rules.resources.staminaMax, self.stamina + stamRec);
  self.focus = Math.min(rules.resources.focusMax, self.focus + focRec);
}

// 1전투 시뮬
function simulateOne(charA, charB, rules, captureLog = false) {
  const A = {
    name: charA.name, str: charA.str, agi: charA.agi,
    hp: rules.hp,
    stamina: rules.resources.staminaStart, focus: rules.resources.focusStart,
    actionCounts: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 }
  };
  const B = {
    name: charB.name, str: charB.str, agi: charB.agi,
    hp: rules.hp,
    stamina: rules.resources.staminaStart, focus: rules.resources.focusStart,
    actionCounts: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 }
  };

  // 선공 결정
  const mode = rules.initiative || "random";
  let firstIsA;
  if (mode === "A_fixed") firstIsA = true;
  else if (mode === "B_fixed") firstIsA = false;
  else if (mode === "simultaneous") firstIsA = null;
  else firstIsA = Math.random() < 0.5;

  const log = [];
  const hpHistory = [{ round: 0, hpA: A.hp, hpB: B.hp }];
  if (captureLog) log.push({ type: "init", firstIsA, mode });

  let round = 0;
  while (A.hp > 0 && B.hp > 0 && round < rules.roundLimit) {
    round++;
    if (captureLog) log.push({ type: "round-start", round });

    if (mode === "simultaneous") {
      // 동시 행동: 양쪽이 동시에 굴림, 결과를 동시 적용
      const aAttacks = chooseAttacks(A, B, rules);
      const bAttacks = chooseAttacks(B, A, rules);
      const aPhase = performActions(A, B, aAttacks, rules, log, true);
      const bPhase = performActions(B, A, bAttacks, rules, log, true);
      endOfRound(A, { attack: aAttacks, defense: bPhase.defensesUsed }, rules);
      endOfRound(B, { attack: bAttacks, defense: aPhase.defensesUsed }, rules);
    } else {
      // 선공 → 후공
      const first = firstIsA ? A : B;
      const second = firstIsA ? B : A;
      const firstAttacks = chooseAttacks(first, second, rules);
      const firstPhase = performActions(first, second, firstAttacks, rules, log);
      if (A.hp <= 0 || B.hp <= 0) {
        hpHistory.push({ round, hpA: Math.max(0, A.hp), hpB: Math.max(0, B.hp) });
        break;
      }
      const secondAttacks = chooseAttacks(second, first, rules);
      const secondPhase = performActions(second, first, secondAttacks, rules, log);
      // 회복
      endOfRound(first, { attack: firstAttacks, defense: secondPhase.defensesUsed }, rules);
      endOfRound(second, { attack: secondAttacks, defense: firstPhase.defensesUsed }, rules);
    }

    hpHistory.push({ round, hpA: Math.max(0, A.hp), hpB: Math.max(0, B.hp) });
  }

  let winner = "draw";
  if (A.hp <= 0 && B.hp <= 0) winner = "draw";
  else if (A.hp <= 0) winner = "B";
  else if (B.hp <= 0) winner = "A";
  else winner = A.hp > B.hp ? "A" : (B.hp > A.hp ? "B" : "draw");

  return {
    winner, rounds: round,
    finalHpA: Math.max(0, A.hp), finalHpB: Math.max(0, B.hp),
    actionCountsA: A.actionCounts, actionCountsB: B.actionCounts,
    firstIsA,
    log: captureLog ? log : null,
    hpHistory: captureLog ? hpHistory : null,
  };
}

// N회 반복
function simulateMany(charA, charB, rules, n) {
  let winsA = 0, winsB = 0, draws = 0;
  let totalRounds = 0;
  // 선공별 통계
  let firstA_count = 0, firstA_winsA = 0;
  let firstB_count = 0, firstB_winsB = 0;

  const totalActions = {
    A: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 },
    B: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 },
  };

  for (let i = 0; i < n; i++) {
    const r = simulateOne(charA, charB, rules, false);
    if (r.winner === "A") winsA++;
    else if (r.winner === "B") winsB++;
    else draws++;
    totalRounds += r.rounds;
    if (r.firstIsA === true) {
      firstA_count++;
      if (r.winner === "A") firstA_winsA++;
    } else if (r.firstIsA === false) {
      firstB_count++;
      if (r.winner === "B") firstB_winsB++;
    }
    for (const k of Object.keys(totalActions.A)) {
      totalActions.A[k] += r.actionCountsA[k];
      totalActions.B[k] += r.actionCountsB[k];
    }
  }

  // 평균 HP 추이 — 50회 평균
  const hpTrace = {};
  const traces = Math.min(50, n);
  for (let i = 0; i < traces; i++) {
    const r = simulateOne(charA, charB, rules, true);
    for (const h of r.hpHistory) {
      if (!hpTrace[h.round]) hpTrace[h.round] = { sumA: 0, sumB: 0, count: 0 };
      hpTrace[h.round].sumA += h.hpA;
      hpTrace[h.round].sumB += h.hpB;
      hpTrace[h.round].count++;
    }
  }
  const hpTraceArr = Object.keys(hpTrace).map(k => ({
    round: parseInt(k),
    A: Math.round(hpTrace[k].sumA / hpTrace[k].count),
    B: Math.round(hpTrace[k].sumB / hpTrace[k].count),
  })).sort((a, b) => a.round - b.round);

  // 샘플 로그 1회
  const sampleResult = simulateOne(charA, charB, rules, true);

  return {
    n, winsA, winsB, draws,
    winRateA: winsA / n * 100,
    winRateB: winsB / n * 100,
    drawRate: draws / n * 100,
    avgRounds: totalRounds / n,
    totalActions,
    hpTraceArr,
    sampleLog: sampleResult.log,
    sampleHistory: sampleResult.hpHistory,
    initiativeStats: {
      firstA_count, firstA_winRate: firstA_count > 0 ? firstA_winsA / firstA_count * 100 : null,
      firstB_count, firstB_winRate: firstB_count > 0 ? firstB_winsB / firstB_count * 100 : null,
    },
  };
}

// ============================================================
// UI 컴포넌트
// ============================================================
function StatSpinner({ label, value, onChange, min = 0, max = 5 }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-zinc-300">{label}</span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange(Math.max(min, value - 1))}
          className="w-7 h-7 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm transition"
        >−</button>
        <span className="font-mono text-lg w-6 text-center text-amber-300">{value}</span>
        <button
          onClick={() => onChange(Math.min(max, value + 1))}
          className="w-7 h-7 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-sm transition"
        >+</button>
      </div>
    </div>
  );
}

function Slider({ label, value, onChange, min, max, step = 1, suffix = "" }) {
  return (
    <div className="py-1.5">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-xs text-zinc-400">{label}</span>
        <span className="font-mono text-sm text-emerald-300">{value}{suffix}</span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full accent-emerald-500"
      />
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 py-1 cursor-pointer text-sm text-zinc-300">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
        className="accent-emerald-500" />
      {label}
    </label>
  );
}

function Section({ title, children, accent = "zinc" }) {
  const borderColor = {
    zinc: "border-zinc-700",
    amber: "border-amber-800/60",
    emerald: "border-emerald-800/60",
    blue: "border-blue-800/60",
  }[accent];
  return (
    <div className={`border ${borderColor} rounded-lg p-3 bg-zinc-900/40`}>
      <div className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2 font-semibold">{title}</div>
      {children}
    </div>
  );
}

// ============================================================
// 시뮬레이터 탭 (기존 App 내용)
// ============================================================
function SimulatorTab({ rules, setRules, updateRule, requestCopy }) {
  const [charA, setCharA] = useState(INITIAL_CHAR_A);
  const [charB, setCharB] = useState(INITIAL_CHAR_B);
  const [iterations, setIterations] = useState(500);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const run = useCallback(() => {
    setRunning(true);
    setTimeout(() => {
      const r = simulateMany(charA, charB, rules, iterations);
      setResult(r);
      setRunning(false);
    }, 30);
  }, [charA, charB, rules, iterations]);

  // 결과 + 설정 텍스트화 (복사용)
  const buildReportText = () => {
    if (!result) return "";
    const initLabel = { random: "무작위 50:50", A_fixed: "A 고정", B_fixed: "B 고정", simultaneous: "동시 행동" }[rules.initiative];
    const actionDist = (counts) => {
      const total = counts.probe + counts.normal + counts.heavy;
      if (total === 0) return "데이터 없음";
      return `견제 ${counts.probe} / 일반 ${counts.normal} / 강공 ${counts.heavy} | 방어 ${counts.block} 회피 ${counts.dodge} 반격 ${counts.counter} | 더블 ${counts.double}`;
    };

    return `=== 전투 시뮬레이션 결과 (${result.n}회) ===

[캐릭터]
A: 근력 ${charA.str} / 회피 ${charA.agi}  (${charA.str >= 4 ? "공격형" : charA.agi >= 4 ? "회피형" : "균형형"})
B: 근력 ${charB.str} / 회피 ${charB.agi}  (${charB.str >= 4 ? "공격형" : charB.agi >= 4 ? "회피형" : "균형형"})
HP: ${rules.hp}  /  선공 모드: ${initLabel}

[승률]
A ${result.winRateA.toFixed(1)}%  |  B ${result.winRateB.toFixed(1)}%  |  무 ${result.drawRate.toFixed(1)}%
평균 라운드: ${result.avgRounds.toFixed(1)}
${result.initiativeStats.firstA_count > 0 && result.initiativeStats.firstB_count > 0 ?
`선공별: A선공(${result.initiativeStats.firstA_count}회) → A승률 ${result.initiativeStats.firstA_winRate.toFixed(1)}%  /  B선공(${result.initiativeStats.firstB_count}회) → B승률 ${result.initiativeStats.firstB_winRate.toFixed(1)}%` : ""}

[행동 분포]
A: ${actionDist(result.totalActions.A)}
B: ${actionDist(result.totalActions.B)}

[자원 설정]
시작 ${rules.resources.staminaStart} / 최대 ${rules.resources.staminaMax} / 기본 회복 +${rules.resources.baseRecover}
견제 추가 회복 +${rules.resources.probeRecoverBonus}, 방어 추가 회복 +${rules.resources.blockRecoverBonus}, 휴식 추가 회복 +${rules.resources.restRecoverBonus}

[공격 행동]
견제   비용 ${rules.attack.probe.cost} / 데미지 ${rules.attack.probe.damage} / 굴림 근×${rules.attack.probe.rollFormula.str} + 회×${rules.attack.probe.rollFormula.agi} + ${rules.attack.probe.rollFormula.base}${rules.attack.probe.enabled ? "" : " (off)"}
일반공 비용 ${rules.attack.normal.cost} / 데미지 ${rules.attack.normal.damage} / 굴림 근×${rules.attack.normal.rollFormula.str} + 회×${rules.attack.normal.rollFormula.agi} + ${rules.attack.normal.rollFormula.base}${rules.attack.normal.enabled ? "" : " (off)"}
강공   비용 ${rules.attack.heavy.cost} / 데미지 ${rules.attack.heavy.damage} / 굴림 근×${rules.attack.heavy.rollFormula.str} + 회×${rules.attack.heavy.rollFormula.agi} + ${rules.attack.heavy.rollFormula.base}${rules.attack.heavy.enabled ? "" : " (off)"}
휴식   ${rules.attack.rest.enabled ? "ON" : "off"}

[방어 행동]
방어   비용 ${rules.defense.block.cost} / 데미지 배율 ${rules.defense.block.damageMult}${rules.defense.block.enabled ? "" : " (off)"}
회피   비용 ${rules.defense.dodge.cost} / 굴림 근×${rules.defense.dodge.rollFormula.str} + 회×${rules.defense.dodge.rollFormula.agi} + ${rules.defense.dodge.rollFormula.base}${rules.defense.dodge.enabled ? "" : " (off)"}
반격   비용 ${rules.defense.counter.cost} / 굴림 근×${rules.defense.counter.rollFormula.str} + 회×${rules.defense.counter.rollFormula.agi} + ${rules.defense.counter.rollFormula.base}${rules.defense.counter.enabled ? "" : " (off)"}

[연속기]
더블 ${rules.combo.doubleEnabled ? "ON" : "off"} / 임계치 ${rules.combo.doubleThreshold}
2번째 굴림 보너스 +${rules.combo.secondRollBonus}, 2번째 데미지 +${(rules.combo.secondDamageBonus * 100).toFixed(0)}%
방어자 2번 방어 페널티 ${rules.combo.defenseDoublePenalty}
`;
  };

  const [copyStatus, setCopyStatus] = useState("");
  const copyReport = async () => {
    const text = buildReportText();
    if (requestCopy) {
      const ok = await requestCopy(text, "시뮬레이션 결과 복사");
      setCopyStatus(ok ? "복사됨" : "");
      setTimeout(() => setCopyStatus(""), 1500);
    } else {
      // fallback if no requestCopy (직접 호출 환경)
      const ok = await tryClipboard(text);
      setCopyStatus(ok ? "복사됨" : "복사 실패");
      setTimeout(() => setCopyStatus(""), 1500);
    }
  };

  // 행동 분포 차트 데이터
  const actionChartData = useMemo(() => {
    if (!result) return [];
    const keys = ["probe", "normal", "heavy", "rest", "block", "dodge", "counter"];
    const labels = { probe: "견제", normal: "일반공", heavy: "강공", rest: "휴식", block: "방어", dodge: "회피", counter: "반격" };
    return keys.map(k => ({
      name: labels[k],
      A: result.totalActions.A[k],
      B: result.totalActions.B[k],
    }));
  }, [result]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
          {/* 좌측 — 캐릭터 + 룰 설정 */}
          <div className="lg:col-span-5 space-y-3">
            {/* 캐릭터 */}
            <div className="grid grid-cols-2 gap-3">
              <Section title="캐릭터 A" accent="blue">
                <StatSpinner label="근력" value={charA.str} onChange={v => setCharA({ ...charA, str: v })} />
                <StatSpinner label="회피" value={charA.agi} onChange={v => setCharA({ ...charA, agi: v })} />
                <div className="text-[10px] text-zinc-500 mt-1">
                  역할: {charA.str >= 4 ? "공격형" : charA.agi >= 4 ? "회피형" : "균형형"}
                </div>
              </Section>
              <Section title="캐릭터 B" accent="amber">
                <StatSpinner label="근력" value={charB.str} onChange={v => setCharB({ ...charB, str: v })} />
                <StatSpinner label="회피" value={charB.agi} onChange={v => setCharB({ ...charB, agi: v })} />
                <div className="text-[10px] text-zinc-500 mt-1">
                  역할: {charB.str >= 4 ? "공격형" : charB.agi >= 4 ? "회피형" : "균형형"}
                </div>
              </Section>
            </div>

            {/* HP + 선공 */}
            <Section title="공통">
              <Slider label="HP" value={rules.hp} onChange={v => updateRule("hp", v)} min={50} max={300} step={10} />
              <Slider label="라운드 상한" value={rules.roundLimit} onChange={v => updateRule("roundLimit", v)} min={10} max={100} step={5} />
              <div className="mt-2">
                <div className="text-xs text-zinc-400 mb-1">선공 모드</div>
                <div className="grid grid-cols-2 gap-1">
                  {[
                    { v: "random", l: "무작위 50:50" },
                    { v: "A_fixed", l: "A 고정 선공" },
                    { v: "B_fixed", l: "B 고정 선공" },
                    { v: "simultaneous", l: "동시 행동" },
                  ].map(opt => (
                    <button key={opt.v}
                      onClick={() => updateRule("initiative", opt.v)}
                      className={`px-2 py-1 rounded text-xs transition ${rules.initiative === opt.v ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
                    >{opt.l}</button>
                  ))}
                </div>
              </div>
            </Section>

            {/* 자원 */}
            <Section title="자원 (스태미나 / 집중력)">
              <Slider label="시작값" value={rules.resources.staminaStart} onChange={v => { updateRule("resources.staminaStart", v); updateRule("resources.focusStart", v); }} min={0} max={10} />
              <Slider label="최대값" value={rules.resources.staminaMax} onChange={v => { updateRule("resources.staminaMax", v); updateRule("resources.focusMax", v); }} min={3} max={15} />
              <Slider label="라운드 기본 회복" value={rules.resources.baseRecover} onChange={v => updateRule("resources.baseRecover", v)} min={0} max={3} />
              <Slider label="견제 추가 회복" value={rules.resources.probeRecoverBonus} onChange={v => updateRule("resources.probeRecoverBonus", v)} min={0} max={3} />
              <Slider label="방어 추가 회복" value={rules.resources.blockRecoverBonus} onChange={v => updateRule("resources.blockRecoverBonus", v)} min={0} max={3} />
              <Slider label="휴식 추가 회복" value={rules.resources.restRecoverBonus} onChange={v => updateRule("resources.restRecoverBonus", v)} min={1} max={6} />
            </Section>

            {/* 공격 행동 */}
            <Section title="공격 행동" accent="amber">
              {["probe", "normal", "heavy"].map(k => {
                const labels = { probe: "견제", normal: "일반공격", heavy: "강공격" };
                return (
                  <div key={k} className="mb-2 pb-2 border-b border-zinc-800 last:border-0">
                    <Toggle label={labels[k]} checked={rules.attack[k].enabled} onChange={v => updateRule(`attack.${k}.enabled`, v)} />
                    <div className="grid grid-cols-2 gap-x-3 pl-4 mt-1">
                      <Slider label="비용" value={rules.attack[k].cost} onChange={v => updateRule(`attack.${k}.cost`, v)} min={0} max={8} />
                      <Slider label="데미지" value={rules.attack[k].damage} onChange={v => updateRule(`attack.${k}.damage`, v)} min={1} max={60} />
                      <Slider label="근력×" value={rules.attack[k].rollFormula.str} onChange={v => updateRule(`attack.${k}.rollFormula.str`, v)} min={0} max={20} />
                      <Slider label="회피×" value={rules.attack[k].rollFormula.agi} onChange={v => updateRule(`attack.${k}.rollFormula.agi`, v)} min={0} max={20} />
                      <Slider label="기본 굴림" value={rules.attack[k].rollFormula.base} onChange={v => updateRule(`attack.${k}.rollFormula.base`, v)} min={0} max={90} />
                    </div>
                  </div>
                );
              })}
              <Toggle label="휴식 (공격 안 함, 자원만 회복)" checked={rules.attack.rest.enabled} onChange={v => updateRule("attack.rest.enabled", v)} />
            </Section>

            {/* 방어 행동 */}
            <Section title="방어 행동" accent="emerald">
              <div className="mb-2 pb-2 border-b border-zinc-800">
                <Toggle label="방어 (감산)" checked={rules.defense.block.enabled} onChange={v => updateRule("defense.block.enabled", v)} />
                <div className="grid grid-cols-2 gap-x-3 pl-4 mt-1">
                  <Slider label="비용" value={rules.defense.block.cost} onChange={v => updateRule("defense.block.cost", v)} min={0} max={4} />
                  <Slider label="데미지 배율" value={rules.defense.block.damageMult} onChange={v => updateRule("defense.block.damageMult", v)} min={0.2} max={1.0} step={0.05} />
                </div>
              </div>
              {["dodge", "counter"].map(k => {
                const labels = { dodge: "회피", counter: "반격" };
                return (
                  <div key={k} className="mb-2 pb-2 border-b border-zinc-800 last:border-0">
                    <Toggle label={labels[k]} checked={rules.defense[k].enabled} onChange={v => updateRule(`defense.${k}.enabled`, v)} />
                    <div className="grid grid-cols-2 gap-x-3 pl-4 mt-1">
                      <Slider label="비용" value={rules.defense[k].cost} onChange={v => updateRule(`defense.${k}.cost`, v)} min={0} max={8} />
                      <Slider label="근력×" value={rules.defense[k].rollFormula.str} onChange={v => updateRule(`defense.${k}.rollFormula.str`, v)} min={0} max={20} />
                      <Slider label="회피×" value={rules.defense[k].rollFormula.agi} onChange={v => updateRule(`defense.${k}.rollFormula.agi`, v)} min={0} max={20} />
                      <Slider label="기본 굴림" value={rules.defense[k].rollFormula.base} onChange={v => updateRule(`defense.${k}.rollFormula.base`, v)} min={0} max={90} />
                    </div>
                  </div>
                );
              })}
            </Section>

            {/* 연속기 */}
            <Section title="연속기 (더블 행동)">
              <Toggle label="더블 행동 허용" checked={rules.combo.doubleEnabled} onChange={v => updateRule("combo.doubleEnabled", v)} />
              <Slider label="더블 가능 자원 임계치" value={rules.combo.doubleThreshold} onChange={v => updateRule("combo.doubleThreshold", v)} min={3} max={12} />
              <Slider label="2번째 행동 굴림 보너스" value={rules.combo.secondRollBonus} onChange={v => updateRule("combo.secondRollBonus", v)} min={0} max={30} />
              <Slider label="2번째 데미지 보너스" value={rules.combo.secondDamageBonus} onChange={v => updateRule("combo.secondDamageBonus", v)} min={0} max={1} step={0.05} suffix="배" />
              <Slider label="방어자 2번 방어 페널티" value={rules.combo.defenseDoublePenalty} onChange={v => updateRule("combo.defenseDoublePenalty", v)} min={-30} max={0} />
            </Section>
          </div>

          {/* 우측 — 실행 + 결과 */}
          <div className="lg:col-span-7 space-y-3">
            {/* 실행 */}
            <Section title="시뮬레이션 실행">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-zinc-400 mr-1">반복:</span>
                {[100, 500, 1000, 5000].map(n => (
                  <button key={n}
                    onClick={() => setIterations(n)}
                    className={`px-3 py-1 rounded text-xs font-mono transition ${iterations === n ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}
                  >{n}</button>
                ))}
                <div className="flex-1" />
                <button
                  onClick={run}
                  disabled={running}
                  className="px-5 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-sm transition"
                >
                  {running ? "실행 중..." : "실행"}
                </button>
              </div>
            </Section>

            {result && (
              <>
                {/* 결과 요약 */}
                <Section title={`결과 (${result.n}회)`}>
                  <div className="flex justify-end mb-2 -mt-1">
                    <button
                      onClick={copyReport}
                      className="text-[11px] px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition flex items-center gap-1.5"
                    >
                      <span>📋</span>
                      <span>{copyStatus || "결과+설정 복사"}</span>
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">A 승률</div>
                      <div className="text-3xl font-bold text-blue-400 font-mono">{result.winRateA.toFixed(1)}<span className="text-base text-zinc-500">%</span></div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{result.winsA}회</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">B 승률</div>
                      <div className="text-3xl font-bold text-amber-400 font-mono">{result.winRateB.toFixed(1)}<span className="text-base text-zinc-500">%</span></div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">{result.winsB}회</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">평균 라운드</div>
                      <div className="text-3xl font-bold text-zinc-300 font-mono">{result.avgRounds.toFixed(1)}</div>
                      <div className="text-[10px] text-zinc-600 mt-0.5">무승부 {result.drawRate.toFixed(1)}%</div>
                    </div>
                  </div>
                  {/* 승률 바 */}
                  <div className="mt-3 flex h-2 rounded overflow-hidden bg-zinc-800">
                    <div className="bg-blue-500" style={{ width: `${result.winRateA}%` }} />
                    <div className="bg-zinc-600" style={{ width: `${result.drawRate}%` }} />
                    <div className="bg-amber-500" style={{ width: `${result.winRateB}%` }} />
                  </div>

                  {/* 선공별 승률 (무작위 모드일 때 의미 있음) */}
                  {result.initiativeStats.firstA_count > 0 && result.initiativeStats.firstB_count > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div className="bg-zinc-900/60 rounded p-2 border border-zinc-800">
                        <div className="text-zinc-500 mb-1">A 선공 시 ({result.initiativeStats.firstA_count}회)</div>
                        <div className="font-mono">
                          A 승률 <span className="text-blue-400 font-bold">{result.initiativeStats.firstA_winRate.toFixed(1)}%</span>
                        </div>
                      </div>
                      <div className="bg-zinc-900/60 rounded p-2 border border-zinc-800">
                        <div className="text-zinc-500 mb-1">B 선공 시 ({result.initiativeStats.firstB_count}회)</div>
                        <div className="font-mono">
                          B 승률 <span className="text-amber-400 font-bold">{result.initiativeStats.firstB_winRate.toFixed(1)}%</span>
                        </div>
                      </div>
                    </div>
                  )}
                </Section>

                {/* HP 추이 */}
                <Section title="라운드별 평균 HP (50회 평균)">
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer>
                      <LineChart data={result.hpTraceArr} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                        <XAxis dataKey="round" stroke="#71717a" tick={{ fontSize: 10 }} />
                        <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 12 }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Line type="monotone" dataKey="A" stroke="#60a5fa" strokeWidth={2} dot={false} name="캐릭터 A" />
                        <Line type="monotone" dataKey="B" stroke="#fbbf24" strokeWidth={2} dot={false} name="캐릭터 B" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </Section>

                {/* 행동 분포 */}
                <Section title="총 행동 분포">
                  <div style={{ width: "100%", height: 200 }}>
                    <ResponsiveContainer>
                      <BarChart data={actionChartData} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                        <XAxis dataKey="name" stroke="#71717a" tick={{ fontSize: 10 }} />
                        <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
                        <Tooltip contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", fontSize: 12 }} />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="A" fill="#3b82f6" name="A" />
                        <Bar dataKey="B" fill="#f59e0b" name="B" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </Section>

                {/* 샘플 로그 */}
                <Section title="샘플 전투 로그 (1회)">
                  <button
                    onClick={() => setShowLog(!showLog)}
                    className="text-xs text-emerald-400 hover:text-emerald-300 mb-2"
                  >
                    {showLog ? "▼ 접기" : "▶ 펼치기"}
                  </button>
                  {showLog && (
                    <div className="font-mono text-[11px] max-h-96 overflow-y-auto bg-zinc-950 rounded p-2 space-y-0.5 border border-zinc-800">
                      {result.sampleLog.map((l, i) => {
                        if (l.type === "init") {
                          const label = l.mode === "simultaneous" ? "동시 행동 모드"
                                      : l.firstIsA ? "A 선공" : "B 선공";
                          return <div key={i} className="text-emerald-400">▶ {label}</div>;
                        }
                        if (l.type === "round-start") {
                          return <div key={i} className="text-zinc-500 mt-1 border-t border-zinc-800 pt-1">— Round {l.round} —</div>;
                        }
                        if (l.type === "rest") {
                          return <div key={i} className="text-zinc-400">{l.actor} 휴식 (자원 회복)</div>;
                        }
                        const atkLabels = { probe: "견제", normal: "일반공", heavy: "강공" };
                        const defLabels = { block: "방어", dodge: "회피", counter: "반격" };
                        const defCost = {
                          block: rules.defense.block.cost,
                          dodge: rules.defense.dodge.cost,
                          counter: rules.defense.counter.cost,
                        };
                        const color = l.actor === "A" ? "text-blue-300" : "text-amber-300";
                        const dmgColor = l.damage > 0 ? "text-red-400" : "text-zinc-500";

                        // 공격 결과 텍스트
                        const atkPart = `${l.actor} ${atkLabels[l.attack]} 굴림 ${l.atkRoll}/${l.atkTarget} ${l.hit ? "명중" : "빗나감"}`;

                        // 방어자 선언 (항상 표시)
                        const defenderName = l.actor === "A" ? "B" : "A";
                        const defLabel = defLabels[l.defense];
                        const cost = defCost[l.defense] || 0;
                        const defDeclare = cost > 0
                          ? `${defenderName} ${defLabel} 선언 (집중력 -${cost})`
                          : `${defenderName} ${defLabel} 선언`;

                        // 방어 결과
                        let defResultText = "";
                        if (l.hit) {
                          if (l.defResult === "block") defResultText = " · 감산 적용";
                          else if (l.defResult === "success") defResultText = ` · 굴림 ${l.defRoll}/${l.defTarget} 성공`;
                          else if (l.defResult === "fail") defResultText = ` · 굴림 ${l.defRoll}/${l.defTarget} 실패`;
                        } else {
                          defResultText = " · 공격 빗나감, 방어 발동 안 함";
                        }

                        return (
                          <div key={i} className={color}>
                            <div>{atkPart}</div>
                            <div className="pl-3 text-zinc-400 text-[10px]">↳ {defDeclare}{defResultText}</div>
                            <div className="pl-3">
                              <span className={dmgColor}>[데미지 {l.damage}{l.counter ? ` / 반격 ${l.counter}` : ""}]</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </Section>
              </>
            )}

            {!result && (
              <div className="text-zinc-600 text-sm text-center py-10 border border-dashed border-zinc-800 rounded">
                좌측에서 캐릭터 스탯과 룰을 설정한 뒤 [실행] 버튼을 누르세요.
              </div>
            )}
          </div>
        </div>

        <div className="text-[10px] text-zinc-700 mt-6 text-center font-mono">
          d100 굴림, 굴림값 ≤ 목표값 시 성공 · 목표값은 5~95 클램프
        </div>
    </div>
  );
}

// ============================================================
// Storage 헬퍼 — window.storage (Artifact) 우선, localStorage fallback
// ============================================================
const STORAGE_PREFIX = "showtime:";
const hasArtifactStorage = () => typeof window !== "undefined" && window.storage;
const hasLocalStorage = () => {
  try { return typeof window !== "undefined" && !!window.localStorage; }
  catch (e) { return false; }
};

const storage = {
  async get(key, fallback = null) {
    // 1순위: Artifact window.storage
    if (hasArtifactStorage()) {
      try {
        const r = await window.storage.get(key);
        if (r) return JSON.parse(r.value);
      } catch (e) {}
    }
    // 2순위: localStorage
    if (hasLocalStorage()) {
      try {
        const v = window.localStorage.getItem(STORAGE_PREFIX + key);
        if (v !== null) return JSON.parse(v);
      } catch (e) {}
    }
    return fallback;
  },
  async set(key, value) {
    if (hasArtifactStorage()) {
      try {
        await window.storage.set(key, JSON.stringify(value));
        return true;
      } catch (e) {}
    }
    if (hasLocalStorage()) {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
        return true;
      } catch (e) {}
    }
    return false;
  },
  async list(prefix) {
    if (hasArtifactStorage()) {
      try {
        const r = await window.storage.list(prefix);
        return r?.keys || [];
      } catch (e) {}
    }
    if (hasLocalStorage()) {
      try {
        const out = [];
        const full = STORAGE_PREFIX + (prefix || "");
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(full)) out.push(k.slice(STORAGE_PREFIX.length));
        }
        return out;
      } catch (e) {}
    }
    return [];
  },
  async delete(key) {
    if (hasArtifactStorage()) {
      try {
        await window.storage.delete(key);
        return true;
      } catch (e) {}
    }
    if (hasLocalStorage()) {
      try {
        window.localStorage.removeItem(STORAGE_PREFIX + key);
        return true;
      } catch (e) {}
    }
    return false;
  },
};

// ============================================================
// AI 대사 풀 (해맑은 반말)
// ============================================================
const AI_LINES = {
  attack_heavy: [
    "이거 한 방 갈게!", "조심해~!", "받아랏!", "전력으로 간다~!",
    "이거 어때!", "쳐낼게~!", "쉽지 않을걸?", "한 방이다!",
  ],
  attack_normal: [
    "갈게~!", "이거다!", "여기!", "받아봐!",
    "한 대!", "쓱~", "치고 들어간다~", "타격!",
  ],
  attack_probe: [
    "툭~", "찔러볼게!", "간 좀 볼게~", "이거 어때~?",
    "느낌 좀 봐~", "쓱쓱~", "살짝!",
  ],
  attack_rest: [
    "잠깐 쉬어갈게~", "후우~ 한숨 돌리자", "정비 좀!",
    "타이밍 보고 있어~", "음~ 다음 한 방 노릴 거야!",
  ],
  defense_block: [
    "방어할래~!", "막을게!", "받아낼게~", "꽉 막기!",
    "버틸 거야!", "흠~ 막아!",
  ],
  defense_dodge: [
    "안 맞을래!", "스슥~", "피했지!", "느려느려~",
    "이건 못 맞춰!", "휙~!", "안 닿아~",
  ],
  defense_counter: [
    "반격이다!", "되받아치기!", "이거 받아라~", "역으로 간다!",
    "기다렸어~!", "찰칵!",
  ],
  crit_success: [
    "와 이거 잘 됐다!", "헐 대박!", "오~!", "이거 완벽한데!",
    "타이밍 좋았어~!",
  ],
  crit_fail: [
    "어 미안 미안 빗나갔어", "헛..!", "어어..?", "이런..!",
    "왜 안 맞지!", "어색하네~",
  ],
  crisis: [
    "헐, 위험해..!", "이거 한 방으로 끝낼래!", "물러나지 않을 거야!",
    "마지막이다~!", "이대로 끝낼 순 없어!", "버틸 거야!",
  ],
  win: [
    "헤헤 이겼다~", "이번엔 내가 이겼네!", "재밌었어~",
    "한 판 더?", "오~ 이겼다!",
  ],
  lose: [
    "졌다.. 한 판 더!", "아쉽네~", "다음엔 진짜 이긴다!",
    "잘 했어~", "음.. 인정!",
  ],
  round_start: [
    "음~ 뭘 할까?", "흠흠...", "좋아 가자!", "자~",
  ],
};
function pickLine(key) {
  const pool = AI_LINES[key] || [""];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ============================================================
// 1:1 대전 — 기본 AI 빌드 슬롯
// ============================================================
const DEFAULT_AI_BUILDS = [
  { id: "atk-knight",  name: "공격형 검사",  str: 4, agi: 2, builtin: true },
  { id: "evd-ninja",   name: "회피형 닌자",  str: 1, agi: 5, builtin: true },
  { id: "bal-fighter", name: "균형형 파이터", str: 3, agi: 3, builtin: true },
];

// ============================================================
// 1:1 대전 탭
// ============================================================
function DuelTab({ rules, updateRule, requestCopy }) {
  // 화면 상태: setup / battle / end / replay
  const [screen, setScreen] = useState("setup");

  // 대전 설정
  const [myChar, setMyChar] = useState({ str: 3, agi: 3 });
  const [aiBuilds, setAiBuilds] = useState(DEFAULT_AI_BUILDS);
  const [selectedBuildId, setSelectedBuildId] = useState("atk-knight");
  const [initMode, setInitMode] = useState("me"); // me / ai / random
  const [aiSpeed, setAiSpeed] = useState(500); // ms
  const [showAIThinking, setShowAIThinking] = useState(true);
  const [showOpponentResources, setShowOpponentResources] = useState(false);
  const [allowUndo, setAllowUndo] = useState(true);
  const [useCheeryTone, setUseCheeryTone] = useState(true);

  // 누적 통계 로드
  const [stats, setStats] = useState({});
  useEffect(() => {
    storage.get("duel-stats", {}).then(setStats);
    storage.get("duel-ai-builds", null).then(saved => {
      if (saved && Array.isArray(saved)) {
        // 사용자 추가 빌드 + 기본 빌드 머지
        const userOnly = saved.filter(b => !b.builtin);
        setAiBuilds([...DEFAULT_AI_BUILDS, ...userOnly]);
      }
    });
  }, []);

  // 전투 상태
  const [battle, setBattle] = useState(null);
  // battle: {
  //   me: { hp, stamina, focus, str, agi },
  //   ai: { hp, stamina, focus, str, agi, name },
  //   round, currentTurn ("me_attack" | "me_defense" | "ai_attack" | "ai_attack_done" | "ai_defense" | "round_end"),
  //   log: [...],
  //   pendingAttacks: [...] (현재 처리 중인 공격들),
  //   pendingMyAttack: [...] (내가 선언한 공격, 더블이면 길이 2),
  //   firstActor: "me" | "ai",
  //   ended: bool, winner: "me" | "ai" | "draw",
  //   history: [...] (리플레이용 상태 스냅샷),
  //   undoSnapshot: {...} (직전 상태)
  // }

  // currentTurn 변화 감시 — AI 행동/턴 진행을 useEffect에서 일원화 처리.
  // setBattle 콜백 안에선 부수효과 일으키지 않음으로써 Strict Mode 더블 실행 방지.
  useEffect(() => {
    if (!battle || battle.ended) return;

    // AI 공격 차례: triggerAIAttack 한 번만 발동
    if (battle.currentTurn === "ai_attack") {
      const t = setTimeout(() => triggerAIAttack(), aiSpeed);
      return () => clearTimeout(t);
    }

    // AI 휴식 등으로 ai_attack_done 진입 — 다음 단계 진행
    if (battle.currentTurn === "ai_attack_done") {
      setBattle(prev => prev ? advanceTurn(prev, "ai_attack_done") : prev);
      return;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle?.currentTurn, battle?.round]);

  // 대전 시작
  const startBattle = () => {
    const aiBuild = aiBuilds.find(b => b.id === selectedBuildId);
    if (!aiBuild) return;
    let firstActor;
    if (initMode === "me") firstActor = "me";
    else if (initMode === "ai") firstActor = "ai";
    else firstActor = Math.random() < 0.5 ? "me" : "ai";

    const newBattle = {
      me: {
        hp: rules.hp, maxHp: rules.hp,
        stamina: rules.resources.staminaStart,
        focus: rules.resources.focusStart,
        str: myChar.str, agi: myChar.agi,
        name: "나",
      },
      ai: {
        hp: rules.hp, maxHp: rules.hp,
        stamina: rules.resources.staminaStart,
        focus: rules.resources.focusStart,
        str: aiBuild.str, agi: aiBuild.agi,
        name: aiBuild.name, buildId: aiBuild.id,
      },
      round: 1,
      currentTurn: firstActor === "me" ? "me_attack" : "ai_attack",
      log: [{ type: "init", firstActor, aiName: aiBuild.name, aiStr: aiBuild.str, aiAgi: aiBuild.agi, mode: initMode }],
      pendingAttacks: null,
      pendingMyAttack: [],
      firstActor,
      secondActor: firstActor === "me" ? "ai" : "me",
      firstDone: false, // 첫 행동 완료 여부 (라운드 내)
      ended: false,
      winner: null,
      myActionCounts: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 },
      aiActionCounts: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 },
      undoSnapshot: null,
      history: [],
    };
    setBattle(newBattle);
    setScreen("battle");
    // AI 선공이면 useEffect가 자동으로 triggerAIAttack 실행
  };

  // === AI가 공격할 때 ===
  // state setter 콜백은 순수해야 하므로, 여기선 상태 transition만 처리.
  // 후속 turn 진행은 useEffect가 currentTurn을 감지해 처리.
  const triggerAIAttack = () => {
    setBattle(prev => {
      if (!prev) return prev;
      // 이미 다른 단계로 진입했거나 종료된 경우 무시 (중복 호출 방어)
      if (prev.currentTurn !== "ai_attack" || prev.ended) return prev;

      const cur = prev;
      const ai = cur.ai, me = cur.me;
      const attacks = chooseAttacks(ai, me, rules);
      const thinking = generateThinking(ai, me, rules, attacks, "attack");
      const lineKey = attacks[0] === "rest" ? "attack_rest"
                    : attacks[0] === "heavy" ? "attack_heavy"
                    : attacks[0] === "normal" ? "attack_normal"
                    : "attack_probe";

      // AI 위기 모드(HP<30) + 공격적 행동 시 시각 효과 플래그
      const isCrisis = ai.hp < 30 && attacks[0] !== "rest";
      const isAggressive = attacks.includes("heavy") || attacks.length > 1;
      const crisisFlag = isCrisis && isAggressive;

      const newLog = [...cur.log,
        useCheeryTone ? { type: "ai_speech", text: pickLine(lineKey), crisis: crisisFlag } : null,
        showAIThinking ? { type: "ai_think", text: thinking } : null,
        { type: "ai_declare", attacks, round: cur.round, crisis: crisisFlag },
      ].filter(Boolean);

      // 휴식 — 자원 회복하고 곧바로 "AI 행동 종료" 단계로
      if (attacks.length === 1 && attacks[0] === "rest") {
        const aiNext = { ...ai, stamina: Math.min(rules.resources.staminaMax, ai.stamina + rules.resources.restRecoverBonus + rules.resources.baseRecover) };
        const counts = { ...cur.aiActionCounts, rest: cur.aiActionCounts.rest + 1 };
        return {
          ...cur, ai: aiNext, log: newLog, aiActionCounts: counts,
          currentTurn: "ai_attack_done", // useEffect가 다음 단계 진행
        };
      }
      // 자원 차감 + 카운트
      let staminaUsed = 0;
      const counts = { ...cur.aiActionCounts };
      for (const k of attacks) { staminaUsed += rules.attack[k].cost; counts[k]++; }
      if (attacks.length > 1) counts.double++;
      const aiNext = { ...ai, stamina: ai.stamina - staminaUsed };

      // 사용자가 방어할 차례
      return {
        ...cur,
        ai: aiNext,
        log: newLog,
        aiActionCounts: counts,
        pendingAttacks: attacks,
        pendingDefenseIndex: 0,
        currentTurn: "me_defense",
      };
    });
  };

  // === 사용자가 공격 선택 (1단계) ===
  const onMyAttackChoose = (firstActionKey) => {
    setBattle(prev => {
      const undoSnapshot = JSON.parse(JSON.stringify(prev));
      const next = { ...prev, undoSnapshot };

      // 휴식이면 더블 분기 없음
      if (firstActionKey === "rest") {
        const me = { ...prev.me, stamina: Math.min(rules.resources.staminaMax, prev.me.stamina + rules.resources.restRecoverBonus + rules.resources.baseRecover) };
        const counts = { ...prev.myActionCounts, rest: prev.myActionCounts.rest + 1 };
        const newLog = [...prev.log, { type: "me_declare", attacks: ["rest"], round: prev.round }];
        return advanceTurn({ ...next, me, log: newLog, myActionCounts: counts }, "me_attack_done");
      }

      // 첫 행동 선택 — 더블 분기 화면으로 이동
      const A = rules.attack;
      const remaining = prev.me.stamina - A[firstActionKey].cost;
      // 더블 가능 여부
      const canDouble = rules.combo.doubleEnabled && remaining >= Math.min(A.probe.cost, A.normal.cost, A.heavy.cost);

      if (!canDouble) {
        // 단발 확정
        return finalizeMyAttack(next, [firstActionKey]);
      }

      return {
        ...next,
        pendingMyAttack: [firstActionKey],
        currentTurn: "me_attack_combo",
      };
    });
  };

  // === 사용자가 연속기 선택 (2단계) ===
  const onMyAttackCombo = (secondActionKey) => {
    setBattle(prev => {
      const finalAttacks = secondActionKey
        ? [...prev.pendingMyAttack, secondActionKey]
        : prev.pendingMyAttack;
      return finalizeMyAttack(prev, finalAttacks);
    });
  };

  // 사용자 공격 확정 → AI 방어 처리
  const finalizeMyAttack = (state, attacks) => {
    // 자원 차감
    let staminaUsed = 0;
    const counts = { ...state.myActionCounts };
    for (const k of attacks) { staminaUsed += rules.attack[k].cost; counts[k]++; }
    if (attacks.length > 1) counts.double++;
    const me = { ...state.me, stamina: state.me.stamina - staminaUsed };
    const newLog = [...state.log, { type: "me_declare", attacks, round: state.round }];

    // AI 방어 결정
    const defenses = chooseDefense(state.ai, me, rules, attacks);
    const aiThinking = generateThinking(state.ai, me, rules, attacks, "defense");
    const defLineKey = defenses[0] === "counter" ? "defense_counter"
                     : defenses[0] === "dodge" ? "defense_dodge"
                     : "defense_block";
    const defLogs = [
      useCheeryTone ? { type: "ai_speech", text: pickLine(defLineKey) } : null,
      showAIThinking ? { type: "ai_think", text: aiThinking } : null,
    ].filter(Boolean);

    // 각 공격 처리 (즉시 굴림)
    let aiAfter = { ...state.ai };
    let meAfter = me;
    const resultLogs = [];
    let focusUsed = 0;
    const aiCounts = { ...state.aiActionCounts };
    for (let i = 0; i < attacks.length; i++) {
      const r = resolveOne(meAfter, aiAfter, attacks[i], defenses[i], rules, i > 0, i > 0);
      aiAfter = { ...aiAfter, hp: aiAfter.hp - r.damage };
      if (r.counter) meAfter = { ...meAfter, hp: meAfter.hp - r.counter };
      focusUsed += rules.defense[defenses[i]].cost;
      aiCounts[defenses[i]]++;
      resultLogs.push({
        type: "action_result",
        actor: "me",
        attack: attacks[i],
        defense: defenses[i],
        ...r,
      });
      if (aiAfter.hp <= 0 || meAfter.hp <= 0) break;
    }
    aiAfter = { ...aiAfter, focus: aiAfter.focus - focusUsed };

    const finalState = {
      ...state,
      me: meAfter, ai: aiAfter,
      log: [...newLog, ...defLogs, ...resultLogs],
      myActionCounts: counts,
      aiActionCounts: aiCounts,
      pendingMyAttack: [],
    };

    return advanceTurn(finalState, "me_attack_done");
  };

  // === 사용자가 방어 선택 ===
  const onMyDefenseChoose = (defenseKey) => {
    setBattle(prev => {
      const undoSnapshot = prev.pendingDefenseIndex === 0 ? JSON.parse(JSON.stringify(prev)) : prev.undoSnapshot;
      const i = prev.pendingDefenseIndex || 0;
      const attacks = prev.pendingAttacks;
      const isSecond = i > 0;

      // 굴림 실행
      const r = resolveOne(prev.ai, prev.me, attacks[i], defenseKey, rules, isSecond, isSecond);
      let meAfter = { ...prev.me, hp: prev.me.hp - r.damage, focus: prev.me.focus - rules.defense[defenseKey].cost };
      let aiAfter = prev.ai;
      if (r.counter) aiAfter = { ...aiAfter, hp: aiAfter.hp - r.counter };

      const counts = { ...prev.myActionCounts };
      counts[defenseKey]++;
      const newLog = [...prev.log, {
        type: "action_result",
        actor: "ai",
        attack: attacks[i],
        defense: defenseKey,
        ...r,
      }];

      const nextState = {
        ...prev,
        me: meAfter, ai: aiAfter,
        log: newLog,
        myActionCounts: counts,
        pendingDefenseIndex: i + 1,
        undoSnapshot,
      };

      // 더 받을 공격이 남았으면 다음 방어로
      if (i + 1 < attacks.length && meAfter.hp > 0 && aiAfter.hp > 0) {
        return nextState; // currentTurn 그대로 me_defense
      }

      // 다 받았음 → 다음 단계
      return advanceTurn({ ...nextState, pendingAttacks: null, pendingDefenseIndex: 0 }, "ai_attack_done");
    });
  };

  // 턴 진행 처리
  const advanceTurn = (state, completedPhase) => {
    // 사망 체크
    if (state.me.hp <= 0 || state.ai.hp <= 0) {
      const winner = state.me.hp <= 0 && state.ai.hp <= 0 ? "draw"
                   : state.me.hp <= 0 ? "ai" : "me";
      setTimeout(() => recordStats(state.ai.buildId, winner, state.round, state.myActionCounts, state.aiActionCounts), 0);
      return { ...state, ended: true, winner, currentTurn: "ended" };
    }

    // me_attack_done → 두 번째 행동자 차례
    if (completedPhase === "me_attack_done") {
      if (state.firstActor === "me" && !state.firstDone) {
        // 후공 AI 차례 — useEffect가 발동
        return { ...state, firstDone: true, currentTurn: "ai_attack" };
      } else {
        return endRound(state);
      }
    }
    if (completedPhase === "ai_attack_done") {
      if (state.firstActor === "ai" && !state.firstDone) {
        // 후공 나 차례
        return { ...state, firstDone: true, currentTurn: "me_attack" };
      } else {
        return endRound(state);
      }
    }
    return state;
  };

  // 라운드 종료 처리 (자원 회복 + 다음 라운드)
  const endRound = (state) => {
    const baseRec = rules.resources.baseRecover;
    const meRec = { ...state.me,
      stamina: Math.min(rules.resources.staminaMax, state.me.stamina + baseRec),
      focus: Math.min(rules.resources.focusMax, state.me.focus + baseRec),
    };
    const aiRec = { ...state.ai,
      stamina: Math.min(rules.resources.staminaMax, state.ai.stamina + baseRec),
      focus: Math.min(rules.resources.focusMax, state.ai.focus + baseRec),
    };
    return {
      ...state,
      me: meRec, ai: aiRec,
      round: state.round + 1,
      firstDone: false,
      currentTurn: state.firstActor === "me" ? "me_attack" : "ai_attack",
      log: [...state.log, { type: "round_end", round: state.round }],
    };
    // AI 선공이면 useEffect가 다음 라운드 시작 시 자동 발동
  };

  // 무르기
  const undo = () => {
    if (!battle?.undoSnapshot) return;
    setBattle(battle.undoSnapshot);
  };

  // 다시하기
  const restart = () => {
    startBattle();
  };

  // 누적 통계 기록
  const recordStats = async (buildId, winner, rounds, myCounts, aiCounts) => {
    const cur = await storage.get("duel-stats", {});
    const s = cur[buildId] || { games: 0, wins: 0, losses: 0, draws: 0, totalRounds: 0, aiCounts: { probe: 0, normal: 0, heavy: 0, rest: 0, block: 0, dodge: 0, counter: 0, double: 0 } };
    s.games++;
    if (winner === "me") s.wins++;
    else if (winner === "ai") s.losses++;
    else s.draws++;
    s.totalRounds += rounds;
    for (const k of Object.keys(s.aiCounts)) s.aiCounts[k] += aiCounts[k] || 0;
    cur[buildId] = s;
    await storage.set("duel-stats", cur);
    setStats(cur);
  };

  // === 화면 분기 ===
  if (screen === "setup") {
    return (
      <DuelSetupScreen
        myChar={myChar} setMyChar={setMyChar}
        aiBuilds={aiBuilds} setAiBuilds={setAiBuilds}
        selectedBuildId={selectedBuildId} setSelectedBuildId={setSelectedBuildId}
        initMode={initMode} setInitMode={setInitMode}
        aiSpeed={aiSpeed} setAiSpeed={setAiSpeed}
        showAIThinking={showAIThinking} setShowAIThinking={setShowAIThinking}
        showOpponentResources={showOpponentResources} setShowOpponentResources={setShowOpponentResources}
        allowUndo={allowUndo} setAllowUndo={setAllowUndo}
        useCheeryTone={useCheeryTone} setUseCheeryTone={setUseCheeryTone}
        stats={stats}
        onStart={startBattle}
      />
    );
  }

  if (screen === "battle" && battle) {
    if (battle.ended) {
      return (
        <DuelEndScreen
          battle={battle}
          stats={stats[battle.ai.buildId]}
          requestCopy={requestCopy}
          onRestart={() => { setScreen("setup"); setTimeout(restart, 0); }}
          onReplay={() => setScreen("replay")}
          onBack={() => setScreen("setup")}
        />
      );
    }
    return (
      <DuelBattleScreen
        battle={battle} rules={rules} updateRule={updateRule}
        showAIThinking={showAIThinking}
        showOpponentResources={showOpponentResources}
        allowUndo={allowUndo}
        useCheeryTone={useCheeryTone}
        requestCopy={requestCopy}
        onMyAttackChoose={onMyAttackChoose}
        onMyAttackCombo={onMyAttackCombo}
        onMyDefenseChoose={onMyDefenseChoose}
        onUndo={undo}
        onRestart={restart}
        onExit={() => setScreen("setup")}
        onOpenRules={() => {}}
      />
    );
  }

  if (screen === "replay" && battle) {
    return (
      <DuelReplayScreen
        battle={battle}
        onBack={() => setScreen("battle")}
      />
    );
  }

  return null;
}

// AI 사고 텍스트 생성
function generateThinking(self, opp, rules, actions, type) {
  const sit = judgeSituation(self, opp, rules);
  const sitLabel = { crisis: "위기", dominant: "우세", losing: "열세", even: "균형" }[sit];
  const role = judgeRole(self);
  const roleLabel = { aggressor: "공격형", evader: "회피형", balanced: "균형형" }[role];

  if (type === "attack") {
    const actNames = actions.map(a => ({ probe: "견제", normal: "일반공", heavy: "강공", rest: "휴식" }[a])).join(" + ");
    let reason = "";

    // 자원 부족으로 강제 선택된 경우 감지
    const wantedHeavy = (sit === "losing" || sit === "crisis");
    const usedHeavy = actions.includes("heavy");
    const usedNormal = actions.includes("normal");
    const A = rules.attack;
    const canHeavy = A.heavy.enabled && self.stamina >= A.heavy.cost;
    const canNormal = A.normal.enabled && self.stamina >= A.normal.cost;

    if (actions[0] === "rest") {
      reason = "자원 부족 — 휴식으로 회복";
    } else if (wantedHeavy && !usedHeavy && !canHeavy) {
      reason = `${sitLabel} — 강공 노렸으나 자원 부족, ${usedNormal ? "일반공" : "견제"}로 대체`;
    } else if (sit === "crisis") {
      reason = "위기 — 한 방 노림";
    } else if (sit === "dominant") {
      if (actions.length > 1) reason = "우세 — 모은 자원 폭발";
      else reason = "우세 — 자원 모으기";
    } else if (sit === "losing") {
      reason = "열세 — 뒤집기 시도";
    } else {
      if (actions.length > 1) reason = `${roleLabel} 더블 콤보`;
      else reason = `${roleLabel} 기본 패턴`;
    }
    return `상황: ${sitLabel} (HP ${self.hp} vs ${opp.hp}) / 자원: ⚡${self.stamina} ◈${self.focus} / 선택: ${actNames} (${reason})`;
  }

  // defense
  const incoming = actions.map(a => ({ probe: "견제", normal: "일반공", heavy: "강공", rest: "휴식" }[a])).join(" + ");
  return `상황: ${sitLabel} / 들어오는 공격: ${incoming} / 자원: ◈${self.focus} → 빌드(${roleLabel}) 패턴으로 방어 결정`;
}

// ============================================================
// 1:1 — 대전 설정 화면
// ============================================================
function DuelSetupScreen({
  myChar, setMyChar, aiBuilds, setAiBuilds,
  selectedBuildId, setSelectedBuildId,
  initMode, setInitMode, aiSpeed, setAiSpeed,
  showAIThinking, setShowAIThinking,
  showOpponentResources, setShowOpponentResources,
  allowUndo, setAllowUndo,
  useCheeryTone, setUseCheeryTone,
  stats, onStart,
}) {
  const [newBuildForm, setNewBuildForm] = useState(null);

  const addBuild = async () => {
    if (!newBuildForm) return;
    const id = "u-" + Date.now();
    const newList = [...aiBuilds, { ...newBuildForm, id, builtin: false }];
    setAiBuilds(newList);
    setSelectedBuildId(id);
    await storage.set("duel-ai-builds", newList.filter(b => !b.builtin));
    setNewBuildForm(null);
  };

  const removeBuild = async (id) => {
    const newList = aiBuilds.filter(b => b.id !== id);
    setAiBuilds(newList);
    if (selectedBuildId === id) setSelectedBuildId(newList[0]?.id || "");
    await storage.set("duel-ai-builds", newList.filter(b => !b.builtin));
  };

  return (
    <div className="max-w-md mx-auto">
      <h2 className="text-lg font-bold mb-3 px-2 text-zinc-100">1:1 대전 설정</h2>

      <Section title="내 캐릭터" accent="blue">
        <StatSpinner label="근력" value={myChar.str} onChange={v => setMyChar({ ...myChar, str: v })} />
        <StatSpinner label="회피" value={myChar.agi} onChange={v => setMyChar({ ...myChar, agi: v })} />
        <div className="text-[10px] text-zinc-500 mt-1">
          역할: {myChar.str >= 4 ? "공격형" : myChar.agi >= 4 ? "회피형" : "균형형"}
        </div>
      </Section>

      <div className="mt-3">
        <Section title="AI 빌드" accent="amber">
          <div className="space-y-1.5">
            {aiBuilds.map(b => {
              const buildStat = stats[b.id];
              const winRate = buildStat?.games > 0 ? (buildStat.wins / buildStat.games * 100).toFixed(0) : null;
              return (
                <div key={b.id}
                  className={`rounded-md px-2.5 py-1.5 border cursor-pointer transition ${selectedBuildId === b.id ? "bg-amber-900/30 border-amber-600" : "bg-zinc-800/50 border-zinc-700 hover:border-zinc-600"}`}
                  onClick={() => setSelectedBuildId(b.id)}
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="text-xs font-semibold text-zinc-100">{b.name}</div>
                      <div className="text-[10px] text-zinc-500 font-mono">근 {b.str} / 회 {b.agi}{winRate !== null ? ` · 내 승률 ${winRate}% (${buildStat.games}판)` : ""}</div>
                    </div>
                    {selectedBuildId === b.id && <span className="text-[10px] text-amber-400">✓</span>}
                    {!b.builtin && selectedBuildId !== b.id && (
                      <button onClick={(e) => { e.stopPropagation(); removeBuild(b.id); }}
                        className="text-[10px] text-zinc-600 hover:text-red-400">✕</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {!newBuildForm ? (
            <button onClick={() => setNewBuildForm({ name: "새 빌드", str: 3, agi: 3 })}
              className="w-full mt-2 text-[11px] text-emerald-400 hover:text-emerald-300 py-1">
              + 새 빌드 만들기
            </button>
          ) : (
            <div className="mt-2 p-2 bg-zinc-800/60 rounded border border-zinc-700">
              <input value={newBuildForm.name}
                onChange={e => setNewBuildForm({ ...newBuildForm, name: e.target.value })}
                placeholder="빌드 이름"
                className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs mb-2 text-zinc-100"/>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <div className="text-[10px] text-zinc-500 mb-0.5">근력</div>
                  <input type="number" min="0" max="5" value={newBuildForm.str}
                    onChange={e => setNewBuildForm({ ...newBuildForm, str: Math.max(0, Math.min(5, parseInt(e.target.value) || 0)) })}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100"/>
                </div>
                <div>
                  <div className="text-[10px] text-zinc-500 mb-0.5">회피</div>
                  <input type="number" min="0" max="5" value={newBuildForm.agi}
                    onChange={e => setNewBuildForm({ ...newBuildForm, agi: Math.max(0, Math.min(5, parseInt(e.target.value) || 0)) })}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100"/>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={addBuild} className="flex-1 bg-emerald-600 text-white text-xs py-1.5 rounded">추가</button>
                <button onClick={() => setNewBuildForm(null)} className="flex-1 bg-zinc-700 text-zinc-300 text-xs py-1.5 rounded">취소</button>
              </div>
            </div>
          )}
        </Section>
      </div>

      <div className="mt-3">
        <Section title="대전 옵션">
          <div className="mb-3">
            <div className="text-xs text-zinc-400 mb-1">선공</div>
            <div className="grid grid-cols-3 gap-1">
              {[["me", "나"], ["ai", "AI"], ["random", "무작위"]].map(([v, l]) => (
                <button key={v} onClick={() => setInitMode(v)}
                  className={`py-1.5 rounded text-xs transition ${initMode === v ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-3">
            <div className="text-xs text-zinc-400 mb-1">AI 응답 속도</div>
            <div className="grid grid-cols-3 gap-1">
              {[[0, "즉시"], [500, "0.5초"], [1000, "1초"]].map(([v, l]) => (
                <button key={v} onClick={() => setAiSpeed(v)}
                  className={`py-1.5 rounded text-xs transition ${aiSpeed === v ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5 mt-2">
            <Toggle label="AI 사고 표시" checked={showAIThinking} onChange={setShowAIThinking} />
            <Toggle label="상대 자원 공개" checked={showOpponentResources} onChange={setShowOpponentResources} />
            <Toggle label="무르기 허용" checked={allowUndo} onChange={setAllowUndo} />
            <Toggle label="해맑은 말투 사용" checked={useCheeryTone} onChange={setUseCheeryTone} />
          </div>
        </Section>
      </div>

      <button onClick={onStart}
        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-lg text-sm mt-4">
        대전 시작
      </button>
    </div>
  );
}

// ============================================================
// 1:1 — 메인 전투 화면
// ============================================================
function DuelBattleScreen({
  battle, rules, updateRule,
  showAIThinking, showOpponentResources, allowUndo, useCheeryTone,
  requestCopy,
  onMyAttackChoose, onMyAttackCombo, onMyDefenseChoose,
  onUndo, onRestart, onExit, onOpenRules,
}) {
  const logRef = React.useRef(null);
  const [showRules, setShowRules] = useState(false);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [battle.log.length]);

  const me = battle.me, ai = battle.ai;
  const A = rules.attack;

  return (
    <div className="max-w-md mx-auto bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden flex flex-col relative" style={{ height: "calc(100dvh - 80px)", minHeight: "640px" }}>
      {/* 헤더 */}
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950 flex-shrink-0">
        <button onClick={onExit} className="text-zinc-500 text-xs">← 나가기</button>
        <div className="text-xs text-zinc-400 font-mono">Round {battle.round}</div>
        <div className="flex gap-2">
          <button onClick={() => setShowRules(true)} className="text-zinc-400 text-xs" title="룰 설정">⚙️</button>
          <button onClick={onRestart} className="text-emerald-400 text-xs">⟲</button>
        </div>
      </div>

      {/* HP 바 */}
      <div className="px-4 py-2.5 bg-zinc-900/60 border-b border-zinc-800 flex-shrink-0">
        <div className="mb-2">
          <div className="flex justify-between items-baseline mb-1">
            <span className="text-xs text-blue-300 font-semibold">나 ({me.str}/{me.agi})</span>
            <span className="font-mono text-xs text-zinc-400">{me.hp} / {me.maxHp}</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.max(0, me.hp / me.maxHp * 100)}%` }} />
          </div>
          <div className="flex gap-3 mt-1 text-[10px] font-mono">
            <span className="text-amber-400">⚡{me.stamina}/{rules.resources.staminaMax}</span>
            <span className="text-emerald-400">◈{me.focus}/{rules.resources.focusMax}</span>
          </div>
        </div>
        <div>
          <div className="flex justify-between items-baseline mb-1">
            <span className="text-xs text-amber-300 font-semibold">{ai.name} ({ai.str}/{ai.agi})</span>
            <span className="font-mono text-xs text-zinc-400">{ai.hp} / {ai.maxHp}</span>
          </div>
          <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
            <div className="h-full bg-amber-500 transition-all" style={{ width: `${Math.max(0, ai.hp / ai.maxHp * 100)}%` }} />
          </div>
          <div className="flex gap-3 mt-1 text-[10px] font-mono">
            {showOpponentResources ? (
              <>
                <span className="text-amber-400">⚡{ai.stamina}/{rules.resources.staminaMax}</span>
                <span className="text-emerald-400">◈{ai.focus}/{rules.resources.focusMax}</span>
              </>
            ) : (
              <span className="text-zinc-600">⚡ 비공개 · ◈ 비공개</span>
            )}
          </div>
        </div>
      </div>

      {/* 채팅 로그 */}
      <div ref={logRef} className="flex-1 px-3 py-2 overflow-y-auto space-y-1.5">
        {battle.log.map((l, i) => <LogEntry key={i} entry={l} />)}

        {/* 턴 안내 */}
        {!battle.ended && (
          <div className={`rounded-lg p-2 mt-1 ${
            battle.currentTurn === "me_attack" || battle.currentTurn === "me_attack_combo" ? "bg-emerald-900/30 border border-emerald-800" :
            battle.currentTurn === "me_defense" ? "bg-rose-900/30 border border-rose-800" :
            "bg-zinc-900/30 border border-zinc-800"
          }`}>
            <div className="text-[10px] font-semibold">
              {battle.currentTurn === "me_attack" && <span className="text-emerald-300">↓ 공격 선언 (자원 ⚡{me.stamina} ◈{me.focus})</span>}
              {battle.currentTurn === "me_attack_combo" && <span className="text-emerald-300">↓ 한 번 더? (남은 ⚡{me.stamina - rules.attack[battle.pendingMyAttack[0]].cost})</span>}
              {battle.currentTurn === "me_defense" && <span className="text-rose-300">↓ 방어 선언 ({(battle.pendingDefenseIndex || 0) + 1}/{battle.pendingAttacks.length})</span>}
              {battle.currentTurn === "ai_attack" && <span className="text-zinc-400">AI 행동 중...</span>}
            </div>
          </div>
        )}
      </div>

      {/* 행동 버튼 */}
      <div className="border-t border-zinc-800 bg-zinc-900 px-3 py-2.5 flex-shrink-0">
        {battle.currentTurn === "me_attack" && (
          <MyAttackPanel rules={rules} me={me} onChoose={onMyAttackChoose} />
        )}
        {battle.currentTurn === "me_attack_combo" && (
          <MyComboPanel rules={rules} me={me} firstAction={battle.pendingMyAttack[0]} onChoose={onMyAttackCombo} />
        )}
        {battle.currentTurn === "me_defense" && (
          <MyDefensePanel rules={rules} me={me}
            ai={battle.ai}
            incoming={battle.pendingAttacks[battle.pendingDefenseIndex || 0]}
            allIncoming={battle.pendingAttacks}
            isSecond={(battle.pendingDefenseIndex || 0) > 0}
            onChoose={onMyDefenseChoose}/>
        )}
        {(battle.currentTurn === "ai_attack") && (
          <div className="text-center py-3 text-zinc-500 text-xs">AI가 행동을 결정 중입니다...</div>
        )}

        <div className="flex justify-between items-center pt-2 mt-2 border-t border-zinc-800">
          {allowUndo && battle.undoSnapshot ? (
            <button onClick={onUndo} className="text-[10px] text-zinc-500 hover:text-zinc-300">↶ 무르기</button>
          ) : <span></span>}
          <button onClick={() => requestCopy && requestCopy(buildBattleLogText(battle, rules), "전투 로그 복사")} className="text-[10px] text-zinc-500 hover:text-zinc-300">📋 복사</button>
        </div>
      </div>

      {/* 룰 시트 슬라이드 업 */}
      {showRules && (
        <div className="absolute inset-0 bg-black/60 z-10 flex items-end" onClick={() => setShowRules(false)}>
          <div className="w-full bg-zinc-900 border-t border-zinc-700 rounded-t-2xl flex flex-col" style={{ maxHeight: "85%" }} onClick={e => e.stopPropagation()}>
            {/* 헤더 */}
            <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between flex-shrink-0">
              <button onClick={() => setShowRules(false)} className="text-zinc-400 text-base w-7 h-7 flex items-center justify-center">✕</button>
              <span className="text-sm font-semibold">룰 설정 (즉시 적용)</span>
              <button onClick={() => setShowRules(false)} className="text-emerald-400 text-xs font-bold">완료</button>
            </div>

            {/* 스크롤 영역 */}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
              <div className="bg-amber-950/30 border border-amber-800/40 rounded-md px-3 py-2">
                <div className="text-[10px] text-amber-300">다음 라운드부터 적용됩니다. 상세 편집은 [밸런스 시뮬] 탭에서 가능합니다.</div>
              </div>

              {/* 자원 */}
              <Section title="자원">
                <Slider label="최대값 (스태미나/집중력 공통)" value={rules.resources.staminaMax}
                  onChange={v => { updateRule("resources.staminaMax", v); updateRule("resources.focusMax", v); }}
                  min={3} max={15} />
                <Slider label="라운드 기본 회복" value={rules.resources.baseRecover}
                  onChange={v => updateRule("resources.baseRecover", v)} min={0} max={4} />
                <Slider label="휴식 추가 회복" value={rules.resources.restRecoverBonus}
                  onChange={v => updateRule("resources.restRecoverBonus", v)} min={1} max={6} />
              </Section>

              {/* 공격 비용·데미지 */}
              <Section title="공격 행동" accent="amber">
                {["probe", "normal", "heavy"].map(k => {
                  const labels = { probe: "견제", normal: "일반공", heavy: "강공" };
                  return (
                    <div key={k} className="mb-2 pb-2 border-b border-zinc-800 last:border-0 last:mb-0 last:pb-0">
                      <div className="text-xs text-zinc-300 mb-1">{labels[k]}</div>
                      <div className="grid grid-cols-2 gap-x-3">
                        <Slider label="비용" value={rules.attack[k].cost}
                          onChange={v => updateRule(`attack.${k}.cost`, v)} min={0} max={8} />
                        <Slider label="데미지" value={rules.attack[k].damage}
                          onChange={v => updateRule(`attack.${k}.damage`, v)} min={1} max={60} />
                      </div>
                    </div>
                  );
                })}
                <Toggle label="휴식 사용" checked={rules.attack.rest.enabled}
                  onChange={v => updateRule("attack.rest.enabled", v)} />
              </Section>

              {/* 방어 비용 */}
              <Section title="방어 행동" accent="emerald">
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-[10px] text-zinc-400 text-center">방어</div>
                    <Slider label="비용" value={rules.defense.block.cost}
                      onChange={v => updateRule("defense.block.cost", v)} min={0} max={4} />
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-400 text-center">회피</div>
                    <Slider label="비용" value={rules.defense.dodge.cost}
                      onChange={v => updateRule("defense.dodge.cost", v)} min={0} max={8} />
                  </div>
                  <div>
                    <div className="text-[10px] text-zinc-400 text-center">반격</div>
                    <Slider label="비용" value={rules.defense.counter.cost}
                      onChange={v => updateRule("defense.counter.cost", v)} min={0} max={8} />
                  </div>
                </div>
                <Slider label="방어 데미지 배율" value={rules.defense.block.damageMult}
                  onChange={v => updateRule("defense.block.damageMult", v)} min={0.2} max={1.0} step={0.05} />
              </Section>

              <div className="text-[10px] text-zinc-500 text-center pt-2 pb-1">
                상세 (굴림 공식·연속기 등) 편집은 [밸런스 시뮬] 탭에서
              </div>
            </div>

            {/* 하단 닫기 버튼 (sticky) */}
            <div className="px-3 py-2.5 border-t border-zinc-800 bg-zinc-900 flex-shrink-0">
              <button onClick={() => setShowRules(false)}
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm">
                전투로 돌아가기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 로그 항목 렌더
function LogEntry({ entry: l }) {
  const atkLabels = { probe: "견제", normal: "일반공", heavy: "강공", rest: "휴식" };
  const defLabels = { block: "방어", dodge: "회피", counter: "반격" };

  if (l.type === "init") {
    return (
      <div className="text-center text-[10px] text-zinc-500 py-1">
        전투 시작 · {l.firstActor === "me" ? "내" : l.aiName} 선공 · AI: {l.aiName} (근{l.aiStr} 회{l.aiAgi})
      </div>
    );
  }
  if (l.type === "round_end") {
    return <div className="text-center text-[10px] py-1 font-mono text-zinc-600">— Round {l.round} 종료 —</div>;
  }
  if (l.type === "me_declare") {
    const actText = l.attacks.map(a => atkLabels[a]).join(" + ");
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-blue-900/40 border border-blue-800 rounded-2xl rounded-br-md px-2.5 py-1.5">
          <div className="text-[10px] text-blue-300 mb-0.5">나 → {actText}</div>
        </div>
      </div>
    );
  }
  if (l.type === "ai_declare") {
    const actText = l.attacks.map(a => atkLabels[a]).join(" + ");
    const cls = l.crisis
      ? "max-w-[80%] bg-rose-900/40 border-2 border-rose-600 rounded-2xl rounded-bl-md px-2.5 py-1.5 crisis-shake crisis-pulse"
      : "max-w-[80%] bg-amber-900/30 border border-amber-800 rounded-2xl rounded-bl-md px-2.5 py-1.5";
    const textCls = l.crisis ? "text-[10px] text-rose-200 font-bold" : "text-[10px] text-amber-300";
    return (
      <div className="flex justify-start">
        <div className={cls}>
          <div className={textCls}>AI → {actText}{l.crisis ? " ⚠" : ""}</div>
        </div>
      </div>
    );
  }
  if (l.type === "ai_speech") {
    const cls = l.crisis
      ? "max-w-[80%] bg-rose-950/60 border-2 border-rose-700 rounded-2xl rounded-bl-sm px-2.5 py-1.5 crisis-shake"
      : "max-w-[80%] bg-zinc-800/80 border border-zinc-700 rounded-2xl rounded-bl-sm px-2.5 py-1.5";
    const textCls = l.crisis ? "text-[11px] text-rose-200 italic font-semibold" : "text-[11px] text-amber-200 italic";
    return (
      <div className="flex justify-start">
        <div className={cls}>
          <div className={textCls}>"{l.text}"</div>
        </div>
      </div>
    );
  }
  if (l.type === "ai_think") {
    return (
      <div className="pl-2 border-l-2 border-zinc-700 ml-1 my-0.5">
        <div className="text-[9px] text-zinc-500 italic leading-relaxed">💭 {l.text}</div>
      </div>
    );
  }
  if (l.type === "action_result") {
    const atk = atkLabels[l.attack];
    const def = defLabels[l.defense];
    const attackerName = l.actor === "me" ? "내가" : "AI가";
    const defenderName = l.actor === "me" ? "AI" : "나";
    const defCostMap = { block: 1, dodge: 3, counter: 4 };
    const defCost = l.defCost !== undefined ? l.defCost : defCostMap[l.defense];

    const dmgColor = l.damage > 0 ? "text-red-400" : "text-zinc-500";

    return (
      <div className="flex justify-center my-1">
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-md px-2.5 py-1.5 text-center max-w-[92%]">
          {/* 공격자 굴림 */}
          <div className="text-[10px] text-zinc-300">
            {attackerName} {atk}{" "}
            <span className="font-mono">
              굴림 {l.atkRoll}/{l.atkTarget}
            </span>{" "}
            <span className={l.hit ? "text-emerald-400" : "text-zinc-500"}>
              {l.hit ? "명중" : "빗나감"}
            </span>
          </div>

          {/* 방어자 선언 (항상 표시) */}
          <div className="text-[10px] text-zinc-500 mt-0.5">
            ↳ {defenderName} {def} 선언
            {defCost > 0 && <span className="text-emerald-500/70 ml-1">(◈-{defCost})</span>}
            {!l.hit && l.defResult === "no_trigger" && <span className="text-zinc-600 ml-1">· 공격 빗나가 방어 발동 없음</span>}
            {!l.hit && l.defResult === "no_trigger_counter" && (
              <span className="text-purple-400 ml-1">
                · 공격 빗나감, 반격 굴림 {l.counterRoll}/{l.counterTarget} {l.counter > 0 ? "명중" : "빗나감"}
              </span>
            )}
            {l.hit && l.defResult === "block" && <span className="text-zinc-400 ml-1">· 감산 적용</span>}
            {l.hit && l.defResult === "success" && (
              <span className="text-emerald-400 ml-1">· 굴림 {l.defRoll}/{l.defTarget} 성공</span>
            )}
            {l.hit && l.defResult === "fail" && (
              <span className="text-red-400 ml-1">· 굴림 {l.defRoll}/{l.defTarget} 실패</span>
            )}
          </div>

          {/* 데미지 */}
          <div className={`text-xs font-mono font-bold mt-1 ${dmgColor}`}>
            데미지 {l.damage}{l.counter ? ` · 반격 ${l.counter}` : ""}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

// 공격 선언 패널
function MyAttackPanel({ rules, me, onChoose }) {
  const A = rules.attack;
  const aff = (k) => A[k].enabled && me.stamina >= A[k].cost;
  return (
    <>
      <div className="text-[9px] text-zinc-500 uppercase tracking-widest mb-1.5">공격 선언 · 1단계</div>
      <div className="grid grid-cols-4 gap-1.5">
        <button onClick={() => onChoose("probe")} disabled={!aff("probe")}
          className={`border rounded-lg py-2 px-1 transition ${aff("probe") ? "border-zinc-700 bg-zinc-900 hover:border-zinc-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">견제</div>
          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">⚡{A.probe.cost}</div>
        </button>
        <button onClick={() => onChoose("normal")} disabled={!aff("normal")}
          className={`border rounded-lg py-2 px-1 transition ${aff("normal") ? "border-blue-700 bg-blue-950/30 hover:border-blue-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">일반공</div>
          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">⚡{A.normal.cost}</div>
        </button>
        <button onClick={() => onChoose("heavy")} disabled={!aff("heavy")}
          className={`border rounded-lg py-2 px-1 transition ${aff("heavy") ? "border-amber-700 bg-amber-950/30 hover:border-amber-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">강공</div>
          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">⚡{A.heavy.cost}</div>
        </button>
        <button onClick={() => onChoose("rest")} disabled={!A.rest.enabled}
          className={`border rounded-lg py-2 px-1 transition ${A.rest.enabled ? "border-emerald-700 bg-emerald-950/30 hover:border-emerald-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">휴식</div>
          <div className="text-[9px] text-emerald-400 font-mono mt-0.5">+{rules.resources.restRecoverBonus}</div>
        </button>
      </div>
    </>
  );
}

// 연속기 분기 패널
function MyComboPanel({ rules, me, firstAction, onChoose }) {
  const A = rules.attack;
  const atkLabels = { probe: "견제", normal: "일반공", heavy: "강공" };
  const remaining = me.stamina - A[firstAction].cost;
  const aff = (k) => A[k].enabled && remaining >= A[k].cost;
  return (
    <>
      <div className="text-[9px] text-zinc-500 uppercase tracking-widest mb-1.5">한 번 더? · 남은 ⚡{remaining}</div>
      <div className="grid grid-cols-3 gap-1.5 mb-2">
        <button onClick={() => onChoose("probe")} disabled={!aff("probe")}
          className={`border rounded-lg py-1.5 px-1 transition ${aff("probe") ? "border-zinc-700 bg-zinc-900 hover:border-zinc-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-[11px] font-semibold">+견제</div>
          <div className="text-[9px] text-zinc-500 font-mono">⚡{A.probe.cost}</div>
        </button>
        <button onClick={() => onChoose("normal")} disabled={!aff("normal")}
          className={`border rounded-lg py-1.5 px-1 transition ${aff("normal") ? "border-blue-700 bg-blue-950/30 hover:border-blue-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-[11px] font-semibold">+일반</div>
          <div className="text-[9px] text-zinc-500 font-mono">⚡{A.normal.cost}</div>
        </button>
        <button onClick={() => onChoose("heavy")} disabled={!aff("heavy")}
          className={`border rounded-lg py-1.5 px-1 transition ${aff("heavy") ? "border-amber-700 bg-amber-950/30 hover:border-amber-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-[11px] font-semibold">+강공</div>
          <div className="text-[9px] text-zinc-500 font-mono">⚡{A.heavy.cost}</div>
        </button>
      </div>
      <button onClick={() => onChoose(null)}
        className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2 rounded-lg text-xs">
        단발로 끝내기 ({atkLabels[firstAction]})
      </button>
    </>
  );
}

// 방어 선언 패널
function MyDefensePanel({ rules, me, ai, incoming, allIncoming, isSecond, onChoose }) {
  const D = rules.defense;
  const aff = (k) => D[k].enabled && me.focus >= D[k].cost;
  const atkLabels = { probe: "견제", normal: "일반공", heavy: "강공" };
  const dmg = rules.attack[incoming]?.damage;

  // AI 위기 + 공격적 행동 시 시각 효과
  const isCrisis = ai && ai.hp < 30;
  const isAggressive = incoming === "heavy" || (allIncoming && allIncoming.length > 1);
  const crisisFlag = isCrisis && isAggressive;

  const boxCls = crisisFlag
    ? "bg-rose-950/60 border-2 border-rose-500 rounded-md px-2.5 py-1.5 mb-2 crisis-shake crisis-pulse"
    : "bg-rose-950/40 border border-rose-700 rounded-md px-2.5 py-1.5 mb-2";

  return (
    <>
      <div className={boxCls}>
        <div className="text-[10px] text-rose-400 mb-0.5">
          들어오는 공격: <span className="font-bold text-rose-200">{atkLabels[incoming]}</span> (데미지 {dmg})
          {crisisFlag && <span className="ml-1 text-rose-300 font-bold">⚠ 발악</span>}
        </div>
      </div>
      <div className="text-[9px] text-zinc-500 uppercase tracking-widest mb-1.5">방어 선언 {isSecond && "(2번째)"}</div>
      <div className="grid grid-cols-3 gap-1.5">
        <button onClick={() => onChoose("block")} disabled={!aff("block")}
          className={`border rounded-lg py-2 px-1 transition ${aff("block") ? "border-zinc-700 bg-zinc-900 hover:border-zinc-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">방어</div>
          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">◈{D.block.cost}·{Math.round(D.block.damageMult*100)}%</div>
        </button>
        <button onClick={() => onChoose("dodge")} disabled={!aff("dodge")}
          className={`border rounded-lg py-2 px-1 transition ${aff("dodge") ? "border-blue-700 bg-blue-950/30 hover:border-blue-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">회피</div>
          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">◈{D.dodge.cost}</div>
        </button>
        <button onClick={() => onChoose("counter")} disabled={!aff("counter")}
          className={`border rounded-lg py-2 px-1 transition ${aff("counter") ? "border-purple-700 bg-purple-950/30 hover:border-purple-500" : "border-zinc-800 bg-zinc-900/30 opacity-30"}`}>
          <div className="text-xs font-semibold">반격</div>
          <div className="text-[9px] text-zinc-500 font-mono mt-0.5">◈{D.counter.cost}</div>
        </button>
      </div>
    </>
  );
}

// ============================================================
// 1:1 — 전투 종료 화면
// ============================================================
function DuelEndScreen({ battle, stats, requestCopy, onRestart, onReplay, onBack }) {
  const won = battle.winner === "me";
  const draw = battle.winner === "draw";
  const lastLine = pickLine(won ? "lose" : "win"); // AI의 입장에서
  const myDmgGiven = battle.ai.maxHp - Math.max(0, battle.ai.hp);
  const aiDmgGiven = battle.me.maxHp - Math.max(0, battle.me.hp);

  return (
    <div className="max-w-md mx-auto">
      <div className={`rounded-xl p-4 mb-3 text-center border ${won ? "bg-emerald-900/30 border-emerald-700" : draw ? "bg-zinc-800 border-zinc-700" : "bg-rose-900/30 border-rose-700"}`}>
        <div className="text-[10px] uppercase tracking-widest mb-1 text-zinc-400">결과</div>
        <div className={`text-3xl font-bold mb-1 ${won ? "text-emerald-300" : draw ? "text-zinc-300" : "text-rose-300"}`}>
          {won ? "승리" : draw ? "무승부" : "패배"}
        </div>
        <div className="text-xs text-zinc-400">{battle.round}라운드 · 내 HP {Math.max(0, battle.me.hp)} / AI HP {Math.max(0, battle.ai.hp)}</div>
        <div className="text-[10px] text-amber-300 italic mt-2">"{lastLine}"</div>
      </div>

      <Section title="이번 판">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <span className="text-zinc-400">내 가한 데미지</span><span className="font-mono text-blue-300 text-right">{myDmgGiven}</span>
          <span className="text-zinc-400">AI 가한 데미지</span><span className="font-mono text-amber-300 text-right">{aiDmgGiven}</span>
          <span className="text-zinc-400">내 행동</span><span className="font-mono text-zinc-300 text-right text-[10px]">견{battle.myActionCounts.probe} 일{battle.myActionCounts.normal} 강{battle.myActionCounts.heavy}</span>
          <span className="text-zinc-400">AI 행동</span><span className="font-mono text-zinc-300 text-right text-[10px]">견{battle.aiActionCounts.probe} 일{battle.aiActionCounts.normal} 강{battle.aiActionCounts.heavy}</span>
        </div>
      </Section>

      {stats && stats.games > 0 && (
        <div className="mt-3">
          <Section title={`누적 (${battle.ai.name} 상대)`}>
            <div className="font-mono text-sm mb-2">
              <span className="text-emerald-400 font-bold">{stats.wins}승</span>
              <span className="text-zinc-600"> · </span>
              <span className="text-red-400 font-bold">{stats.losses}패</span>
              {stats.draws > 0 && <><span className="text-zinc-600"> · </span><span className="text-zinc-400">{stats.draws}무</span></>}
              <span className="text-zinc-500 text-xs ml-2">({stats.games}판, 승률 {(stats.wins / stats.games * 100).toFixed(0)}%)</span>
            </div>
            <div className="text-[10px] text-zinc-500 mb-1">AI 행동 패턴 (누적):</div>
            <div className="text-[10px] text-zinc-400 font-mono leading-relaxed">
              {(() => {
                const tot = stats.aiCounts.probe + stats.aiCounts.normal + stats.aiCounts.heavy + stats.aiCounts.rest;
                if (tot === 0) return "데이터 없음";
                const pct = (n) => (n / tot * 100).toFixed(0);
                return `공격: 강공 ${pct(stats.aiCounts.heavy)}% · 일반 ${pct(stats.aiCounts.normal)}% · 견제 ${pct(stats.aiCounts.probe)}% · 휴식 ${pct(stats.aiCounts.rest)}%`;
              })()}
            </div>
            <div className="text-[10px] text-zinc-400 font-mono leading-relaxed">
              {(() => {
                const tot = stats.aiCounts.block + stats.aiCounts.dodge + stats.aiCounts.counter;
                if (tot === 0) return "";
                const pct = (n) => (n / tot * 100).toFixed(0);
                return `방어: 방어 ${pct(stats.aiCounts.block)}% · 회피 ${pct(stats.aiCounts.dodge)}% · 반격 ${pct(stats.aiCounts.counter)}%`;
              })()}
            </div>
          </Section>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <button onClick={onRestart}
          className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm">
          ⟲ 다시하기 (같은 설정)
        </button>
        <button onClick={onReplay}
          className="w-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 py-2.5 rounded-lg text-sm">
          🎬 리플레이 보기
        </button>
        <button onClick={() => requestCopy && requestCopy(buildBattleLogText(battle), "전투 로그 복사")}
          className="w-full border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 py-2.5 rounded-lg text-sm">
          📋 전체 로그 복사
        </button>
        <button onClick={onBack}
          className="w-full border border-zinc-800 bg-zinc-900 text-zinc-400 py-2.5 rounded-lg text-sm">
          ← 설정 변경
        </button>
      </div>
    </div>
  );
}

// ============================================================
// 1:1 — 리플레이 화면
// ============================================================
function DuelReplayScreen({ battle, onBack }) {
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const total = battle.log.length;

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (cursor < total - 1) setCursor(cursor + 1);
      else setPlaying(false);
    }, 800 / speed);
    return () => clearTimeout(t);
  }, [playing, cursor, total, speed]);

  const visibleLogs = battle.log.slice(0, cursor + 1);

  return (
    <div className="max-w-md mx-auto bg-zinc-950 rounded-xl border border-zinc-800 overflow-hidden flex flex-col" style={{ height: "calc(100dvh - 80px)", minHeight: "640px" }}>
      <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950 flex-shrink-0">
        <button onClick={onBack} className="text-zinc-500 text-xs">← 결과로</button>
        <span className="text-sm font-semibold">🎬 리플레이</span>
        <span className="text-[10px] text-zinc-500 font-mono">{cursor + 1}/{total}</span>
      </div>

      <div className="flex-1 px-3 py-3 overflow-y-auto space-y-1.5">
        {visibleLogs.map((l, i) => <LogEntry key={i} entry={l} />)}
      </div>

      <div className="border-t border-zinc-800 bg-zinc-900 px-4 py-3 flex-shrink-0">
        <input type="range" min={0} max={total - 1} value={cursor}
          onChange={e => { setCursor(parseInt(e.target.value)); setPlaying(false); }}
          className="w-full accent-emerald-500 mb-2" />

        <div className="flex items-center justify-center gap-2">
          <button onClick={() => { setCursor(0); setPlaying(false); }}
            className="w-9 h-9 rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700">⏮</button>
          <button onClick={() => { setCursor(Math.max(0, cursor - 1)); setPlaying(false); }}
            className="w-9 h-9 rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700">⏪</button>
          <button onClick={() => setPlaying(!playing)}
            className="w-11 h-11 rounded-full bg-emerald-600 text-white">{playing ? "⏸" : "▶"}</button>
          <button onClick={() => { setCursor(Math.min(total - 1, cursor + 1)); setPlaying(false); }}
            className="w-9 h-9 rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700">⏩</button>
          <button onClick={() => { setCursor(total - 1); setPlaying(false); }}
            className="w-9 h-9 rounded-full bg-zinc-800 text-zinc-300 hover:bg-zinc-700">⏭</button>
        </div>
        <div className="flex justify-center gap-3 mt-2">
          {[1, 2, 4].map(s => (
            <button key={s} onClick={() => setSpeed(s)}
              className={`text-[10px] ${speed === s ? "text-emerald-400 font-bold" : "text-zinc-500"}`}>{s}×</button>
          ))}
        </div>
        <div className="text-[9px] text-zinc-600 text-center mt-2 leading-tight">
          리플레이는 보기 전용입니다. 처음부터 다시 두려면<br/>
          [← 결과로] → [⟲ 다시하기]
        </div>
      </div>
    </div>
  );
}

// 전투 로그를 텍스트로 빌드
function buildBattleLogText(battle, rules) {
  const atkLabels = { probe: "견제", normal: "일반공", heavy: "강공", rest: "휴식" };
  const defLabels = { block: "방어", dodge: "회피", counter: "반격" };
  let text = `=== 1:1 대전 로그 ===\n`;
  text += `나: 근${battle.me.str}/회${battle.me.agi}  vs  ${battle.ai.name}: 근${battle.ai.str}/회${battle.ai.agi}\n`;
  text += `결과: ${battle.winner === "me" ? "승리" : battle.winner === "ai" ? "패배" : battle.ended ? "무승부" : "진행 중"} / ${battle.round}라운드\n\n`;
  for (const l of battle.log) {
    if (l.type === "init") text += `[전투 시작] ${l.firstActor === "me" ? "내" : "AI"} 선공\n`;
    else if (l.type === "round_end") text += `\n— Round ${l.round} 종료 —\n`;
    else if (l.type === "me_declare") text += `[나] ${l.attacks.map(a => atkLabels[a]).join(" + ")}\n`;
    else if (l.type === "ai_declare") text += `[AI] ${l.attacks.map(a => atkLabels[a]).join(" + ")}\n`;
    else if (l.type === "ai_speech") text += `  "${l.text}"\n`;
    else if (l.type === "ai_think") text += `  💭 ${l.text}\n`;
    else if (l.type === "action_result") {
      const atkN = l.actor === "me" ? "내" : "AI";
      const defN = l.actor === "me" ? "AI" : "내";
      const atk = atkLabels[l.attack], def = defLabels[l.defense];
      let r = `${atkN} ${atk} 굴림 ${l.atkRoll}/${l.atkTarget} ${l.hit ? "명중" : "빗나감"} / ${defN} ${def} 선언`;
      if (l.hit) {
        if (l.defResult === "block") r += " · 감산";
        else if (l.defResult === "success") r += ` · 굴림 ${l.defRoll}/${l.defTarget} 성공`;
        else if (l.defResult === "fail") r += ` · 굴림 ${l.defRoll}/${l.defTarget} 실패`;
      } else {
        r += " · 방어 발동 없음";
      }
      r += ` [데미지 ${l.damage}${l.counter ? `/반격${l.counter}` : ""}]`;
      text += `  ${r}\n`;
    }
  }
  return text;
}

// 클립보드 복사 시도. 성공 여부와 텍스트 반환.
async function tryClipboard(text) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {}
  }
  // execCommand fallback
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (e) {}
  return false;
}

// ============================================================
// 메인 App — 탭 컨테이너
// ============================================================
export default function App() {
  const [tab, setTab] = useState("sim"); // sim | duel
  const [rules, setRules] = useState(INITIAL_RULES);
  const [copyModal, setCopyModal] = useState(null); // { text, title } | null

  const updateRule = (path, value) => {
    setRules(prev => {
      const next = JSON.parse(JSON.stringify(prev));
      const keys = path.split(".");
      let obj = next;
      for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
      obj[keys[keys.length - 1]] = value;
      return next;
    });
  };

  // 텍스트 복사 시도 — 실패 시 모달로 표시
  const requestCopy = async (text, title = "복사") => {
    const ok = await tryClipboard(text);
    if (!ok) {
      // fallback — 모달로 표시
      setCopyModal({ text, title });
    }
    return ok;
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-3" style={{ fontFamily: '"Noto Sans KR", system-ui, sans-serif' }}>
      <style>{`
        @keyframes crisis-shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-3px); }
          20%, 40%, 60%, 80% { transform: translateX(3px); }
        }
        .crisis-shake {
          animation: crisis-shake 0.55s ease-in-out;
        }
        @keyframes crisis-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(244, 63, 94, 0.5), 0 0 0 1px rgba(244, 63, 94, 0.7); }
          50% { box-shadow: 0 0 12px 4px rgba(244, 63, 94, 0.7), 0 0 0 1px rgba(244, 63, 94, 1); }
        }
        .crisis-pulse {
          animation: crisis-pulse 1.2s ease-in-out infinite;
        }
      `}</style>
      <div className="max-w-7xl mx-auto">
        {/* 헤더 + 탭 */}
        <div className="mb-3 flex items-center justify-between border-b border-zinc-800 pb-2">
          <h1 className="text-base font-bold tracking-tight text-zinc-100">Showtime</h1>
          <div className="flex gap-1">
            <button onClick={() => setTab("sim")}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition ${tab === "sim" ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
              밸런스 시뮬
            </button>
            <button onClick={() => setTab("duel")}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition ${tab === "duel" ? "bg-emerald-700 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>
              1:1 대전
            </button>
          </div>
        </div>

        {tab === "sim" && <SimulatorTab rules={rules} setRules={setRules} updateRule={updateRule} requestCopy={requestCopy} />}
        {tab === "duel" && <DuelTab rules={rules} updateRule={updateRule} requestCopy={requestCopy} />}

        {/* 복사 모달 */}
        {copyModal && (
          <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={() => setCopyModal(null)}>
            <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-2xl w-full max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
              <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-sm font-semibold">{copyModal.title}</span>
                <button onClick={() => setCopyModal(null)} className="text-zinc-400 text-lg">✕</button>
              </div>
              <div className="p-3 bg-amber-950/30 border-b border-amber-800/40 text-[11px] text-amber-300">
                자동 복사가 막혔습니다. 아래 텍스트를 길게 눌러 전체 선택 후 복사하세요.
              </div>
              <textarea
                readOnly
                value={copyModal.text}
                onFocus={e => e.target.select()}
                className="flex-1 w-full bg-zinc-950 text-zinc-200 text-[11px] font-mono p-3 resize-none focus:outline-none"
                style={{ minHeight: "300px" }}
              />
              <div className="px-3 py-2 border-t border-zinc-800 flex justify-end gap-2">
                <button onClick={async () => {
                  const ok = await tryClipboard(copyModal.text);
                  if (ok) setCopyModal(null);
                }} className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold">
                  다시 복사 시도
                </button>
                <button onClick={() => setCopyModal(null)} className="px-3 py-1.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs">
                  닫기
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
