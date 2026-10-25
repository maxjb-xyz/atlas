from shell import page

BODY = r"""
          <sc-if value="{{isOverview}}" hint-placeholder-val="{{true}}">
            <div style="display: flex; align-items: baseline; gap: 12px; padding: 16px 22px 0;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">Everything Atlas knows</span>
              <span class="num" style="color: var(--tx3);">2,184 records in one memory</span>
              <span style="flex: 1;"></span>
              <span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;">EVERY RECORD KEEPS ITS SOURCE</span>
            </div>
            <div style="position: relative; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); margin: 14px 22px 0; border-top: 1px solid var(--sep); border-left: 1px solid var(--sep);">
              <sc-for list="{{cells}}" as="c" hint-placeholder-count="6">
                <button type="button" class="row" onClick="{{c.go}}" style="border: 0; border-right: 1px solid var(--sep); border-bottom: 1px solid var(--sep); background: transparent; text-align: left; padding: 12px 16px 14px; display: flex; flex-direction: column; gap: 9px; min-width: 0;">
                  <span style="display: flex; align-items: center; gap: 8px;">
                    <svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{c.d}}"></path></svg>
                    <span class="lab" style="color: var(--tx2);">{{c.l}}</span>
                    <span style="flex: 1;"></span>
                    <span class="mono" style="font-size: 11px; height: 18px; padding: 0 6px; border: 1px solid var(--sep2); display: inline-flex; align-items: center; color: var(--tx);">{{c.n}}</span>
                  </span>
                  <span style="display: flex; flex-direction: column; gap: 3px;">
                    <sc-for list="{{c.items}}" as="x" hint-placeholder-count="4">
                      <span style="display: flex; align-items: center; gap: 8px; height: 21px; min-width: 0;">
                        <span style="width: 6px; height: 6px; border-radius: {{x.r}}; background: {{x.c}}; flex: none;"></span>
                        <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tx);">{{x.n}}</span>
                        <span style="flex: 1;"></span>
                        <span aria-hidden="true" style="width: {{x.bw}}px; height: 5px; background: {{x.c}}; opacity: .55; flex: none;"></span>
                        <span class="mono" style="font-size: 11px; color: var(--tx3); white-space: nowrap; min-width: 46px; text-align: right;">{{x.m}}</span>
                      </span>
                    </sc-for>
                  </span>
                </button>
              </sc-for>
              <span class="node" aria-hidden="true" style="left: 33.333%; top: 0;"></span>
              <span class="node" aria-hidden="true" style="left: 66.666%; top: 0;"></span>
              <span class="node" aria-hidden="true" style="left: 0; top: 50%;"></span>
              <span class="node" aria-hidden="true" style="left: 33.333%; top: 50%;"></span>
              <span class="node" aria-hidden="true" style="left: 66.666%; top: 50%;"></span>
              <span class="node" aria-hidden="true" style="left: 100%; top: 50%;"></span>
              <span class="node" aria-hidden="true" style="left: 33.333%; top: 100%;"></span>
              <span class="node" aria-hidden="true" style="left: 66.666%; top: 100%;"></span>
            </div>

            <div style="display: flex; align-items: center; gap: 10px; margin: 22px 22px 4px;">
              <span aria-hidden="true" style="width: 6px; height: 6px; background: var(--ac);"></span>
              <span class="lab" style="color: var(--tx2);">Recently learned</span>
              <span aria-hidden="true" style="flex: 1; border-top: 1px dashed var(--dash);"></span>
              <span class="lab">Corrections replace, never erase</span>
            </div>
            <sc-for list="{{learned}}" as="f" hint-placeholder-count="5">
              <div class="row" style="display: grid; grid-template-columns: minmax(0, 1fr) 210px 120px 70px 64px; align-items: center; gap: 14px; padding: 0 22px; min-height: 40px; border-bottom: 1px solid var(--sep);">
                <span style="display: flex; flex-direction: column; min-width: 0; padding: 6px 0;">
                  <span style="font-size: 13.5px;">{{f.fact}}</span>
                  <sc-if value="{{f.old}}" hint-placeholder-val="{{false}}"><span style="font-size: 12px; color: var(--tx3);"><span style="text-decoration: line-through;">{{f.old}}</span> · {{f.oldNote}}</span></sc-if>
                </span>
                <span style="font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{f.src}}</span>
                <span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tx2);"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{f.c}};"></span>{{f.area}}</span>
                <span class="mono" style="font-size: 11px; color: var(--tx3);">{{f.t}}</span>
                <button type="button" style="justify-self: end; border: 0; background: transparent; padding: 0; color: var(--tx3); font-size: 12px; text-decoration: underline; text-underline-offset: 3px;">Correct</button>
              </div>
            </sc-for>
          </sc-if>

          <sc-if value="{{isAreas}}" hint-placeholder-val="{{false}}">
            <div style="display: flex; align-items: baseline; gap: 12px; padding: 16px 22px 0;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">One memory. Areas decide what leaves.</span>
            </div>
            <p style="margin: 6px 22px 0; color: var(--tx2); max-width: 760px;">Atlas tags everything as it comes in, and always knows all of it. These settings only matter when something goes out: a message, a share, an action.</p>
            <div style="display: flex; align-items: center; flex-wrap: wrap; margin: 14px 22px 4px;">
              <span class="lab" style="margin-right: 8px;">How it works</span>
              <sc-for list="{{flow}}" as="s" hint-placeholder-count="5">
                <span aria-hidden="true" style="width: 16px; border-top: 1px dashed var(--dash);"></span>
                <span class="tag" style="color: {{s.fg}}; border-color: {{s.bd}};"><span style="color: var(--tx3);">{{s.m}}</span>{{s.l}}</span>
              </sc-for>
            </div>
            <div style="display: grid; grid-template-columns: 158px minmax(0, 1fr) 168px 128px 112px 196px 52px; gap: 14px; padding: 18px 22px 8px; border-bottom: 1px solid var(--sep);">
              <sc-for list="{{cols}}" as="h" hint-placeholder-count="7"><span class="lab">{{h}}</span></sc-for>
            </div>
            <sc-for list="{{areas}}" as="a" hint-placeholder-count="5">
              <div class="row" style="display: grid; grid-template-columns: 158px minmax(0, 1fr) 168px 128px 112px 196px 52px; gap: 14px; align-items: start; padding: 11px 22px; border-bottom: 1px solid var(--sep);">
                <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
                  <span style="display: inline-flex; align-items: center; gap: 8px; font-weight: 500;"><span style="width: 8px; height: 8px; border-radius: 2px; background: {{a.c}};"></span>{{a.n}}</span>
                  <span style="font-size: 12px; color: var(--tx3); padding-left: 16px;">{{a.lens}}</span>
                </span>
                <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span>{{a.inA}}</span><span style="font-size: 12px; color: var(--tx3);">{{a.inB}}</span></span>
                <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span class="{{a.sendCls}}" style="font-size: {{a.sendFs}}; color: {{a.sendC}}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{a.sendA}}</span><span style="font-size: 12px; color: var(--tx3);">{{a.sendB}}</span></span>
                <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span>{{a.shareA}}</span><span style="font-size: 12px; color: var(--tx3);">{{a.shareB}}</span></span>
                <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span style="color: {{a.faceC}};">{{a.faceA}}</span><span style="font-size: 12px; color: var(--tx3);">{{a.faceB}}</span></span>
                <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span>{{a.aloneA}}</span><span style="font-size: 12px; color: var(--tx3);">{{a.aloneB}}</span></span>
                <span>
                  <sc-if value="{{a.priv}}" hint-placeholder-val="{{false}}"><span class="tag" style="color: var(--tx); border-color: var(--tx3);"><svg class="ic" width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" style="stroke-width: 2.2;"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>Yes</span></sc-if>
                  <sc-if value="{{a.pub}}" hint-placeholder-val="{{true}}"><span style="color: var(--tx3);">No</span></sc-if>
                </span>
              </div>
            </sc-for>
            <div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); margin: 16px 22px 0; border: 1px dashed var(--dash);">
              <div style="display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; border-right: 1px dashed var(--dash);">
                <svg viewBox="290 128 444 768" width="8" height="14" aria-hidden="true" style="flex: none; margin-top: 2px;"><polygon points="512,128.96 290.84,418.52 512,895.04 733.16,418.52" style="fill: var(--ac);"></polygon></svg>
                <span style="display: flex; flex-direction: column; gap: 2px;"><span>Atlas made Fitness itself on Sep 3, after 12 gym check-ins. You said yes.</span><span style="font-size: 12px; color: var(--tx3);">New areas are always a suggestion first. Nothing moves until you agree.</span></span>
              </div>
              <div style="display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px;">
                <span class="mono" aria-hidden="true" style="font-size: 12px; color: var(--tx3); margin-top: 1px;">↺</span>
                <span style="display: flex; flex-direction: column; gap: 2px;"><span>Wrong area on something? Tap its chip anywhere to move it.</span><span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;">3 FIXES THIS WEEK · ATLAS LEARNS FROM EACH</span></span>
              </div>
            </div>
          </sc-if>

          <sc-if value="{{isPeople}}" hint-placeholder-val="{{false}}">
            <div style="display: flex; align-items: baseline; gap: 12px; padding: 16px 22px 0;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">People</span>
              <span class="num" style="color: var(--tx3);">214 · 6 new this month</span>
              <span style="flex: 1;"></span>
              <span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;">MOST RECENT FIRST</span>
            </div>
            <div style="display: grid; grid-template-columns: 28px minmax(0, 1fr) 170px 140px 110px 120px; gap: 14px; padding: 18px 22px 8px; border-bottom: 1px solid var(--sep);">
              <span></span>
              <sc-for list="{{pcols}}" as="h" hint-placeholder-count="5"><span class="lab">{{h}}</span></sc-for>
            </div>
            <sc-for list="{{people}}" as="p" hint-placeholder-count="10">
              <div class="row" style="display: grid; grid-template-columns: 28px minmax(0, 1fr) 170px 140px 110px 120px; gap: 14px; align-items: center; padding: 0 22px; height: 47px; border-bottom: 1px solid var(--sep);">
                <span style="width: 28px; height: 28px; border-radius: 50%; background: var(--sel); color: var(--tx2); font-size: 10.5px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;">{{p.i}}</span>
                <span style="display: flex; flex-direction: column; min-width: 0;"><span style="font-weight: 500;">{{p.n}}</span><span style="font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{p.rel}}</span></span>
                <span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tx2); min-width: 0;">
                  <span style="display: inline-flex; gap: 3px;"><sc-for list="{{p.dots}}" as="d" hint-placeholder-count="1"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{d}};"></span></sc-for></span>
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{p.areas}}</span>
                </span>
                <span class="num" style="font-size: 12.5px; color: {{p.lc}};">{{p.last}}</span>
                <span style="font-size: 12.5px; color: var(--tx2);">{{p.ch}}</span>
                <span style="display: inline-flex; align-items: center; gap: 8px;"><span aria-hidden="true" style="display: inline-flex; gap: 2px;"><sc-for list="{{p.segs}}" as="g" hint-placeholder-count="5"><span style="width: 4px; height: 10px; background: {{g}};"></span></sc-for></span><span class="mono" style="font-size: 11.5px; color: var(--tx2);">{{p.k}}</span></span>
              </div>
            </sc-for>
            <div style="display: flex; align-items: center; gap: 12px; padding: 14px 22px;">
              <span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;">+ 204 MORE</span>
              <span aria-hidden="true" style="flex: 1; border-top: 1px dashed var(--dash);"></span>
              <span style="font-size: 12px; color: var(--tx3);">Atlas adds people as you email, text and meet them. Nobody gets typed in by hand.</span>
            </div>
          </sc-if>
"""

JS = r"""
  renderVals() {
    var self = this;
    var tab = this.state.tab || 'Overview';
    var A = { Personal: 'var(--P)', Keyframes: 'var(--K)', UCF: 'var(--U)', Fitness: 'var(--F)', Health: 'var(--H)' };
    function it(n, area, m, bw) { return { n: n, c: area ? A[area] : 'var(--tx3)', r: area ? '50%' : '1px', m: m || '', bw: bw || 0 }; }
    function go(t) { return function () { self.setState({ tab: t }); }; }
    var none = function () {};
    var cells = [
      { l: 'People', n: '214', go: none, d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
        items: [it('Mom', 'Personal', 'today'), it('Priya Nair', 'Keyframes', 'today'), it('Jordan Park', 'UCF', 'Mon'), it('Jordan Lee', 'Keyframes', 'Oct 14'), it('Sam Ortiz', 'Personal', 'Mon')] },
      { l: 'Places', n: '38', go: none, d: 'M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
        items: [it('Home', 'Personal', 'now'), it('Lake Eola Park', 'Keyframes', 'Nov 15'), it('Bright Smile Dental', 'Health', 'Thu'), it('Riverside Park', 'Keyframes', 'Sat'), it('Crunch Gym', 'Fitness', 'Sun')] },
      { l: 'Areas', n: '5', go: go('Areas'), d: 'M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
        items: [it('Personal', 'Personal', '612', 72), it('Keyframes', 'Keyframes', '388', 46), it('UCF', 'UCF', '201', 24), it('Fitness', 'Fitness', '54', 7), it('Health · private', 'Health', '29', 4)] },
      { l: 'Collections', n: '7', go: none, d: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
        items: [it('Instagram saves', 'Personal', '236'), it('Film list', 'Personal', '112'), it('Shot ideas', 'Keyframes', '48'), it('Gear', 'Keyframes', '31'), it('Recipes', 'Personal', '19')] },
      { l: 'Memory', n: '1,284', go: none, d: 'M12 2 4 11l8 11 8-11z',
        items: [it('Facts', '', '1,284'), it('Journal, one page a day', '', '51 days'), it('Portrait of you', '', 'Sun'), it('Corrections kept', '', '17'), it('Learned this week', '', '23')] },
      { l: 'Files', n: '412', go: none, d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
        items: [it('Rate card 2026.pdf', 'Keyframes', 'Oct 2'), it('Riverside promo brief.pdf', 'Keyframes', 'Oct 19'), it('Calc II syllabus.pdf', 'UCF', 'Aug 25'), it('Shoot checklist.md', 'Keyframes', 'Oct 12'), it('Lease 2026.pdf', 'Personal', 'Jul 30')] }
    ];
    var learned = [
      { fact: 'Jordan Lee prefers Slack over email', src: 'From today’s Jordan sync', area: 'Keyframes', t: '1:40 PM' },
      { fact: 'Priya Nair’s wedding is Nov 15 at Lake Eola', src: 'From Priya’s email', area: 'Keyframes', t: '11:22 AM' },
      { fact: 'Your dentist is Dr. Alvarez. Cleanings every 6 months', src: 'From your 7:01 PM chat', area: 'Health', t: '7:01 PM' },
      { fact: 'Calc II final is Tuesday, Dec 9 at 10:00 AM', src: 'From the Calc II syllabus', area: 'UCF', t: 'Mon' },
      { fact: 'Mom’s number ends in 0417', old: 'ends in 2290', oldNote: 'you corrected it Oct 18', src: 'You said so in chat', area: 'Personal', t: 'Oct 18' }
    ].map(function (f) { f.c = A[f.area]; f.old = f.old || ''; f.oldNote = f.oldNote || ''; return f; });

    function ar(n, o) { o.n = n; o.c = A[n]; o.priv = !!o.priv; o.pub = !o.priv; o.sendC = o.sendC || 'var(--tx2)'; o.sendCls = o.mono ? 'mono' : ''; o.sendFs = o.mono ? '12px' : '13px'; o.faceC = o.faceC || 'var(--tx)'; return o; }
    var areas = [
      ar('Personal', { lens: 'Family, home, plans', inA: '612 items', inB: '41 people · 4 collections', sendA: 'iMessage, Gmail', sendC: 'var(--tx)', sendB: 'as you', shareA: 'Only you', shareB: '', faceA: 'None', faceC: 'var(--tx3)', faceB: '', aloneA: 'Calendar, reminders', aloneB: 'asks before speaking as you' }),
      ar('Keyframes', { lens: 'Clients, shoots, rates', inA: '388 items', inB: '63 people · 2 projects', sendA: 'hello@keyframes.studio', mono: true, sendB: 'never from your Gmail', shareA: 'Jordan Lee', shareB: 'member · editor', faceA: 'Front desk', faceB: 'answers clients', aloneA: 'Rate-card replies', aloneB: 'scheduling, filing' }),
      ar('UCF', { lens: 'Classes and deadlines', inA: '201 items', inB: '18 people · 4 courses', sendA: 'max.barbare@ucf.edu', mono: true, sendB: '', shareA: 'Only you', shareB: '', faceA: 'None', faceC: 'var(--tx3)', faceB: '', aloneA: 'File email, add deadlines', aloneB: 'pings if due in 48h' }),
      ar('Fitness', { lens: 'Gym, runs, sleep', inA: '54 items', inB: '2 people · Apple Health', sendA: 'Nothing sends', sendC: 'var(--tx3)', sendB: '', shareA: 'Only you', shareB: '', faceA: 'None', faceC: 'var(--tx3)', faceB: '', aloneA: 'Nudges', aloneB: 'after 4 days without the gym' }),
      ar('Health', { lens: 'Never leaves this area', inA: '29 items', inB: '3 people · 1 place', sendA: 'Asks every time', sendC: 'var(--tx)', sendB: 'no drafts kept', shareA: 'No one', shareB: 'no members or faces', faceA: 'None, ever', faceB: '', aloneA: 'Nothing', aloneB: 'only answers you', priv: true })
    ];
    var flow = [
      { m: '', l: 'Email, chat, calendar', fg: 'var(--tx2)', bd: 'var(--sep2)' },
      { m: '', l: 'Tagged by Atlas', fg: 'var(--tx2)', bd: 'var(--sep2)' },
      { m: '◆', l: 'One memory', fg: 'var(--tx)', bd: 'var(--tx3)' },
      { m: '', l: 'Area rules', fg: 'var(--tx2)', bd: 'var(--sep2)' },
      { m: '→', l: 'Out', fg: 'var(--tx3)', bd: 'var(--dash)' }
    ];
    function pr(i, n, rel, as, last, ch, k, today) {
      var lvl = k > 60 ? 5 : k > 30 ? 4 : k > 12 ? 3 : k > 5 ? 2 : 1, segs = [];
      for (var j = 0; j < 5; j++) segs.push(j < lvl ? 'var(--tx2)' : 'var(--sep2)');
      return { i: i, n: n, rel: rel, dots: as.map(function (a) { return A[a]; }), areas: as.join(', ') + (as.indexOf('Health') >= 0 ? ' · private' : ''), last: last, lc: today ? 'var(--tx)' : 'var(--tx2)', ch: ch, k: k + ' facts', segs: segs };
    }
    var people = [
      pr('M', 'Mom', 'Family', ['Personal'], 'Today, 7:01 PM', 'iMessage', 86, true),
      pr('PN', 'Priya Nair', 'Client · wedding on Nov 15', ['Keyframes'], 'Today, 11:22 AM', 'Email', 6, true),
      pr('JP', 'Jordan Park', 'Calc II study group', ['UCF'], 'Yesterday', 'iMessage', 9),
      pr('SO', 'Sam Ortiz', 'Roommate · gym buddy', ['Personal', 'Fitness'], 'Yesterday', 'iMessage', 37),
      pr('DP', 'Dev Patel', 'Client · Riverside promo', ['Keyframes'], 'Oct 19', 'Email', 18),
      pr('D', 'Dad', 'Family', ['Personal'], 'Oct 19', 'Phone', 64),
      pr('MC', 'Mike Chen', 'Trainer at Crunch', ['Fitness'], 'Oct 17', 'Text', 7),
      pr('HR', 'Prof. Hannah Reyes', 'Film Theory', ['UCF'], 'Oct 16', 'Email', 12),
      pr('JL', 'Jordan Lee', 'Editor · Keyframes member', ['Keyframes', 'Personal'], 'Oct 14', 'Slack', 41),
      pr('EA', 'Dr. Elena Alvarez', 'Dentist', ['Health'], 'Sep 30', 'Phone', 4)
    ];
    var built = { Overview: 1, People: 1, Areas: 1 };
    var tabs = this.mkTabs([['Overview'], ['Places', '38'], ['Areas', '5'], ['Collections', '7'], ['Memory'], ['Files', '412']], tab, 'tab');
    tabs.forEach(function (t) { if (!built[t.name]) t.pick = none; });
    var metas = { Overview: 'Updated 7:01 PM', People: 'Synced 7:01 PM', Areas: '5 areas · 1 private' };

    return Object.assign(this.shellVals('Library'), {
      tabs: tabs, meta: metas[tab] || '',
      isOverview: tab === 'Overview', isAreas: tab === 'Areas', isPeople: tab === 'People',
      cells: cells, learned: learned,
      cols: ['Area', 'What’s in it', 'Sends from', 'Shared with', 'Faces', 'Atlas does alone', 'Private'],
      areas: areas, flow: flow,
      pcols: ['Name', 'Areas', 'Last talked', 'Usually', 'Atlas knows'],
      people: people
    });
  }
"""

if __name__ == '__main__':
    out = page(title='Atlas · Library', active='Library', label='Library', body=BODY, js=JS,
               placeholder='Ask what Atlas knows, or tell it something', state="{ tab: 'Overview' }")
    open('../Library.dc.html', 'w').write(out)
    print('wrote Library')
