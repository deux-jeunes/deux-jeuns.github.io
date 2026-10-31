// 응원 도우미 핵심 로직 (브라우저·Node 공용)
(function (root) {
  'use strict';

  const COURSES = { full: 42.195, half: 21.0975, '10k': 10, '5k': 5 };

  // "1:02:03" / "62:03" / "3:45"(분:초) → 초
  function parseDuration(s) {
    if (s == null) return null;
    const m = String(s).trim().match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (!m) return null;
    const a = +m[1], b = +m[2], c = m[3] != null ? +m[3] : null;
    if (b >= 60 || (c != null && c >= 60)) return null;
    return c == null ? a * 60 + b : a * 3600 + b * 60 + c;
  }

  function fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) return '-';
    sec = Math.round(sec);
    const sign = sec < 0 ? '-' : '';
    sec = Math.abs(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n) => String(n).padStart(2, '0');
    return sign + (h ? h + ':' + p(m) : m) + ':' + p(s);
  }

  // 페이스(초/km) → "5'12\""
  function fmtPace(secPerKm) {
    if (!secPerKm || !isFinite(secPerKm)) return '-';
    const t = Math.round(secPerKm);
    return Math.floor(t / 60) + "'" + String(t % 60).padStart(2, '0') + '"';
  }

  // 거리 표기 → km
  function parseDistance(s) {
    if (s == null) return null;
    const t = String(s).trim().toLowerCase().replace(/\s+/g, '');
    if (/^(half|하프|하프지점|중간)$/.test(t)) return COURSES.half;
    if (/^(full|finish|골인|도착|완주|풀)$/.test(t)) return null; // 코스 거리로 따로 처리
    const m = t.match(/^(\d+(?:\.\d+)?)(km|k)?$/);
    return m ? +m[1] : null;
  }

  // 기록 붙여넣기 해석: 줄마다 "거리 … 시간" 형태를 찾음
  // 예) "5km 00:28:31", "10K	0:57:02	5'42\"", "Half 2:01:10", "FINISH 4:05:22"
  function parseSplits(text, courseKm) {
    const out = [];
    if (!text) return out;
    const lines = String(text).split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.replace(/["'″′]/g, ' ').trim();
      if (!line) continue;
      const distM = line.match(/(\d+(?:\.\d+)?)\s*(km|k)\b|(\bhalf\b|하프|\bfinish\b|골인|도착|완주)/i);
      if (!distM) continue;
      let km;
      if (distM[1]) km = +distM[1];
      else if (/half|하프/i.test(distM[3])) km = COURSES.half;
      else km = courseKm || null;
      if (!km) continue;
      const rest = line.slice(distM.index + distM[0].length);
      const timeM = rest.match(/\d{1,2}:\d{2}:\d{2}|\d{1,3}:\d{2}/);
      if (!timeM) continue;
      const sec = parseDuration(timeM[0]);
      if (sec == null || sec <= 0) continue;
      out.push({ km, sec });
    }
    return normalizeSplits(out);
  }

  // 거리순 정렬, 같은 거리 중복 제거(나중 값 우선), 시간 역전 제거
  function normalizeSplits(splits) {
    const byKm = new Map();
    for (const s of splits || []) {
      if (s && s.km > 0 && s.sec > 0) byKm.set(Math.round(s.km * 10000) / 10000, s.sec);
    }
    const arr = [...byKm.entries()].map(([km, sec]) => ({ km, sec })).sort((a, b) => a.km - b.km);
    const res = [];
    for (const s of arr) {
      if (res.length && s.sec <= res[res.length - 1].sec) continue;
      res.push(s);
    }
    return res;
  }

  // 남은 구간 예상 페이스(초/km)
  // 기록 없음 → 목표 페이스, 1개 → 평균, 2개 이상 → 최근 구간 60% + 전체 평균 40%
  function estimatePace(runner) {
    const splits = normalizeSplits(runner.splits);
    const target = runner.targetPace || (runner.targetSec && runner.courseKm ? runner.targetSec / runner.courseKm : null);
    if (!splits.length) return target || 360;
    const last = splits[splits.length - 1];
    const avg = last.sec / last.km;
    if (splits.length === 1) return avg;
    const prev = splits[splits.length - 2];
    const recent = (last.sec - prev.sec) / (last.km - prev.km);
    return recent * 0.6 + avg * 0.4;
  }

  // 지점 도착 예상: { status: 'passed'|'upcoming', etaMs, elapsedSec, actual }
  // startMs: 출발 시각(epoch ms)
  function predictArrival(runner, spotKm, startMs) {
    const splits = normalizeSplits(runner.splits);
    const exact = splits.find((s) => Math.abs(s.km - spotKm) < 0.05);
    if (exact) return { status: 'passed', elapsedSec: exact.sec, etaMs: startMs + exact.sec * 1000, actual: true };
    const last = splits[splits.length - 1];
    if (last && last.km > spotKm) {
      // 이미 지나간 지점: 앞뒤 기록으로 보간
      let before = { km: 0, sec: 0 };
      for (const s of splits) { if (s.km < spotKm) before = s; }
      const after = splits.find((s) => s.km > spotKm);
      const sec = before.sec + (after.sec - before.sec) * (spotKm - before.km) / (after.km - before.km);
      return { status: 'passed', elapsedSec: sec, etaMs: startMs + sec * 1000, actual: false };
    }
    const pace = estimatePace(runner);
    const baseKm = last ? last.km : 0, baseSec = last ? last.sec : 0;
    const sec = baseSec + pace * (spotKm - baseKm);
    return { status: 'upcoming', elapsedSec: sec, etaMs: startMs + sec * 1000, actual: false, pace };
  }

  // 오늘 날짜 + "HH:MM" → epoch ms
  function clockToMs(dateStr, hhmm) {
    const [y, mo, d] = String(dateStr).split('-').map(Number);
    const [h, mi, se] = String(hhmm || '00:00').split(':').map(Number);
    return new Date(y, mo - 1, d, h || 0, mi || 0, se || 0).getTime();
  }

  // 모든 주자×지점 일정 (시간순)
  function buildSchedule(state, nowMs) {
    const rows = [];
    for (const r of state.runners || []) {
      const startMs = clockToMs(state.date, r.start || state.start);
      const courseKm = r.courseKm || COURSES.full;
      for (const sp of state.spots || []) {
        if (sp.km > courseKm + 0.01) continue;
        const p = predictArrival({ ...r, courseKm }, sp.km, startMs);
        rows.push({ runnerId: r.id, spotId: sp.id, runner: r, spot: sp, ...p, inMs: p.etaMs - nowMs });
      }
    }
    rows.sort((a, b) => a.etaMs - b.etaMs);
    return rows;
  }

  // 알림을 보낼 항목: 리드 시간 안으로 들어왔고 아직 안 보낸 것
  // sent: Set of "runnerId|spotId|kind"
  function dueAlerts(schedule, nowMs, leadMin, sent) {
    const out = [];
    for (const row of schedule) {
      if (row.status !== 'upcoming') continue;
      const left = row.etaMs - nowMs;
      if (left < -3 * 60000) continue;
      const kinds = [];
      if (left <= leadMin * 60000) kinds.push('lead');
      if (left <= 60000) kinds.push('now');
      for (const k of kinds) {
        const key = row.runnerId + '|' + row.spotId + '|' + k;
        if (!sent.has(key)) out.push({ key, kind: k, row });
      }
    }
    // 같은 항목에 lead/now가 동시에 걸리면 now만 보내고 lead는 보낸 것으로 처리(markKeys)
    const nowPairs = new Set(out.filter((a) => a.kind === 'now').map((a) => a.row.runnerId + '|' + a.row.spotId));
    return out
      .filter((a) => a.kind === 'now' || !nowPairs.has(a.row.runnerId + '|' + a.row.spotId))
      .map((a) => ({ ...a, markKeys: a.kind === 'now' ? [a.key, a.row.runnerId + '|' + a.row.spotId + '|lead'] : [a.key] }));
  }

  const api = { COURSES, parseDuration, fmtDuration, fmtPace, parseDistance, parseSplits, normalizeSplits, estimatePace, predictArrival, clockToMs, buildSchedule, dueAlerts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CheerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
