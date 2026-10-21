from shell import page, diamond

# Who glyph: Atlas diamond, your initials, or a stroke icon for faces/jobs/automations/harnesses.
WHO = (
    '<span style="width: 20px; height: 20px; flex: none; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; color: var(--tx2);">'
    '<sc-if value="{{r.isAtlas}}" hint-placeholder-val="{{true}}">' + diamond(7, 12) + '</sc-if>'
    '<sc-if value="{{r.isYou}}" hint-placeholder-val="{{false}}"><span style="font-size: 8px; font-weight: 600; letter-spacing: .02em;">MB</span></sc-if>'
    '<sc-if value="{{r.hasIcon}}" hint-placeholder-val="{{false}}"><svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="stroke-width: 1.8;"><path d="{{r.d}}"></path></svg></sc-if>'
    '</span>'
)

COLS = '72px 196px minmax(0, 1fr) 112px 128px'

BODY = r"""
          <div style="display: flex; align-items: baseline; gap: 12px; padding: 16px 22px 12px;">
            <span class="disp" style="font-size: 21px; font-weight: 600;">What happened</span>
            <span class="num" style="color: var(--tx3);">Today so far, Tue Oct 21</span>
            <span style="flex: 1;"></span>
            <span class="lab">Append-only · kept forever</span>
          </div>

          <div style="display: grid; grid-template-columns: repeat(4, 118px) minmax(0, 1fr); border-top: 1px dashed var(--dash); border-bottom: 1px dashed var(--dash); position: relative;">
            <span class="node" aria-hidden="true" style="left: 0; top: 0;"></span>
            <span class="node" aria-hidden="true" style="left: 100%; top: 0;"></span>
            <span class="node" aria-hidden="true" style="left: 0; top: 100%;"></span>
            <span class="node" aria-hidden="true" style="left: 100%; top: 100%;"></span>
            <sc-for list="{{stats}}" as="s" hint-placeholder-count="4">
              <div style="padding: 10px 0 10px 22px; display: flex; flex-direction: column; gap: 2px; border-right: 1px solid var(--sep);">
                <span class="lab" style="font-size: 9.5px;">{{s.l}}</span>
                <span class="disp num" style="font-size: 20px; font-weight: 600;">{{s.v}}</span>
              </div>
            </sc-for>
            <div style="padding: 9px 22px 8px 20px; display: flex; flex-direction: column; justify-content: center; gap: 3px; min-width: 0;">
              <div role="img" aria-label="Activity by hour, busiest at 7 PM" style="display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); height: 32px; align-items: end;">
                <sc-for list="{{hours}}" as="h" hint-placeholder-count="24"><span style="display: flex; flex-direction: column; align-items: center; gap: 2px;"><sc-for list="{{h.cells}}" as="q" hint-placeholder-count="5"><span style="width: 5px; height: 4px; background: {{q.c}};"></span></sc-for></span></sc-for>
              </div>
              <div class="mono" aria-hidden="true" style="display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); font-size: 9.5px; line-height: 12px; letter-spacing: .06em; color: var(--tx3); border-top: 1px solid var(--sep); padding-top: 3px;">
                <sc-for list="{{hours}}" as="h" hint-placeholder-count="24"><span style="text-align: center; color: {{h.tc}}; white-space: nowrap;">{{h.tick}}</span></sc-for>
              </div>
            </div>
          </div>

          <div style="display: grid; grid-template-columns: minmax(0, 1fr) 86px; gap: 14px; padding: 0 22px; height: 30px; align-items: center; border-bottom: 1px solid var(--sep);">
            <div class="lab" style="display: grid; grid-template-columns: COLS; gap: 14px; font-size: 9.5px;"><span>Time</span><span>Who</span><span>What happened</span><span>Area</span><span>Receipt</span></div>
            <span class="lab" style="font-size: 9.5px; text-align: right;">State</span>
          </div>

          <sc-for list="{{groups}}" as="g" hint-placeholder-count="2">
            <div style="display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 22px; border-top: {{g.bt}};">
              <span class="lab" style="color: var(--tx2);">{{g.label}}</span>
              <span class="lab" style="color: var(--sep2);">/</span>
              <span class="lab">{{g.count}}</span>
            </div>
            <sc-for list="{{g.rows}}" as="r" hint-placeholder-count="6">
              <div style="position: relative; border-top: 1px solid var(--sep); background: {{r.bg}};">
                <sc-if value="{{r.isOpen}}" hint-placeholder-val="{{false}}"><span aria-hidden="true" style="position: absolute; left: 0; top: -1px; bottom: 0; width: 2px; background: var(--tx2);"></span></sc-if>
                <div style="display: grid; grid-template-columns: minmax(0, 1fr) 86px; gap: 14px; align-items: center; padding: 0 22px;">
                  <button type="button" class="row" onClick="{{r.toggle}}" aria-expanded="{{r.isOpen}}" style="border: 0; background: transparent; text-align: left; padding: 0; margin: 0 -8px; padding: 0 8px; border-radius: 6px; height: 38px; display: grid; grid-template-columns: COLS; gap: 14px; align-items: center; min-width: 0;">
                    <span class="mono" style="font-size: 11.5px; color: var(--tx3);">{{r.t}}</span>
                    <span style="display: flex; align-items: center; gap: 8px; min-width: 0;">WHO<span style="font-size: 12.5px; color: var(--tx2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{r.who}}</span></span>
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"><span style="color: var(--tx);">{{r.what}}</span><span style="color: var(--tx3);">{{r.det}}</span></span>
                    <span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tx2); white-space: nowrap;"><span style="width: 7px; height: 7px; border-radius: 50%; flex: none; box-sizing: border-box; background: {{r.ac}}; border: {{r.abd}};"></span>{{r.area}}</span>
                    <span class="mono" style="font-size: 11px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{r.kind}}</span>
                  </button>
                  <span style="display: flex; justify-content: flex-end; align-items: center;">
                    <sc-if value="{{r.canUndo}}" hint-placeholder-val="{{false}}"><button type="button" class="it" style="height: 22px; padding: 0 8px; border-radius: 5px; border: 1px solid var(--sep2); background: var(--win); font-size: 12px; color: var(--tx2);">Undo</button></sc-if>
                    <sc-if value="{{r.inInbox}}" hint-placeholder-val="{{false}}"><span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2); white-space: nowrap;"><span style="width: 6px; height: 6px; background: var(--ac);"></span>In Inbox</span></sc-if>
                    <sc-if value="{{r.running}}" hint-placeholder-val="{{false}}"><span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2); white-space: nowrap;"><span class="mono spin" aria-hidden="true" style="color: var(--ac); width: 9px;"></span>Running</span></sc-if>
                    <sc-if value="{{r.done}}" hint-placeholder-val="{{false}}"><span class="mono" style="font-size: 11px; color: var(--tx3);">{{r.doneText}}</span></sc-if>
                  </span>
                </div>
                <sc-if value="{{r.isOpen}}" hint-placeholder-val="{{false}}">
                  <div class="rise" style="padding: 0 22px 14px 108px; display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; align-items: center; flex-wrap: wrap; row-gap: 6px; min-height: 28px;">
                      <span class="lab" style="margin-right: 8px;">Path</span>
                      <sc-for list="{{r.path}}" as="c" hint-placeholder-count="4">
                        <span aria-hidden="true" style="width: {{c.gap}}px; border-top: 1px dashed var(--dash);"></span>
                        <span class="tag" style="color: {{c.fg}}; border-color: {{c.bd}}; border-style: {{c.bs}};"><sc-if value="{{c.m}}" hint-placeholder-val="{{false}}"><span style="color: {{c.mc}};">{{c.m}}</span></sc-if>{{c.l}}</span>
                      </sc-for>
                      <span style="flex: 1;"></span>
                      <span style="display: inline-flex; gap: 6px;"><sc-for list="{{r.acts}}" as="a" hint-placeholder-count="2"><button type="button" class="btn" style="height: 26px; padding: 0 10px;">{{a.l}}</button></sc-for></span>
                    </div>
                    <div class="mono" style="display: grid; grid-template-columns: 104px minmax(0, 1fr); gap: 5px 14px; font-size: 12px; line-height: 18px; color: var(--tx2); padding: 10px 14px; border: 1px solid var(--sep); border-radius: 8px; background: var(--win);">
                      <sc-for list="{{r.kv}}" as="k" hint-placeholder-count="6"><span class="lab" style="font-size: 9.5px; line-height: 18px;">{{k.k}}</span><span style="color: {{k.c}};">{{k.v}}</span></sc-for>
                    </div>
                  </div>
                </sc-if>
              </div>
            </sc-for>
          </sc-for>
          <div aria-hidden="true" style="position: absolute; left: 0; right: 0; bottom: 0; height: 64px; background: linear-gradient(to bottom, transparent, var(--win)); pointer-events: none;"></div>
""".replace('WHO', WHO).replace('COLS', COLS)

JS = r"""
  renderVals() {
    var self = this;
    var tab = this.state.tab, open = this.state.open;
    var I = {
      face: 'M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM12 12a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM7.5 20a4.5 4.5 0 0 1 9 0',
      job: 'M4 4h6v6H4zM14 14h6v6h-6zM7 10v4a3 3 0 0 0 3 3h4',
      code: 'M5 17l5-5-5-5M12 19h7',
      auto: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z'
    };
    var A = { P: ['Personal', 'var(--P)'], K: ['Keyframes', 'var(--K)'], U: ['UCF', 'var(--U)'], F: ['Fitness', 'var(--F)'], X: ['Not sure yet', 'transparent'] };
    function src(l) { return { l: l, fg: 'var(--tx2)', bd: 'var(--sep2)', bs: 'solid', m: '', mc: '' }; }
    function ok(l) { return { l: l, fg: 'var(--tx2)', bd: 'var(--sep2)', bs: 'solid', m: '✓', mc: 'var(--F)' }; }
    function you(l) { return { l: l, fg: 'var(--ac)', bd: 'var(--ac)', bs: 'solid', m: '●', mc: 'var(--ac)' }; }
    function next(l) { return { l: l, fg: 'var(--tx3)', bd: 'var(--dash)', bs: 'dashed', m: '→', mc: 'var(--tx3)' }; }
    function kv(k, v, c) { return { k: k, v: v, c: c || 'var(--tx2)' }; }
    var ASK = 'You · chat · 7:01 PM · “Move my dentist to Thursday morning and let Mom know I’ll call her after.”';
    var today = [
      { id: 'dentist', t: '7:01 PM', who: 'Atlas', isAtlas: true, what: 'Moved Dentist cleaning to Thu 10:00 AM', det: ' · was Wed 3:00 PM', a: 'P', kind: 'calendar.update', grp: 'Actions', undo: true,
        path: [src('You · chat'), src('Atlas'), ok('calendar.write'), ok('iCloud')],
        kv: [kv('Asked by', ASK), kv('Changed', 'Wed Oct 22, 3:00 PM → Thu Oct 23, 10:00 AM · iCloud'), kv('Checked', '✓ No conflict with Calc II review at 12:00', 'var(--F)'), kv('Powers', 'calendar.write'), kv('Brain', 'Codex · 2.1k tokens · $0.00 on your subscription'), kv('Undo', 'Available · puts it back on Wed 3:00 PM')],
        acts: [{ l: 'Open event' }, { l: 'Ask about this' }], ref: 'run_7f3a91c2' },
      { id: 'remind', t: '7:01 PM', who: 'Atlas', isAtlas: true, what: 'Set a reminder to leave for the dentist', det: ' · Thu 9:40 AM', a: 'P', kind: 'reminder.create', grp: 'Actions', undo: true,
        path: [src('You · chat'), src('Atlas'), ok('reminders.write')],
        kv: [kv('Asked by', 'Same request as the dentist move'), kv('Set', 'Thu Oct 23, 9:40 AM · “Leave for the dentist”'), kv('Why 9:40', 'Thursday morning traffic from home, plus time to park'), kv('Powers', 'reminders.write'), kv('Undo', 'Available')],
        acts: [{ l: 'Open in Agenda' }], ref: 'run_7f3a91c2' },
      { id: 'mom', t: '7:01 PM', who: 'Atlas', isAtlas: true, what: 'Drafted a text to Mom', det: ' · waiting on you', a: 'P', kind: 'outbox.hold', grp: 'Actions', inbox: true,
        path: [src('You · chat'), src('Atlas'), ok('Secrets'), ok('Sharing'), you('Your OK')],
        kv: [kv('Asked by', 'Same request as the dentist move'), kv('Draft', '“Hey Mom, my dentist got moved to Thursday morning, so I’ll call you after…”'), kv('Held because', 'It speaks for you, so it always asks'), kv('Status', 'Waiting in Inbox', 'var(--ac)')],
        acts: [{ l: 'Open in Inbox' }], ref: 'run_7f3a91c2' },
      { id: 'chat', t: '7:01 PM', who: 'You · chat', isYou: true, what: '“Move my dentist to Thursday morning and let Mom know…”', det: '', a: 'P', kind: 'chat.turn', grp: 'Conversations', doneText: '3 TURNS',
        path: [src('You · Mac · chat'), src('Atlas')],
        kv: [kv('Said', '“Move my dentist to Thursday morning and let Mom know I’ll call her after.”'), kv('Atlas did', '2 changes, 1 draft for your OK'), kv('Area', 'Personal · picked by Atlas, not changed'), kv('Brain', 'Codex · 2.1k tokens · $0.00')],
        acts: [{ l: 'Open transcript' }], ref: 'conv_51c0de88' },
      { id: 'gearDone', t: '6:40 PM', who: 'Job · Gear rental quotes', icon: 'job', what: 'Got 3 of 4 quotes, Lensrentals is cheapest', det: ' · $302', a: 'K', kind: 'job.result', grp: 'Jobs', inbox: true,
        path: [src('Job'), ok('3 helpers done'), src('Atlas'), you('Book it?')],
        kv: [kv('Quotes', 'Lensrentals $268/day · BorrowLenses $295 · Pro Cam Orlando $310'), kv('Still going', 'Orlando Grip · reading their rate sheet PDF'), kv('Brain', 'Workers AI + Codex · $0.04'), kv('Next', 'Booking waits on you · money always asks', 'var(--ac)')],
        acts: [{ l: 'Open in Inbox' }, { l: 'Watch the job' }], ref: 'job_gear_0c19' },
      { id: 'gearStart', t: '5:48 PM', who: 'Job · Gear rental quotes', icon: 'job', what: 'Started 4 helpers to find an FX3 kit for Saturday', det: '', a: 'K', kind: 'job.start', grp: 'Jobs', running: true,
        path: [src('You · voice · car'), src('Atlas'), src('4 helpers'), ok('browser.read'), ok('email.send')],
        kv: [kv('Asked by', 'You · voice · 5:46 PM · “Find me the cheapest FX3 kit for Saturday.”'), kv('Helpers', 'Lensrentals · BorrowLenses · Pro Cam Orlando · Orlando Grip'), kv('Allowed', 'Read shop sites, email shops from hello@keyframes.studio'), kv('Not allowed', 'Booking or paying'), kv('Budget', '$0.25 cap · $0.04 used')],
        acts: [{ l: 'Watch the job' }, { l: 'Stop' }], ref: 'job_gear_0c19' },
      { id: 'pr', t: '4:30 PM', who: 'Claude Code via Atlas', icon: 'code', what: 'Opened PR #42 Site refresh', det: ' · tests and preview checked', a: 'K', kind: 'acp.pr', grp: 'Jobs', inbox: true,
        path: [src('You · Mon chat'), src('Atlas'), src('Claude Code'), ok('Tests'), ok('Preview'), you('Your review')],
        kv: [kv('Asked by', 'You · Mon 1:14 PM · “The Keyframes gallery is slow on phones, fix it.”'), kv('Harness', 'Claude Code over ACP · sandbox · keyframes-site'), kv('Changed', '+214 −63 across 9 files on atlas/site-refresh'), kv('Checked', '✓ 58 of 58 tests · ✓ preview deploy · ✓ phone layout', 'var(--F)'), kv('Powers', 'repo.write on its branch only · merging asks you')],
        acts: [{ l: 'Open in Inbox' }, { l: 'Open PR' }], ref: 'job_code_88e2' },
      { id: 'jordan', t: '2:15 PM', who: 'Atlas', isAtlas: true, what: 'Asked which Jordan your Tuesday 1:00 PM sync is with', det: '', a: 'X', kind: 'inbox.ask', grp: 'Conversations', inbox: true,
        path: [src('Calendar sync'), src('Atlas'), you('Your answer')],
        kv: [kv('Why', 'The invite has no email, and you know two Jordans'), kv('Best guess', 'Jordan Lee 52% · Jordan Park 48% · too close to pick'), kv('Then', 'File it in the right area and remember for next time'), kv('Status', 'Waiting in Inbox', 'var(--ac)')],
        acts: [{ l: 'Answer in Inbox' }], ref: 'run_2b6610fe' },
      { id: 'triage', t: '2:05 PM', who: 'Class email triage', icon: 'auto', what: 'Filed 3 UCF emails, added Calc II problem set 7', det: ' · due Wed', a: 'U', kind: 'automation.run', grp: 'Actions', undo: true,
        path: [src('Email from ucf.edu'), src('Class email triage'), ok('mail.label'), ok('agenda.write')],
        kv: [kv('Trigger', '3 emails from ucf.edu between 1:58 and 2:04 PM'), kv('Did', 'Filed 3 under UCF · added “Calc II PS7” due Wed at noon'), kv('Skipped', 'A ping · due more than 24 hours out'), kv('Brain', 'Workers AI · Clef · $0.002'), kv('Undo', 'Available · unfiles and removes the due date')],
        acts: [{ l: 'Open automation' }], ref: 'auto_triage_r214' },
      { id: 'priya', t: '11:22 AM', who: 'Keyframes front desk', icon: 'face', what: 'Told Priya Nair Nov 15 is open, passed pricing to you', det: '', a: 'K', kind: 'face.reply', grp: 'Faces', inbox: true,
        path: [src('Priya · email'), src('Keyframes front desk'), ok('Public rate card'), ok('Outbox'), you('Pricing to you')],
        kv: [kv('On behalf of', 'Keyframes · sees public Keyframes records only'), kv('Said', '“November 15 is open. Max will send you a custom quote today.”'), kv('Used', 'Rate card 2026 (public) · calendar free/busy, no details'), kv('Didn’t share', 'Custom pricing · anything outside Keyframes'), kv('Handed off', 'Custom package price → your Inbox', 'var(--ac)'), kv('Brain', 'Workers AI · $0.003')],
        acts: [{ l: 'Open thread' }, { l: 'Open in Inbox' }], ref: 'face_fd_reply_77' },
      { id: 'brief', t: '7:30 AM', who: 'Morning brief', icon: 'auto', what: 'Read the morning brief on the kitchen speaker', det: ' · 2 min', a: 'P', kind: 'automation.run', grp: 'Actions', doneText: 'DONE',
        path: [src('Weekdays 7:30 AM'), ok('You were home'), src('Morning brief'), ok('Kitchen speaker')],
        kv: [kv('Covered', '4 events · 2 deadlines · storms after 3 PM'), kv('Voice', 'ElevenLabs · eleven_v4_turbo'), kv('Brain', 'Codex + ElevenLabs · $0.03')],
        acts: [{ l: 'Play it again' }, { l: 'Open automation' }], ref: 'auto_brief_r088' }
    ];
    var yesterday = [
      { id: 'goodnight', t: '11:34 PM', who: 'Goodnight', icon: 'auto', what: 'Lights off, front door locked, alarm set for 7:10 AM', det: '', a: 'P', kind: 'automation.run', grp: 'Actions', doneText: 'DONE',
        path: [src('You · “Goodnight”'), src('Goodnight'), ok('home.write'), ok('alarm.set')],
        kv: [kv('Trigger', 'You said “Goodnight” to the bedroom speaker'), kv('Did', '6 lights off · front door locked · alarm 7:10 AM from your 9:00 class'), kv('Brain', 'Workers AI · $0.001')],
        acts: [{ l: 'Open automation' }], ref: 'auto_gn_r301' },
      { id: 'dan', t: '4:10 PM', who: 'Keyframes front desk', icon: 'face', what: 'Answered Dan Ortiz about a product shoot', det: ' · sent rate card', a: 'K', kind: 'face.reply', grp: 'Faces', doneText: 'SENT',
        path: [src('Dan · email'), src('Keyframes front desk'), ok('Public rate card'), ok('Outbox')],
        kv: [kv('Said', '“Here’s the rate card. Max has openings the week of Nov 3.”'), kv('Used', 'Rate card 2026 (public) · free/busy only')],
        acts: [{ l: 'Open thread' }], ref: 'face_fd_reply_76' },
      { id: 'site', t: '1:15 PM', who: 'Claude Code via Atlas', icon: 'code', what: 'Started Site refresh on keyframes-site', det: '', a: 'K', kind: 'job.start', grp: 'Jobs', doneText: 'DONE',
        path: [src('You · chat'), src('Atlas'), src('Claude Code')],
        kv: [kv('Brief', 'Gallery loads slowly on phones. Lazy-load images, keep the look.')],
        acts: [{ l: 'Watch the job' }], ref: 'job_code_88e2' },
      { id: 'run', t: '9:05 AM', who: 'Atlas', isAtlas: true, what: 'Logged your 4.1 mi run from Apple Health', det: '', a: 'F', kind: 'health.import', grp: 'Actions', undo: true,
        path: [src('Apple Health'), src('Atlas'), ok('records.write')],
        kv: [kv('Logged', '4.1 mi · 34:12 · 8:20/mi')],
        acts: [{ l: 'Open in Library' }], ref: 'run_0a91e4d3' }
    ];
    function prep(x) {
      var o = Object.assign({}, x);
      var ar = A[x.a];
      o.area = ar[0]; o.ac = ar[1]; o.abd = x.a === 'X' ? '1px dashed var(--tx3)' : '0';
      o.isAtlas = !!x.isAtlas; o.isYou = !!x.isYou; o.hasIcon = !!x.icon; o.d = x.icon ? I[x.icon] : '';
      o.canUndo = !!x.undo && x.id !== open; o.inInbox = !!x.inbox; o.running = !!x.running; o.done = !x.undo && !x.inbox && !x.running; o.doneText = x.doneText || '';
      o.isOpen = x.id === open; o.bg = o.isOpen ? 'var(--bg)' : 'transparent';
      o.path = (x.path || []).map(function (p, i) { var q = Object.assign({}, p); q.gap = i === 0 ? 0 : 16; return q; });
      o.kv = (x.kv || []).concat(x.ref ? [{ k: 'Run', v: x.ref, c: 'var(--tx3)' }] : []);
      o.toggle = function () { self.setState({ open: self.state.open === x.id ? '' : x.id }); };
      return o;
    }
    function pick(list) { return list.filter(function (x) { return tab === 'Everything' || x.grp === tab; }).map(prep); }
    var g1 = pick(today), g2 = pick(yesterday);
    var groups = [];
    if (g1.length) groups.push({ label: 'Today', count: g1.length + (g1.length === 1 ? ' entry' : ' entries'), rows: g1 });
    if (g2.length) groups.push({ label: 'Yesterday · Mon Oct 20', count: g2.length + (g2.length === 1 ? ' entry' : ' entries'), rows: g2 });
    groups.forEach(function (g, i) { g.bt = i === 0 ? '0' : '1px dashed var(--dash)'; });
    var per = [0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 3, 1, 0, 4, 1, 3, 2, 3, 5];
    var hours = [];
    for (var h = 0; h < 24; h++) {
      var past = h < per.length, n = past ? per[h] : 0, now = h === per.length - 1;
      var cells = [];
      for (var k = 0; k < 5; k++) { var on = past && k >= 5 - n; cells.push({ c: on ? (now ? 'var(--tx)' : 'var(--tx2)') : (past ? 'var(--sep2)' : 'var(--sep)') }); }
      hours.push({ cells: cells, tick: now ? 'NOW' : (h % 6 === 0 && h < 18 ? ['12a', '6a', '12p'][h / 6] : ''), tc: now ? 'var(--tx)' : 'var(--tx3)' });
    }
    return Object.assign(this.shellVals('History'), {
      tabs: this.mkTabs([['Everything'], ['Actions'], ['Conversations'], ['Faces'], ['Jobs']], tab, 'tab'),
      meta: 'Undo available on 6 today',
      stats: [{ l: 'Actions', v: '14' }, { l: 'Conversations', v: '3' }, { l: 'Jobs', v: '2' }, { l: 'Brains', v: '$0.41' }],
      hours: hours,
      groups: groups
    });
  }
"""

if __name__ == '__main__':
    out = page(title='Atlas · History', active='History', label='History', body=BODY, js=JS,
               placeholder='Ask what happened, or undo something', state="{ tab: 'Everything', open: 'dentist' }")
    open('../History.dc.html', 'w').write(out)
    print('wrote History')
