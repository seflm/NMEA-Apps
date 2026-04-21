/**
 * race-core.js — Race Assistant v2 shared module
 * Uses MQTT.js over WebSocket; state schema v4 (universal lines + waypoints).
 * Requires:  <script src="shared/mqtt.min.js"></script>
 */
(function (global) {
'use strict';

// =============================================================================
// Constants
// =============================================================================
const R_EARTH_M  = 6371000;
const M_PER_NM   = 1852;
const RAD        = Math.PI / 180;
const DEG        = 180 / Math.PI;
const SCHEMA_VER = 4;

// =============================================================================
// Geo helpers (equirectangular — fine for race scale < 5 nm)
// =============================================================================
function geoDist(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const latMid = (a.lat + b.lat) * 0.5 * RAD;
  const x = dLon * Math.cos(latMid);
  return Math.sqrt(x * x + dLat * dLat) * R_EARTH_M;
}

function geoBearing(a, b) {
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
            Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLon);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

function geoOffset(p, bearingDeg, distM) {
  const latR = p.lat * RAD;
  const dx = Math.sin(bearingDeg * RAD) * distM;
  const dy = Math.cos(bearingDeg * RAD) * distM;
  return {
    lat: p.lat + (dy / R_EARTH_M) * DEG,
    lon: p.lon + (dx / (R_EARTH_M * Math.cos(latR))) * DEG,
  };
}

// Smallest signed angle difference a→b in (-180, 180]
function angleDiff(a, b) {
  return ((b - a + 540) % 360) - 180;
}

// =============================================================================
// Geometry helpers (equirectangular metres) — projected path + line ops
// =============================================================================

// lat/lon → metres from reference origin
function _ll2m(origin, pt) {
  const cosLat = Math.cos(origin.lat * RAD);
  return {
    x: (pt.lon - origin.lon) * RAD * R_EARTH_M * cosLat,
    y: (pt.lat - origin.lat) * RAD * R_EARTH_M,
  };
}

// metres → lat/lon
function _m2ll(origin, m) {
  const cosLat = Math.cos(origin.lat * RAD);
  return {
    lat: origin.lat + (m.y / R_EARTH_M) * DEG,
    lon: origin.lon + (m.x / (R_EARTH_M * cosLat)) * DEG,
  };
}

// bearing → unit direction vector (North=+Y, East=+X)
function _bearingToVec(deg) {
  return { x: Math.sin(deg * RAD), y: Math.cos(deg * RAD) };
}

// Ray-ray intersection: P1 + t*d1 = P2 + s*d2  →  returns {x,y,t} or null
function _intersectRays(p1, d1, p2, d2) {
  const det = d1.y * d2.x - d1.x * d2.y;
  if (Math.abs(det) < 1e-9) return null;
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const t  = (dx * d2.y - dy * d2.x) / det;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y, t };
}

// =============================================================================
// Formatting helpers
// =============================================================================
function fmt(v, d = 1) {
  return (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);
}

function fmtCoord(v, pos, neg) {
  if (v == null || isNaN(v)) return '—';
  const letter = v >= 0 ? pos : neg;
  const abs = Math.abs(v);
  const deg = Math.floor(abs);
  const minFull = (abs - deg) * 60;
  const min = Math.floor(minFull);
  const sec = ((minFull - min) * 60).toFixed(1);
  return `${deg}° ${String(min).padStart(2,'0')}' ${sec}" ${letter}`;
}

function fmtDuration(sec) {
  if (sec == null || isNaN(sec) || sec < 0) return '—';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// =============================================================================
// State schema v4
// field.marks  = physical objects placed on the water
//   kind: 'line' | 'mark' | 'waypoint'
//   'line' marks have points:[{lat,lon},{lat,lon}]; lat/lon is midpoint cache
// course.legs  = ordered sequence of marks to visit (references mark IDs)
//   legs have target_type: 'mark' | 'line'
// =============================================================================
function defaultState() {
  return {
    version: SCHEMA_VER,
    mqtt: { host: 'esp-nmea.local', port: 9001 },
    boat: {
      name: 'First 36',
      polar_url: 'first36.json',
      deviation: {
        samples:    [[], [], [], [], [], [], [], []],
        offsets:    [0, 0, 0, 0, 0, 0, 0, 0],
        calibrated: [false, false, false, false, false, false, false, false],
      },
    },
    field: {
      marks: [],
    },
    course: {
      type: 'carousel',
      laps: 1,
      legs: [],       // { id, mark_id, name, target_type }
      sequence: [],
    },
    progress: {
      current_leg_idx: 0,
      lap: 0,
      manual_leg_idx: null,
    },
    wind_samples: [],
  };
}

let _state = defaultState();
let _nextMarkId = 1;
let _nextLegId  = 1;
let _nextWaypointNum = 1;

// =============================================================================
// Midpoint helper — keeps mark.lat/lon in sync for line marks
// =============================================================================
function _updateLineMidpoint(mark) {
  if (mark.kind !== 'line' || !mark.points) return;
  const a = mark.points[0], b = mark.points[1];
  if (a && b && a.lat != null && b.lat != null) {
    mark.lat = (a.lat + b.lat) / 2;
    mark.lon = (a.lon + b.lon) / 2;
  } else if (a && a.lat != null) {
    mark.lat = a.lat; mark.lon = a.lon;
  } else if (b && b.lat != null) {
    mark.lat = b.lat; mark.lon = b.lon;
  } else {
    mark.lat = null; mark.lon = null;
  }
}

// =============================================================================
// Schema migrations
// =============================================================================
function _migrate(raw) {
  if (!raw || !raw.version) return null;
  if (raw.version === SCHEMA_VER) return raw;

  // v2 → v3: course.waypoints → field.marks + course.legs
  if (raw.version === 2 && raw.course && raw.course.waypoints) {
    const s = defaultState();
    if (raw.boat) {
      s.boat.name      = raw.boat.name      || s.boat.name;
      s.boat.polar_url = raw.boat.polar      || s.boat.polar_url;
      if (raw.boat.deviation) s.boat.deviation = Object.assign(s.boat.deviation, raw.boat.deviation);
    }
    const kindMap = { 'line-end': 'start-pin', 'mark': 'mark', 'turning': 'mark', 'finish': 'finish-pin' };
    s.field.marks = (raw.course.waypoints || []).map(wp => ({
      id: wp.id,
      name: wp.name || '',
      kind: kindMap[wp.kind] || 'mark',
      rounding: wp.rounding || 'any',
      lat: wp.lat || null,
      lon: wp.lon || null,
      confidence_m: wp.confidence_m || null,
      bearings: wp.bearings || [],
      distance_hint_nm: wp.distance_hint_nm || null,
    }));
    let lid = 1;
    s.course.type = raw.course.type || 'carousel';
    s.course.laps = raw.course.laps || 1;
    s.course.legs = s.field.marks.map(m => ({ id: lid++, mark_id: m.id, name: m.name || m.kind, target_type: 'mark' }));
    raw = s;
    raw.version = 3;
    // fall through to v3→v4
  }

  // v3 → v4: merge start/finish pin+rc pairs into universal 'line' marks
  if (raw.version === 3) {
    const s = defaultState();
    s.version = SCHEMA_VER;
    s.mqtt    = Object.assign({}, raw.mqtt    || s.mqtt);
    s.boat    = Object.assign({}, raw.boat    || s.boat);
    s.field   = { marks: (raw.field && raw.field.marks ? [...raw.field.marks] : []) };
    s.course  = {
      type: (raw.course && raw.course.type) || 'carousel',
      laps: (raw.course && raw.course.laps) || 1,
      legs: (raw.course && raw.course.legs ? [...raw.course.legs] : []),
      sequence: (raw.course && raw.course.sequence ? [...raw.course.sequence] : []),
    };
    s.progress = Object.assign({ current_leg_idx: 0, lap: 0, manual_leg_idx: null }, raw.progress || {});
    if (s.progress.manual_leg_idx === undefined) s.progress.manual_leg_idx = null;
    s.wind_samples = raw.wind_samples || [];

    // Helper: merge a pin+rc pair into one line mark
    function _mergeLineMarks(pinKind, rcKind, defaultName) {
      const pin = s.field.marks.find(m => m.kind === pinKind);
      const rc  = s.field.marks.find(m => m.kind === rcKind);
      if (!pin && !rc) return;
      const primaryId = pin ? pin.id : rc.id;
      const removedId = pin && rc ? rc.id : null;
      const lineMark = {
        id: primaryId,
        name: defaultName,
        kind: 'line',
        rounding: 'any',
        points: [
          { lat: pin ? pin.lat : null, lon: pin ? pin.lon : null },
          { lat: rc  ? rc.lat  : null, lon: rc  ? rc.lon  : null },
        ],
        lat: null, lon: null,
        confidence_m: null, bearings: [], distance_hint_nm: null,
      };
      _updateLineMidpoint(lineMark);
      s.field.marks = s.field.marks.filter(m => m.kind !== pinKind && m.kind !== rcKind);
      s.field.marks.push(lineMark);
      if (removedId) {
        s.course.legs = s.course.legs.filter(l => l.mark_id !== removedId);
      }
      s.course.legs = s.course.legs.map(l =>
        (l.mark_id === (pin && pin.id) || l.mark_id === (rc && rc.id))
          ? Object.assign({}, l, { mark_id: lineMark.id, target_type: 'line' })
          : l
      );
    }

    _mergeLineMarks('start-pin', 'start-rc', 'Start');
    _mergeLineMarks('finish-pin', 'finish-rc', 'Finish');

    // Ensure all legs have target_type
    s.course.legs = s.course.legs.map(l => {
      if (!l.target_type) {
        const m = s.field.marks.find(mk => mk.id === l.mark_id);
        return Object.assign({}, l, { target_type: m && m.kind === 'line' ? 'line' : 'mark' });
      }
      return l;
    });

    // Clamp progress index
    if (s.course.sequence.length > 0 &&
        s.progress.current_leg_idx >= s.course.sequence.length) {
      s.progress.current_leg_idx = Math.max(0, s.course.sequence.length - 1);
    }

    return s;
  }

  return null;  // unknown version → start fresh
}

// =============================================================================
// State persistence
// =============================================================================
function loadState() {
  try {
    const raw = JSON.parse(localStorage.getItem('race.state') || '{}');
    const migrated = _migrate(raw);
    if (migrated) {
      _state = migrated;
    } else {
      _state = defaultState();
    }
    const mIds = _state.field.marks.map(m => m.id);
    const lIds = _state.course.legs.map(l => l.id);
    _nextMarkId = mIds.length ? Math.max(...mIds) + 1 : 1;
    _nextLegId  = lIds.length ? Math.max(...lIds)  + 1 : 1;
    // Init waypoint counter from existing WP names
    let maxWp = 0;
    _state.field.marks.forEach(m => {
      if (m.kind === 'waypoint') {
        const n = parseInt((m.name || '').replace(/^WP/, ''));
        if (!isNaN(n) && n > maxWp) maxWp = n;
      }
    });
    _nextWaypointNum = maxWp + 1;
    if (migrated && raw.version !== SCHEMA_VER) saveState();
  } catch (e) {
    console.warn('[RaceCore] loadState failed:', e);
  }
  return _state;
}

function saveState() {
  localStorage.setItem('race.state', JSON.stringify(_state));
}

function getState() { return _state; }

function clearState() {
  _state = defaultState();
  _nextMarkId = _nextLegId = 1;
  _nextWaypointNum = 1;
  saveState();
}

// =============================================================================
// Polar interpolation
// =============================================================================
let _polar = null;

async function loadPolar(url) {
  url = url || _state.boat.polar_url || 'first36.json';
  try {
    const r = await fetch(url);
    _polar = await r.json();
    return _polar;
  } catch (e) {
    console.warn('[RaceCore] Polar load failed:', e);
    return null;
  }
}

function getPolar() { return _polar; }

function interpOptimal(optArr, tws) {
  if (!optArr || !optArr.length) return null;
  if (tws <= optArr[0].tws) return { ...optArr[0] };
  if (tws >= optArr[optArr.length - 1].tws) return { ...optArr[optArr.length - 1] };
  for (let i = 0; i < optArr.length - 1; i++) {
    const a = optArr[i], b = optArr[i + 1];
    if (tws >= a.tws && tws <= b.tws) {
      const t = (tws - a.tws) / (b.tws - a.tws);
      return { tws, twa: a.twa + t * (b.twa - a.twa), sog: a.sog + t * (b.sog - a.sog) };
    }
  }
  return null;
}

function interpSpeed(twa, tws) {
  if (!_polar || !_polar.twa_rows || !_polar.sog) return null;
  const absTwa = Math.abs(((twa + 540) % 360) - 180);
  const tr = _polar.twa_rows, tc = _polar.tws_kts, sm = _polar.sog;
  const cTwa = Math.max(tr[0], Math.min(tr[tr.length - 1], absTwa));
  const cTws = Math.max(tc[0], Math.min(tc[tc.length - 1], tws));
  let ri = 0; while (ri < tr.length - 2 && tr[ri + 1] < cTwa) ri++;
  let ci = 0; while (ci < tc.length - 2 && tc[ci + 1] < cTws) ci++;
  const rt = (cTwa - tr[ri]) / (tr[ri + 1] - tr[ri]);
  const ct = (cTws - tc[ci]) / (tc[ci + 1] - tc[ci]);
  const s00 = sm[ri][ci], s01 = sm[ri][ci + 1];
  const s10 = sm[ri + 1][ci], s11 = sm[ri + 1][ci + 1];
  if ([s00, s01, s10, s11].some(v => v == null)) return null;
  return (s00 + ct * (s01 - s00)) + rt * ((s10 + ct * (s11 - s10)) - (s00 + ct * (s01 - s00)));
}

// =============================================================================
// Compass deviation calibration
// =============================================================================
const DEV_MIN_SOG_KTS  = 2;
const DEV_MAX_ROT      = 3;
const DEV_MAX_AWA_DIFF = 5;
const DEV_MIN_SAMPLES  = 20;

let _lastAwaDev = null;

function deviationBucket(hdgDeg) {
  return Math.floor(((hdgDeg % 360) + 360) % 360 / 45) % 8;
}

function sampleDeviation(hdgDeg, cogDeg, sogKts, rotDegMin, awaDeg) {
  if (hdgDeg == null || cogDeg == null || sogKts == null) return;
  if (sogKts < DEV_MIN_SOG_KTS) return;
  if (Math.abs(rotDegMin || 0) > DEV_MAX_ROT) return;
  if (_lastAwaDev != null && Math.abs(angleDiff(_lastAwaDev, awaDeg)) > DEV_MAX_AWA_DIFF) {
    _lastAwaDev = awaDeg;
    return;
  }
  _lastAwaDev = awaDeg;

  const diff = angleDiff(cogDeg, hdgDeg);
  const bucket = deviationBucket(hdgDeg);
  const dev = _state.boat.deviation;
  dev.samples[bucket].push(diff);
  if (dev.samples[bucket].length > 200) dev.samples[bucket].shift();

  const sorted = [...dev.samples[bucket]].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  dev.offsets[bucket] = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  dev.calibrated[bucket] = dev.samples[bucket].length >= DEV_MIN_SAMPLES;
}

function deviationAt(hdgDeg) {
  const b = deviationBucket(hdgDeg);
  return _state.boat.deviation.offsets[b] || 0;
}

function correctedHeading(hdgMag, variation) {
  const dev = deviationAt(hdgMag);
  const varDeg = (variation != null && !isNaN(variation)) ? variation : 0;
  return (hdgMag + dev + varDeg + 360) % 360;
}

function deviationProgress() {
  return _state.boat.deviation.calibrated.filter(Boolean).length;
}

// =============================================================================
// Field mark helpers
// =============================================================================
function isLine(kind) { return kind === 'line'; }

function addMark(mark) {
  mark = Object.assign({
    id: _nextMarkId++, name: '', kind: 'mark', rounding: 'any',
    lat: null, lon: null, confidence_m: null, bearings: [],
  }, mark);
  if (mark.kind === 'line' && !mark.points) {
    mark.points = [{ lat: null, lon: null }, { lat: null, lon: null }];
  }
  _state.field.marks.push(mark);
  saveState();
  return mark;
}

function addWaypoint(lat, lon) {
  const name = 'WP' + _nextWaypointNum++;
  return addMark({ name, kind: 'waypoint', rounding: 'any',
                   lat: lat ?? null, lon: lon ?? null });
}

function removeMark(id) {
  _state.field.marks = _state.field.marks.filter(m => m.id !== id);
  _state.course.legs = _state.course.legs.filter(l => l.mark_id !== id);
  rebuildSequence();
  saveState();
}

function updateMark(id, patch) {
  const m = _state.field.marks.find(m => m.id === id);
  if (!m) return;
  Object.assign(m, patch);
  if (m.kind === 'line') _updateLineMidpoint(m);
  saveState();
}

function getMark(id) {
  return _state.field.marks.find(m => m.id === id) || null;
}

// Line mark center (midpoint of both endpoints, or whichever is set)
function lineCenter(markId) {
  const m = _state.field.marks.find(mk => mk.id === markId && mk.kind === 'line');
  if (!m || !m.points) return null;
  const a = m.points[0], b = m.points[1];
  if (a && b && a.lat != null && b.lat != null)
    return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
  if (a && a.lat != null) return { lat: a.lat, lon: a.lon };
  if (b && b.lat != null) return { lat: b.lat, lon: b.lon };
  return null;
}

// Line mark info: length, bearing, endpoints
function lineInfo(markId) {
  const m = _state.field.marks.find(mk => mk.id === markId && mk.kind === 'line');
  if (!m || !m.points) return null;
  const a = m.points[0], b = m.points[1];
  if (!a || !b || a.lat == null || b.lat == null) return null;
  return {
    lengthM: geoDist(a, b),
    bearing: geoBearing(a, b),
    pointA:  a,
    pointB:  b,
  };
}

// Closest point on a line segment to a boat position
function lineClosestPoint(ptA, ptB, boat) {
  if (!ptA || !ptB || ptA.lat == null || ptB.lat == null) return ptA;
  const cosLat = Math.cos(ptA.lat * RAD);
  const bx = (ptB.lon - ptA.lon) * RAD * R_EARTH_M * cosLat;
  const by = (ptB.lat - ptA.lat) * RAD * R_EARTH_M;
  const px = (boat.lon - ptA.lon) * RAD * R_EARTH_M * cosLat;
  const py = (boat.lat - ptA.lat) * RAD * R_EARTH_M;
  const len2 = bx * bx + by * by;
  if (len2 < 1e-6) return ptA;
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return {
    lat: ptA.lat + (t * by / R_EARTH_M) * DEG,
    lon: ptA.lon + (t * bx / (R_EARTH_M * cosLat)) * DEG,
  };
}

// =============================================================================
// Projected path — boat → tack point → target (both port-first & stbd-first)
// =============================================================================
function calcProjectedPath(boatLat, boatLon, tgtLat, tgtLon, portBrg, stbdBrg, twa) {
  const origin = { lat: boatLat, lon: boatLon };
  const boat_m = { x: 0, y: 0 };
  const tgt_m  = _ll2m(origin, { lat: tgtLat, lon: tgtLon });
  const onPort = twa != null && twa > 180;

  // Stbd-tack-first: sail at stbdBrg until hitting port layline through target
  const tackStbd = _intersectRays(boat_m, _bearingToVec(stbdBrg), tgt_m, _bearingToVec(portBrg));
  // Port-tack-first: sail at portBrg until hitting stbd layline through target
  const tackPort = _intersectRays(boat_m, _bearingToVec(portBrg), tgt_m, _bearingToVec(stbdBrg));

  return {
    onPort,
    stbdFirst: {
      tackPt: tackStbd ? _m2ll(origin, tackStbd) : null,
      validT:  tackStbd ? tackStbd.t > 5 : false,  // >5m ahead of boat
    },
    portFirst: {
      tackPt: tackPort ? _m2ll(origin, tackPort) : null,
      validT:  tackPort ? tackPort.t > 5 : false,
    },
  };
}

// =============================================================================
// Triangulation — weighted least-squares mark position from bearings
// =============================================================================
function addBearing(markId, lat, lon, bearingMag, source) {
  const m = _state.field.marks.find(mk => mk.id === markId);
  if (!m) return;
  if (!m.bearings) m.bearings = [];
  m.bearings.push({ ts: Date.now(), lat, lon, bearing_mag: bearingMag, source, excluded: false });
  solveMark(markId);
  saveState();
}

function solveMark(markId) {
  const m = _state.field.marks.find(mk => mk.id === markId);
  if (!m || !m.bearings || m.bearings.length === 0) return null;

  const active = m.bearings.filter(b => !b.excluded);
  if (active.length === 0) return null;

  const origin = { lat: active[0].lat, lon: active[0].lon };
  const lines = active.map(b => {
    const dx = (b.lon - origin.lon) * RAD * Math.cos(origin.lat * RAD) * R_EARTH_M;
    const dy = (b.lat - origin.lat) * RAD * R_EARTH_M;
    const brg = b.bearing_mag * RAD;
    return { px: dx, py: dy, ux: Math.sin(brg), uy: Math.cos(brg) };
  });

  let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
  for (const l of lines) {
    const p00 = 1 - l.ux * l.ux, p01 = -l.ux * l.uy, p11 = 1 - l.uy * l.uy;
    a00 += p00; a01 += p01; a11 += p11;
    b0  += p00 * l.px + p01 * l.py;
    b1  += p01 * l.px + p11 * l.py;
  }

  const det = a00 * a11 - a01 * a01;
  if (Math.abs(det) < 1e-10) return null;

  const x = (b0 * a11 - b1 * a01) / det;
  const y = (b1 * a00 - b0 * a01) / det;

  let estLat = origin.lat + (y / R_EARTH_M) * DEG;
  let estLon = origin.lon + (x / (R_EARTH_M * Math.cos(origin.lat * RAD))) * DEG;

  if (active.length < 5 && m.distance_hint_nm != null) {
    const hintM = m.distance_hint_nm * M_PER_NM;
    const refMark = _state.field.marks.find(mk => mk.kind === 'line' && mk.lat != null);
    const refPt = refMark ? { lat: refMark.lat, lon: refMark.lon } : null;
    if (refPt) {
      const hintWeight = 0.3 * (1 - (active.length - 1) / 4);
      const hintPt = geoOffset(refPt, geoBearing(refPt, { lat: estLat, lon: estLon }), hintM);
      estLat = estLat + hintWeight * (hintPt.lat - estLat);
      estLon = estLon + hintWeight * (hintPt.lon - estLon);
    }
  }

  let sumResid = 0;
  for (const l of lines) {
    const dx = (estLon - origin.lon) * RAD * Math.cos(origin.lat * RAD) * R_EARTH_M - l.px;
    const dy = (estLat - origin.lat) * RAD * R_EARTH_M - l.py;
    sumResid += Math.abs(-l.uy * dx + l.ux * dy);
  }
  const confidence_m = active.length > 1 ? sumResid / active.length : 200;

  m.lat = estLat;
  m.lon = estLon;
  m.confidence_m = confidence_m;
  saveState();
  return { lat: estLat, lon: estLon, confidence_m };
}

// =============================================================================
// Course legs
// =============================================================================
function addLeg(markId, name, targetType) {
  const mark = _state.field.marks.find(m => m.id === markId);
  if (!mark) return null;
  const resolvedType = targetType || (mark.kind === 'line' ? 'line' : 'mark');
  const leg = {
    id: _nextLegId++,
    mark_id: markId,
    name: name || mark.name || mark.kind,
    target_type: resolvedType,
  };
  _state.course.legs.push(leg);
  rebuildSequence();
  saveState();
  return leg;
}

function removeLeg(id) {
  _state.course.legs = _state.course.legs.filter(l => l.id !== id);
  rebuildSequence();
  saveState();
}

function updateLeg(id, patch) {
  const leg = _state.course.legs.find(l => l.id === id);
  if (!leg) return;
  Object.assign(leg, patch);
  saveState();
}

function moveLeg(id, direction) {  // direction: -1 up, +1 down
  const legs = _state.course.legs;
  const idx = legs.findIndex(l => l.id === id);
  if (idx < 0) return;
  const to = idx + direction;
  if (to < 0 || to >= legs.length) return;
  [legs[idx], legs[to]] = [legs[to], legs[idx]];
  rebuildSequence();
  saveState();
}

function rebuildSequence() {
  const { course } = _state;
  const legs = course.legs || [];
  if (course.type === 'carousel') {
    const seq = [];
    for (let lap = 0; lap < (course.laps || 1); lap++) {
      for (const leg of legs) seq.push(leg.id);
    }
    course.sequence = seq;
  } else {
    course.sequence = legs.map(l => l.id);
  }
}

// =============================================================================
// Auto leg detection — sequence walk
// =============================================================================
const ROUNDING_RADIUS_M = 30;
const _sweepHistory = {};   // legId → [bearingDeg, ...]

function checkAdvance(lat, lon) {
  const { course, field, progress } = _state;
  if (!course.sequence || course.sequence.length === 0) return false;

  const legId = course.sequence[progress.current_leg_idx];
  const leg   = course.legs.find(l => l.id === legId);
  if (!leg) return false;

  const mark = field.marks.find(m => m.id === leg.mark_id);
  if (!mark || mark.lat == null || mark.lon == null) return false;

  const boat  = { lat, lon };
  const distM = geoDist(boat, mark);

  if (distM > ROUNDING_RADIUS_M) {
    if (!_sweepHistory[legId]) _sweepHistory[legId] = [];
    _sweepHistory[legId].push(geoBearing(mark, boat));
    if (_sweepHistory[legId].length > 60) _sweepHistory[legId].shift();
    return false;
  }

  if (isLine(mark.kind) || leg.target_type === 'line') return _advance();

  const hist = _sweepHistory[legId] || [];
  if (hist.length < 3) return false;
  const sweep = angleDiff(hist[0], hist[hist.length - 1]);

  if      (mark.rounding === 'port' && sweep >  60) return _advance();
  else if (mark.rounding === 'stbd' && sweep < -60) return _advance();
  else if (mark.rounding === 'any'  && Math.abs(sweep) > 60) return _advance();

  return false;
}

function forceAdvance() { _advance(); }

function forceBack() {
  if (_state.progress.current_leg_idx > 0) {
    _state.progress.current_leg_idx--;
    saveState();
    _emit('progress', _state.progress);
  }
}

function _advance() {
  const { course, progress } = _state;
  const legId = course.sequence[progress.current_leg_idx];
  delete _sweepHistory[legId];

  if (progress.current_leg_idx < course.sequence.length - 1) {
    progress.current_leg_idx++;
    progress.lap = Math.floor(
      progress.current_leg_idx / Math.max(1, course.sequence.length / (course.laps || 1))
    );
    saveState();
    _emit('progress', progress);
    return true;
  }
  return false;
}

// Resolve effective target index (manual override if set, else auto)
function _resolveIdx() {
  const { progress, course } = _state;
  const seq = course.sequence || [];
  const manual = progress.manual_leg_idx;
  if (manual != null && manual >= 0 && manual < seq.length) return manual;
  return Math.min(progress.current_leg_idx, Math.max(0, seq.length - 1));
}

function currentLegLabel() {
  const { course, field } = _state;
  if (!course.sequence || course.sequence.length === 0) return 'prestart';
  const idx = _resolveIdx();
  if (idx === 0) return 'prestart';

  const prevLegId = course.sequence[idx - 1];
  const currLegId = course.sequence[idx];
  const prevLeg   = course.legs.find(l => l.id === prevLegId);
  const currLeg   = course.legs.find(l => l.id === currLegId);
  if (!prevLeg || !currLeg) return 'unknown';

  const prevMark = field.marks.find(m => m.id === prevLeg.mark_id);
  const currMark = field.marks.find(m => m.id === currLeg.mark_id);
  if (!prevMark || !currMark) return 'unknown';

  if (isLine(prevMark.kind) && currMark.kind === 'mark') return 'upwind';
  if (prevMark.kind === 'mark' && isLine(currMark.kind)) return 'downwind';

  // Mark→mark or line→line: classify by bearing to target vs TWD
  if (currMark.lat != null && _live.twd != null && _live.lat != null) {
    const brg     = geoBearing({ lat: _live.lat, lon: _live.lon }, currMark);
    const brgDiff = Math.abs(angleDiff(brg, _live.twd));
    return brgDiff < 90 ? 'upwind' : 'downwind';
  }

  return 'unknown';
}

function currentTarget() {
  const { course, field } = _state;
  if (!course.sequence || course.sequence.length === 0) return null;
  const idx   = _resolveIdx();
  const legId = course.sequence[idx];
  const leg   = course.legs.find(l => l.id === legId);
  if (!leg) return null;

  const mark = field.marks.find(m => m.id === leg.mark_id);
  if (!mark) return null;

  // For line targets with both endpoints set, return closest point on segment
  if (leg.target_type === 'line' && mark.kind === 'line' && mark.points) {
    const a = mark.points[0], b = mark.points[1];
    if (a && b && a.lat != null && b.lat != null && _live.lat != null) {
      return lineClosestPoint(a, b, { lat: _live.lat, lon: _live.lon });
    }
  }

  return mark;
}

function setManualLegIdx(idx) {
  const seq = _state.course.sequence || [];
  _state.progress.manual_leg_idx = (idx == null)
    ? null
    : Math.max(0, Math.min(idx, seq.length - 1));
  saveState();
  _emit('progress', _state.progress);
}

// =============================================================================
// ETA to next tack / gybe
// =============================================================================
function etaToTack(boatLat, boatLon, markLat, markLon, twd, tws, sog, leg) {
  if (!_polar || twd == null || tws == null || sog == null || sog < 0.5) return null;
  const isUpwind = leg === 'upwind';
  const optList  = isUpwind ? _polar.beat_optimal : _polar.run_optimal;
  const opt      = interpOptimal(optList, tws);
  if (!opt) return null;

  const boat = { lat: boatLat, lon: boatLon };
  const mark = { lat: markLat, lon: markLon };
  const onPort = _live.twa != null && _live.twa > 180;

  let laylineBrg;
  if (isUpwind) {
    laylineBrg = onPort ? (twd - opt.twa + 360) % 360 : (twd + opt.twa) % 360;
  } else {
    const off = 180 - opt.twa;
    laylineBrg = onPort ? (twd + 180 + off) % 360 : (twd + 180 - off + 360) % 360;
  }

  const distToMark = geoDist(boat, mark);
  const brgToMark  = geoBearing(boat, mark);
  const delta      = angleDiff(laylineBrg, brgToMark);
  const perpDist   = Math.abs(distToMark * Math.sin(delta * RAD));

  const cogDelta  = angleDiff(laylineBrg, _live.cog || brgToMark);
  const perpSpeed = Math.abs(sog * Math.sin(cogDelta * RAD));
  if (perpSpeed < 0.1) return null;

  return (perpDist / M_PER_NM) / perpSpeed * 3600;
}

// =============================================================================
// MQTT client
// =============================================================================
const _live = {
  lat: null, lon: null, alt: null, sog: null, cog: null,
  hdg: null, rot: null, variation: null,
  tws: null, twd: null, twa: null,
  aws: null, awa: null, awd: null,
  fix: 0, sats: 0, hdop: null,
  water_spd: null, water_depth: null, water_temp: null,
  ap_on: false, ap_mode: 0, ap_target: null,
  heap: null, rssi: null, clients: null,
  lastTs: 0,
};

let _mqttClient    = null;
let _mqttConnected = false;

const _listeners = {};

function _emit(event, data) {
  (_listeners[event] || []).forEach(cb => { try { cb(data); } catch (e) {} });
}

function on(event, cb) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(cb);
}

function off(event, cb) {
  if (!_listeners[event]) return;
  _listeners[event] = _listeners[event].filter(f => f !== cb);
}

function mqttConnect(host, port) {
  if (typeof mqtt === 'undefined') {
    console.error('[RaceCore] mqtt.js not loaded — check shared/mqtt.min.js');
    return;
  }

  host = host || _state.mqtt.host || 'esp-nmea.local';
  port = port || _state.mqtt.port || 9001;

  if (_mqttClient) {
    try { _mqttClient.end(true); } catch (e) {}
  }

  // Use wss:// on HTTPS pages for Safari compatibility
  const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  const url = `${protocol}${host}:${port}`;
  console.log('[RaceCore] Connecting to MQTT:', url);

  _mqttClient = mqtt.connect(url, {
    reconnectPeriod: 3000,
    connectTimeout:  8000,
    keepalive:       30,
    protocolVersion: 4,
    clean: true,
    clientId: 'race-assistant-' + Math.random().toString(16).substr(2, 8),
  });

  _mqttClient.on('connect', () => {
    _mqttConnected = true;
    _mqttClient.subscribe('esp-nmea/#');
    _emit('connect', null);
    _updateBadge();
    console.log('[RaceCore] MQTT connected to', url);
  });

  _mqttClient.on('reconnect', () => {
    _mqttConnected = false;
    _updateBadge();
  });

  _mqttClient.on('close', () => {
    console.log('[RaceCore] MQTT connection closed');
    _mqttConnected = false;
    _emit('disconnect', null);
    _updateBadge();
  });

  _mqttClient.on('error', (err) => {
    console.error('[RaceCore] MQTT error:', err);
    console.error('[RaceCore] Error details:', err.message, err.stack);
    _mqttConnected = false;
    _emit('disconnect', null);
    _updateBadge();
  });

  _mqttClient.on('offline', () => {
    console.warn('[RaceCore] MQTT client offline');
    _mqttConnected = false;
    _updateBadge();
  });

  _mqttClient.on('message', (topic, payload) => {
    try {
      const d = JSON.parse(payload.toString());
      _mergeLive(topic, d);
      _live.lastTs = Date.now();
      _updateBadge();
      _emit('data', { live: _live, topic, raw: d });

      if (_live.hdg != null && _live.cog != null && _live.sog != null) {
        sampleDeviation(_live.hdg, _live.cog, _live.sog, _live.rot, _live.awa);
      }
      if (_live.lat != null && _live.lon != null) {
        checkAdvance(_live.lat, _live.lon);
      }
    } catch (e) {
      console.warn('[RaceCore] MQTT bad JSON on', topic, e);
    }
  });
}

function _mergeLive(topic, d) {
  switch (topic) {
    case 'esp-nmea/nav':
      _live.sog       = d.sog;
      _live.cog       = d.cog;
      _live.hdg       = d.hdg;
      _live.rot       = d.rot;
      _live.variation = d.var;
      break;
    case 'esp-nmea/wind':
      _live.aws = d.aws;
      _live.awa = d.awa;
      _live.awd = d.awd;
      _live.tws = d.tws;
      _live.twa = d.twa;
      _live.twd = d.twd;
      break;
    case 'esp-nmea/gps':
      _live.lat  = d.lat;
      _live.lon  = d.lon;
      _live.alt  = d.alt;
      _live.fix  = d.fix;
      _live.sats = d.sats;
      _live.hdop = d.hdop;
      break;
    case 'esp-nmea/water':
      _live.water_spd   = d.spd;
      _live.water_depth = d.depth;
      _live.water_temp  = d.temp;
      break;
    case 'esp-nmea/ap':
      _live.ap_on     = d.on;
      _live.ap_mode   = d.mode;
      _live.ap_target = d.target;
      break;
    case 'esp-nmea/status':
      _live.heap    = d.heap;
      _live.rssi    = d.rssi;
      _live.clients = d.clients;
      break;
  }
}

function apCommand(payload) {
  if (!_mqttClient || !_mqttConnected) return;
  _mqttClient.publish('esp-nmea/cmd/ap', JSON.stringify(payload));
}

function getLive() { return _live; }
function isMqttConnected() { return _mqttConnected; }

function testConnection(host, port) {
  return new Promise((resolve) => {
    // Use wss:// on HTTPS pages for Safari compatibility
    const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    const testUrl = `${protocol}${host}:${port}`;
    console.log('[RaceCore] Testing connection to:', testUrl);

    const testClient = mqtt.connect(testUrl, {
      connectTimeout: 5000,
      clean: true,
      clientId: 'test-' + Math.random().toString(16).substr(2, 8),
    });

    const timeout = setTimeout(() => {
      testClient.end();
      resolve({ success: false, error: 'Connection timeout' });
    }, 5000);

    testClient.on('connect', () => {
      clearTimeout(timeout);
      testClient.end();
      resolve({ success: true, url: testUrl });
    });

    testClient.on('error', (err) => {
      clearTimeout(timeout);
      testClient.end();
      resolve({ success: false, error: err.message || err.toString() });
    });
  });
}

async function diagnoseNetwork(host, port) {
  const results = [];

  try {
    const httpUrl = `http://${host}:${port}/`;
    await fetch(httpUrl, { mode: 'no-cors', signal: AbortSignal.timeout(3000) });
    results.push({ test: 'HTTP', result: 'Success', url: httpUrl });
  } catch (error) {
    results.push({ test: 'HTTP', result: 'Failed', error: error.message });
  }

  for (const protocol of ['ws://', 'wss://']) {
    try {
      const wsUrl = `${protocol}${host}:${port}`;
      const ws = new WebSocket(wsUrl);
      const wsResult = await new Promise((resolve) => {
        const timeout = setTimeout(() => { ws.close(); resolve({ success: false, error: 'Timeout' }); }, 3000);
        ws.onopen  = () => { clearTimeout(timeout); ws.close(); resolve({ success: true }); };
        ws.onerror = () => { clearTimeout(timeout); resolve({ success: false, error: 'WebSocket error' }); };
      });
      results.push({ test: `WebSocket ${protocol}`, result: wsResult.success ? 'Success' : 'Failed',
                     url: wsUrl, error: wsResult.error });
    } catch (error) {
      results.push({ test: `WebSocket ${protocol}`, result: 'Failed', error: error.message });
    }
  }

  return results;
}

// =============================================================================
// Connection badge updater
// =============================================================================
function _updateBadge() {
  const dot    = document.getElementById('wsDot');
  const status = document.getElementById('wsStatus');
  const age    = document.getElementById('wsAge');

  const ageMs = _live.lastTs ? Date.now() - _live.lastTs : Infinity;
  const stale  = ageMs > 5000;

  if (dot) {
    dot.classList.toggle('connected', _mqttConnected && !stale);
    dot.classList.toggle('stale',     _mqttConnected && stale);
  }
  if (status) {
    if (!_mqttConnected) status.textContent = 'Connecting…';
    else if (stale)       status.textContent = 'No data';
    else                  status.textContent = 'Live';
  }
  if (age && _live.lastTs) {
    const s = Math.round(ageMs / 1000);
    age.textContent = `data ${s}s ago`;
    age.style.color = stale ? 'var(--warn)' : 'var(--muted)';
  }

  document.body.classList.toggle('data-stale', stale);
}

setInterval(_updateBadge, 1000);

// =============================================================================
// Export
// =============================================================================
global.RaceCore = {
  // State
  loadState, saveState, getState, clearState,
  // Geo
  geoDist, geoBearing, geoOffset, angleDiff,
  // Format
  fmt, fmtCoord, fmtDuration,
  // Polar
  loadPolar, getPolar, interpOptimal, interpSpeed,
  // Deviation
  sampleDeviation, deviationAt, correctedHeading, deviationProgress,
  // Field marks
  addMark, removeMark, updateMark, getMark, addWaypoint,
  isLine, lineCenter, lineInfo, lineClosestPoint,
  // Triangulation
  addBearing, solveMark,
  // Course legs
  addLeg, removeLeg, updateLeg, moveLeg, rebuildSequence,
  // Leg / race logic
  checkAdvance, forceAdvance, forceBack,
  currentLegLabel, currentTarget, etaToTack,
  setManualLegIdx,
  // Projected path
  calcProjectedPath,
  // MQTT
  mqttConnect, getLive, isMqttConnected, testConnection, diagnoseNetwork, apCommand, on, off,
  // Constants
  M_PER_NM, RAD, DEG, R_EARTH_M,
};

})(window);
