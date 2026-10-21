from shell import page, diamond

CSS = r"""
.card{transition:border-color .12s,background .12s;cursor:pointer}
.card:hover{border-color:var(--dash);background:var(--hover)}
.lnk{border:0;background:transparent;padding:0;color:var(--tx2);font-size:12.5px;display:inline-flex;align-items:center;gap:6px}
.lnk:hover{color:var(--tx)}
"""

PLAY = '<svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><path d="M1 1l7 4-7 4z" style="fill: currentColor;"></path></svg>'

BODY = r"""
          <sc-if value="{{isGrid}}" hint-placeholder-val="{{true}}">
            <div style="padding: 18px 22px; display: flex; flex-direction: column; gap: 14px;">
              <sc-if value="{{showSuggest}}" hint-placeholder-val="{{true}}">
                <div class="rise" style="display: flex; align-items: center; gap: 14px; height: 56px; padding: 0 12px 0 16px; border: 1px solid var(--ac); border-radius: 8px; background: var(--acs); box-sizing: border-box;">
                  DIAMOND
                  <span class="tag" style="color: var(--ac); border-color: var(--ac);">Atlas suggests</span>
                  <span style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                    <span style="font-weight: 500;">You've asked for the shoot gear checklist 3 times. Make it an automation?</span>
                    <span style="font-size: 12px; color: var(--tx2);">Say &#8220;Gear check&#8221; and Atlas sends the list to your phone and ticks items off as you pack.</span>
                  </span>
                  <button type="button" class="btnp">Make it</button>
                  <button type="button" class="btn">No thanks</button>
                </div>
              </sc-if>
              <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
                <sc-for list="{{cards}}" as="c" hint-placeholder-count="8">
                  <div role="button" tabindex="0" class="card" onClick="{{c.open}}" style="height: 172px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 8px; background: var(--win); padding: 13px 15px 0; display: flex; flex-direction: column; overflow: hidden;">
                    <div style="display: flex; align-items: center; gap: 7px;">
                      <svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{c.g}}"></path></svg>
                      <span class="lab" style="font-size: 10px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{c.trig}}</span>
                      <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--tx3);"><span style="width: 6px; height: 6px; border-radius: 50%; background: {{c.ac}};"></span>{{c.area}}</span>
                    </div>
                    <span class="disp" style="font-size: 17px; font-weight: 600; margin-top: 10px; line-height: 1.25;">{{c.name}}</span>
                    <span style="color: var(--tx2); font-size: 12.5px; margin-top: 3px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">{{c.desc}}</span>
                    <span class="mono" style="font-size: 11px; color: var(--tx3); margin-top: auto; padding-bottom: 9px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.spec}}</span>
                    <div style="display: flex; align-items: center; gap: 10px; height: 42px; flex: none; border-top: 1px dashed var(--dash); margin: 0 -15px; padding: 0 12px 0 15px;">
                      <span style="display: inline-flex; gap: 2px;" aria-label="Last 12 runs"><sc-for list="{{c.sq}}" as="q" hint-placeholder-count="12"><span style="width: 6px; height: 6px; box-sizing: border-box; background: {{q.bg}}; border: 1px solid {{q.bd}};"></span></sc-for></span>
                      <span style="font-size: 12px; color: var(--tx3); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.last}}</span>
                      <sc-if value="{{c.isRequest}}" hint-placeholder-val="{{true}}">
                        <button type="button" class="btn" style="height: 26px; padding: 0 10px; gap: 7px;">PLAY Run</button>
                      </sc-if>
                      <sc-if value="{{c.isAuto}}" hint-placeholder-val="{{false}}">
                        <span role="switch" aria-checked="{{c.on}}" aria-label="On" style="width: 28px; height: 16px; box-sizing: border-box; border-radius: 4px; background: {{c.swBg}}; border: 1px solid {{c.swBd}}; position: relative; flex: none;"><span style="position: absolute; top: 2px; left: {{c.knob}}px; width: 10px; height: 10px; border-radius: 2px; background: {{c.knobBg}};"></span></span>
                      </sc-if>
                    </div>
                  </div>
                </sc-for>
                <div role="button" tabindex="0" class="card" style="height: 172px; box-sizing: border-box; border: 1px dashed var(--dash); border-radius: 8px; background: transparent; padding: 16px; display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 6px;">
                  <span style="width: 28px; height: 28px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; color: var(--tx2); margin-bottom: 4px;"><svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></span>
                  <span class="disp" style="font-size: 17px; font-weight: 600;">New automation</span>
                  <span style="font-size: 12.5px; color: var(--tx2);">Describe it, or show Atlas once.</span>
                </div>
              </div>
            </div>
          </sc-if>

          <sc-if value="{{isDetail}}" hint-placeholder-val="{{false}}">
            <div class="rise" style="padding: 16px 22px 18px; display: flex; flex-direction: column;">
              <div style="display: flex; align-items: center; gap: 8px; height: 30px;">
                <button type="button" class="lnk" onClick="{{back}}"><svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>All automations</button>
                <span style="flex: 1;"></span>
                <sc-if value="{{d.isRequest}}" hint-placeholder-val="{{true}}"><span class="mono" style="font-size: 11px; color: var(--tx3); margin-right: 6px;">or say &#8220;{{d.phrase}}&#8221;</span></sc-if>
                <button type="button" class="btnp">PLAY {{d.runL}}</button>
                <button type="button" class="btn">Edit<span class="kbd">E</span></button>
                <button type="button" class="btn">{{d.pauseL}}</button>
              </div>
              <div style="display: flex; align-items: center; gap: 12px; margin-top: 16px;">
                <span style="width: 32px; height: 32px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; color: var(--tx2);"><svg class="ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="{{d.g}}"></path></svg></span>
                <span class="disp" style="font-size: 26px; font-weight: 600; line-height: 1.1;">{{d.name}}</span>
                <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--tx2); margin-left: 6px;"><span style="width: 7px; height: 7px; border-radius: 50%; background: {{d.ac}};"></span>{{d.area}}</span>
                <span class="tag" style="margin-left: 4px; color: {{d.stC}}; border-color: {{d.stBd}};"><span style="width: 5px; height: 5px; background: {{d.stC}};"></span>{{d.state}}</span>
              </div>
              <span style="color: var(--tx2); margin-top: 6px; padding-left: 44px;">{{d.desc}}</span>

              <div style="display: flex; align-items: center; margin-top: 30px; min-height: 236px;">
                <div style="width: 226px; flex: none; box-sizing: border-box; border: 1px dashed var(--dash); border-radius: 8px; padding: 28px 12px 12px; position: relative;">
                  <span class="lab" style="position: absolute; left: 12px; top: 9px; font-size: 9.5px;">When</span>
                  <sc-for list="{{d.when}}" as="w" hint-placeholder-count="2">
                    <sc-if value="{{w.join}}" hint-placeholder-val="{{false}}"><div class="mono" style="font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--tx3); padding: 6px 0 6px 12px; margin-left: 12px; border-left: 1px dashed var(--dash);">{{w.join}}</div></sc-if>
                    <div style="border: 1px solid var(--sep2); border-radius: 6px; background: var(--win); padding: 8px 11px; display: flex; flex-direction: column; gap: 2px;">
                      <span class="lab" style="font-size: 9.5px;">{{w.k}}</span>
                      <span style="font-weight: 500;">{{w.v}}</span>
                    </div>
                  </sc-for>
                </div>
                <div aria-hidden="true" style="flex: 1; min-width: 40px; position: relative; border-top: 1px dashed var(--tx3);"><span class="node" style="left: 0; top: 0;"></span><span style="position: absolute; right: -1px; top: -4px; width: 0; height: 0; border-left: 6px solid var(--tx3); border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;"></span></div>
                <div style="width: 486px; flex: none; box-sizing: border-box; border: 1px dashed var(--dash); border-radius: 8px; padding: 28px 12px 12px; position: relative;">
                  <span class="lab" style="position: absolute; left: 12px; top: 9px; font-size: 9.5px;">Do · {{d.stepCount}}</span>
                  <sc-for list="{{d.steps}}" as="s" hint-placeholder-count="4">
                    <sc-if value="{{s.gap}}" hint-placeholder-val="{{false}}"><div aria-hidden="true" style="height: 10px; margin-left: 22px; border-left: 1px dashed var(--dash);"></div></sc-if>
                    <div style="display: flex; align-items: center; gap: 10px; height: 38px; box-sizing: border-box; border: 1px solid {{s.bd}}; border-radius: 6px; background: var(--win); padding: 0 10px;">
                      <span class="mono" style="font-size: 10.5px; color: var(--tx3); width: 18px;">{{s.n}}</span>
                      <span style="flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{s.t}}</span>
                      <sc-if value="{{s.ask}}" hint-placeholder-val="{{false}}"><span class="tag" style="height: 16px; font-size: 9px; color: var(--ac); border-color: var(--ac);">Asks first</span></sc-if>
                      <span class="mono" style="font-size: 10px; color: var(--tx3); letter-spacing: .08em; text-transform: uppercase;">{{s.p}}</span>
                    </div>
                  </sc-for>
                </div>
                <div aria-hidden="true" style="flex: 1; min-width: 40px; position: relative; border-top: 1px dashed var(--tx3);"><span class="node" style="left: 0; top: 0;"></span><span style="position: absolute; right: -1px; top: -4px; width: 0; height: 0; border-left: 6px solid var(--tx3); border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;"></span></div>
                <div style="width: 216px; flex: none; box-sizing: border-box; border: 1px dashed var(--dash); border-radius: 8px; padding: 28px 12px 12px; position: relative;">
                  <span class="lab" style="position: absolute; left: 12px; top: 9px; font-size: 9.5px;">Report</span>
                  <div style="border: 1px solid var(--sep2); border-radius: 6px; background: var(--win); padding: 8px 11px; display: flex; flex-direction: column; gap: 2px;">
                    <span class="lab" style="font-size: 9.5px;">{{d.repWhere}}</span>
                    <span style="font-weight: 500;">{{d.rep}}</span>
                  </div>
                </div>
              </div>

              <div style="display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 32px; margin-top: 30px; padding-top: 18px; border-top: 1px dashed var(--dash);">
                <div style="display: flex; flex-direction: column; gap: 10px;">
                  <span class="lab">Allowed</span>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap;">
                    <sc-for list="{{d.allowed}}" as="a" hint-placeholder-count="3"><span class="tag" style="height: 22px; font-size: 10px; color: {{a.fg}}; border-color: {{a.bd}};"><span style="color: {{a.mc}};">{{a.m}}</span>{{a.n}}</span></sc-for>
                  </div>
                  <span style="font-size: 12px; color: var(--tx3); line-height: 1.5;">{{d.allowNote}}</span>
                  <span class="lab" style="margin-top: 10px;">Made</span>
                  <span style="font-size: 12.5px; color: var(--tx2); line-height: 1.5;">{{d.made}}</span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span class="lab">Runs</span>
                    <span style="display: inline-flex; gap: 3px;"><sc-for list="{{d.sq}}" as="q" hint-placeholder-count="12"><span style="width: 9px; height: 9px; box-sizing: border-box; background: {{q.bg}}; border: 1px solid {{q.bd}};"></span></sc-for></span>
                    <span style="flex: 1;"></span>
                    <span class="lab">{{d.total}}</span>
                  </div>
                  <div class="mono" style="display: grid; grid-template-columns: minmax(0, 1.3fr) 64px minmax(0, 1.6fr) 60px; font-size: 11.5px;">
                    <sc-for list="{{d.recent}}" as="r" hint-placeholder-count="3">
                      <span style="padding: 7px 0; border-top: 1px solid var(--sep); color: var(--tx2); white-space: nowrap;">{{r.t}}</span>
                      <span style="padding: 7px 0; border-top: 1px solid var(--sep); color: var(--tx3);">{{r.dur}}</span>
                      <span style="padding: 7px 0; border-top: 1px solid var(--sep); color: {{r.c}}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{r.res}}</span>
                      <span style="padding: 7px 0; border-top: 1px solid var(--sep); color: var(--tx3); text-align: right;">{{r.cost}}</span>
                    </sc-for>
                  </div>
                </div>
              </div>
            </div>
          </sc-if>
""".replace('DIAMOND', diamond(9, 16)).replace('PLAY', PLAY)

JS = r"""
  renderVals() {
    var self = this;
    var tab = this.state.tab, view = this.state.view;
    var G = {
      request: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
      schedule: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
      email: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
      absence: 'M5 22h14M5 2h14M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2',
      watch: 'M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'
    };
    var AREA = { P: ['Personal', 'var(--P)'], K: ['Keyframes', 'var(--K)'], U: ['UCF', 'var(--U)'], F: ['Fitness', 'var(--F)'] };
    function st(t, p, ask) { return { t: t, p: p, ask: !!ask }; }
    function run(t, dur, res, cost, bad) { return { t: t, dur: dur, res: res, cost: cost, c: bad ? 'var(--ac)' : 'var(--tx2)' }; }
    var all = [
      { id: 'goodnight', made: 'Sep 14, from a chat: \u201cwhen I say goodnight, shut the house down.\u201d Edited Oct 2 to add the brief.', name: 'Goodnight', a: 'P', kind: 'request', g: 'request', phrase: 'Goodnight', trig: 'Say “Goodnight” · or 11:30 PM',
        desc: 'Lights off, door locked, alarm set, tomorrow’s brief on your phone.',
        when: [{ k: 'Say', v: '“Goodnight”, or tap Run' }, { k: 'Or at', v: '11:30 PM, if you’re home', join: 'or' }],
        steps: [st('Turn off the lights', 'Home'), st('Lock the front door', 'Home'), st('Set an alarm from tomorrow’s first event', 'Calendar'), st('Send tomorrow’s brief to your phone', 'Notify')],
        allowed: [['Home'], ['Calendar'], ['Notifications']], rep: 'Only if something fails', repWhere: 'Phone',
        runs: 'oooooooooooo', last: 'Last night, 11:42 PM', total: '31 runs',
        recent: [run('Mon 11:42 PM', '9s', '✓ Done', '$0.003'), run('Sun 12:08 AM', '11s', '✓ Done', '$0.003'), run('Sat 11:30 PM', '8s', '✓ Done, on schedule', '$0.002')] },
      { id: 'shoot', made: 'Sep 20, after you ran the same four steps by hand twice.', name: 'Shoot mode', a: 'K', kind: 'request', g: 'request', phrase: 'Shoot mode', trig: 'Say “Shoot mode”',
        desc: 'Quiets everything but Keyframes and gets the shoot ready.',
        when: [{ k: 'Say', v: '“Shoot mode”, or tap Run' }],
        steps: [st('Silence everything outside Keyframes', 'Notify'), st('Send the gear checklist to your phone', 'Library'), st('Check the weather at the location', 'Weather'), st('Share live location with Jordan Lee', 'Location', true)],
        allowed: [['Notifications'], ['Library'], ['Weather'], ['Location', 'ask']], rep: 'A summary when it’s done', repWhere: 'Phone',
        runs: '....ooooooso', last: 'Oct 11, 7:12 AM', total: '9 runs',
        recent: [run('Oct 11 7:12 AM', '6s', '✓ Done', '$0.004'), run('Oct 4 6:55 AM', '7s', '✓ Done', '$0.004'), run('Sep 27 8:01 AM', '9s', '– Location skipped by you', '$0.003')] },
      { id: 'home', made: 'Aug 30, from a chat. The Sunday text to Mom came later.', name: 'Heading home', a: 'P', kind: 'request', g: 'request', phrase: 'Heading home', trig: 'Say “Heading home”',
        desc: 'Warms the house, queues your playlist, texts Mom on Sundays.',
        when: [{ k: 'Say', v: '“Heading home”, or tap Run' }],
        steps: [st('Set the thermostat to 72°', 'Home'), st('Queue the evening playlist', 'Music'), st('Text Mom your ETA, Sundays only', 'Messages')],
        allowed: [['Home'], ['Music'], ['Messages', 'earned']], rep: 'Quietly, in History', repWhere: 'History',
        runs: 'oooooooooooo', last: 'Yesterday, 5:48 PM', total: '46 runs',
        recent: [run('Mon 5:48 PM', '5s', '✓ Done', '$0.001'), run('Sun 6:20 PM', '6s', '✓ Done, texted Mom', '$0.002'), run('Fri 5:31 PM', '5s', '✓ Done', '$0.001')] },
      { id: 'brief', made: 'Aug 28, during setup.', name: 'Morning brief', a: 'P', kind: 'schedule', g: 'schedule', trig: 'Weekdays · 7:30 AM', on: true,
        desc: 'Your day, the weather, and what needs you, read aloud.',
        when: [{ k: 'Every', v: 'Weekday at 7:30 AM' }],
        steps: [st('Read today’s calendar', 'Calendar'), st('Check the weather', 'Weather'), st('Gather what needs you', 'Inbox'), st('Read it aloud on the kitchen speaker', 'Speakers')],
        allowed: [['Calendar'], ['Weather'], ['Inbox'], ['Speakers']], rep: 'Out loud, then on your phone', repWhere: 'Kitchen speaker',
        runs: 'oooooxoooooo', last: 'Today, 7:30 AM', total: '58 runs',
        recent: [run('Today 7:30 AM', '1m 52s', '✓ Done', '$0.011'), run('Mon 7:30 AM', '2m 04s', '✓ Done', '$0.012'), run('Fri 7:30 AM', '1m 47s', '✓ Done', '$0.010')] },
      { id: 'review', made: 'Sep 7, from a chat: \u201ccheck in with me every Sunday night.\u201d', name: 'Weekly review', a: 'P', kind: 'schedule', g: 'schedule', trig: 'Sundays · 7:00 PM', on: true,
        desc: 'Asks how the week went, updates your journal, sketches next week.',
        when: [{ k: 'Every', v: 'Sunday at 7:00 PM' }],
        steps: [st('Ask how the week went, by voice', 'Voice'), st('Update your journal', 'Memory'), st('Sketch next week on your calendar', 'Calendar', true)],
        allowed: [['Voice'], ['Memory'], ['Calendar', 'ask']], rep: 'A short voice chat with you', repWhere: 'Phone or Mac',
        runs: '......oooooso'.slice(1), last: 'Sunday, 7:00 PM', total: '6 runs',
        recent: [run('Sun 7:00 PM', '14m', '✓ Done, journal updated', '$0.09'), run('Oct 12 7:00 PM', '11m', '✓ Done', '$0.07'), run('Oct 5 7:00 PM', '–', '– Skipped, you were away', '–')] },
      { id: 'triage', made: 'Aug 29, after Atlas noticed three missed due dates in UCF email.', name: 'Class email triage', a: 'U', kind: 'event', g: 'email', trig: 'When ucf.edu emails you', on: true,
        desc: 'Pulls due dates into Agenda. Pings only if due within 48 hours.',
        when: [{ k: 'Arrives', v: 'An email from ucf.edu' }],
        steps: [st('Pull due dates into Agenda', 'Calendar'), st('File the email under UCF', 'Email'), st('Ping you if due within 48 hours', 'Notify')],
        allowed: [['Email'], ['Calendar'], ['Notifications']], rep: 'A ping if due within 48 hours', repWhere: 'Phone',
        runs: 'oooooooooooo', last: '3 today · 2:05 PM', total: '112 runs',
        recent: [run('Today 2:05 PM', '4s', '✓ Filed, PS7 due Wed', '$0.001'), run('Today 11:40 AM', '3s', '✓ Filed', '$0.001'), run('Today 9:12 AM', '3s', '✓ Filed', '$0.001')] },
      { id: 'gym', made: 'Sep 12, from Fitness goals: 4 gym days a week.', name: 'Gym nudge', a: 'F', kind: 'event', g: 'absence', trig: 'No gym in 4 days', on: true,
        desc: 'After 4 days away, suggests a free slot at 5 PM.',
        when: [{ k: 'If', v: 'No gym visit in 4 days' }, { k: 'Then at', v: '5:00 PM that day', join: 'and' }],
        steps: [st('Find a free slot after 5 PM', 'Calendar'), st('Nudge you with the slot', 'Notify')],
        allowed: [['Calendar'], ['Notifications']], rep: 'A nudge you can snooze', repWhere: 'Phone',
        runs: '........oooo', last: 'Oct 9, 5:00 PM', total: '4 runs',
        recent: [run('Oct 9 5:00 PM', '3s', '✓ Nudged, you went', '$0.001'), run('Sep 30 5:00 PM', '3s', '✓ Nudged', '$0.001'), run('Sep 21 5:00 PM', '2s', '✓ Nudged, you went', '$0.001')] },
      { id: 'fx3', made: 'Today, 1:10 PM, from the Gear rental quotes job.', name: 'FX3 price watch', a: 'K', kind: 'watch', g: 'watch', trig: 'Watching · until Oct 24', on: true,
        desc: 'Tells you if the FX3 kit drops below $250 a day.',
        when: [{ k: 'Watching', v: 'Lensrentals · Sony FX3 kit' }, { k: 'Every', v: '6 hours, until Oct 24', join: 'checks' }],
        steps: [st('Open the listing in a browser', 'Browser'), st('Read the daily price', 'Browser'), st('Tell you if it’s under $250', 'Notify')],
        allowed: [['Browser'], ['Notifications']], rep: 'A ping the moment it drops', repWhere: 'Phone and Inbox',
        runs: '.....ooooooo', last: '$268 now · checked 7:00 PM', total: '7 checks',
        recent: [run('Today 7:00 PM', '12s', '$268, no change', '$0.004'), run('Today 1:00 PM', '11s', '$268, down from $275', '$0.004'), run('Today 7:00 AM', '12s', '$275, no change', '$0.004')] }
    ];
    function squares(s) {
      return s.split('').map(function (ch) {
        if (ch === 'o') return { bg: 'var(--tx3)', bd: 'var(--tx3)' };
        if (ch === 'x') return { bg: 'var(--ac)', bd: 'var(--ac)' };
        if (ch === 's') return { bg: 'transparent', bd: 'var(--tx3)' };
        return { bg: 'transparent', bd: 'var(--sep2)' };
      });
    }
    var KINDS = { 'On request': 'request', 'Scheduled': 'schedule', 'Events': 'event', 'Watches': 'watch' };
    var counts = {};
    all.forEach(function (x) { counts[x.kind] = (counts[x.kind] || 0) + 1; });
    var shown = all.filter(function (x) { return tab === 'All' || KINDS[tab] === x.kind; });
    var cards = shown.map(function (x) {
      var on = x.on !== false;
      var asks = x.steps.filter(function (s) { return s.ask; }).length;
      return {
        name: x.name, desc: x.desc, trig: x.trig, g: G[x.g], area: AREA[x.a][0], ac: AREA[x.a][1],
        spec: x.steps.length + ' steps · ' + x.allowed.length + ' powers' + (asks ? ' · ' + asks + ' asks first' : ''),
        sq: squares(x.runs), last: x.last,
        isRequest: x.kind === 'request', isAuto: x.kind !== 'request', on: on,
        swBg: on ? 'var(--btn)' : 'transparent', swBd: on ? 'var(--btn)' : 'var(--sep2)', knob: on ? 14 : 2, knobBg: on ? 'var(--btntx)' : 'var(--tx3)',
        open: function () { self.setState({ view: x.id }); }
      };
    });
    var cur = all.filter(function (x) { return x.id === view; })[0];
    var d = {};
    if (cur) {
      var asksN = cur.steps.filter(function (s) { return s.ask; }).length;
      var earned = cur.allowed.some(function (a) { return a[1] === 'earned'; });
      d = {
        name: cur.name, desc: cur.desc, g: G[cur.g], area: AREA[cur.a][0], ac: AREA[cur.a][1],
        isRequest: cur.kind === 'request', phrase: cur.phrase || '',
        state: cur.kind === 'request' ? 'Ready' : (cur.kind === 'watch' ? 'Watching' : 'On'),
        stC: 'var(--F)', stBd: 'var(--sep2)', pauseL: 'Pause', runL: cur.kind === 'watch' ? 'Check now' : 'Run now',
        when: cur.when.map(function (w) { return { k: w.k, v: w.v, join: w.join || '' }; }),
        stepCount: cur.steps.length + ' steps, in order',
        steps: cur.steps.map(function (s, i) { return { n: (i < 9 ? '0' : '') + (i + 1), t: s.t, p: s.p, ask: s.ask, gap: i > 0, bd: s.ask ? 'var(--ac)' : 'var(--sep2)' }; }),
        rep: cur.rep, repWhere: cur.repWhere,
        allowed: cur.allowed.map(function (a) {
          if (a[1] === 'ask') return { n: a[0] + ' · asks first', m: '●', mc: 'var(--ac)', fg: 'var(--ac)', bd: 'var(--ac)' };
          if (a[1] === 'earned') return { n: a[0] + ' · earned trust', m: '✓', mc: 'var(--F)', fg: 'var(--tx2)', bd: 'var(--sep2)' };
          return { n: a[0], m: '✓', mc: 'var(--F)', fg: 'var(--tx2)', bd: 'var(--sep2)' };
        }),
        allowNote: asksN ? 'Atlas runs the rest on its own and stops to ask before the marked step.' : (earned ? 'You OK’d the Sunday text 5 times, so Atlas sends it without asking now.' : 'Nothing here asks first. Atlas can only use these powers while it runs.'),
        made: cur.made, sq: squares(cur.runs), total: cur.total + ' · last 12', recent: cur.recent
      };
    }
    return Object.assign(this.shellVals('Automations'), {
      tabs: this.mkTabs([['All', String(all.length)], ['On request', String(counts.request)], ['Scheduled', String(counts.schedule)], ['Events', String(counts.event)], ['Watches', String(counts.watch)]], tab, 'tab').map(function (t) { t.pick = function () { self.setState({ tab: t.name, view: '' }); }; return t; }),
      meta: cur ? 'Automation · ' + cur.total : '4 runs today · 0 failed',
      isGrid: !cur, isDetail: !!cur, showSuggest: tab === 'All' || tab === 'On request',
      cards: cards, d: d,
      back: function () { self.setState({ view: '' }); }
    });
  }
"""

if __name__ == '__main__':
    out = page(title='Atlas · Automations', active='Automations', label='Automations', body=BODY, js=JS,
               placeholder='Describe an automation, or say run Goodnight', extra_css=CSS,
               state="{ tab: 'All', view: '' }")
    open('../Automations.dc.html', 'w').write(out)
    print('wrote Automations')
