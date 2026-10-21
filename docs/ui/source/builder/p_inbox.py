from shell import page

ICON = '<svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style="color: {{i.ic}};"><path d="{{i.d}}"></path></svg>'

BODY = r"""
          <div style="display: flex; align-items: baseline; gap: 12px; padding: 16px 22px 12px;">
            <span class="disp" style="font-size: 21px; font-weight: 600;">Waiting on you</span>
            <span class="num" style="color: var(--tx3);">{{countText}}</span>
            <span style="flex: 1;"></span>
            <span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;"><span class="kbd">J</span> <span class="kbd">K</span> move &#160; <span class="kbd">⏎</span> approve &#160; <span class="kbd">E</span> edit &#160; <span class="kbd">N</span> not now</span>
          </div>
          <sc-for list="{{items}}" as="i" hint-placeholder-count="5">
            <sc-if value="{{i.closed}}" hint-placeholder-val="{{true}}">
              <button type="button" class="row" onClick="{{i.open}}" style="width: 100%; border: 0; border-top: 1px solid var(--sep); background: transparent; text-align: left; display: grid; grid-template-columns: 30px minmax(0, 1fr) 120px 170px 64px 84px; align-items: center; gap: 14px; padding: 0 22px; height: 54px;">
                <span style="width: 28px; height: 28px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; display: inline-flex; align-items: center; justify-content: center;">ICON</span>
                <span style="display: flex; flex-direction: column; min-width: 0;">
                  <span style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{i.title}}</span>
                  <span style="font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{i.sub}}</span>
                </span>
                <span style="display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--tx2);"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{i.ac}}; border: {{i.abd}}; box-sizing: border-box;"></span>{{i.area}}</span>
                <span style="font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{i.src}}</span>
                <span class="mono" style="font-size: 11px; color: var(--tx3);">{{i.t}}</span>
                <span class="tag" style="justify-self: end; color: {{i.kc}};"><span style="width: 5px; height: 5px; background: {{i.kc}};"></span>{{i.kshort}}</span>
              </button>
            </sc-if>
            <sc-if value="{{i.isOpen}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="position: relative; border-top: 1px solid var(--sep); background: var(--bg); padding: 16px 22px 18px; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 0 14px;">
                <span aria-hidden="true" style="position: absolute; left: 0; top: -1px; bottom: 0; width: 2px; background: var(--ac);"></span>
                <span style="width: 28px; height: 28px; box-sizing: border-box; border: 1px solid var(--ac); border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--ac);">ICON</span>
                <div style="display: flex; flex-direction: column; gap: 10px; min-width: 0;">
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 28px;">
                    <span class="tag" style="color: {{i.kc}}; border-color: {{i.kc}};"><span style="width: 5px; height: 5px; background: {{i.kc}};"></span>{{i.kind}}</span>
                    <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2); margin-left: 4px;"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{i.ac}}; border: {{i.abd}}; box-sizing: border-box;"></span>{{i.area}}</span>
                    <span style="font-size: 12px; color: var(--tx3);">· {{i.src}} · {{i.t}}</span>
                  </div>
                  <span class="disp" style="font-size: 20px; font-weight: 600; line-height: 1.2;">{{i.title}}</span>
                  <span style="color: var(--tx2); max-width: 760px;">{{i.why}}</span>

                  <sc-if value="{{i.isSpeaks}}" hint-placeholder-val="{{true}}">
                    <div style="border: 1px solid var(--sep); border-radius: 8px; background: var(--win); max-width: 820px;">
                      <div class="mono" style="display: flex; gap: 18px; flex-wrap: wrap; padding: 8px 14px; border-bottom: 1px dashed var(--dash); font-size: 11.5px; color: var(--tx2);">
                        <sc-for list="{{i.hdr}}" as="h" hint-placeholder-count="3"><span><span style="color: var(--tx3);">{{h.k}}</span> {{h.v}}</span></sc-for>
                      </div>
                      <p style="margin: 0; padding: 12px 14px 14px; font-size: 14.5px; line-height: 1.55;">{{i.body}}</p>
                    </div>
                  </sc-if>

                  <sc-if value="{{i.isSpend}}" hint-placeholder-val="{{false}}">
                    <div class="mono" style="border: 1px solid var(--sep); border-radius: 8px; background: var(--win); max-width: 820px; font-size: 12px;">
                      <sc-for list="{{i.lines}}" as="l" hint-placeholder-count="3">
                        <div style="display: flex; padding: 8px 14px; border-bottom: 1px dashed var(--dash); color: {{l.c}}; font-weight: {{l.fw}};"><span style="flex: 1;">{{l.k}}</span><span>{{l.v}}</span></div>
                      </sc-for>
                      <div style="display: flex; align-items: center; gap: 10px; padding: 9px 14px; color: var(--tx2);"><svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>Vault · Visa ending 4417 · filled in at checkout, Atlas never sees the number</div>
                    </div>
                  </sc-if>

                  <sc-if value="{{i.isQuestion}}" hint-placeholder-val="{{false}}">
                    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
                      <sc-for list="{{i.choices}}" as="c" hint-placeholder-count="3">
                        <button type="button" class="btn" style="height: 56px; padding: 0 14px 0 10px; gap: 10px; border-radius: 8px; text-align: left;">
                          <span style="width: 28px; height: 28px; border-radius: 50%; background: var(--sel); color: var(--tx2); font-size: 10.5px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center;">{{c.i}}</span>
                          <span style="display: flex; flex-direction: column;"><span style="font-weight: 500;">{{c.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{c.s}}</span></span>
                          <span class="kbd" style="margin-left: 6px;">{{c.k}}</span>
                        </button>
                      </sc-for>
                    </div>
                  </sc-if>

                  <sc-if value="{{i.isReview}}" hint-placeholder-val="{{false}}">
                    <div class="mono" style="display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 7px 14px; font-size: 12px; color: var(--tx2); max-width: 820px; padding: 12px 14px; border: 1px solid var(--sep); border-radius: 8px; background: var(--win);">
                      <sc-for list="{{i.stats}}" as="s" hint-placeholder-count="4"><span class="lab" style="line-height: 18px;">{{s.k}}</span><span style="color: {{s.c}};">{{s.v}}</span></sc-for>
                    </div>
                  </sc-if>

                  <div style="display: flex; align-items: center; gap: 0; flex-wrap: wrap; padding: 2px 0;">
                    <span class="lab" style="margin-right: 8px;">{{i.chainLabel}}</span>
                    <sc-for list="{{i.chain}}" as="c" hint-placeholder-count="4">
                      <span aria-hidden="true" style="width: 16px; border-top: 1px dashed var(--dash);"></span>
                      <span class="tag" style="color: {{c.fg}}; border-color: {{c.bd}}; border-style: {{c.bs}};"><span style="color: {{c.mc}};">{{c.m}}</span>{{c.l}}</span>
                    </sc-for>
                  </div>

                  <div style="display: flex; align-items: center; gap: 8px; padding-top: 4px;">
                    <sc-if value="{{i.hold}}" hint-placeholder-val="{{false}}">
                      <button type="button" class="btnp" style="position: relative; overflow: hidden;"><span aria-hidden="true" style="position: absolute; left: 0; bottom: 0; height: 3px; width: 38%; background: var(--ac);"></span><span style="position: relative;">{{i.primary}}</span><span class="mono" style="position: relative; opacity: .6; font-size: 11px;">HOLD</span></button>
                    </sc-if>
                    <sc-if value="{{i.press}}" hint-placeholder-val="{{true}}">
                      <button type="button" class="btnp">{{i.primary}}<span class="mono" style="opacity: .6; font-size: 11px;">⏎</span></button>
                    </sc-if>
                    <sc-for list="{{i.more}}" as="m" hint-placeholder-count="2"><button type="button" class="btn">{{m.l}}<span class="kbd">{{m.k}}</span></button></sc-for>
                    <span style="flex: 1;"></span>
                    <span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;">{{i.foot}}</span>
                  </div>
                </div>
              </div>
            </sc-if>
          </sc-for>
          <div style="border-top: 1px solid var(--sep);"></div>
""".replace('ICON', ICON)

JS = r"""
  renderVals() {
    var self = this;
    var tab = this.state.tab, open = this.state.open;
    var D = {
      speaks: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
      spend: 'M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2zM2 10h20M6 15h4',
      question: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
      review: 'M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 9v12M13 6h3a2 2 0 0 1 2 2v7'
    };
    function ok(l) { return { m: '✓', l: l, fg: 'var(--tx2)', bd: 'var(--sep2)', bs: 'solid', mc: 'var(--F)' }; }
    function you(l) { return { m: '●', l: l, fg: 'var(--ac)', bd: 'var(--ac)', bs: 'solid', mc: 'var(--ac)' }; }
    function next(l) { return { m: '→', l: l, fg: 'var(--tx3)', bd: 'var(--dash)', bs: 'dashed', mc: 'var(--tx3)' }; }
    var all = [
      { id: 'priya', k: 'speaks', grp: 'Approvals', kind: 'Speaks for you', kshort: 'Reply', title: 'Reply to Priya Nair about a wedding film', sub: 'The front desk passed this to you. She wants a custom package.', area: 'Keyframes', ac: 'var(--K)', src: 'Keyframes front desk', t: '11:22 AM',
        why: 'Priya asked the front desk for a price on a full-day wedding. It can only quote your public rate card, and she wants extras, so it told her you would reply today and handed it to you.',
        hdr: [{ k: 'TO', v: 'priya.nair@gmail.com' }, { k: 'FROM', v: 'hello@keyframes.studio' }, { k: 'RE', v: 'Wedding film, Nov 15' }],
        body: 'Hi Priya, thanks for reaching out. For a full day with a 4 to 6 minute highlight film and the full ceremony cut, I would quote $2,400. November 15 is still open. Want to hop on a quick call this week? Max',
        chainLabel: 'Outbox', chain: [ok('Secrets'), ok('Sharing'), ok('Facts · rate card 2026'), you('Your OK'), next('Send')],
        primary: 'Send', more: [{ l: 'Edit', k: 'E' }, { l: 'Not now', k: 'N' }], foot: 'ASKS EVERY TIME · 0 OF 5 TO EARN TRUST' },
      { id: 'jordan', k: 'question', grp: 'Questions', kind: 'Question', kshort: 'Answer', title: 'Which Jordan is "Jordan sync" with?', sub: 'Tuesday at 1:00 PM. You know two Jordans.', area: 'Not sure yet', ac: 'transparent', abd: '1px dashed var(--tx3)', src: 'Atlas', t: '2:15 PM',
        why: 'The invite has no email on it. Once you pick, Atlas files the event in the right area and remembers for next time.',
        choices: [{ i: 'JL', n: 'Jordan Lee', s: 'Keyframes editor · talked Oct 14', k: '1' }, { i: 'JP', n: 'Jordan Park', s: 'Calc II study group · texted yesterday', k: '2' }, { i: '+', n: 'Someone else', s: 'Add a new person', k: '3' }],
        chainLabel: 'Then', chain: [next('File in area'), next('Link to person'), next('Remember')],
        primary: '', more: [{ l: 'Skip', k: 'N' }], foot: 'ONLY ASKS WHEN IT CAN’T TELL' },
      { id: 'pr', k: 'review', grp: 'Reviews', kind: 'Ready for review', kshort: 'Review', title: 'Site refresh PR is ready', sub: 'keyframes-site #42 · +214 −63 · 58 of 58 tests passed', area: 'Keyframes', ac: 'var(--K)', src: 'Job · Claude Code', t: '4:30 PM',
        why: 'Claude Code did the work. Atlas ran the tests, opened the preview, and checked the new gallery on a phone-sized screen before handing it over.',
        stats: [{ k: 'Branch', v: 'atlas/site-refresh → main', c: 'var(--tx2)' }, { k: 'Changes', v: '+214 −63 across 9 files', c: 'var(--tx2)' }, { k: 'Tests', v: '✓ 58 of 58 passed', c: 'var(--F)' }, { k: 'Preview', v: '✓ keyframes-site-pr42.pages.dev', c: 'var(--F)' }],
        chainLabel: 'Checked', chain: [ok('Tests'), ok('Preview'), ok('Phone layout'), you('Your review'), next('Merge')],
        primary: 'Merge', more: [{ l: 'Open preview', k: 'P' }, { l: 'View diff', k: 'D' }], foot: 'MERGING ALWAYS ASKS' },
      { id: 'gear', k: 'spend', grp: 'Approvals', kind: 'Spends money', kshort: 'Pay', title: 'Book the Lensrentals FX3 kit for $302', sub: 'Cheapest of 4 quotes. Ships Friday for Saturday’s shoot.', area: 'Keyframes', ac: 'var(--K)', src: 'Job · Gear rental quotes', t: '6:40 PM',
        why: 'Four shops quoted. Lensrentals is the cheapest and arrives Friday. Pro Cam is $42 more but you could pick it up today.',
        lines: [{ k: 'Sony FX3 cinema kit · Sat Oct 25 · 1 day', v: '$268.00', c: 'var(--tx2)', fw: 400 }, { k: 'Damage waiver', v: '$34.00', c: 'var(--tx2)', fw: 400 }, { k: 'Total', v: '$302.00', c: 'var(--tx)', fw: 500 }],
        chainLabel: 'Checks', chain: [ok('Keyframes gear budget · $898 left'), ok('Card on file'), you('Hold to approve')],
        primary: 'Hold to book', hold: true, more: [{ l: 'Pick Pro Cam instead', k: '2' }, { l: 'Not now', k: 'N' }], foot: 'MONEY ALWAYS ASKS' },
      { id: 'mom', k: 'speaks', grp: 'Approvals', kind: 'Speaks for you', kshort: 'Text', title: 'Text Mom about Thursday', sub: '“Hey Mom, my dentist got moved to Thursday morning…”', area: 'Personal', ac: 'var(--P)', src: 'From your 7:01 PM chat', t: '7:01 PM',
        why: 'You asked Atlas to let her know you would call after the dentist. It sounds like you, so it waits for your OK.',
        hdr: [{ k: 'TO', v: 'Mom · iMessage' }, { k: 'FROM', v: 'Your Mac' }],
        body: 'Hey Mom, my dentist got moved to Thursday morning, so I’ll call you after, around 11:30. Love you',
        chainLabel: 'Outbox', chain: [ok('Secrets'), ok('Sharing'), you('Your OK'), next('Send')],
        primary: 'Send', more: [{ l: 'Edit', k: 'E' }, { l: 'Not now', k: 'N' }], foot: 'UNSEND WITHIN 2 MIN' }
    ];
    var counts = { Approvals: 0, Questions: 0, Reviews: 0 };
    all.forEach(function (x) { counts[x.grp]++; });
    var shown = all.filter(function (x) { return tab === 'All' || x.grp === tab; });
    var openId = shown.some(function (x) { return x.id === open; }) ? open : (shown[0] && shown[0].id);
    var items = shown.map(function (x) {
      var o = Object.assign({}, x);
      o.d = D[x.k]; o.isOpen = x.id === openId; o.closed = !o.isOpen;
      o.ic = 'var(--tx2)'; o.abd = x.abd || '0';
      o.kc = (x.k === 'speaks' || x.k === 'spend') ? 'var(--ac)' : (x.k === 'review' ? 'var(--F)' : 'var(--tx2)');
      o.isSpeaks = x.k === 'speaks'; o.isSpend = x.k === 'spend'; o.isQuestion = x.k === 'question'; o.isReview = x.k === 'review';
      o.hold = !!x.hold; o.press = !x.hold && !!x.primary;
      o.open = function () { self.setState({ open: x.id }); };
      return o;
    });
    return Object.assign(this.shellVals('Inbox'), {
      tabs: this.mkTabs([['All', '5'], ['Approvals', String(counts.Approvals)], ['Questions', String(counts.Questions)], ['Reviews', String(counts.Reviews)]], tab, 'tab'),
      meta: 'Oldest first · 11:22 AM',
      countText: shown.length + (shown.length === 1 ? ' item' : ' items'),
      items: items
    });
  }
"""

if __name__ == '__main__':
    out = page(title='Atlas · Inbox', active='Inbox', label='Inbox', body=BODY, js=JS,
               placeholder='Answer, approve, or change any of these', state="{ tab: 'All', open: 'priya' }")
    open('../Inbox.dc.html', 'w').write(out)
    print('wrote Inbox')
