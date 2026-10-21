"""Home (stage + console), ported onto the shared shell from the hand-built StageHome."""
import re
from shell import page, diamond

SRC = open('StageHome.src.html').read()

# Pieces lifted from the hand-built file.
sheet_start = SRC.index('<div style="position: relative; padding: 18px 60px 0;">')
console_start = SRC.index('<div style="position: absolute; left: 50%; bottom: 18px;')
section_end = SRC.index('</section>')
sheet = SRC[sheet_start:console_start]
console = SRC[console_start:section_end]

helpers_start = sheet.index('<sc-if value="{{isHelpers}}"')
helpers_end = sheet.index('</sc-if>', sheet.index('Ships Fri. Pro Cam is local.')) + len('</sc-if>')

JOBS = r"""<sc-if value="{{isJobs}}" hint-placeholder-val="{{false}}">
          <div style="padding: 16px 20px 18px; display: flex; flex-direction: column; gap: 14px;">
            <div style="display: flex; align-items: center; gap: 6px;">
              <sc-for list="{{jobTabs}}" as="j" hint-placeholder-count="2">
                <button type="button" onClick="{{j.pick}}" style="height: 30px; padding: 0 11px; border-radius: 6px; border: 1px solid {{j.bd}}; background: {{j.bg}}; display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: {{j.fg}};"><span class="mono spin" aria-hidden="true" style="color: var(--ac); width: 9px;"></span>{{j.name}}<span class="mono" style="font-size: 11px; color: var(--tx3);">{{j.prog}}</span></button>
              </sc-for>
              <span style="flex: 1;"></span>
              <span class="lab" style="margin-right: 6px;">{{jobCost}}</span>
              <button type="button" class="btn" style="height: 28px;">Steer<span class="kbd">S</span></button>
              <button type="button" class="btn" style="height: 28px;">Stop</button>
            </div>

            <sc-if value="{{isGear}}" hint-placeholder-val="{{true}}">
              <div style="display: flex; flex-direction: column; gap: 10px;">
                <div style="display: flex; align-items: baseline; gap: 12px;"><span class="disp" style="font-size: 21px; font-weight: 600;">Gear rental quotes</span><span style="color: var(--tx3);">for Saturday's Riverside shoot · 4 helpers, one per shop</span></div>
                HELPERS_DIAGRAM
              </div>
            </sc-if>

            <sc-if value="{{isCode}}" hint-placeholder-val="{{false}}">
              <div style="display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; align-items: baseline; gap: 12px;"><span class="disp" style="font-size: 21px; font-weight: 600;">Fix gallery lazy-load</span><span style="color: var(--tx3);">keyframes-site · Claude Code does the work, Atlas runs it</span></div>
                <div style="display: flex; align-items: center; gap: 0;">
                  <sc-for list="{{steps}}" as="s" hint-placeholder-count="5">
                    <span aria-hidden="true" style="width: {{s.w}}px; border-top: 1px dashed var(--dash);"></span>
                    <span class="tag" style="color: {{s.fg}}; border-color: {{s.bd}}; border-style: {{s.bs}};"><span style="color: {{s.mc}};">{{s.m}}</span>{{s.l}}</span>
                  </sc-for>
                </div>
                <div style="display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 14px;">
                  <div class="mono" style="background: var(--bg); border: 1px solid var(--sep); border-radius: 8px; padding: 12px 14px; font-size: 11.5px; line-height: 1.75; color: var(--tx2); overflow: hidden;">
                    <div style="color: var(--tx3);">$ claude · keyframes-site · atlas/gallery-lazy</div>
                    <sc-for list="{{term}}" as="l" hint-placeholder-count="7"><div style="white-space: pre; color: {{l.c}};">{{l.t}}</div></sc-for>
                    <div style="white-space: pre;"><span style="color: var(--ac);">▸</span> npm test   <span style="color: var(--tx);">41/58</span>  <span style="color: var(--ac);">■■■■■■■■■■■■■■</span><span style="color: var(--dash);">■■■■■■</span><span class="blink" style="color: var(--tx);"> _</span></div>
                  </div>
                  <div style="border: 1px solid var(--sep); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px;"><span class="lab" style="flex: 1;">Atlas answered for you</span><span class="mono" style="font-size: 11px; color: var(--tx3);">2 · ASKED YOU 0</span></div>
                    <sc-for list="{{answers}}" as="a" hint-placeholder-count="2">
                      <div style="display: flex; flex-direction: column; gap: 4px; padding-top: 8px; border-top: 1px dashed var(--dash);">
                        <span style="font-size: 12.5px; color: var(--tx2);">{{a.q}}</span>
                        <span style="display: flex; gap: 8px; align-items: flex-start;">DIAMOND<span style="font-size: 12.5px;">{{a.a}}</span></span>
                        <span class="mono" style="font-size: 10.5px; color: var(--tx3);">{{a.src}}</span>
                      </div>
                    </sc-for>
                  </div>
                </div>
              </div>
            </sc-if>
          </div>
        </sc-if>"""

helpers_block = sheet[helpers_start:helpers_end]
diagram_start = helpers_block.index('<div style="position: relative; width: 760px;')
diagram_end = helpers_block.rindex('</div>', 0, helpers_block.rindex('</div>'))  # drop the wrapper's own close
diagram = helpers_block[diagram_start:diagram_end].rstrip()
# the extracted diagram ends one level early; make sure tags balance
opens = diagram.count('<div'); closes = diagram.count('</div>')
diagram += '</div>' * (opens - closes)
jobs = JOBS.replace('HELPERS_DIAGRAM', diagram).replace('DIAMOND', diamond(7, 12).replace('flex: none;', 'flex: none; margin-top: 3px;'))
sheet = sheet[:helpers_start] + jobs + sheet[helpers_end:]

# Draft tab badge kept ember; header row comes from the shell.
A_LINE = re.search(r'    var A = \[.*?\];\n', SRC, re.S).group(0)

JS = r"""
  openJob(id) { this.setState({ tab: 'Jobs', job: id, jobsOpen: false }); }
  renderVals() {
    var self = this;
    var tab = this.state.tab, job = this.state.job || 'gear';
""" + A_LINE + r"""
    var R = { P: 'var(--Prgb)', K: 'var(--Krgb)', U: 'var(--Urgb)', F: 'var(--Frgb)' };
    var H = 34;
    function ev(t, time, s, d, a, x) {
      x = x || {};
      var top = Math.round((s - 8) * H) + 2, h = Math.round(d * H) - 4;
      return { t: t, time: time, top: top, h: h, bg: x.ghost ? 'transparent' : 'rgba(' + R[a] + ',.13)', bd: x.ghost ? '1px dashed var(--dash)' : '1px solid rgba(' + R[a] + ',.22)', op: x.ghost ? '.65' : '1', deco: x.ghost ? 'line-through' : 'none', sel: !!x.sel, stop: top - 3, sh: h + 6 };
    }
    function day(d, n, evs, o) {
      o = o || {};
      return { d: d, n: n, ev: evs, today: !!o.today, c: o.today ? 'var(--ac)' : 'var(--tx2)', fw: o.today ? 600 : 400, bg: o.today ? 'var(--acs)' : 'transparent' };
    }
    var days = [
      day('Mon', '20', [ev('Film Theory', '10:00', 10, 1.25, 'U'), ev('Gym', '4:00', 16, 1, 'F')]),
      day('Tue', '21', [ev('Calc II', '9:00', 9, 1.25, 'U'), ev('Jordan sync', '1:00', 13, 1, 'K'), ev('Gym', '5:30', 17.5, 1, 'F')], { today: true }),
      day('Wed', '22', [ev('Film Theory', '10:00', 10, 1.25, 'U'), ev('Dentist', '3:00', 15, 1, 'P', { ghost: true })]),
      day('Thu', '23', [ev('Dentist cleaning', '10:00', 10, 1, 'P', { sel: true }), ev('Calc II review', '12:00', 12, 1, 'U'), ev('Shoot prep', '3:00', 15, 2, 'K')]),
      day('Fri', '24', [ev('Calc II', '9:00', 9, 1.25, 'U'), ev('Riverside review', '2:00', 14, 1.5, 'K')]),
      day('Sat', '25', [ev('Riverside shoot', '10:00', 10, 4, 'K')]),
      day('Sun', '26', [ev('Long run', '8:30', 8.5, 1.5, 'F'), ev('Family dinner', '6:00', 18, 1.5, 'P')])
    ];
    var hours = [];
    for (var i = 1; i < 11; i++) { var hr = 8 + i; hours.push({ top: i * H, l: (hr > 12 ? hr - 12 : hr) + (hr >= 12 ? 'p' : 'a') }); }
    var tabs = this.mkTabs([['Now', ''], ['Week', ''], ['Draft', '1'], ['Jobs', '2']], tab, 'tab');
    if (tab !== 'Draft') tabs[2].bc = 'var(--ac)';
    var metas = { Now: 'Tue Oct 21 · 7:02 PM · Home', Week: 'Calendar · iCloud, UCF · Synced 7:01 PM', Draft: 'Draft · iMessage · Waiting on you', Jobs: '2 running · Finished work goes to Inbox' };
    var jobTabs = [['gear', 'Gear rental quotes', '3/4'], ['code', 'Fix gallery lazy-load', '41/58']].map(function (j) {
      var on = j[0] === job;
      return { name: j[1], prog: j[2], bg: on ? 'var(--sel)' : 'var(--win)', bd: on ? 'var(--dash)' : 'var(--sep2)', fg: on ? 'var(--tx)' : 'var(--tx2)', pick: function () { self.setState({ job: j[0] }); } };
    });
    function st(m, l, kind, w) {
      var k = { done: ['var(--tx2)', 'var(--sep2)', 'solid', 'var(--F)'], now: ['var(--ac)', 'var(--ac)', 'solid', 'var(--ac)'], next: ['var(--tx3)', 'var(--dash)', 'dashed', 'var(--tx3)'] }[kind];
      return { m: m, l: l, fg: k[0], bd: k[1], bs: k[2], mc: k[3], w: w };
    }
    return Object.assign(this.shellVals('Home'), {
      tabs: tabs, meta: metas[tab],
      isWeek: tab === 'Week', isNow: tab === 'Now', isDraft: tab === 'Draft', isJobs: tab === 'Jobs',
      isGear: job === 'gear', isCode: job === 'code', jobTabs: jobTabs, jobCost: job === 'gear' ? '$0.04 · 14 MIN' : '$0.31 · 22 MIN',
      openDraft: function () { self.setState({ tab: 'Draft' }); },
      days: days, hours: hours, nowTop: Math.round((19.03 - 8) * H) > 372 ? 372 : Math.round((19.03 - 8) * H),
      legend: [{ n: 'Personal', c: 'var(--P)' }, { n: 'Keyframes', c: 'var(--K)' }, { n: 'UCF', c: 'var(--U)' }, { n: 'Fitness', c: 'var(--F)' }],
      a0: A[0], a1: A[1], a2: A[2], a3: A[3],
      cells: [
        { l: 'Next', lc: 'var(--tx3)', a: 'Dentist cleaning', b: 'Thursday, 10:00 AM', c: 'LEAVE 9:40 · 23 MIN' },
        { l: 'Needs you · 5', lc: 'var(--ac)', a: 'Reply to Priya Nair', b: 'Text to Mom, and 3 more', c: 'OLDEST 11:22 AM' },
        { l: 'Jobs · 2', lc: 'var(--tx3)', a: 'Gear rental quotes', b: 'Fix gallery lazy-load', c: '[■■■□] 3/4 · TESTS 41/58' }
      ],
      helpers: [
        { name: 'Lensrentals', price: '$268/day', y: 16, status: 'Done · ships Fri', sc: 'var(--F)', pc: 'var(--tx)', bd: 'var(--sep2)' },
        { name: 'Pro Cam Orlando', price: '$310/day', y: 86, status: 'Done · local pickup', sc: 'var(--F)', pc: 'var(--tx)', bd: 'var(--sep2)' },
        { name: 'BorrowLenses', price: '$295/day', y: 162, status: 'Done · ships Thu', sc: 'var(--F)', pc: 'var(--tx)', bd: 'var(--sep2)' },
        { name: 'Orlando Grip', price: 'reading', y: 232, status: 'Browser · rate sheet PDF', sc: 'var(--ac)', pc: 'var(--ac)', bd: 'var(--ac)' }
      ],
      steps: [st('✓', 'Plan', 'done', 0), st('✓', 'Edit · 3 files', 'done', 16), st('●', 'Test', 'now', 16), st('→', 'Preview', 'next', 16), st('→', 'PR to Inbox', 'next', 16)],
      term: [
        { t: '✓ read   src/components/Gallery.tsx', c: 'var(--tx2)' },
        { t: '✓ read   src/hooks/useInView.ts', c: 'var(--tx2)' },
        { t: '? asked  keep the observer or use loading=lazy?', c: 'var(--tx)' },
        { t: '◆ atlas  keep the observer (see right)', c: 'var(--tx)' },
        { t: '✓ edit   src/hooks/useLazyImage.ts      +38 -12', c: 'var(--tx2)' },
        { t: '✓ edit   src/components/Gallery.tsx     +21 -30', c: 'var(--tx2)' },
        { t: '✓ edit   src/components/Gallery.test.tsx +44', c: 'var(--tx2)' }
      ],
      answers: [
        { q: 'Keep the IntersectionObserver or switch to loading="lazy"?', a: 'Keep the observer. Safari 15 is still 8% of your visitors.', src: 'FROM SITE ANALYTICS · LAST 30 DAYS' },
        { q: 'Run the full suite or only gallery tests?', a: 'Full suite. Last week a gallery change broke the booking form.', src: 'FROM HISTORY · PR #39' }
      ]
    });
  }
"""

BODY = sheet + console

if __name__ == '__main__':
    out = page(title='Atlas', active='Home', label='Stage', body=BODY, js=JS, sheet=False, composer=False,
               state="{ tab: 'Week', job: 'gear' }")
    open('../StageHome.dc.html', 'w').write(out)
    print('wrote StageHome')
