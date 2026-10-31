// node cheer/test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const C = createRequire(import.meta.url)('./core.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('parseDuration', () => {
  assert.equal(C.parseDuration('1:02:03'), 3723);
  assert.equal(C.parseDuration('5:30'), 330);
  assert.equal(C.parseDuration('62:03'), 3723);
  assert.equal(C.parseDuration('5:70'), null);
  assert.equal(C.parseDuration('abc'), null);
});

t('fmt', () => {
  assert.equal(C.fmtDuration(3723), '1:02:03');
  assert.equal(C.fmtDuration(330), '5:30');
  assert.equal(C.fmtPace(342), "5'42\"");
});

t('parseSplits 다양한 형식', () => {
  const s = C.parseSplits(`구간	기록	페이스
5km	00:28:31	5'42"
10K 0:57:02
Half 2:01:10
30km 2:55:00
FINISH 4:05:22
메모 없는 줄`, 42.195);
  assert.deepEqual(s.map((x) => x.km), [5, 10, 21.0975, 30, 42.195]);
  assert.equal(s[0].sec, 28 * 60 + 31);
  assert.equal(s[4].sec, 4 * 3600 + 5 * 60 + 22);
});

t('normalizeSplits 중복·역전 제거', () => {
  const s = C.normalizeSplits([{ km: 10, sec: 3000 }, { km: 5, sec: 1500 }, { km: 10, sec: 3100 }, { km: 15, sec: 2000 }]);
  assert.deepEqual(s, [{ km: 5, sec: 1500 }, { km: 10, sec: 3100 }]);
});

t('estimatePace', () => {
  assert.equal(C.estimatePace({ splits: [], targetSec: 4 * 3600, courseKm: 40 }), 360);
  assert.equal(C.estimatePace({ splits: [{ km: 10, sec: 3000 }] }), 300);
  // 최근 330, 평균 (6300/20)=315 → 0.6*330+0.4*315 = 324
  assert.equal(C.estimatePace({ splits: [{ km: 10, sec: 3000 }, { km: 20, sec: 6300 }] }), 324);
});

t('predictArrival', () => {
  const start = 1_000_000;
  const r = { splits: [{ km: 10, sec: 3000 }], courseKm: 42.195 };
  const up = C.predictArrival(r, 15, start);
  assert.equal(up.status, 'upcoming');
  assert.equal(up.elapsedSec, 4500);
  assert.equal(up.etaMs, start + 4500 * 1000);
  const passed = C.predictArrival(r, 5, start);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.elapsedSec, 1500); // 0~10km 보간
  const exact = C.predictArrival(r, 10, start);
  assert.equal(exact.actual, true);
});

t('buildSchedule 시간순·코스 밖 지점 제외', () => {
  const state = {
    date: '2026-11-01', start: '08:00',
    spots: [{ id: 's1', km: 5 }, { id: 's2', km: 15 }],
    runners: [
      { id: 'a', courseKm: 10, targetSec: 3000, splits: [] },
      { id: 'b', courseKm: 42.195, targetPace: 300, splits: [] },
    ],
  };
  const now = C.clockToMs('2026-11-01', '08:00');
  const rows = C.buildSchedule(state, now);
  assert.equal(rows.length, 3); // a는 15km 지점 없음
  assert.deepEqual(rows.map((r) => r.runnerId + r.spotId), ['as1', 'bs1', 'bs2']);
  assert.equal(rows[0].inMs, 1500 * 1000);
});

t('dueAlerts 리드·임박·중복 방지', () => {
  const state = { date: '2026-11-01', start: '08:00', spots: [{ id: 's', km: 5 }], runners: [{ id: 'a', targetPace: 300, splits: [] }] };
  const eta = C.clockToMs('2026-11-01', '08:25');
  const sent = new Set();
  const at = (ms) => C.dueAlerts(C.buildSchedule(state, ms), ms, 5, sent);
  assert.equal(at(eta - 10 * 60000).length, 0);
  let a = at(eta - 4 * 60000);
  assert.equal(a.length, 1); assert.equal(a[0].kind, 'lead');
  a[0].markKeys.forEach((k) => sent.add(k));
  assert.equal(at(eta - 3 * 60000).length, 0);
  a = at(eta - 30000);
  assert.equal(a.length, 1); assert.equal(a[0].kind, 'now');
  a[0].markKeys.forEach((k) => sent.add(k));
  assert.equal(at(eta).length, 0);
  // 리드 구간을 건너뛰고 바로 임박이면 now만, 이후 lead도 안 옴
  const sent2 = new Set();
  const b = C.dueAlerts(C.buildSchedule(state, eta - 20000), eta - 20000, 5, sent2);
  assert.deepEqual(b.map((x) => x.kind), ['now']);
  b[0].markKeys.forEach((k) => sent2.add(k));
  assert.equal(C.dueAlerts(C.buildSchedule(state, eta - 10000), eta - 10000, 5, sent2).length, 0);
});

console.log(`ALL PASS (${n})`);
