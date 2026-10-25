import json
import os

from shell import page

# Home's Now tab for M7 (docs/ui §8): the colored diamond, a glance at what's next with
# a map, the weather, what needs you, and the week in area colors. A second state shows
# Home scoped to Keyframes: the stage's rails take the area's color. The diamond is the
# mark in ember (brand/atlas-mark.svg), the same in every scope.
# The diamond here is one frame of docs/ui/source/diamond.html, which shows it moving.

FRAMES = json.load(open(os.path.join(os.path.dirname(__file__), 'diamond_frames.json')))

EXTRA_CSS = r"""
.scK{--dash:rgba(var(--Krgb),.55);--dot:rgba(var(--Krgb),.16)}
.card{border:1px solid var(--sep);border-radius:10px;background:var(--win);box-sizing:border-box}
.dk{--d1:#ffb48c;--d2:#ff6a3d;--d3:#e2442a;--d4:#b02e1d}.lt{--d1:#f08a5d;--d2:#e8501b;--d3:#c2391b;--d4:#8f2412}
.dia{font-family:'Geist Mono',ui-monospace,monospace;font-size:5.1px;line-height:5.1px;margin:0;white-space:pre;font-weight:700;flex:none}
.soft{color:var(--tx2)}
"""

# A small map: streets, a park and the lake, the way from home to where the event is.
MAP = r"""
<svg viewBox="0 0 320 128" width="100%" height="128" aria-hidden="true" style="display: block; border-radius: 8px; background: var(--bg);">
  <rect x="196" y="8" width="96" height="58" rx="6" style="fill: rgba(var(--Frgb), .16);"></rect>
  <path d="M0 104 C 60 96, 90 120, 150 112 S 250 92, 320 102 L 320 128 L 0 128 Z" style="fill: rgba(var(--Urgb), .18);"></path>
  <g style="stroke: var(--sep2); stroke-width: 7; stroke-linecap: round; fill: none;">
    <path d="M-10 40 H 330"></path><path d="M70 -10 V 100"></path><path d="M180 -10 V 96"></path>
  </g>
  <g style="stroke: var(--sep); stroke-width: 3; fill: none;">
    <path d="M-10 70 H 330"></path><path d="M120 -10 V 100"></path><path d="M250 -10 V 90"></path><path d="M20 -10 L 60 100"></path>
  </g>
  <path class="draw" d="M70 86 V 40 H 180 V 22 H 236" style="fill: none; stroke: ROUTE; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round;"></path>
  <circle cx="70" cy="86" r="6" style="fill: var(--win); stroke: var(--tx); stroke-width: 2;"></circle>
  <rect x="230" y="16" width="12" height="12" rx="2" style="fill: ROUTE;"></rect>
</svg>
"""

BODY = r"""
          <div class="rise" style="position: absolute; inset: 0; padding: 22px 26px; display: flex; flex-direction: column; gap: 18px; box-sizing: border-box;">
            <div style="display: flex; gap: 26px; align-items: center;">
              <sc-if value="{{isAll}}" hint-placeholder-val="{{true}}"><pre class="dia" aria-hidden="true">FRAME_ALL</pre></sc-if>
              <sc-if value="{{isK}}" hint-placeholder-val="{{false}}"><pre class="dia" aria-hidden="true">FRAME_K</pre></sc-if>
              <div style="display: flex; flex-direction: column; gap: 8px; flex: 1;">
                <span class="disp" style="font-size: 34px; font-weight: 600; line-height: 1.1;">{{hello}}</span>
                <span style="font-size: 15.5px;" class="soft">{{sub}}</span>
                <div style="display: flex; gap: 8px; padding-top: 8px; flex-wrap: wrap;">
                  <sc-for list="{{receipts}}" as="r" hint-placeholder-count="2"><span style="height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--sep2); background: var(--win); display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px;"><span style="color: var(--F);">✓</span>{{r}}</span></sc-for>
                </div>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: 1.25fr 1fr 1fr; gap: 12px;">
              <div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;">
                <span style="display: flex; align-items: center; gap: 8px;"><span style="font-weight: 600;">Next</span><span class="ach" style="--c: {{next.c}}; --rgb: {{next.rgb}};">{{next.area}}</span><span style="flex: 1;"></span><span style="font-size: 12px; color: var(--tx3);">{{next.when}}</span></span>
                <span style="display: flex; flex-direction: column;"><span style="font-size: 16px; font-weight: 500;">{{next.n}}</span><span class="soft" style="font-size: 12.5px;">{{next.where}}</span></span>
                <sc-if value="{{isAll}}" hint-placeholder-val="{{true}}">MAP_ALL</sc-if>
                <sc-if value="{{isK}}" hint-placeholder-val="{{false}}">MAP_K</sc-if>
                <span style="display: flex; align-items: center; gap: 8px; font-size: 12.5px;"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{next.c}};"></span><span>{{next.leave}}</span><span style="flex: 1;"></span><span style="color: var(--tx3);">{{next.trip}}</span></span>
              </div>

              <div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;">
                <span style="display: flex; align-items: center; gap: 8px;"><span style="font-weight: 600;">Weather</span><span style="flex: 1;"></span><span style="font-size: 12px; color: var(--tx3);">Winter Park</span></span>
                <span style="display: flex; align-items: center; gap: 14px;">
                  <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" style="fill: none; stroke: var(--K); stroke-width: 1.6; stroke-linecap: round; flex: none;"><circle cx="12" cy="12" r="4.2" style="fill: rgba(var(--Krgb), .25);"></circle><path d="M12 2v2.2M12 19.8V22M2 12h2.2M19.8 12H22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6"></path></svg>
                  <span style="display: flex; flex-direction: column;"><span class="disp" style="font-size: 28px; font-weight: 600; line-height: 1;">71°</span><span class="soft" style="font-size: 12.5px;">Clear tonight</span></span>
                </span>
                <span style="font-size: 13px;">{{rain}}</span>
                <div style="display: grid; grid-template-columns: repeat(12, 1fr); gap: 3px; align-items: end; height: 46px; margin-top: auto;">
                  <sc-for list="{{hours}}" as="h" hint-placeholder-count="12"><span style="display: flex; flex-direction: column; justify-content: flex-end; height: 46px; gap: 2px;"><span style="height: {{h.r}}px; border-radius: 2px; background: rgba(var(--Urgb), .75);"></span><span style="height: {{h.t}}px; border-radius: 2px; background: rgba(var(--Krgb), {{h.o}});"></span></span></sc-for>
                </div>
                <span class="mono" style="display: flex; justify-content: space-between; font-size: 10px; color: var(--tx3);"><span>NOW</span><span>MIDNIGHT</span><span>9 AM</span><span>3 PM</span></span>
              </div>

              <div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 4px;">
                <span style="display: flex; align-items: center; gap: 8px; padding-bottom: 6px;"><span style="font-weight: 600;">Needs you</span><span style="flex: 1;"></span><span style="font-size: 12px; color: var(--ac);">{{needN}}</span></span>
                <sc-for list="{{needs}}" as="n" hint-placeholder-count="2">
                  <span style="display: flex; align-items: flex-start; gap: 10px; padding: 9px 0; border-top: 1px solid var(--sep);">
                    <span style="width: 7px; height: 7px; border-radius: 2px; background: var(--ac); margin-top: 6px; flex: none;"></span>
                    <span style="display: flex; flex-direction: column; flex: 1;"><span style="font-weight: 500;">{{n.n}}</span><span class="soft" style="font-size: 12.5px;">{{n.why}}</span></span>
                    <button type="button" class="btn" style="height: 26px; padding: 0 10px; font-size: 12px;">{{n.act}}</button>
                  </span>
                </sc-for>
                <span style="margin-top: auto; display: flex; align-items: center; gap: 8px; padding-top: 8px; border-top: 1px solid var(--sep); font-size: 12.5px;"><span class="mono spin" aria-hidden="true" style="color: var(--tx2); width: 9px;"></span><span class="soft">{{jobsLine}}</span></span>
              </div>
            </div>

            <div style="display: flex; align-items: flex-end; gap: 22px;">
              <span style="font-weight: 600; padding-bottom: 18px;">This week</span>
              <div style="display: grid; grid-template-columns: repeat(7, 46px); gap: 10px; align-items: end;">
                <sc-for list="{{week}}" as="d" hint-placeholder-count="7">
                  <span style="display: flex; flex-direction: column; align-items: center; gap: 5px;">
                    <span style="display: flex; flex-direction: column-reverse; gap: 2px; width: 28px; height: 64px; justify-content: flex-start;">
                      <sc-for list="{{d.segs}}" as="g" hint-placeholder-count="3"><span style="height: {{g.h}}px; border-radius: 3px; background: {{g.c}};"></span></sc-for>
                    </span>
                    <span style="font-size: 12px; color: {{d.fc}}; font-weight: {{d.fw}};">{{d.n}}</span>
                  </span>
                </sc-for>
              </div>
              <span style="flex: 1;"></span>
              <span style="display: flex; flex-direction: column; gap: 6px; padding-bottom: 18px; align-items: flex-end;">
                <span>{{weekLine}}</span>
                <span style="display: flex; gap: 8px;"><sc-for list="{{legend}}" as="l" hint-placeholder-count="4"><span class="ach" style="--c: {{l.c}}; --rgb: {{l.rgb}};">{{l.n}}</span></sc-for></span>
              </span>
            </div>
          </div>
"""

JS = r"""
  renderVals() {
    var self = this;
    var st = this.state;
    var K = st.scope === 'Keyframes';
    var AC = { P: ['var(--P)', 'var(--Prgb)', 'Personal'], K: ['var(--K)', 'var(--Krgb)', 'Keyframes'], U: ['var(--U)', 'var(--Urgb)', 'UCF'], F: ['var(--F)', 'var(--Frgb)', 'Fitness'] };
    function seg(a, h) { return { c: AC[a][0], h: h }; }
    var weekAll = [[seg('U', 14), seg('P', 8)], [seg('K', 22), seg('U', 10)], [seg('F', 8), seg('P', 6)], [seg('K', 28), seg('U', 14), seg('F', 8)], [seg('K', 16), seg('P', 8)], [seg('K', 30)], [seg('P', 10), seg('F', 6)]];
    var weekK = [[], [seg('K', 22)], [], [seg('K', 28)], [seg('K', 16)], [seg('K', 30)], []];
    var days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    var week = (K ? weekK : weekAll).map(function (s, i) { var today = i === 1; return { n: today ? 'Today' : days[i], segs: s.length ? s : [{ c: 'var(--sep)', h: 4 }], fc: today ? 'var(--tx)' : 'var(--tx3)', fw: today ? 600 : 400 }; });
    var hours = [[0, 18], [0, 16], [0, 14], [0, 12], [0, 12], [0, 14], [0, 20], [2, 24], [10, 22], [22, 18], [26, 16], [14, 18]].map(function (h) { return { r: h[0], t: h[1], o: h[0] > 8 ? '.35' : '.7' }; });
    var base = this.shellVals('Home');
    var v = K ? {
      tc: base.tc + ' scK', scopeDots: ['var(--K)'], scopeName: 'Keyframes',
      hello: 'Keyframes, this week.', sub: 'Two shoots, one quote out, and Priya’s waiting on a price.',
      receipts: ['Held Sat for the Riverside shoot', 'Sent Dev the rate card'],
      next: { area: 'Keyframes', c: AC.K[0], rgb: AC.K[1], when: 'Sat · 9:00 AM', n: 'Riverside promo shoot', where: 'Lake Eola Park, by the amphitheater', leave: 'Leave by 8:25 for the 9:00 call time', trip: '24 min by car' },
      rain: 'Rain Saturday from 3 pm. The shoot wraps by 1.',
      needN: '2', needs: [{ n: 'Price for Priya’s wedding film', why: 'She wants extras; the front desk said today', act: 'Draft it' }, { n: 'Approve the gear booking', why: 'Lensrentals, $302 for Saturday', act: 'Review' }],
      jobsLine: 'Gear rental quotes: 3 of 4 shops answered',
      weekLine: 'Saturday is the long one.', legend: [{ c: AC.K[0], rgb: AC.K[1], n: 'Keyframes' }]
    } : {
      hello: 'Evening, Max.', sub: 'You’re home. Two things need you before tomorrow.',
      receipts: ['Moved the dentist to Thu 10:00', 'Told Mom you’ll call after'],
      next: { area: 'Fitness', c: AC.F[0], rgb: AC.F[1], when: 'Tonight · 7:30 PM', n: 'Climbing with Sam', where: 'Aiguille Rock Climbing, Longwood', leave: 'Leave by 7:05', trip: '18 min by car · light traffic' },
      rain: 'Rain tomorrow from 3 pm. Bring a jacket to the edit session.',
      needN: '2', needs: [{ n: 'Reply to Priya about the quote', why: 'She wrote at 11:22, the front desk handed it to you', act: 'Draft it' }, { n: 'Text to Mom', why: 'Waiting on your OK', act: 'Review' }],
      jobsLine: '2 jobs running: gear quotes, and the gallery fix',
      weekLine: 'Thursday is the busy one.', legend: [AC.P, AC.K, AC.U, AC.F].map(function (a) { return { c: a[0], rgb: a[1], n: a[2] }; })
    };
    var tabs = this.mkTabs([['Now'], ['Week'], ['Draft', '1'], ['Jobs', '2']], 'Now', 'tab');
    return Object.assign(base, { tabs: tabs, meta: K ? 'Keyframes · Tue Oct 21 · 7:02 PM' : 'Tue Oct 21 · 7:02 PM · Home', isAll: !K, isK: K, hours: hours, week: week }, v);
  }
"""

if __name__ == '__main__':
    body = (BODY.replace('FRAME_ALL', FRAMES['all']).replace('FRAME_K', FRAMES['K'])
            .replace('MAP_ALL', MAP.replace('ROUTE', 'var(--F)')).replace('MAP_K', MAP.replace('ROUTE', 'var(--K)')))
    out = page(title='Atlas · Now', active='Home', label='Stage', body=body, js=JS, extra_css=EXTRA_CSS,
               placeholder='Ask Atlas anything, or hold Space to talk', state="{ scope: 'All' }")
    open('../Now.dc.html', 'w').write(out)
    print('wrote Now')
