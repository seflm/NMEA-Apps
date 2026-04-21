/**
 * race-plotter.js — Race Assistant v2 canvas plotter
 * Usage: const plotter = new RacePlotter(canvasEl);
 *        plotter.draw(live, state, routeResult);
 */
(function (global) {
'use strict';

class RacePlotter {
  constructor(canvas, options = {}) {
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.pxPerM  = 0.2;    // zoom: pixels per metre
    this.panX    = 0;
    this.panY    = 0;
    this.centerLL = null;  // chart center {lat, lon}
    this._scaleElId = options.scaleElId || 'hudScale';

    this._live   = null;
    this._state  = null;
    this._route  = null;

    this._dragging = false;
    this._dragX = 0;
    this._dragY = 0;
    this._pickCb = null;  // called with {lat,lon} when pick mode active

    this._ambientWaypointMode = false;
    this._onAmbientClick = null;

    this._bindEvents();

    this._ro = new ResizeObserver(() => { this.resize(); this.draw(); });
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  resize() {
    const dpr = devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width  = w * dpr;
    this.canvas.height = h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setCenter(ll) { this.centerLL = ll; }

  startPick(cb) { this._pickCb = cb; this.canvas.style.cursor = 'crosshair'; }
  cancelPick()  { this._pickCb = null; if (!this._ambientWaypointMode) this.canvas.style.cursor = ''; }

  setAmbientWaypointMode(enabled, cb) {
    this._ambientWaypointMode = enabled;
    this._onAmbientClick = enabled ? cb : null;
    this.canvas.style.cursor = enabled ? 'crosshair' : '';
  }

  draw(live, state, routeResult) {
    this._live  = live  || this._live;
    this._state = state || this._state;
    this._route = routeResult !== undefined ? routeResult : this._route;
    this._render();
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render() {
    const { ctx } = this;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;

    const live  = this._live;
    const state = this._state;
    const route = this._route;

    ctx.clearRect(0, 0, w, h);

    // Auto-center on boat or first placed mark
    if (!this.centerLL) {
      if (live && live.lat != null) {
        this.centerLL = { lat: live.lat, lon: live.lon };
      } else if (state && state.field && state.field.marks.length > 0) {
        const m = state.field.marks.find(m => m.lat != null);
        if (m) this.centerLL = { lat: m.lat, lon: m.lon };
      }
    }

    if (!this.centerLL) {
      ctx.fillStyle = 'var(--muted, #4a7a9b)';
      ctx.font = '14px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for GPS or mark…', w / 2, h / 2);
      return;
    }

    this._drawGrid();

    // Boat trail
    if (state && state._trackHistory && state._trackHistory.length > 1) {
      ctx.strokeStyle = 'rgba(0,212,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      state._trackHistory.forEach((p, i) => {
        const px = this._ll2px(p);
        if (i === 0) ctx.moveTo(px.x, px.y); else ctx.lineTo(px.x, px.y);
      });
      ctx.stroke();
    }

    // Marks and route lines
    if (state && state.field) {
      this._drawRoute(state);
      this._drawMarks(state, route);
    }

    // Projected path (replaces old infinite laylines)
    if (route && route.projectedPath && live && live.lat != null) {
      const tgt = state && RaceCore.currentTarget();
      if (tgt && tgt.lat != null) {
        const boatLL = { lat: live.lat, lon: live.lon };
        this._drawProjectedPath(boatLL, tgt, route.projectedPath);
      }
    }

    // Wind arrow HUD (top-right)
    if (live && live.twd != null) this._drawWindArrow(live.twd, live.tws);

    // Boat
    if (live && live.lat != null) {
      const bp = this._ll2px({ lat: live.lat, lon: live.lon });
      this._drawBoat(bp, live.hdg != null ? live.hdg : live.cog || 0);
    }

    this._drawScaleHud(w, h);
  }

  _drawGrid() {
    const { ctx } = this;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    ctx.strokeStyle = 'rgba(26,58,92,0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(74,122,155,0.55)';
    ctx.font = '10px Courier New';
    ctx.textAlign = 'center'; ctx.fillText('N', w / 2, 12);
    ctx.fillText('S', w / 2, h - 4);
    ctx.textAlign = 'left';  ctx.fillText('E', w - 10, h / 2 + 4);
    ctx.textAlign = 'right'; ctx.fillText('W', 10, h / 2 + 4);
  }

  _drawRoute(state) {
    const { ctx } = this;
    const marks = state.field.marks;
    const legs  = state.course && state.course.legs ? state.course.legs : [];
    const pts = legs
      .map(leg => marks.find(m => m.id === leg.mark_id))
      .filter(m => m && m.lat != null);
    if (pts.length < 2) return;
    ctx.strokeStyle = 'rgba(0,153,204,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    pts.forEach((m, i) => {
      const p = this._ll2px(m);
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  _drawMarks(state, route) {
    const legs = state.course && state.course.legs ? state.course.legs : [];
    const seq  = state.course && state.course.sequence ? state.course.sequence : [];
    const prog = state.progress || {};
    // Resolve target index respecting manual override
    const manualIdx = prog.manual_leg_idx;
    const autoIdx   = prog.current_leg_idx || 0;
    const effIdx    = (manualIdx != null && manualIdx >= 0 && manualIdx < seq.length) ? manualIdx : autoIdx;
    const curLegId  = seq.length > 0 ? seq[Math.min(effIdx, seq.length - 1)] : null;
    const curLeg    = legs.find(l => l.id === curLegId);
    const targetMarkId = curLeg ? curLeg.mark_id : null;

    for (const mark of state.field.marks) {
      if (mark.lat == null && mark.kind !== 'line') continue;
      const isTarget = mark.id === targetMarkId;

      // Confidence circle (regular marks only)
      if (mark.kind !== 'line' && mark.lat != null &&
          mark.confidence_m != null && mark.confidence_m < 500) {
        const p = this._ll2px(mark);
        const r = mark.confidence_m * this.pxPerM;
        this.ctx.strokeStyle = 'rgba(0,212,255,0.3)';
        this.ctx.lineWidth = 1;
        this.ctx.setLineDash([3, 3]);
        this.ctx.beginPath();
        this.ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        this.ctx.stroke();
        this.ctx.setLineDash([]);
      }

      // Bearing rays
      if (mark.bearings && mark.kind !== 'line') {
        for (const b of mark.bearings) {
          if (b.excluded || b.lat == null) continue;
          const src = this._ll2px({ lat: b.lat, lon: b.lon });
          const far = RaceCore.geoOffset({ lat: b.lat, lon: b.lon }, b.bearing_mag, 3 * RaceCore.M_PER_NM);
          const farPx = this._ll2px(far);
          this.ctx.strokeStyle = 'rgba(0,212,255,0.18)';
          this.ctx.lineWidth = 1;
          this.ctx.setLineDash([]);
          this.ctx.beginPath();
          this.ctx.moveTo(src.x, src.y);
          this.ctx.lineTo(farPx.x, farPx.y);
          this.ctx.stroke();
        }
      }

      if (mark.kind === 'line') {
        this._drawLineMark(mark, isTarget);
      } else if (mark.lat != null) {
        const p = this._ll2px(mark);
        const color = this._markColor(mark, isTarget);
        this._drawBuoy(p, color, mark.name || mark.kind, isTarget);
      }
    }
  }

  _markColor(mark, isTarget) {
    if (isTarget) return '#00d4ff';
    if (mark.kind === 'line')     return '#ffcc00';
    if (mark.kind === 'mark')     return '#ff7a00';
    if (mark.kind === 'waypoint') return '#a0c4ff';
    return '#4a7a9b';
  }

  _drawLineMark(mark, isTarget) {
    const { ctx } = this;
    if (!mark.points) return;
    const a = mark.points[0], b = mark.points[1];
    const hasA = a && a.lat != null;
    const hasB = b && b.lat != null;
    const color = isTarget ? '#00d4ff' : '#ffcc00';
    const r = 5;

    if (hasA && hasB) {
      const pa = this._ll2px(a);
      const pb = this._ll2px(b);

      // Highlight glow for target line
      if (isTarget) {
        ctx.strokeStyle = 'rgba(0,212,255,0.2)';
        ctx.lineWidth = 8;
        ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      }

      // Line segment
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();

      // Endpoint circles
      for (const p of [pa, pb]) {
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }

      // Label at midpoint
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
      ctx.fillStyle = color;
      ctx.font = 'bold 9px Courier New';
      ctx.textAlign = 'center';
      ctx.fillText((mark.name || 'line').substring(0, 8), mx, my - r - 4);
    } else {
      // Only one endpoint set — draw it as a single dot
      const p = hasA ? this._ll2px(a) : hasB ? this._ll2px(b) : null;
      if (p) {
        ctx.fillStyle = color;
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = 'bold 9px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText((mark.name || 'line').substring(0, 8), p.x, p.y - r - 4);
      }
    }
  }

  _drawBuoy(p, color, label, highlight) {
    const { ctx } = this;
    const r = highlight ? 8 : 6;
    if (highlight) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r + 5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,212,255,0.15)';
      ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    if (label) {
      ctx.fillStyle = color;
      ctx.font = `bold 9px Courier New`;
      ctx.textAlign = 'center';
      ctx.fillText(label.substring(0, 8), p.x, p.y - r - 4);
    }
  }

  // Draw projected two-leg path (boat → tack point → target) for both tacks
  _drawProjectedPath(boatLL, targetLL, path) {
    const boatPx   = this._ll2px(boatLL);
    const targetPx = this._ll2px(targetLL);

    // Draw each path (port-first = green, stbd-first = red)
    const paths = [
      { data: path.portFirst,  color: 'rgba(48,209,88,',  current: path.onPort  },
      { data: path.stbdFirst,  color: 'rgba(255,59,48,',  current: !path.onPort },
    ];

    for (const { data, color, current } of paths) {
      const alpha  = current ? '0.85)' : '0.3)';
      const width  = current ? 2.5 : 1.5;
      const dash   = current ? [] : [5, 4];

      this.ctx.strokeStyle = color + alpha;
      this.ctx.lineWidth   = width;
      this.ctx.setLineDash(dash);

      if (data.validT && data.tackPt) {
        const tackPx = this._ll2px(data.tackPt);
        // Leg 1: boat → tack point
        this.ctx.beginPath();
        this.ctx.moveTo(boatPx.x, boatPx.y);
        this.ctx.lineTo(tackPx.x, tackPx.y);
        this.ctx.stroke();
        // Leg 2: tack point → target
        this.ctx.beginPath();
        this.ctx.moveTo(tackPx.x, tackPx.y);
        this.ctx.lineTo(targetPx.x, targetPx.y);
        this.ctx.stroke();
        // Diamond marker at tack point
        if (current) {
          const d = 5;
          this.ctx.strokeStyle = color + '0.9)';
          this.ctx.lineWidth = 1.5;
          this.ctx.setLineDash([]);
          this.ctx.beginPath();
          this.ctx.moveTo(tackPx.x, tackPx.y - d);
          this.ctx.lineTo(tackPx.x + d, tackPx.y);
          this.ctx.lineTo(tackPx.x, tackPx.y + d);
          this.ctx.lineTo(tackPx.x - d, tackPx.y);
          this.ctx.closePath();
          this.ctx.stroke();
        }
      } else {
        // On or past layline — direct line to target
        this.ctx.beginPath();
        this.ctx.moveTo(boatPx.x, boatPx.y);
        this.ctx.lineTo(targetPx.x, targetPx.y);
        this.ctx.stroke();
      }
    }
    this.ctx.setLineDash([]);
  }

  _drawBoat(p, headingDeg) {
    const { ctx } = this;
    const RAD = RaceCore.RAD;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(headingDeg * RAD);
    ctx.fillStyle = '#00d4ff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, -11);
    ctx.lineTo(7, 9);
    ctx.lineTo(0, 5);
    ctx.lineTo(-7, 9);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  _drawWindArrow(twd, tws) {
    const { ctx } = this;
    const cx = this.canvas.clientWidth - 42, cy = 42, r = 24;
    ctx.fillStyle = 'rgba(7,15,28,0.75)';
    ctx.strokeStyle = 'rgba(26,58,92,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();

    const RAD = RaceCore.RAD;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((twd + 180) * RAD);
    ctx.strokeStyle = '#00d4ff';
    ctx.fillStyle   = '#00d4ff';
    ctx.lineWidth   = 2;
    ctx.beginPath(); ctx.moveTo(0, -r + 5); ctx.lineTo(0, r - 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, r - 5); ctx.lineTo(-4, r - 11); ctx.lineTo(4, r - 11); ctx.closePath(); ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 9px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText(`${Math.round(twd)}°`, cx, cy + r + 12);
    if (tws != null) ctx.fillText(`${tws.toFixed(1)}kt`, cx, cy - r - 4);
  }

  _drawScaleHud(w, h) {
    const scaleNm = (Math.min(w, h) / 2 / this.pxPerM) / RaceCore.M_PER_NM;
    const el = document.getElementById(this._scaleElId);
    if (el) el.textContent = scaleNm.toFixed(2) + ' nm';
  }

  // Returns true if pixel coords (x,y) are within ~12px of any placed mark
  _nearMark(x, y) {
    const state = this._state;
    if (!state || !state.field) return false;
    for (const mark of state.field.marks) {
      if (mark.lat == null) continue;
      const p = this._ll2px(mark);
      if (Math.hypot(p.x - x, p.y - y) < 12) return true;
      // Also check line endpoints
      if (mark.kind === 'line' && mark.points) {
        for (const pt of mark.points) {
          if (pt && pt.lat != null) {
            const pp = this._ll2px(pt);
            if (Math.hypot(pp.x - x, pp.y - y) < 12) return true;
          }
        }
      }
    }
    return false;
  }

  // ── Coordinate transforms ─────────────────────────────────────────────────

  _ll2px(ll) {
    const RAD = RaceCore.RAD;
    const R = RaceCore.R_EARTH_M;
    const ctr = this.centerLL;
    const dx = (ll.lon - ctr.lon) * RAD * Math.cos(ctr.lat * RAD) * R;
    const dy = (ll.lat - ctr.lat) * RAD * R;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    return {
      x: w / 2 + this.panX + dx * this.pxPerM,
      y: h / 2 + this.panY - dy * this.pxPerM,
    };
  }

  _px2ll(x, y) {
    const RAD = RaceCore.RAD;
    const DEG = RaceCore.DEG;
    const R = RaceCore.R_EARTH_M;
    const ctr = this.centerLL;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const dx = (x - (w / 2 + this.panX)) / this.pxPerM;
    const dy = ((h / 2 + this.panY) - y) / this.pxPerM;
    return {
      lat: ctr.lat + (dy / R) * DEG,
      lon: ctr.lon + (dx / (R * Math.cos(ctr.lat * RAD))) * DEG,
    };
  }

  // ── Event binding ─────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      this.pxPerM = Math.max(0.005, Math.min(10, this.pxPerM * factor));
      this._render();
    }, { passive: false });

    c.addEventListener('mousedown', (e) => {
      if (this._pickCb) return;
      if (this._ambientWaypointMode) return;
      this._dragging = true;
      this._dragX = e.offsetX; this._dragY = e.offsetY;
    });
    c.addEventListener('mousemove', (e) => {
      if (!this._dragging) return;
      this.panX += e.offsetX - this._dragX; this.panY += e.offsetY - this._dragY;
      this._dragX = e.offsetX; this._dragY = e.offsetY;
      this._render();
    });
    c.addEventListener('mouseup', () => { this._dragging = false; });
    c.addEventListener('mouseleave', () => { this._dragging = false; });

    c.addEventListener('click', (e) => {
      if (!this.centerLL) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this._pickCb) {
        const ll = this._px2ll(x, y);
        const cb = this._pickCb;
        this.cancelPick();
        cb(ll);
        return;
      }

      if (this._ambientWaypointMode && this._onAmbientClick && !this._nearMark(x, y)) {
        const ll = this._px2ll(x, y);
        this._onAmbientClick(ll);
      }
    });

    // Touch: single-finger pan, pinch zoom
    let _lastTouches = null;
    c.addEventListener('touchstart', (e) => {
      _lastTouches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touches = Array.from(e.touches).map(t => ({ x: t.clientX, y: t.clientY }));
      if (!_lastTouches) { _lastTouches = touches; return; }
      if (touches.length === 1 && _lastTouches.length === 1 && !this._pickCb && !this._ambientWaypointMode) {
        this.panX += touches[0].x - _lastTouches[0].x;
        this.panY += touches[0].y - _lastTouches[0].y;
      } else if (touches.length === 2 && _lastTouches.length === 2) {
        const d0 = Math.hypot(_lastTouches[1].x - _lastTouches[0].x, _lastTouches[1].y - _lastTouches[0].y);
        const d1 = Math.hypot(touches[1].x - touches[0].x, touches[1].y - touches[0].y);
        if (d0 > 10) this.pxPerM = Math.max(0.005, Math.min(10, this.pxPerM * (d1 / d0)));
      }
      _lastTouches = touches;
      this._render();
    }, { passive: false });
    c.addEventListener('touchend', () => { _lastTouches = null; });

    c.addEventListener('touchend', (e) => {
      if (!this.centerLL) return;
      if (e.changedTouches.length !== 1) return;
      const t = e.changedTouches[0];
      const rect = c.getBoundingClientRect();
      const x = t.clientX - rect.left;
      const y = t.clientY - rect.top;

      if (this._pickCb) {
        const ll = this._px2ll(x, y);
        const cb = this._pickCb;
        this.cancelPick();
        cb(ll);
        return;
      }

      if (this._ambientWaypointMode && this._onAmbientClick && !this._nearMark(x, y)) {
        const ll = this._px2ll(x, y);
        this._onAmbientClick(ll);
      }
    });
  }
}

global.RacePlotter = RacePlotter;

})(window);
