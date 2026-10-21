from shell import page

BODY = r"""
          <div style="position: absolute; left: 0; top: 0; bottom: 0; width: 208px; box-sizing: border-box; border-right: 1px solid var(--sep); padding: 8px 10px 14px;">
            <sc-for list="{{groups}}" as="g" hint-placeholder-count="6">
              <div class="lab" style="padding: 12px 8px 4px; font-size: 9.5px;">{{g.n}}</div>
              <sc-for list="{{g.items}}" as="s" hint-placeholder-count="2">
                <button type="button" class="it" onClick="{{s.pick}}" style="width: 100%; height: 28px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border: 0; border-radius: 6px; background: {{s.bg}}; color: {{s.fg}}; font-weight: {{s.fw}}; text-align: left; font-size: 12.5px;"><span style="flex: 1;">{{s.n}}</span><span class="mono" style="font-size: 10.5px; color: {{s.mc}};">{{s.meta}}</span></button>
              </sc-for>
            </sc-for>
          </div>

          <div style="position: absolute; left: 208px; right: 0; top: 0; bottom: 0; overflow: hidden; padding: 20px 28px 0; box-sizing: border-box;">
            <div style="display: flex; align-items: flex-start; gap: 16px; padding-bottom: 16px;">
              <div style="display: flex; flex-direction: column; gap: 3px;">
                <span class="disp" style="font-size: 21px; font-weight: 600;">{{secTitle}}</span>
                <span style="color: var(--tx2);">{{secSub}}</span>
              </div>
              <span style="flex: 1;"></span>
              <button type="button" class="btn">{{secBtn}}</button>
            </div>

            <sc-if value="{{isCharacter}}" hint-placeholder-val="{{true}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <div style="display: grid; grid-template-columns: 128px minmax(0, 1fr); align-items: center; gap: 16px; padding: 12px 0; border-top: 1px dashed var(--dash);">
                  <span class="lab">Name</span>
                  <div style="display: flex; align-items: center; gap: 14px;">
                    <span style="width: 200px; height: 30px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; padding: 0 10px; display: inline-flex; align-items: center; background: var(--bg); font-weight: 500;">Atlas<span class="blink" style="width: 1px; height: 15px; background: var(--ac); margin-left: 1px;"></span></span>
                    <span style="color: var(--tx3); font-size: 12.5px;">It answers to this name, out loud too.</span>
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 16px; padding: 14px 0; border-top: 1px dashed var(--dash);">
                  <span class="lab" style="padding-top: 2px;">Personality</span>
                  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 40px;">
                    <sc-for list="{{traits}}" as="t" hint-placeholder-count="4">
                      <div style="display: flex; flex-direction: column; gap: 7px;">
                        <div style="display: flex; align-items: baseline; gap: 8px;"><span style="font-weight: 500;">{{t.n}}</span><span style="flex: 1;"></span><span class="mono" style="font-size: 11px; color: var(--tx3);">{{t.v}}/5</span></div>
                        <div style="display: flex; align-items: center; gap: 10px;">
                          <span style="font-size: 12px; color: var(--tx3); width: 62px;">{{t.lo}}</span>
                          <div style="display: flex; gap: 3px; flex: 1;">
                            <sc-for list="{{t.cells}}" as="c" hint-placeholder-count="5"><button type="button" aria-label="{{c.label}}" onClick="{{c.pick}}" style="flex: 1; height: 8px; padding: 0; border: 1px solid {{c.bd}}; background: {{c.bg}}; border-radius: 1px;"></button></sc-for>
                          </div>
                          <span style="font-size: 12px; color: var(--tx3); width: 62px; text-align: right;">{{t.hi}}</span>
                        </div>
                      </div>
                    </sc-for>
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 16px; padding: 14px 0; border-top: 1px dashed var(--dash);">
                  <span class="lab" style="padding-top: 11px;">Sounds like</span>
                  <div style="border: 1px solid var(--sep); border-radius: 8px; background: var(--bg); padding: 10px 14px; display: grid; grid-template-columns: 50px minmax(0, 1fr); gap: 6px 12px; align-items: baseline;">
                    <span class="lab">You</span><span style="color: var(--tx2);">Did the Lensrentals quote come in?</span>
                    <span class="lab" style="color: var(--ac);">Atlas</span><span style="font-size: 14px; line-height: 1.5;">{{sample}}</span>
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 16px; padding: 14px 0; border-top: 1px dashed var(--dash);">
                  <span class="lab" style="padding-top: 5px;">Voice</span>
                  <div style="display: flex; flex-direction: column; gap: 10px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <span style="font-weight: 500;">ElevenLabs</span>
                      <span class="tag">eleven_v4_turbo</span>
                      <span class="tag" style="color: var(--F);"><span>✓</span>Connected</span>
                      <span style="flex: 1;"></span>
                      <span class="mono" style="font-size: 11px; color: var(--tx3); letter-spacing: .04em;">~280 MS TO FIRST WORD</span>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px;">
                      <sc-for list="{{voices}}" as="v" hint-placeholder-count="3">
                        <div onClick="{{v.pick}}" style="cursor: pointer; border: 1px solid {{v.bd}}; border-radius: 8px; background: {{v.bg}}; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;">
                          <div style="display: flex; align-items: center; gap: 8px;"><span style="font-weight: 600;">{{v.n}}</span><span style="font-size: 12px; color: var(--tx3); white-space: nowrap;">{{v.s}}</span><span style="flex: 1;"></span><sc-if value="{{v.on}}" hint-placeholder-val="{{false}}"><span class="tag" style="color: var(--ac); border-color: var(--ac);">In use</span></sc-if></div>
                          <div style="display: flex; align-items: center; gap: 10px;">
                            <button type="button" aria-label="Preview" class="it" style="width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--sep2); background: var(--win); display: inline-flex; align-items: center; justify-content: center; padding: 0; color: var(--tx2);"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" style="fill: currentColor;"></path></svg></button>
                            <span class="mono" style="font-size: 13px; letter-spacing: .06em; color: {{v.wc}}; flex: 1; white-space: nowrap; overflow: hidden;">{{v.w}}</span>
                            <span class="mono" style="font-size: 10.5px; color: var(--tx3);">0:04</span>
                          </div>
                        </div>
                      </sc-for>
                    </div>
                  </div>
                </div>

                <div style="display: grid; grid-template-columns: 128px minmax(0, 1fr); gap: 16px; padding: 14px 0; border-top: 1px dashed var(--dash);">
                  <span class="lab" style="padding-top: 4px; line-height: 1.6;">Talks like<br>a person</span>
                  <div style="display: flex; align-items: flex-start; gap: 28px; flex-wrap: wrap;">
                    <sc-for list="{{segs}}" as="g" hint-placeholder-count="3">
                      <div style="display: flex; flex-direction: column; gap: 6px;">
                        <span style="font-size: 12px; color: var(--tx2);">{{g.n}}</span>
                        <div style="display: inline-flex; border: 1px solid var(--sep2); border-radius: 6px; overflow: hidden;">
                          <sc-for list="{{g.opts}}" as="o" hint-placeholder-count="3"><button type="button" onClick="{{o.pick}}" style="height: 26px; padding: 0 11px; border: 0; border-left: 1px solid {{o.bl}}; background: {{o.bg}}; color: {{o.fg}}; font-size: 12px; font-weight: {{o.fw}};">{{o.l}}</button></sc-for>
                        </div>
                      </div>
                    </sc-for>
                  </div>
                </div>
              </div>
            </sc-if>

            <sc-if value="{{isBrains}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column; gap: 14px;">
                <div style="display: flex; align-items: stretch;">
                  <sc-for list="{{chain}}" as="b" hint-placeholder-count="3">
                    <sc-if value="{{b.join}}" hint-placeholder-val="{{false}}">
                      <div aria-hidden="true" style="flex: 0 0 40px; position: relative;">
                        <div style="position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed var(--dash);"></div>
                        <span class="node" style="left: 50%; top: 50%;"></span>
                      </div>
                    </sc-if>
                    <div style="flex: 1; min-width: 0; border: 1px {{b.bs}} {{b.bd}}; border-radius: 8px; background: var(--win); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; position: relative;">
                      <span class="lab" style="font-size: 9.5px;">{{b.step}}</span>
                      <div style="display: flex; align-items: center; gap: 8px;"><span class="disp" style="font-size: 18px; font-weight: 600;">{{b.n}}</span><span style="flex: 1;"></span><span class="tag" style="color: {{b.tc}}; border-color: {{b.tb}};"><span style="width: 5px; height: 5px; background: {{b.tc}};"></span>{{b.state}}</span></div>
                      <span style="font-size: 12.5px; color: var(--tx2);">{{b.sub}}</span>
                      <div class="mono" style="display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 5px 10px; font-size: 11.5px; color: var(--tx2); padding-top: 9px; border-top: 1px dashed var(--dash);">
                        <sc-for list="{{b.rows}}" as="r" hint-placeholder-count="2"><span class="lab" style="font-size: 9.5px; line-height: 17px;">{{r.k}}</span><span style="color: {{r.c}}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{r.v}}</span></sc-for>
                      </div>
                      <div style="display: flex; gap: 6px; padding-top: 2px;">
                        <sc-for list="{{b.btns}}" as="x" hint-placeholder-count="2"><button type="button" class="btn" style="height: 26px; padding: 0 10px; font-size: 12px;">{{x}}</button></sc-for>
                      </div>
                    </div>
                  </sc-for>
                </div>
                <div class="mono" style="font-size: 10.5px; letter-spacing: .06em; color: var(--tx3); display: flex; gap: 8px; align-items: center;"><span style="width: 6px; height: 6px; border: 1px solid var(--dash);"></span>ATLAS GOES BACK TO MAIN AS SOON AS IT RECOVERS · LAST SWITCH OCT 12, FOR 14 MIN</div>

                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding-top: 4px;">
                  <sc-for list="{{panels}}" as="p" hint-placeholder-count="2">
                    <div style="border: 1px solid var(--sep); border-radius: 8px; background: var(--bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;">
                      <div style="display: flex; align-items: baseline; gap: 8px;"><span style="font-weight: 600;">{{p.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{p.on}}</span><span style="flex: 1;"></span><button type="button" class="btn" style="height: 24px; padding: 0 9px; font-size: 12px;">Change</button></div>
                      <span style="font-size: 12.5px; color: var(--tx2); line-height: 1.45;">{{p.sub}}</span>
                      <div class="mono" style="display: grid; grid-template-columns: 90px minmax(0, 1fr) auto; gap: 0 12px; font-size: 11.5px; color: var(--tx2);">
                        <sc-for list="{{p.rows}}" as="r" hint-placeholder-count="3">
                          <span class="lab" style="font-size: 9.5px; line-height: 26px; border-top: 1px dashed var(--dash);">{{r.k}}</span>
                          <span style="line-height: 26px; border-top: 1px dashed var(--dash); color: var(--tx);">{{r.v}}</span>
                          <span style="line-height: 26px; border-top: 1px dashed var(--dash); color: var(--tx3); text-align: right;">{{r.u}}</span>
                        </sc-for>
                      </div>
                    </div>
                  </sc-for>
                </div>

                <div style="display: flex; align-items: center; gap: 22px; flex-wrap: wrap; padding: 11px 0 0; border-top: 1px dashed var(--dash);">
                  <span class="lab">This month</span>
                  <sc-for list="{{usage}}" as="u" hint-placeholder-count="4"><span style="display: inline-flex; align-items: baseline; gap: 7px; font-size: 12.5px;"><span style="color: var(--tx2);">{{u.n}}</span><span class="mono" style="font-size: 12px;">{{u.v}}</span></span></sc-for>
                  <span style="flex: 1;"></span>
                  <span class="mono" style="font-size: 12px; color: var(--tx2);">$24.52 <span style="color: var(--tx3);">+ plans</span></span>
                </div>
              </div>
            </sc-if>
          </div>
"""

JS = r"""
  renderVals() {
    var self = this;
    var st = this.state;
    var sec = st.sec || 'character';
    var built = { character: 1, brains: 1 };
    var G = [
      ['Atlas', [['character', 'Character & voice', ''], ['look', 'Look & themes', '']]],
      ['Brains', [['brains', 'Brains', '3'], ['usage', 'Usage & limits', '']]],
      ['Connected', [['connections', 'Connections', '9'], ['devices', 'Devices', '3'], ['vault', 'Vault', '14']]],
      ['People', [['members', 'Members', '2'], ['faces', 'Faces', '2']]],
      ['Abilities', [['skills', 'Skills & tools', '23'], ['permissions', 'Permissions', '']]],
      ['System', [['notifications', 'Notifications', ''], ['updates', 'Updates', '✓'], ['data', 'Data & export', '']]]
    ];
    var groups = G.map(function (g) {
      return { n: g[0], items: g[1].map(function (s) {
        var on = s[0] === sec;
        return { n: s[1], meta: s[2], mc: s[2] === '✓' ? 'var(--F)' : 'var(--tx3)', bg: on ? 'var(--sel)' : 'transparent', fg: on ? 'var(--tx)' : 'var(--tx2)', fw: on ? 500 : 400,
          pick: function () { if (built[s[0]]) self.setState({ sec: s[0] }); } };
      }) };
    });

    var T = [['warmth', 'Warmth', 'Reserved', 'Warm'], ['humor', 'Humor', 'Serious', 'Playful'], ['directness', 'Directness', 'Explains', 'Brief'], ['initiative', 'Initiative', 'Waits', 'Jumps in']];
    var val = {};
    T.forEach(function (t) { val[t[0]] = st[t[0]] || 3; });
    var traits = T.map(function (t) {
      var v = val[t[0]];
      var cells = [1, 2, 3, 4, 5].map(function (k) {
        var cur = k === v, fill = k < v;
        return { label: t[1] + ' ' + k, bd: cur ? 'var(--ac)' : (fill ? 'var(--m3)' : 'var(--sep2)'), bg: cur ? 'var(--ac)' : (fill ? 'var(--m3)' : 'transparent'),
          pick: function () { var s = {}; s[t[0]] = k; self.setState(s); } };
      });
      return { n: t[1], lo: t[2], hi: t[3], v: v, cells: cells };
    });
    var w = val.warmth, h = val.humor, d = val.directness, i = val.initiative;
    var sample = (w >= 4 ? 'Yep, good news. ' : (w === 3 ? 'Yes. ' : '')) +
      (d >= 4 ? 'Lensrentals: $268 a day, ships Friday.' : (d === 3 ? 'Lensrentals came in at $268 a day and can ship Friday.' : 'It did. Lensrentals came back at $268 a day, and they can ship it Friday, so it arrives before Saturday’s shoot.')) +
      (h >= 4 ? ' Cheapest of the four, so your wallet gets the day off.' : (h === 3 ? ' Cheapest of the four.' : '')) +
      (i >= 4 ? ' Say go and I’ll book it.' : (i === 3 ? ' Want me to book it?' : ''));

    var vsel = st.voice || 'Harlan';
    var voices = [['Harlan', 'Low, calm', '▁▂▄▃▅▄▂▃▄▂▁▂▃▂▁'], ['Wren', 'Bright, quick', '▂▅▃▇▄▆▂▅▃▆▄▂▅▃▂'], ['Inés', 'Warm, husky', '▁▃▅▄▃▅▆▄▂▃▂▁▃▄▂']].map(function (v) {
      var on = v[0] === vsel;
      return { n: v[0], s: v[1], w: v[2], on: on, bd: on ? 'var(--ac)' : 'var(--sep2)', bg: on ? 'var(--bg)' : 'var(--win)', wc: on ? 'var(--ac)' : 'var(--tx3)', pick: function () { self.setState({ voice: v[0] }); } };
    });

    function seg(key, name, opts, def) {
      var cur = st[key] || def;
      return { n: name, opts: opts.map(function (o, k) {
        var on = o === cur;
        return { l: o, bl: k === 0 ? 'transparent' : 'var(--sep2)', bg: on ? 'var(--sel)' : 'transparent', fg: on ? 'var(--tx)' : 'var(--tx3)', fw: on ? 500 : 400, pick: function () { var s = {}; s[key] = o; self.setState(s); } };
      }) };
    }
    var segs = [seg('speed', 'Speed', ['0.9×', '1.0×', '1.1×', '1.2×'], '1.0×'), seg('small', 'Small talk', ['Never', 'Sometimes', 'Often'], 'Sometimes'), seg('fillers', 'Fillers like “um”', ['Off', 'Light'], 'Off')];

    var chain = [
      { join: false, step: '01 · Main', n: 'ChatGPT', state: 'In use', tc: 'var(--ac)', tb: 'var(--ac)', bs: 'solid', bd: 'var(--tx3)', sub: 'Codex sign-in, so it runs on your ChatGPT plan.',
        rows: [{ k: 'Plan', v: 'ChatGPT Plus', c: 'var(--tx)' }, { k: 'Limit', v: '[■■■□□□□□] 31%', c: 'var(--tx2)' }, { k: 'Month', v: '1,284 turns', c: 'var(--tx2)' }], btns: ['Change', 'Sign out'] },
      { join: true, step: '02 · If it’s unavailable', n: 'Claude', state: 'Standby', tc: 'var(--tx3)', tb: 'var(--sep2)', bs: 'dashed', bd: 'var(--sep2)', sub: 'Anthropic API key, with a monthly cap.',
        rows: [{ k: 'Cap', v: '$100 a month', c: 'var(--tx)' }, { k: 'Used', v: '[■■□□□□□□] $23.40', c: 'var(--tx2)' }, { k: 'Month', v: '212 turns', c: 'var(--tx2)' }], btns: ['Set cap', 'Change'] },
      { join: true, step: '03 · Last resort', n: 'Workers AI', state: 'Standby', tc: 'var(--tx3)', tb: 'var(--sep2)', bs: 'dashed', bd: 'var(--sep2)', sub: 'Your Cloudflare account. Always there.',
        rows: [{ k: 'Model', v: 'Best open model', c: 'var(--tx)' }, { k: 'Feel', v: 'Fast, simpler', c: 'var(--tx2)' }, { k: 'Month', v: 'Unused · $0.00', c: 'var(--tx2)' }], btns: ['Change'] }
    ];
    var panels = [
      { n: 'Quick jobs', on: 'on Workers AI', sub: 'Sorting, pulling out facts and remembering run on small fast models, so the main brain stays free.',
        rows: [{ k: 'Decide', v: 'Clef', u: '18,402 calls' }, { k: 'Extract', v: 'Clairic', u: '9,733 calls' }, { k: 'Remember', v: 'Embeddings', u: '13,785 calls' }] },
      { n: 'Voice', on: 'on ElevenLabs', sub: 'Speech uses eleven_v4_turbo. Voice turns use the main brain on a faster setting.',
        rows: [{ k: 'Speaks', v: 'eleven_v4_turbo', u: '3h 12m · 38% of plan' }, { k: 'Thinks', v: 'ChatGPT · fast', u: '412 turns' }, { k: 'First word', v: '~280 ms', u: 'median this week' }] }
    ];
    var usage = [{ n: 'ChatGPT', v: 'in plan' }, { n: 'Claude', v: '$23.40' }, { n: 'Workers AI', v: '$1.12' }, { n: 'ElevenLabs', v: '38% of plan' }];

    var secs = {
      character: ['Character & voice', 'How Atlas sounds when it writes and when it talks.', 'Reset to default'],
      brains: ['Brains', 'Which models think for Atlas. If one is down or over its cap, the next takes over.', 'Add a brain']
    };
    var s = secs[sec];
    return Object.assign(this.shellVals('Settings'), {
      tabs: this.mkTabs([[s[0], '']], s[0], 'crumb'), meta: 'Atlas 0.1 · up to date',
      groups: groups, secTitle: s[0], secSub: s[1], secBtn: s[2],
      isCharacter: sec === 'character', isBrains: sec === 'brains',
      traits: traits, sample: sample, voices: voices, segs: segs,
      chain: chain, panels: panels, usage: usage
    });
  }
"""

if __name__ == '__main__':
    out = page(title='Atlas · Settings', active='Settings', label='Settings', body=BODY, js=JS,
               placeholder='Change anything by asking, like: talk a bit slower',
               state="{ sec: 'character', warmth: 4, humor: 3, directness: 4, initiative: 3 }")
    open('../Settings.dc.html', 'w').write(out)
    print('wrote Settings')
