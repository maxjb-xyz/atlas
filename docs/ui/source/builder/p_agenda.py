from shell import page, diamond

# Kind glyph: Atlas's diamond for promises, a stroked icon for everything else.
GLYPH = ('<span style="width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; flex: none;">'
         '<sc-if value="{{X.isPromise}}" hint-placeholder-val="{{false}}">' + diamond(8, 14) + '</sc-if>'
         '<sc-if value="{{X.notPromise}}" hint-placeholder-val="{{true}}"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="color: {{X.gc}};"><path d="{{X.d}}"></path></svg></sc-if>'
         '</span>')

GLYPH_SM = ('<span style="width: 11px; height: 11px; display: inline-flex; align-items: center; justify-content: center; flex: none;">'
            '<sc-if value="{{X.isPromise}}" hint-placeholder-val="{{false}}">' + diamond(6, 11) + '</sc-if>'
            '<sc-if value="{{X.notPromise}}" hint-placeholder-val="{{true}}"><svg class="ic" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" style="color: {{X.gc}}; stroke-width: 2;"><path d="{{X.d}}"></path></svg></sc-if>'
            '</span>')

BODY = r"""
        <sc-if value="{{isUpcoming}}" hint-placeholder-val="{{true}}">
          <div style="display: flex; align-items: baseline; gap: 12px; padding: 15px 22px 11px;">
            <span class="disp" style="font-size: 21px; font-weight: 600;">{{title}}</span>
            <span class="num" style="color: var(--tx3);">{{range}}</span>
            <sc-if value="{{filtered}}" hint-placeholder-val="{{false}}"><button type="button" onClick="{{clearDay}}" style="border: 0; background: transparent; padding: 0; color: var(--tx2); text-decoration: underline; text-underline-offset: 3px; font-size: 12.5px;">Show all 7 days</button></sc-if>
            <span style="flex: 1;"></span>
            <sc-for list="{{kinds}}" as="k" hint-placeholder-count="5"><span style="display: inline-flex; align-items: center; gap: 6px; margin-left: 14px; font-size: 12px; color: var(--tx2);">GLYPH_K{{k.l}}</span></sc-for>
          </div>

          <div style="padding: 0 22px 12px;">
            <div style="position: relative; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border: 1px solid var(--sep);">
              <span class="node" aria-hidden="true" style="left: 0; top: 0;"></span>
              <span class="node" aria-hidden="true" style="left: 100%; top: 0;"></span>
              <span class="node" aria-hidden="true" style="left: 0; top: 100%;"></span>
              <span class="node" aria-hidden="true" style="left: 100%; top: 100%;"></span>
              <sc-for list="{{strip}}" as="d" hint-placeholder-count="7">
                <button type="button" class="it" onClick="{{d.pick}}" aria-pressed="{{d.on}}" style="border: 0; border-right: {{d.br}}; background: {{d.bg}}; box-shadow: {{d.sh}}; text-align: left; padding: 8px 12px 9px; display: flex; flex-direction: column; gap: 2px;">
                  <span style="display: flex; align-items: center; gap: 6px;"><span class="lab" style="color: {{d.lc}};">{{d.dow}}</span><span style="flex: 1;"></span><span class="lab" style="font-size: 9.5px; color: {{d.nc}};">{{d.note}}</span></span>
                  <span style="display: flex; align-items: baseline; gap: 8px;"><span class="disp num" style="font-size: 22px; font-weight: 600; line-height: 1.15;">{{d.n}}</span><span class="mono" style="font-size: 11px; color: var(--tx3);">{{d.count}}</span></span>
                  <span class="mono" aria-label="{{d.loadLabel}}" style="font-size: 8.5px; letter-spacing: 1.5px; line-height: 10px;"><span style="color: {{d.fc}};">{{d.fill}}</span><span style="color: var(--sep2);">{{d.empty}}</span></span>
                </button>
              </sc-for>
            </div>
          </div>

          <sc-for list="{{groups}}" as="g" hint-placeholder-count="3">
            <div style="display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 22px; border-top: 1px solid var(--sep); background: var(--bg);">
              <span class="lab" style="color: var(--tx); letter-spacing: .12em;">{{g.name}}</span>
              <span class="lab">{{g.date}}</span>
              <span aria-hidden="true" style="flex: 1; border-top: 1px dashed var(--dash); margin: 0 4px;"></span>
              <sc-if value="{{g.today}}" hint-placeholder-val="{{false}}"><span class="lab" style="display: inline-flex; align-items: center; gap: 6px; color: var(--ac);"><span style="width: 5px; height: 5px; background: var(--ac);"></span>Now 7:02 PM</span></sc-if>
              <span class="lab">{{g.count}}</span>
            </div>
            <sc-for list="{{g.rows}}" as="r" hint-placeholder-count="3">
              <div class="row" style="position: relative; display: grid; grid-template-columns: 74px 104px minmax(0, 1fr) 118px 186px; align-items: center; gap: 14px; height: 36px; padding: 0 22px; border-top: 1px solid var(--sep);">
                <span class="mono" style="font-size: 12px; color: var(--tx2);">{{r.time}}</span>
                <span style="display: inline-flex; align-items: center; gap: 8px;">GLYPH_R<span class="lab" style="font-size: 10px; color: var(--tx3);">{{r.kind}}</span></span>
                <span style="display: flex; align-items: center; gap: 10px; min-width: 0; white-space: nowrap;">
                  <span style="font-weight: 500; flex: none;">{{r.title}}</span>
                  <sc-if value="{{r.moved}}" hint-placeholder-val="{{false}}"><span class="tag" style="color: var(--ac); border-color: var(--ac); flex: none;"><span style="width: 5px; height: 5px; background: var(--ac);"></span>Moved from Wed 3 PM</span></sc-if>
                  <span style="color: var(--tx3); overflow: hidden; text-overflow: ellipsis; font-size: 12.5px;">{{r.sub}}</span>
                </span>
                <span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tx2);"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{r.ac}};"></span>{{r.area}}</span>
                <span style="font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{r.src}}</span>
              </div>
            </sc-for>
          </sc-for>
          <div style="border-top: 1px solid var(--sep);"></div>
          <div aria-hidden="true" style="position: absolute; left: 0; right: 0; bottom: 0; height: 36px; background: linear-gradient(to bottom, transparent, var(--win)); pointer-events: none;"></div>
        </sc-if>

        <sc-if value="{{isWeek}}" hint-placeholder-val="{{false}}">
          <div style="padding: 16px 22px 0; display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; align-items: baseline; gap: 12px;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">This week</span>
              <span class="num" style="color: var(--tx3);">Oct 20 to 26</span>
              <span style="flex: 1;"></span>
              <sc-for list="{{legend}}" as="g" hint-placeholder-count="4"><span style="display: inline-flex; align-items: center; gap: 6px; margin-left: 12px; font-size: 12px; color: var(--tx2);"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{g.c}};"></span>{{g.n}}</span></sc-for>
              <span style="width: 1px; height: 12px; background: var(--sep2); margin: 0 4px 0 14px; align-self: center;"></span>
              <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2);"><span style="width: 14px; height: 9px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 2px; background: var(--win);"></span>Reminders, promises, runs</span>
            </div>
            <div style="display: grid; grid-template-columns: 44px repeat(7, minmax(0, 1fr)); border-bottom: 1px solid var(--sep);">
              <span></span>
              <sc-for list="{{wdays}}" as="d" hint-placeholder-count="7"><span style="padding: 6px 8px; font-size: 12px; color: {{d.c}}; font-weight: {{d.fw}};">{{d.d}} <span class="num">{{d.n}}</span></span></sc-for>
            </div>
            <div style="position: relative; display: grid; grid-template-columns: 44px repeat(7, minmax(0, 1fr)); height: WEEKHpx;">
              <div style="position: relative;">
                <sc-for list="{{hours}}" as="h" hint-placeholder-count="8"><span class="mono" style="position: absolute; right: 8px; top: {{h.top}}px; transform: translateY(-50%); font-size: 10px; color: var(--tx3);">{{h.l}}</span></sc-for>
              </div>
              <sc-for list="{{wdays}}" as="d" hint-placeholder-count="7">
                <div style="position: relative; border-left: 1px solid var(--sep); background: {{d.bg}};">
                  <sc-for list="{{lines}}" as="h" hint-placeholder-count="16"><div style="position: absolute; left: 0; right: 0; top: {{h.top}}px; border-top: 1px solid var(--sep); opacity: {{h.op}};"></div></sc-for>
                  <sc-for list="{{d.ev}}" as="e" hint-placeholder-count="2">
                    <div style="position: absolute; left: 4px; right: 4px; top: {{e.top}}px; height: {{e.h}}px; box-sizing: border-box; border-radius: 5px; padding: 4px 7px; background: {{e.bg}}; border: {{e.bd}}; opacity: {{e.op}}; overflow: hidden;">
                      <div style="font-size: 11.5px; font-weight: 500; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-decoration: {{e.deco}};">{{e.t}}</div>
                      <sc-if value="{{e.showTime}}" hint-placeholder-val="{{false}}"><div class="num" style="font-size: 10.5px; color: var(--tx3);">{{e.time}}</div></sc-if>
                    </div>
                    <sc-if value="{{e.sel}}" hint-placeholder-val="{{false}}">
                      <div class="pick" style="position: absolute; left: 1px; right: 1px; top: {{e.stop}}px; height: {{e.sh}}px; border: 1px solid var(--ac); pointer-events: none;">
                        <span class="hd" style="left: -4px; top: -4px;"></span><span class="hd" style="right: -4px; top: -4px;"></span><span class="hd" style="left: -4px; bottom: -4px;"></span><span class="hd" style="right: -4px; bottom: -4px;"></span>
                        <span class="mono" style="position: absolute; left: -1px; top: calc(100% + 4px); height: 16px; padding: 0 5px; background: var(--ac); color: #fff; font-size: 9.5px; letter-spacing: .06em; display: inline-flex; align-items: center; white-space: nowrap;">MOVED · WAS WED 3 PM</span>
                      </div>
                    </sc-if>
                  </sc-for>
                  <sc-for list="{{d.mk}}" as="m" hint-placeholder-count="2">
                    <div style="position: absolute; left: 3px; right: 3px; top: {{m.top}}px; height: 18px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 4px; background: var(--win); padding: 0 5px; display: flex; align-items: center; gap: 5px; font-size: 10.5px; white-space: nowrap; overflow: hidden; opacity: {{m.op}}; z-index: 2;">GLYPH_M<span style="overflow: hidden; text-overflow: ellipsis;">{{m.t}}</span></div>
                  </sc-for>
                  <sc-if value="{{d.today}}" hint-placeholder-val="{{false}}"><div style="position: absolute; left: 0; right: 0; top: {{nowTop}}px; border-top: 1.5px solid var(--ac); z-index: 3;"><span style="position: absolute; left: -3px; top: -4px; width: 6px; height: 6px; background: var(--ac);"></span></div></sc-if>
                </div>
              </sc-for>
            </div>
          </div>
        </sc-if>
"""

H = 34          # px per hour in the week grid
START, END = 7, 24
WEEKH = (END - START) * H

BODY = (BODY.replace('GLYPH_K', GLYPH.replace('X.', 'k.'))
            .replace('GLYPH_R', GLYPH.replace('X.', 'r.'))
            .replace('GLYPH_M', GLYPH_SM.replace('X.', 'm.'))
            .replace('WEEKH', str(WEEKH)))

JS = r"""
  renderVals() {
    var self = this;
    var tab = this.state.tab, pick = this.state.day || null;
    var AC = { P: 'var(--P)', K: 'var(--K)', U: 'var(--U)', F: 'var(--F)' };
    var AN = { P: 'Personal', K: 'Keyframes', U: 'UCF', F: 'Fitness' };
    var R = { P: 'var(--Prgb)', K: 'var(--Krgb)', U: 'var(--Urgb)', F: 'var(--Frgb)' };
    var KIND = {
      event: { l: 'Event', d: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', gc: 'var(--tx3)' },
      reminder: { l: 'Reminder', d: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0', gc: 'var(--tx2)' },
      due: { l: 'Due', d: 'M4 22V4a1 1 0 0 1 1-1h12l-2 5 2 5H5', gc: 'var(--tx2)' },
      promise: { l: 'Promise', d: '', gc: 'var(--tx2)' },
      run: { l: 'Run', d: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z', gc: 'var(--tx2)' }
    };
    function glyph(k) { var K = KIND[k]; return { isPromise: k === 'promise', notPromise: k !== 'promise', d: K.d, gc: K.gc }; }

    // Upcoming: next 7 days from now (Tue Oct 21, 7:02 PM).
    var DAYS = [
      { key: 'Tue', name: 'Today', dow: 'Tue', n: '21', date: 'Tue Oct 21', load: 2, today: true },
      { key: 'Wed', name: 'Tomorrow', dow: 'Wed', n: '22', date: 'Wed Oct 22', load: 3 },
      { key: 'Thu', name: 'Thursday', dow: 'Thu', n: '23', date: 'Oct 23', load: 7, note: 'Busy' },
      { key: 'Fri', name: 'Friday', dow: 'Fri', n: '24', date: 'Oct 24', load: 5 },
      { key: 'Sat', name: 'Saturday', dow: 'Sat', n: '25', date: 'Oct 25', load: 5, note: 'Shoot' },
      { key: 'Sun', name: 'Sunday', dow: 'Sun', n: '26', date: 'Oct 26', load: 3 },
      { key: 'Mon', name: 'Monday', dow: 'Mon', n: '27', date: 'Oct 27', load: 3 }
    ];
    var brief = ['run', 'Morning brief', 'Read aloud in the kitchen', 'P', 'Automation'];
    var ROWS = {
      Tue: [
        ['7:30 PM', 'reminder', 'Take the recycling out', '', 'P', 'You asked Sunday'],
        ['9:00 PM', 'promise', 'Check if Orlando Grip sent its rate sheet', 'If not, I’ll call them at 9 AM', 'K', 'Atlas · Gear rental quotes'],
        ['11:30 PM', 'run', 'Goodnight', 'Only if you’re home', 'P', 'Automation']
      ],
      Wed: [
        ['7:30 AM'].concat(brief),
        ['10:00 AM', 'event', 'Film Theory', 'Nicholson 112 · 75 min', 'U', 'UCF calendar'],
        ['12:00 PM', 'due', 'Calc II problem set 7', 'Submit on Webcourses', 'U', 'From a Canvas email']
      ],
      Thu: [
        ['7:30 AM'].concat(brief),
        ['9:40 AM', 'reminder', 'Leave for the dentist', '23 min drive with traffic', 'P', 'Set by Atlas'],
        ['10:00 AM', 'event', 'Dentist cleaning', '', 'P', 'iCloud', true],
        ['12:00 PM', 'event', 'Calc II review', 'Exam prep session', 'U', 'UCF calendar'],
        ['3:00 PM', 'event', 'Shoot prep', 'Studio · 2 hours', 'K', 'Keyframes calendar']
      ],
      Fri: [
        ['7:30 AM'].concat(brief),
        ['9:00 AM', 'event', 'Calc II', 'Lecture · 75 min', 'U', 'UCF calendar'],
        ['2:00 PM', 'event', 'Riverside review', 'Client cut · 90 min', 'K', 'Keyframes calendar'],
        ['5:00 PM', 'promise', 'Confirm the FX3 kit shipped', 'Tracking from Lensrentals', 'K', 'Atlas · Gear rental quotes']
      ],
      Sat: [
        ['8:00 AM', 'reminder', 'Pack the gear', 'Checklist from the last shoot', 'K', 'Set by Atlas'],
        ['10:00 AM', 'event', 'Riverside shoot', 'Riverside Park · 4 hours', 'K', 'Keyframes calendar']
      ],
      Sun: [
        ['8:30 AM', 'event', 'Long run', '8 miles, easy pace', 'F', 'Training plan'],
        ['6:00 PM', 'event', 'Family dinner', 'At Mom’s', 'P', 'iCloud']
      ],
      Mon: [
        ['7:30 AM'].concat(brief),
        ['10:00 AM', 'event', 'Film Theory', 'Nicholson 112 · 75 min', 'U', 'UCF calendar'],
        ['4:00 PM', 'event', 'Gym', 'Upper body', 'F', 'Training plan']
      ]
    };
    function row(r) {
      return Object.assign({ time: r[0], kind: KIND[r[1]].l, title: r[2], sub: r[3], ac: AC[r[4]], area: AN[r[4]], src: r[5], moved: !!r[6] }, glyph(r[1]));
    }
    var total = 0;
    DAYS.forEach(function (d) { total += ROWS[d.key].length; });
    var strip = DAYS.map(function (d, i) {
      var on = pick === d.key, c = ROWS[d.key].length;
      return {
        dow: d.dow, n: d.n, on: on ? 'true' : 'false',
        note: d.today ? 'Today' : (d.note || ''), nc: d.today ? 'var(--ac)' : 'var(--tx2)', lc: d.today ? 'var(--ac)' : 'var(--tx3)',
        count: c + (c === 1 ? ' item' : ' items'),
        fill: new Array(d.load + 1).join('■'), empty: new Array(8 - d.load + 1).join('■'), fc: d.load >= 7 ? 'var(--tx)' : 'var(--tx2)',
        loadLabel: 'Load ' + d.load + ' of 8',
        br: i < 6 ? '1px solid var(--sep)' : '0',
        bg: on ? 'var(--sel)' : 'transparent', sh: on ? 'inset 0 -2px 0 var(--tx)' : 'none',
        pick: function () { self.setState({ day: on ? null : d.key }); }
      };
    });
    var groups = DAYS.filter(function (d) { return !pick || d.key === pick; }).map(function (d) {
      var c = ROWS[d.key].length;
      return { name: d.name, date: d.date, today: !!d.today, count: c + (c === 1 ? ' item' : ' items'), rows: ROWS[d.key].map(row) };
    });
    var pd = DAYS.filter(function (d) { return d.key === pick; })[0];

    // Week: Mon Oct 20 to Sun Oct 26. Events are blocks, everything else is a small marker.
    var H = HPX, S = HSTART, E = HEND, NOW = 19.03;
    function ev(t, time, s, dur, a, x) {
      x = x || {};
      var top = Math.round((s - S) * H) + 2, h = Math.round(dur * H) - 4;
      var past = !!x.past;
      return { t: t, time: time, top: top, h: h, showTime: h >= 44, bg: x.ghost ? 'transparent' : 'rgba(' + R[a] + ',.13)', bd: x.ghost ? '1px dashed var(--dash)' : '1px solid rgba(' + R[a] + ',.22)', op: x.ghost ? '.65' : (past ? '.45' : '1'), deco: x.ghost ? 'line-through' : 'none', sel: !!x.sel, stop: top - 3, sh: h + 6 };
    }
    function mk(t, s, k, past) {
      var top = Math.round((s - S) * H) - 9;
      top = Math.max(0, Math.min(top, (E - S) * H - 18));
      return Object.assign({ t: t, top: top, op: past ? '.45' : '1' }, glyph(k));
    }
    function wd(d, n, evs, mks, o) {
      o = o || {};
      return { d: d, n: n, ev: evs, mk: mks, today: !!o.today, c: o.today ? 'var(--ac)' : 'var(--tx2)', fw: o.today ? 600 : 400, bg: o.today ? 'var(--acs)' : 'transparent' };
    }
    var wdays = [
      wd('Mon', '20', [ev('Film Theory', '10:00', 10, 1.25, 'U', { past: true }), ev('Gym', '4:00', 16, 1, 'F', { past: true })], [mk('Morning brief', 7.5, 'run', true)]),
      wd('Tue', '21', [ev('Calc II', '9:00', 9, 1.25, 'U', { past: true }), ev('Jordan sync', '1:00', 13, 0.75, 'K', { past: true }), ev('Gym', '5:30', 17.5, 1, 'F', { past: true })],
        [mk('Morning brief', 7.5, 'run', true), mk('Recycling', 19.5, 'reminder'), mk('Rate sheet?', 21, 'promise'), mk('Goodnight', 23.5, 'run')], { today: true }),
      wd('Wed', '22', [ev('Film Theory', '10:00', 10, 1.25, 'U'), ev('Dentist', '3:00', 15, 1, 'P', { ghost: true })],
        [mk('Morning brief', 7.5, 'run'), mk('Calc II PS7', 12, 'due')]),
      wd('Thu', '23', [ev('Dentist cleaning', '10:00', 10, 1, 'P', { sel: true }), ev('Calc II review', '12:00', 12, 1, 'U'), ev('Shoot prep', '3:00', 15, 2, 'K')],
        [mk('Morning brief', 7.5, 'run'), mk('Leave 9:40', 9.55, 'reminder')]),
      wd('Fri', '24', [ev('Calc II', '9:00', 9, 1.25, 'U'), ev('Riverside review', '2:00', 14, 1.5, 'K')],
        [mk('Morning brief', 7.5, 'run'), mk('FX3 shipped?', 17, 'promise')]),
      wd('Sat', '25', [ev('Riverside shoot', '10:00', 10, 4, 'K')], [mk('Pack the gear', 8, 'reminder')]),
      wd('Sun', '26', [ev('Long run', '8:30', 8.5, 1.5, 'F'), ev('Family dinner', '6:00', 18, 1.5, 'P')], [])
    ];
    var hours = [], lines = [];
    for (var i = 1; i < E - S; i++) {
      var hr = S + i;
      lines.push({ top: i * H, op: hr % 2 === 0 ? '.6' : '.3' });
      if (hr % 2 === 0) hours.push({ top: i * H, l: (hr > 12 ? hr - 12 : hr) + (hr >= 12 ? 'p' : 'a') });
    }

    return Object.assign(this.shellVals('Agenda'), {
      tabs: this.mkTabs([['Upcoming', String(total)], ['Week', '']], tab, 'tab'),
      meta: total + ' on the clock · next 7 days',
      isUpcoming: tab === 'Upcoming', isWeek: tab === 'Week',
      title: pd ? (pd.today ? 'Today' : pd.name) : 'Next 7 days',
      range: pd ? (pd.today ? 'Tue Oct 21' : pd.dow + ' Oct ' + pd.n) : 'Oct 21 to 27',
      filtered: !!pd,
      clearDay: function () { self.setState({ day: null }); },
      kinds: ['event', 'reminder', 'due', 'promise', 'run'].map(function (k) { return Object.assign({ l: KIND[k].l }, glyph(k)); }),
      strip: strip, groups: groups,
      wdays: wdays, hours: hours, lines: lines, nowTop: Math.round((NOW - S) * H),
      legend: [{ n: 'Personal', c: 'var(--P)' }, { n: 'Keyframes', c: 'var(--K)' }, { n: 'UCF', c: 'var(--U)' }, { n: 'Fitness', c: 'var(--F)' }]
    });
  }
""".replace('HPX', str(H)).replace('HSTART', str(START)).replace('HEND', str(END))

if __name__ == '__main__':
    out = page(title='Atlas · Agenda', active='Agenda', label='Agenda', body=BODY, js=JS,
               placeholder='Add, move, or ask about anything coming up', state="{ tab: 'Upcoming', day: null }")
    open('../Agenda.dc.html', 'w').write(out)
    print('wrote Agenda')
