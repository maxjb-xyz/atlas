"""Atlas settings for M7: five sections (Atlas, Brains, Notifications, Permissions, Account).

Each section is a state, so a screenshot can show one view:
  {"sec":"atlas","atab":"Character"}   also "Voice" and "Look"
  {"sec":"brains"}                     add "picker":true for the model picker
  {"sec":"notifications"} {"sec":"permissions"} {"sec":"account"}
"""
from shell import page

CSS = r"""
.sl{width:100%;height:32px;display:flex;align-items:center;gap:10px;padding:0 10px;border:0;border-radius:7px;text-align:left;font-size:13px}
.h2{font-size:13px;font-weight:600;color:var(--tx)}
.aside{font-size:12px;color:var(--tx3)}
.sub{font-size:12px;color:var(--tx3);line-height:1.4}
.card{border:1px solid var(--sep);border-radius:8px;background:var(--win)}
.cardb{border:1px solid var(--sep);border-radius:8px;background:var(--bg)}
.rule{border-top:1px dashed var(--dash)}
.tg{width:26px;height:15px;flex:none;border:0;padding:0;border-radius:8px;background:var(--sep2);position:relative;display:inline-block;transition:background .15s}
.tg::after{content:'';position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:var(--win);transition:transform .15s}
.tg.on{background:var(--btn)}
.tg.on::after{transform:translateX(11px);background:var(--btntx)}
.seg{display:inline-flex;border:1px solid var(--sep2);border-radius:6px;overflow:hidden;flex:none}
.seg button{height:26px;padding:0 11px;border:0;background:transparent;color:var(--tx3);font-size:12px;white-space:nowrap}
.seg button+button{border-left:1px solid var(--sep2)}
.seg button.on{background:var(--sel);color:var(--tx);font-weight:500}
.seg.sm button{height:24px;padding:0 9px;font-size:11.5px}
.seg.lock{opacity:.55}
.seg.lock button{cursor:default}
.pill{height:26px;padding:0 11px;border-radius:13px;border:1px solid transparent;background:transparent;color:var(--tx2);font-size:12.5px}
.pill.on{border-color:var(--sep2);background:var(--sel);color:var(--tx);font-weight:500}
.mtr{display:flex;gap:2px}
.mtr i{flex:1;height:6px;background:var(--sep2);border-radius:1px}
.mtr i.f{background:var(--m2)}
.mtr i.q{background:var(--m4)}
.mtr i.n{background:var(--ac)}
.chip{height:26px;padding:0 7px 0 10px;border:1px solid var(--sep2);border-radius:6px;background:var(--win);display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:500}
.ok{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--tx2)}
.ok::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--F)}
.idle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--tx3)}
.idle::before{content:'';width:6px;height:6px;border-radius:50%;border:1px solid var(--tx3);box-sizing:border-box}
.btn.s{height:26px;padding:0 10px;font-size:12px}
.btnp.s{height:26px;padding:0 11px;font-size:12px}
.tbtn{border:0;background:transparent;padding:0;color:var(--tx2);font-size:12px}
.tbtn:hover{color:var(--tx)}
.hold{position:relative;overflow:hidden}
.hold .fill{position:absolute;left:0;top:0;bottom:0;width:0;background:var(--sel);transition:width .25s}
.hold:active .fill{width:100%;transition:width 2.5s linear}
.hold span{position:relative}
.slot{cursor:pointer;transition:border-color .12s}
.slot:hover{border-color:var(--tx3)}
"""

LOCK = '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4"></path></svg>'
CHEV = '<svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="M6 9l6 6 6-6"></path></svg>'

BODY = r"""
          <div style="position: absolute; left: 0; top: 0; bottom: 0; width: 188px; box-sizing: border-box; border-right: 1px solid var(--sep); padding: 14px 10px; display: flex; flex-direction: column; gap: 2px;">
            <sc-for list="{{secs}}" as="s" hint-placeholder-count="5">
              <button type="button" class="sl it" onClick="{{s.pick}}" style="background: {{s.bg}}; color: {{s.fg}}; font-weight: {{s.fw}};">
                <svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style="color: {{s.ic}};"><path d="{{s.d}}"></path></svg>
                <span style="flex: 1;">{{s.n}}</span>
                <span class="mono" style="font-size: 10.5px; color: var(--tx3);">{{s.meta}}</span>
              </button>
            </sc-for>
            <span style="flex: 1;"></span>
            <div style="padding: 0 10px; font-size: 12px; color: var(--tx3); line-height: 1.45;">Anything here can also be done by asking.</div>
          </div>

          <div style="position: absolute; left: 188px; right: 0; top: 0; bottom: 0; overflow: hidden; padding: 22px 28px 0; box-sizing: border-box;">
            <div style="display: flex; align-items: flex-start; gap: 16px; padding-bottom: 18px;">
              <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0;">
                <span class="disp" style="font-size: 21px; font-weight: 600;">{{secTitle}}</span>
                <span style="color: var(--tx2);">{{secSub}}</span>
              </div>
              <span style="flex: 1;"></span>
              <sc-if value="{{isAtlas}}" hint-placeholder-val="{{true}}">
                <div role="tablist" style="display: flex; gap: 2px; padding-top: 2px;">
                  <sc-for list="{{apills}}" as="p" hint-placeholder-count="3"><button type="button" role="tab" class="{{p.cls}}" onClick="{{p.pick}}">{{p.n}}</button></sc-for>
                </div>
              </sc-if>
              <sc-if value="{{secBtn}}" hint-placeholder-val="{{false}}"><button type="button" class="btn">{{secBtn}}</button></sc-if>
            </div>

            <!-- ============ ATLAS · CHARACTER ============ -->
            <sc-if value="{{isCharacter}}" hint-placeholder-val="{{true}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); align-items: center; gap: 16px; padding: 13px 0;">
                  <span style="font-weight: 500;">Name</span>
                  <div style="display: flex; align-items: center; gap: 14px;">
                    <span style="width: 200px; height: 30px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; padding: 0 10px; display: inline-flex; align-items: center; background: var(--bg); font-weight: 500;">Atlas<span class="blink" style="width: 1px; height: 15px; background: var(--tx2); margin-left: 1px;"></span></span>
                    <span class="sub">It answers to this name, out loud too.</span>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0;">
                  <span style="font-weight: 500;">Personality</span>
                  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 40px;">
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

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0;">
                  <div style="display: flex; flex-direction: column; gap: 3px; padding-top: 10px;"><span style="font-weight: 500;">Sounds like</span><span class="sub">Changes as you move the scales.</span></div>
                  <div class="cardb" style="padding: 12px 16px; display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 7px 12px; align-items: baseline;">
                    <span class="aside">You</span><span style="color: var(--tx2);">Did the Lensrentals quote come in?</span>
                    <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500;">DIAMOND Atlas</span><span style="font-size: 14px; line-height: 1.5;">{{sample}}</span>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0;">
                  <div style="display: flex; flex-direction: column; gap: 3px; padding-top: 10px;"><span style="font-weight: 500;">Written character</span><span class="sub">Who Atlas is, in its own words.</span></div>
                  <div class="card" style="padding: 12px 16px; display: flex; gap: 18px; align-items: center;">
                    <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px;">
                      <span style="color: var(--tx2); line-height: 1.55;">Atlas is calm, quick and on your side. It says what it did and what it didn’t, owns its mistakes without fuss, and keeps its jokes dry and rare.</span>
                      <span class="aside">From the Atlas preset, with two lines of yours · edited Oct 3</span>
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 6px;"><button type="button" class="btn s">Edit the text</button><button type="button" class="btn s">Presets</button></div>
                  </div>
                </div>
              </div>
            </sc-if>

            <!-- ============ ATLAS · VOICE ============ -->
            <sc-if value="{{isVoice}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0;">
                  <span style="font-weight: 500; padding-top: 4px;">Speaks with</span>
                  <div style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                      <span style="font-weight: 500;">ElevenLabs</span><span class="mono" style="font-size: 11px; color: var(--tx3);">eleven_v4_turbo</span><span class="ok">Connected</span>
                      <span style="flex: 1;"></span>
                      <span class="aside">First word in <span class="mono" style="color: var(--tx2);">~280 ms</span></span>
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px;">
                      <sc-for list="{{voices}}" as="v" hint-placeholder-count="3">
                        <div onClick="{{v.pick}}" style="cursor: pointer; border: 1px solid {{v.bd}}; border-radius: 8px; background: {{v.bg}}; padding: 10px 12px; display: flex; flex-direction: column; gap: 7px;">
                          <div style="display: flex; align-items: center; gap: 8px;"><span style="font-weight: 600;">{{v.n}}</span><span style="font-size: 12px; color: var(--tx3); white-space: nowrap;">{{v.s}}</span><span style="flex: 1;"></span><sc-if value="{{v.on}}" hint-placeholder-val="{{false}}"><span style="color: var(--F); font-size: 12px;">✓</span></sc-if></div>
                          <div style="display: flex; align-items: center; gap: 10px;">
                            <button type="button" aria-label="Preview" class="it" style="width: 24px; height: 24px; flex: none; border-radius: 50%; border: 1px solid var(--sep2); background: var(--win); display: inline-flex; align-items: center; justify-content: center; padding: 0; color: var(--tx2);"><svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" style="fill: currentColor;"></path></svg></button>
                            <span class="mono" style="font-size: 13px; letter-spacing: .06em; color: {{v.wc}}; flex: 1; white-space: nowrap; overflow: hidden;">{{v.w}}</span>
                          </div>
                        </div>
                      </sc-for>
                      <div style="border: 1px dashed var(--sep2); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; justify-content: center; gap: 3px;"><span style="font-weight: 500;">More voices</span><span class="sub">Browse the library, or describe one.</span></div>
                    </div>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0;">
                  <span style="font-weight: 500; padding-top: 2px;">Talks like a person</span>
                  <div style="display: flex; align-items: flex-start; gap: 28px; flex-wrap: wrap;">
                    <sc-for list="{{segs}}" as="g" hint-placeholder-count="3">
                      <div style="display: flex; flex-direction: column; gap: 6px;">
                        <span style="font-size: 12px; color: var(--tx2);">{{g.n}}</span>
                        <div class="seg"><sc-for list="{{g.opts}}" as="o" hint-placeholder-count="3"><button type="button" class="{{o.cls}}" onClick="{{o.pick}}">{{o.l}}</button></sc-for></div>
                      </div>
                    </sc-for>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0; align-items: center;">
                  <span style="font-weight: 500;">Hears with</span>
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="font-weight: 500;">Deepgram Flux</span><span class="ok">Connected</span><span class="aside">Knows you’ve finished in <span class="mono" style="color: var(--tx2);">~160 ms</span></span>
                    <span style="flex: 1;"></span>
                    <span style="font-size: 12.5px; color: var(--tx2);">Stop when I talk over it</span><button type="button" class="{{bargeCls}}" onClick="{{toggleBarge}}" aria-label="Stop when I talk over it"></button>
                  </div>
                </div>
              </div>
            </sc-if>

            <!-- ============ ATLAS · LOOK ============ -->
            <sc-if value="{{isLook}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0;">
                  <span style="font-weight: 500;">Theme</span>
                  <div style="display: flex; flex-direction: column; gap: 12px;">
                    <div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px;">
                      <sc-for list="{{themes}}" as="t" hint-placeholder-count="5">
                        <div onClick="{{t.pick}}" style="cursor: pointer; display: flex; flex-direction: column; gap: 8px;">
                          <div style="height: 86px; border-radius: 8px; border: 1px solid {{t.ring}}; box-shadow: 0 0 0 {{t.rw}}px {{t.ring}}; background: {{t.bg}}; position: relative; overflow: hidden;">
                            <div style="position: absolute; left: 0; top: 0; bottom: 0; width: 28px; background: {{t.side}}; border-right: 1px solid {{t.sep}};"></div>
                            <div style="position: absolute; left: 6px; top: 8px; width: 7px; height: 7px; background: {{t.tx}}; transform: rotate(45deg) scale(.8);"></div>
                            <div style="position: absolute; left: 6px; top: 24px; width: 15px; height: 3px; border-radius: 1px; background: {{t.tx3}};"></div>
                            <div style="position: absolute; left: 6px; top: 31px; width: 12px; height: 3px; border-radius: 1px; background: {{t.tx3}};"></div>
                            <div style="position: absolute; left: 6px; top: 38px; width: 14px; height: 3px; border-radius: 1px; background: {{t.tx3}};"></div>
                            <div style="position: absolute; left: 38px; right: 10px; top: 10px; bottom: 10px; border-radius: 4px; background: {{t.win}}; border: 1px solid {{t.sep}};">
                              <div style="position: absolute; left: 8px; top: 6px; font-family: {{t.font}}; font-size: 15px; font-weight: 600; color: {{t.tx}}; letter-spacing: -.02em;">Aa</div>
                              <div style="position: absolute; left: 8px; top: 31px; width: 54%; height: 3px; border-radius: 1px; background: {{t.tx3}};"></div>
                              <div style="position: absolute; left: 8px; top: 38px; width: 38%; height: 3px; border-radius: 1px; background: {{t.tx3}};"></div>
                              <div style="position: absolute; right: 7px; top: 8px; width: 6px; height: 6px; border-radius: 1px; background: {{t.ac}};"></div>
                              <div style="position: absolute; right: 7px; bottom: 6px; width: 18px; height: 7px; border-radius: 2px; background: {{t.tx}};"></div>
                            </div>
                          </div>
                          <div style="display: flex; flex-direction: column; gap: 1px;"><span style="display: flex; align-items: center; gap: 6px; font-weight: 500; white-space: nowrap;">{{t.n}}<sc-if value="{{t.on}}" hint-placeholder-val="{{false}}"><span style="color: var(--F); font-size: 12px;">✓</span></sc-if></span><span class="aside">{{t.s}}</span></div>
                        </div>
                      </sc-for>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;"><button type="button" class="{{followCls}}" onClick="{{toggleFollow}}" aria-label="Follow the system"></button><span style="font-size: 12.5px;">Follow the system</span><span class="aside">Daylight by day, Graphite at night.</span></div>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0; align-items: center;">
                  <span style="font-weight: 500;">Accent</span>
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <sc-for list="{{accents}}" as="a" hint-placeholder-count="6"><button type="button" aria-label="{{a.n}}" onClick="{{a.pick}}" style="width: 22px; height: 22px; padding: 0; border-radius: 6px; border: 0; background: {{a.c}}; box-shadow: 0 0 0 2px var(--win), 0 0 0 {{a.rw}}px var(--tx2);"></button></sc-for>
                    <span class="aside" style="margin-left: 8px;">Ember marks what needs you. Pick it or one of these.</span>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0; align-items: center;">
                  <span style="font-weight: 500;">Density and motion</span>
                  <div style="display: flex; align-items: flex-start; gap: 28px;">
                    <sc-for list="{{lookSegs}}" as="g" hint-placeholder-count="2">
                      <div style="display: flex; flex-direction: column; gap: 6px;">
                        <span style="font-size: 12px; color: var(--tx2);">{{g.n}}</span>
                        <div class="seg"><sc-for list="{{g.opts}}" as="o" hint-placeholder-count="2"><button type="button" class="{{o.cls}}" onClick="{{o.pick}}">{{o.l}}</button></sc-for></div>
                      </div>
                    </sc-for>
                  </div>
                </div>

                <div class="rule" style="display: grid; grid-template-columns: 132px minmax(0, 1fr); gap: 16px; padding: 15px 0; align-items: center;">
                  <span style="font-weight: 500;">Your own</span>
                  <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="color: var(--tx2);">Describe a look and Atlas makes the theme, with a live preview.</span>
                    <span style="flex: 1;"></span>
                    <button type="button" class="btn s">Make a theme</button><button type="button" class="btn s">Open a theme file</button>
                  </div>
                </div>
              </div>
            </sc-if>

            <!-- ============ BRAINS, SIMPLE ============ -->
            <sc-if value="{{isBrainsSimple}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column; gap: 14px; padding-top: 4px;">
                <div style="border: 1px solid var(--sep); border-radius: 10px; background: var(--bg); padding: 18px 20px; display: flex; align-items: center; gap: 18px;">
                  <span class="logo" style="width: 56px; height: 56px; border-radius: 14px;"><img class="lg {{bs.main.inv}}" src="{{bs.main.lg}}" width="30" height="30" alt=""></span>
                  <span style="display: flex; flex-direction: column; gap: 4px; flex: 1;">
                    <span class="disp" style="font-size: 19px; font-weight: 600;">Atlas thinks with ChatGPT, on your Plus plan.</span>
                    <span style="color: var(--tx2);">If ChatGPT is busy, Claude takes over for that answer. Voice uses Workers AI, because it starts talking fastest.</span>
                  </span>
                  <button type="button" class="btn">Change</button>
                </div>
                <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
                  <sc-for list="{{bs.provs}}" as="p" hint-placeholder-count="3">
                    <div style="border: 1px solid var(--sep); border-radius: 10px; background: var(--win); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;">
                      <span style="display: flex; align-items: center; gap: 10px;"><span class="logo" style="width: 32px; height: 32px;"><img class="lg {{p.inv}}" src="{{p.lg}}" width="18" height="18" alt=""></span><span style="display: flex; flex-direction: column; flex: 1;"><span style="font-weight: 600;">{{p.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{p.how}}</span></span><span style="width: 7px; height: 7px; border-radius: 50%; background: var(--F);"></span></span>
                      <span style="font-size: 13.5px;">{{p.line}}</span>
                      <span style="height: 6px; border-radius: 3px; background: var(--sep); overflow: hidden; display: block;"><span style="display: block; height: 6px; width: {{p.pct}}%; border-radius: 3px; background: {{p.c}};"></span></span>
                      <span style="font-size: 12px; color: var(--tx3);">{{p.foot}}</span>
                    </div>
                  </sc-for>
                </div>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  <span style="font-weight: 600; padding-bottom: 4px;">For different kinds of work</span>
                  <sc-for list="{{bs.kinds}}" as="k" hint-placeholder-count="4">
                    <div class="row" style="display: grid; grid-template-columns: 220px minmax(0, 1fr) auto; align-items: center; gap: 16px; height: 46px; border-top: 1px solid var(--sep); padding: 0 6px; margin: 0 -6px; border-radius: 6px;">
                      <span style="display: flex; flex-direction: column;"><span style="font-weight: 500;">{{k.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{k.what}}</span></span>
                      <span style="display: flex; align-items: center; gap: 8px; color: var(--tx2);"><sc-for list="{{k.by}}" as="b" hint-placeholder-count="2"><span style="display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px 0 7px; border-radius: 13px; border: 1px solid var(--sep2); background: var(--win); color: var(--tx); font-size: 12.5px;"><img class="lg {{b.inv}}" src="{{b.lg}}" width="14" height="14" alt="">{{b.n}}</span><sc-if value="{{b.then}}" hint-placeholder-val="{{false}}"><span style="font-size: 12px; color: var(--tx3);">then</span></sc-if></sc-for></span>
                      <span style="font-size: 12px; color: var(--tx3);">{{k.week}}</span>
                    </div>
                  </sc-for>
                </div>
                <div style="display: flex; align-items: center; gap: 10px; padding-top: 2px;"><span style="font-size: 12.5px; color: var(--tx3);">Models, fallbacks and limits for each role are in the details.</span><button type="button" class="btn" style="height: 26px; font-size: 12px;">Show details</button></div>
              </div>
            </sc-if>

            <!-- ============ BRAINS ============ -->
            <sc-if value="{{isBrains}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <div class="rule" style="display: flex; align-items: baseline; gap: 10px; padding: 11px 0 9px;"><span class="h2">Roles</span><span class="aside">A fallback covers one turn, and Atlas tells you.</span></div>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                  <sc-for list="{{roles}}" as="r" hint-placeholder-count="2">
                    <div style="display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 16px; align-items: center;">
                      <div style="display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 600;">{{r.n}}</span><span class="aside">{{r.sub}}</span></div>
                      <div style="display: flex; align-items: stretch;">
                        <sc-for list="{{r.slots}}" as="b" hint-placeholder-count="3">
                          <sc-if value="{{b.join}}" hint-placeholder-val="{{false}}">
                            <div aria-hidden="true" style="flex: 0 0 28px; position: relative;"><div style="position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed var(--dash);"></div><span class="node" style="left: 50%; top: 50%;"></span></div>
                          </sc-if>
                          <div style="flex: 1 1 0; min-width: 0; position: relative;">
                            <sc-if value="{{b.real}}" hint-placeholder-val="{{true}}">
                              <div class="slot" onClick="{{b.pick}}" style="height: 44px; box-sizing: border-box; border: 1px solid {{b.bd}}; border-radius: 8px; background: var(--win); padding: 0 10px 0 12px; display: flex; align-items: center; gap: 10px;">
                                <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;"><span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{b.model}}</span><span class="aside">{{b.prov}}</span></div>
                                <span class="{{b.stc}}">{{b.state}}</span>
                                CHEV
                              </div>
                            </sc-if>
                            <sc-if value="{{b.ghost}}" hint-placeholder-val="{{false}}">
                              <div style="height: 44px; box-sizing: border-box; border: 1px dashed var(--sep2); border-radius: 8px; padding: 0 12px; display: flex; align-items: center; gap: 8px; color: var(--tx3); font-size: 12.5px;"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add a fallback</div>
                            </sc-if>
                            <sc-if value="{{b.open}}" hint-placeholder-val="{{false}}">
                              <div class="rise" role="dialog" aria-label="Choose a model" style="position: absolute; left: -1px; top: 52px; width: 460px; background: var(--win); border: 1px solid var(--sep2); border-radius: 10px; box-shadow: var(--sh); z-index: 30; overflow: hidden;">
                                <div style="display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px;">
                                  <span style="font-weight: 600;">Main, if ChatGPT is unavailable</span><span style="flex: 1;"></span><span class="kbd">esc</span>
                                </div>
                                <div style="display: flex; align-items: center; gap: 10px; padding: 0 14px 10px;">
                                  <div class="seg sm"><sc-for list="{{pickProv}}" as="o" hint-placeholder-count="3"><button type="button" class="{{o.cls}}" onClick="{{o.pick}}">{{o.l}}</button></sc-for></div>
                                  <span style="flex: 1;"></span><span class="aside">{{pickNote}}</span>
                                </div>
                                <div style="display: grid; grid-template-columns: minmax(0, 1fr) 104px 86px; gap: 0 14px; padding: 6px 14px; border-top: 1px solid var(--sep); font-size: 11.5px; color: var(--tx3);"><span>Model</span><span>Speed</span><span style="text-align: right;">{{pickCostHd}}</span></div>
                                <sc-for list="{{pickRows}}" as="m" hint-placeholder-count="4">
                                  <div class="row" onClick="{{m.pick}}" style="cursor: pointer; display: grid; grid-template-columns: minmax(0, 1fr) 104px 86px; gap: 0 14px; align-items: center; padding: 8px 14px; border-top: 1px solid var(--sep); background: {{m.bg}};">
                                    <div style="display: flex; flex-direction: column; gap: 1px; min-width: 0;"><span style="display: flex; align-items: center; gap: 7px; font-weight: 500;">{{m.n}}<sc-if value="{{m.on}}" hint-placeholder-val="{{false}}"><span style="color: var(--F); font-size: 12px;">✓</span></sc-if></span><span class="aside">{{m.s}}</span></div>
                                    <div style="display: flex; flex-direction: column; gap: 4px;"><div class="mtr"><sc-for list="{{m.sp}}" as="c" hint-placeholder-count="5"><i class="{{c.k}}"></i></sc-for></div><span class="mono" style="font-size: 10.5px; color: var(--tx3);">{{m.tps}}</span></div>
                                    <span class="mono" style="font-size: 11.5px; color: var(--tx2); text-align: right;">{{m.cost}}</span>
                                  </div>
                                </sc-for>
                                <div style="padding: 9px 14px 10px; border-top: 1px solid var(--sep); font-size: 12px; color: var(--tx3);">{{pickFoot}}</div>
                              </div>
                            </sc-if>
                          </div>
                        </sc-for>
                      </div>
                    </div>
                  </sc-for>
                </div>

                <div class="rule" style="display: flex; align-items: baseline; gap: 10px; padding: 11px 0 9px; margin-top: 14px;"><span class="h2">Named brains</span><span class="aside">Atlas sees only these names and lines when it hands work to a helper.</span><span style="flex: 1;"></span><button type="button" class="tbtn">New brain</button></div>
                <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
                  <sc-for list="{{named}}" as="nb" hint-placeholder-count="3">
                    <div class="card" style="padding: 11px 14px 12px; display: flex; flex-direction: column; gap: 10px;">
                      <div style="display: flex; flex-direction: column; gap: 2px;"><div style="display: flex; align-items: baseline; gap: 8px;"><span class="disp" style="font-size: 16px; font-weight: 600;">{{nb.n}}</span><span style="flex: 1;"></span><span class="mono" style="font-size: 10.5px; color: var(--tx3);">{{nb.stat}}</span></div><span style="font-size: 12.5px; color: var(--tx2);">{{nb.line}}</span></div>
                      <div style="display: flex; align-items: stretch;">
                        <sc-for list="{{nb.slots}}" as="b" hint-placeholder-count="2">
                          <sc-if value="{{b.join}}" hint-placeholder-val="{{false}}"><div aria-hidden="true" style="flex: 0 0 16px; position: relative;"><div style="position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed var(--dash);"></div></div></sc-if>
                          <sc-if value="{{b.real}}" hint-placeholder-val="{{true}}"><div class="slot" style="flex: 1 1 0; min-width: 0; border: 1px solid var(--sep2); border-radius: 6px; padding: 5px 9px; display: flex; flex-direction: column;"><span style="font-size: 12px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{b.model}}</span><span style="font-size: 11px; color: var(--tx3);">{{b.prov}}</span></div></sc-if>
                          <sc-if value="{{b.ghost}}" hint-placeholder-val="{{false}}"><div style="flex: 1 1 0; min-width: 0; border: 1px dashed var(--sep2); border-radius: 6px; padding: 5px 9px; display: flex; align-items: center; font-size: 12px; color: var(--tx3);">Add a fallback</div></sc-if>
                        </sc-for>
                      </div>
                    </div>
                  </sc-for>
                </div>
                <div class="cardb" style="margin-top: 10px; padding: 8px 14px; display: grid; grid-template-columns: 112px repeat(5, minmax(0, 1fr)); gap: 12px; align-items: center;">
                  <span style="font-weight: 500;">Used for</span>
                  <sc-for list="{{usedFor}}" as="u" hint-placeholder-count="5">
                    <div style="display: flex; flex-direction: column; gap: 3px; align-items: flex-start;"><span class="aside">{{u.k}}</span><button type="button" class="chip">{{u.v}}CHEV</button></div>
                  </sc-for>
                </div>

                <div class="rule" style="display: flex; align-items: baseline; gap: 10px; padding: 11px 0 9px; margin-top: 14px;"><span class="h2">Providers</span><span class="aside">Checked every minute. A failing one is skipped within seconds.</span><span style="flex: 1;"></span><span class="mono" style="font-size: 11px; color: var(--tx3);">$18.40 this month + plan</span></div>
                <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
                  <sc-for list="{{provs}}" as="p" hint-placeholder-count="3">
                    <div class="card" style="padding: 11px 14px; display: flex; flex-direction: column; gap: 7px;">
                      <div style="display: flex; align-items: center; gap: 10px;"><span style="font-weight: 600;">{{p.n}}</span><span class="ok">{{p.state}}</span><span style="flex: 1;"></span><button type="button" class="tbtn">Manage</button></div>
                      <div style="display: flex; align-items: baseline; gap: 8px;"><span style="font-size: 12.5px; color: var(--tx2);">{{p.k}}</span><span style="flex: 1;"></span><span class="mono" style="font-size: 11.5px;">{{p.v}}</span></div>
                      <div class="mtr"><sc-for list="{{p.cells}}" as="c" hint-placeholder-count="24"><i class="{{c.k}}"></i></sc-for></div>
                      <span class="aside">{{p.foot}}</span>
                    </div>
                  </sc-for>
                </div>
              </div>
            </sc-if>

            <!-- ============ NOTIFICATIONS ============ -->
            <sc-if value="{{isNotif}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <sc-if value="{{showSugg}}" hint-placeholder-val="{{true}}">
                  <div class="pick" style="border: 1px solid var(--ac); background: var(--acs); border-radius: 8px; padding: 10px 12px 10px 14px; display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
                    DIAMOND
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">You read Telegram faster than notifications. Reach you there first for Now?</span><span class="aside">Last 30 days: Telegram read in about 1 minute, push in about 6.</span></div>
                    <button type="button" class="btnp s" onClick="{{acceptSugg}}">Accept</button><button type="button" class="btn s" onClick="{{dismissSugg}}">Not now</button>
                  </div>
                </sc-if>
                <div class="rule" style="display: flex; align-items: center; gap: 10px; padding: 12px 0 12px;">
                  <span class="h2">Where it goes</span><span class="aside" style="margin-right: 6px;">The first that applies:</span>
                  <sc-for list="{{order}}" as="o" hint-placeholder-count="3">
                    <sc-if value="{{o.join}}" hint-placeholder-val="{{false}}"><span aria-hidden="true" style="width: 18px; border-top: 1px dashed var(--dash);"></span></sc-if>
                    <span class="tag" style="text-transform: none; letter-spacing: 0; font-family: Inter, sans-serif; font-size: 12px; height: 22px; padding: 0 8px; border-radius: 4px; color: {{o.c}}; border-color: {{o.bd}};"><span class="mono" style="font-size: 10px; color: var(--tx3);">{{o.i}}</span>{{o.n}}</span>
                  </sc-for>
                </div>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                  <sc-for list="{{urg}}" as="u" hint-placeholder-count="3">
                    <div style="display: grid; grid-template-columns: 156px minmax(0, 1fr); gap: 16px; align-items: center;">
                      <div style="display: flex; flex-direction: column; gap: 1px;"><div style="display: flex; align-items: baseline; gap: 8px;"><span class="disp" style="font-size: 15px; font-weight: 600;">{{u.n}}</span><span class="mono" style="font-size: 10px; color: var(--tx3);">{{u.stat}}</span></div><span class="aside">{{u.sub}}</span></div>
                      <div style="display: flex; align-items: stretch;">
                        <sc-for list="{{u.steps}}" as="c" hint-placeholder-count="3">
                          <sc-if value="{{c.join}}" hint-placeholder-val="{{false}}">
                            <div aria-hidden="true" style="flex: 0 0 {{c.jw}}px; position: relative;"><div style="position: absolute; left: 0; right: 0; top: 50%; border-top: 1px dashed var(--dash);"></div><span class="node" style="left: 50%; top: 50%;"></span><span class="mono" style="position: absolute; left: 0; right: 0; bottom: calc(50% + 6px); text-align: center; font-size: 9.5px; letter-spacing: .06em; color: var(--tx3); white-space: nowrap;">{{c.jl}}</span></div>
                          </sc-if>
                          <div class="slot" style="flex: 0 0 160px; height: 46px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 8px; background: var(--win); padding: 0 12px; display: flex; align-items: center; gap: 10px;">
                            <svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{c.d}}"></path></svg>
                            <div style="display: flex; flex-direction: column; min-width: 0;"><span style="font-weight: 500;">{{c.n}}</span><span class="aside" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.s}}</span></div>
                          </div>
                        </sc-for>
                        <div aria-hidden="true" style="flex: 0 0 10px;"></div>
                        <button type="button" aria-label="Add a channel" class="it" style="flex: 0 0 34px; height: 46px; border: 1px dashed var(--sep2); border-radius: 8px; background: transparent; color: var(--tx3); display: inline-flex; align-items: center; justify-content: center; padding: 0;"><svg class="ic" width="13" height="13" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"></path></svg></button>
                      </div>
                    </div>
                  </sc-for>
                </div>
                <div class="aside" style="padding: 10px 0 0 172px;">Reading it on one device clears it everywhere.</div>

                <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 18px;">
                  <div class="card" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 9px;">
                    <div style="display: flex; align-items: center; gap: 10px;"><span style="font-weight: 600;">Quiet hours</span><span style="flex: 1;"></span><button type="button" class="{{quietCls}}" onClick="{{toggleQuiet}}" aria-label="Quiet hours"></button></div>
                    <div style="display: flex; flex-direction: column; gap: 1px;"><span style="font-size: 12.5px;">10 pm to 7 am</span><span class="aside">Only Now gets through. Starts in 7 hours.</span></div>
                    <div class="mtr" style="position: relative;"><sc-for list="{{dayCells}}" as="c" hint-placeholder-count="24"><i class="{{c.k}}"></i></sc-for></div>
                    <div class="mono" style="display: flex; font-size: 10px; color: var(--tx3);"><span style="flex: 1;">12 AM</span><span style="flex: 1; text-align: center;">NOON</span><span style="flex: 1; text-align: right;">12 AM</span></div>
                  </div>
                  <div class="card" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 9px;">
                    <div style="display: flex; align-items: center; gap: 10px;"><span style="font-weight: 600;">Focus</span><span style="flex: 1;"></span><button type="button" class="{{focusCls}}" onClick="{{toggleFocus}}" aria-label="Focus"></button></div>
                    <span style="font-size: 12.5px; color: var(--tx2); line-height: 1.45;">Holds Soon during focus blocks on your calendar, or while you’ve picked an area.</span>
                    <span style="flex: 1;"></span>
                    <div style="display: flex; align-items: center; gap: 8px;"><span class="idle">Not focusing</span><span style="flex: 1;"></span><span class="aside">Next: Riverside edit, 3 pm</span></div>
                  </div>
                  <div class="card" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 9px;">
                    <div style="display: flex; align-items: center; gap: 10px;"><span style="font-weight: 600;">Interruption budget</span><span style="flex: 1;"></span>
                      <div style="display: inline-flex; align-items: center; border: 1px solid var(--sep2); border-radius: 6px; height: 22px;"><button type="button" aria-label="Fewer" style="width: 22px; height: 20px; border: 0; background: transparent; color: var(--tx2); padding: 0;">−</button><span class="mono" style="font-size: 11px; padding: 0 4px;">10/day</span><button type="button" aria-label="More" style="width: 22px; height: 20px; border: 0; background: transparent; color: var(--tx2); padding: 0;">+</button></div></div>
                    <div style="display: flex; align-items: baseline; gap: 8px;"><span class="disp num" style="font-size: 20px; font-weight: 600;">4</span><span style="font-size: 12.5px; color: var(--tx2);">of 10 used today</span></div>
                    <div class="mtr"><sc-for list="{{budget}}" as="c" hint-placeholder-count="10"><i class="{{c.k}}" style="height: 8px;"></i></sc-for></div>
                    <span class="aside">Atlas’s own pings count. Resets at 7 am.</span>
                  </div>
                </div>
              </div>
            </sc-if>

            <!-- ============ PERMISSIONS ============ -->
            <sc-if value="{{isPerms}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: flex; flex-direction: column;">
                <div style="display: grid; grid-template-columns: minmax(0, 1.42fr) minmax(0, 1fr); gap: 28px;">
                  <div style="display: flex; flex-direction: column;">
                    <div class="rule" style="display: flex; align-items: baseline; gap: 10px; padding: 12px 0 4px;"><span class="h2">Kinds of action</span></div>
                    <sc-for list="{{kinds}}" as="k" hint-placeholder-count="5">
                      <div style="display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--sep);">
                        <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">{{k.n}}</span><span class="aside">{{k.s}}</span></div>
                        <sc-if value="{{k.lock}}" hint-placeholder-val="{{false}}">LOCK</sc-if>
                        <div class="{{k.segCls}}"><sc-for list="{{k.opts}}" as="o" hint-placeholder-count="3"><button type="button" class="{{o.cls}}" onClick="{{o.pick}}">{{o.l}}</button></sc-for></div>
                      </div>
                    </sc-for>
                    <div class="aside" style="padding-top: 9px;">A vault login asks the first time on each site, and secrets only go through the app.</div>
                  </div>
                  <div style="display: flex; flex-direction: column;">
                    <div class="rule" style="display: flex; align-items: baseline; gap: 10px; padding: 12px 0 4px;"><span class="h2">Atlas doesn’t ask for</span><span style="flex: 1;"></span><span class="aside">Trust you gave it</span></div>
                    <sc-for list="{{trusted}}" as="t" hint-placeholder-count="4">
                      <div style="display: flex; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--sep);">
                        <div style="flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">{{t.n}}</span><span class="aside">{{t.s}}</span></div>
                        <button type="button" class="btn s">Ask again</button>
                      </div>
                    </sc-for>
                  </div>
                </div>

                <div class="rule" style="display: flex; align-items: baseline; gap: 10px; padding: 12px 0 4px; margin-top: 14px;"><span class="h2">Your own rules</span><span class="aside">Each starts as Atlas behaves out of the box, on the left.</span></div>
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 28px;">
                  <sc-for list="{{rules}}" as="r" hint-placeholder-count="10">
                    <div style="display: flex; align-items: center; gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--sep);">
                      <span style="flex: 1; min-width: 0; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{r.n}}</span>
                      <div class="seg sm"><sc-for list="{{r.opts}}" as="o" hint-placeholder-count="2"><button type="button" class="{{o.cls}}" onClick="{{o.pick}}">{{o.l}}</button></sc-for></div>
                    </div>
                  </sc-for>
                </div>
              </div>
            </sc-if>

            <!-- ============ ACCOUNT ============ -->
            <sc-if value="{{isAccount}}" hint-placeholder-val="{{false}}">
              <div class="rise" style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px;">
                <div class="card" style="padding: 13px 16px; display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: center; gap: 10px; padding-bottom: 8px;"><span class="h2">Passkeys</span><span class="aside">How you sign in. No passwords.</span><span style="flex: 1;"></span><button type="button" class="btn s">Add a passkey</button></div>
                  <sc-for list="{{passkeys}}" as="p" hint-placeholder-count="2">
                    <div style="display: flex; align-items: center; gap: 12px; padding: 9px 0; border-top: 1px solid var(--sep);">
                      <svg class="ic" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{p.d}}"></path></svg>
                      <div style="flex: 1; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">{{p.n}}</span><span class="aside">{{p.s}}</span></div>
                      <span style="font-size: 12px; color: var(--tx2);">{{p.used}}</span>
                    </div>
                  </sc-for>
                </div>

                <div class="card" style="padding: 13px 16px; display: flex; flex-direction: column; gap: 10px;">
                  <div style="display: flex; align-items: center; gap: 10px;"><span class="h2">Vault</span><span class="aside">Built in and encrypted.</span><span style="flex: 1;"></span><button type="button" class="btn s">Open the vault</button></div>
                  <div style="display: flex; align-items: baseline; gap: 10px; padding-top: 2px;"><span class="disp num" style="font-size: 26px; font-weight: 600;">14</span><span style="color: var(--tx2);">entries</span></div>
                  <div style="display: flex; gap: 6px; flex-wrap: wrap;"><sc-for list="{{vault}}" as="v" hint-placeholder-count="4"><span style="height: 22px; padding: 0 8px; border: 1px solid var(--sep2); border-radius: 4px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2);"><span class="mono" style="color: var(--tx);">{{v.c}}</span>{{v.n}}</span></sc-for></div>
                  <span class="aside">Atlas never sees the values. Last used 2 hours ago, on chase.com.</span>
                </div>

                <div class="card" style="padding: 13px 16px; display: flex; flex-direction: column; gap: 10px;">
                  <div style="display: flex; align-items: center; gap: 10px;"><span class="h2">Updates</span><span class="aside">Running 0.7.0</span><span style="flex: 1;"></span><span class="mono" style="font-size: 10.5px; color: var(--tx3);">CHECKED 6:02 AM</span></div>
                  <div class="cardb" style="padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;">
                    <div style="display: flex; align-items: baseline; gap: 8px;"><span class="disp" style="font-size: 16px; font-weight: 600;">Atlas 0.7.1 is out</span><span class="aside">Oct 23</span></div>
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                      <sc-for list="{{notes}}" as="n" hint-placeholder-count="3"><div style="display: flex; gap: 9px; font-size: 12.5px; color: var(--tx2);"><span style="color: var(--tx3);">·</span><span>{{n}}</span></div></sc-for>
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px; padding-top: 4px;">
                      <button type="button" class="btnp s">Update</button>
                      <span class="aside">Takes a minute. You can roll back to 0.7.0.</span>
                    </div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 10px; padding-top: 2px;"><button type="button" class="{{autoCls}}" onClick="{{toggleAuto}}" aria-label="Update on its own"></button><span style="font-size: 12.5px;">Update on its own</span><span class="aside">Overnight, when you’re not talking.</span></div>
                </div>

                <div class="card" style="padding: 13px 16px; display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: center; gap: 10px; padding-bottom: 8px;"><span class="h2">Your data</span><span class="aside">It only grows, and it’s yours.</span></div>
                  <div style="display: flex; align-items: center; gap: 12px; padding: 10px 0; border-top: 1px solid var(--sep);">
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">Export everything</span><span class="aside">The log, records, files, skills and settings.</span></div>
                    <button type="button" class="btn s">Export</button>
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 8px; padding: 10px 0; border-top: 1px solid var(--sep);">
                    <div style="display: flex; align-items: center; gap: 12px;"><div style="flex: 1; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">Restore to a point</span><span class="aside">Any moment in the last 30 days.</span></div><button type="button" class="btn s">Choose a point</button></div>
                    <div class="mtr"><sc-for list="{{days}}" as="c" hint-placeholder-count="30"><i class="{{c.k}}" style="height: 10px;"></i></sc-for></div>
                    <div class="mono" style="display: flex; font-size: 10px; color: var(--tx3);"><span style="flex: 1;">SEP 24</span><span>TODAY</span></div>
                  </div>
                  <div style="display: flex; align-items: center; gap: 12px; padding: 10px 0 2px; border-top: 1px solid var(--sep);">
                    <div style="flex: 1; display: flex; flex-direction: column; gap: 1px;"><span style="font-weight: 500;">Delete everything</span><span class="aside">Everything, and every backup. No undo.</span></div>
                    <button type="button" class="btn s hold"><span class="fill"></span><span>Hold to delete</span></button>
                  </div>
                </div>
              </div>
            </sc-if>
          </div>
""".replace('LOCK', LOCK).replace('CHEV', CHEV)

JS = r"""
  renderVals() {
    var self = this;
    var st = this.state;
    var sec = st.sec || 'atlas';
    function set(k, v) { var s = {}; s[k] = v; self.setState(s); }
    LOGOS_JS
    function lb(k, n, then) { return { lg: L[k].uri, inv: L[k].inv, n: n, then: !!then }; }
    var bsimple = {
      main: { lg: L.openai.uri, inv: L.openai.inv },
      provs: [
        { lg: L.openai.uri, inv: L.openai.inv, n: 'ChatGPT', how: 'Your Plus plan', line: 'Most of today’s plan is left', pct: 62, c: 'var(--tx2)', foot: '62% used · resets at 4:10 pm' },
        { lg: L.claude.uri, inv: L.claude.inv, n: 'Claude', how: 'By Anthropic key', line: '$18.40 of your $100 this month', pct: 18, c: '#d97757', foot: 'At $100 it stops and asks you' },
        { lg: L.cloudflare.uri, inv: L.cloudflare.inv, n: 'Workers AI', how: 'Comes with Cloudflare', line: 'Free so far today', pct: 41, c: '#f38020', foot: '41% of the free allowance · resets 8 pm' }
      ],
      kinds: [
        { n: 'Quick jobs', what: 'Lookups and small helpers', by: [lb('cloudflare', 'Workers AI', true), lb('openai', 'ChatGPT')], week: '1,906 this week' },
        { n: 'Hard problems', what: 'Research, plans, checking a job’s work', by: [lb('openai', 'ChatGPT', true), lb('claude', 'Claude')], week: '48 this week' },
        { n: 'Long reading', what: 'Whole documents and long threads', by: [lb('claude', 'Claude')], week: '6 this week' },
        { n: 'Learning skills', what: 'What it keeps after a conversation', by: [lb('cloudflare', 'Workers AI')], week: '12 this week' }
      ]
    };
    function cells(n, f) { var a = []; for (var i = 0; i < n; i++) a.push({ k: f(i) }); return a; }
    function seg(key, opts, def) {
      var cur = st[key] || def;
      return opts.map(function (o) { return { l: o, cls: o === cur ? 'on' : '', pick: function () { set(key, o); } }; });
    }
    function tg(key, def) { var on = st[key] === undefined ? def : st[key]; return 'tg' + (on ? ' on' : ''); }
    function flip(key, def) { return function () { var on = st[key] === undefined ? def : st[key]; set(key, !on); }; }

    var S = [
      ['atlas', 'Atlas', 'M12 2 4.5 12 12 22l7.5-10z', ''],
      ['brains', 'Brains', 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9.5 9.5h5v5h-5z', ''],
      ['notifications', 'Notifications', 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0', '4/10'],
      ['permissions', 'Permissions', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', ''],
      ['account', 'Account', 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', '0.7.1']
    ];
    var secs = S.map(function (s) {
      var on = s[0] === sec;
      return { n: s[1], d: s[2], meta: s[3], bg: on ? 'var(--sel)' : 'transparent', fg: on ? 'var(--tx)' : 'var(--tx2)', fw: on ? 500 : 400, ic: on ? 'var(--tx)' : 'var(--tx3)', pick: function () { self.setState({ sec: s[0], picker: false }); } };
    });

    // ---------- Atlas ----------
    var atab = st.atab || 'Character';
    var apills = ['Character', 'Voice', 'Look'].map(function (p) { return { n: p, cls: 'pill' + (p === atab ? ' on' : ''), pick: function () { set('atab', p); } }; });

    var T = [['warmth', 'Warmth', 'Reserved', 'Warm'], ['humor', 'Humor', 'Serious', 'Playful'], ['directness', 'Directness', 'Explains', 'Brief'], ['initiative', 'Initiative', 'Waits', 'Jumps in']];
    var val = {};
    T.forEach(function (t) { val[t[0]] = st[t[0]] || 3; });
    var traits = T.map(function (t) {
      var v = val[t[0]];
      var cs = [1, 2, 3, 4, 5].map(function (k) {
        var cur = k === v, fill = k < v;
        return { label: t[1] + ' ' + k, bd: cur ? 'var(--tx)' : (fill ? 'var(--m3)' : 'var(--sep2)'), bg: cur ? 'var(--tx)' : (fill ? 'var(--m3)' : 'transparent'), pick: function () { set(t[0], k); } };
      });
      return { n: t[1], lo: t[2], hi: t[3], v: v, cells: cs };
    });
    var w = val.warmth, h = val.humor, d = val.directness, i = val.initiative;
    var sample = (w >= 4 ? 'Yep, good news. ' : (w === 3 ? 'Yes. ' : '')) +
      (d >= 4 ? 'Lensrentals: $268 a day, ships Friday.' : (d === 3 ? 'Lensrentals came in at $268 a day and can ship Friday.' : 'It did. Lensrentals came back at $268 a day, and they can ship it Friday, so it arrives before Saturday’s shoot.')) +
      (h >= 4 ? ' Cheapest of the four, so your wallet gets the day off.' : (h === 3 ? ' Cheapest of the four.' : '')) +
      (i >= 4 ? ' Say go and I’ll book it.' : (i === 3 ? ' Want me to book it?' : ''));

    var vsel = st.voice || 'Harlan';
    var voices = [['Harlan', 'Low, calm', '▁▂▄▃▅▄▂▃▄▂▁▂▃▂▁▂▃'], ['Wren', 'Bright, quick', '▂▅▃▇▄▆▂▅▃▆▄▂▅▃▂▄▃'], ['Inés', 'Warm, husky', '▁▃▅▄▃▅▆▄▂▃▂▁▃▄▂▃▂']].map(function (v) {
      var on = v[0] === vsel;
      return { n: v[0], s: v[1], w: v[2], on: on, bd: on ? 'var(--tx2)' : 'var(--sep2)', bg: on ? 'var(--bg)' : 'var(--win)', wc: on ? 'var(--tx)' : 'var(--tx3)', pick: function () { set('voice', v[0]); } };
    });
    var segs = [
      { n: 'Speed', opts: seg('speed', ['0.9×', '1.0×', '1.1×', '1.2×'], '1.0×') },
      { n: 'Small talk', opts: seg('small', ['Never', 'Sometimes', 'Often'], 'Sometimes') },
      { n: 'Fillers like “um”', opts: seg('fillers', ['Off', 'Light'], 'Off') }
    ];

    var TH = [
      ['Graphite', 'Warm dark', { bg: '#141413', win: '#1b1a19', side: '#181716', sep: '#2c2a28', tx: '#f1efea', tx3: '#5a5752', ac: '#ff6a3d', font: "'Inter Tight', Inter, sans-serif" }],
      ['Daylight', 'Light', { bg: '#faf9f6', win: '#ffffff', side: '#f4f3ef', sep: '#e7e5df', tx: '#191817', tx3: '#cdc9c0', ac: '#e8501b', font: "'Inter Tight', Inter, sans-serif" }],
      ['Terminal', 'Mono, dense', { bg: '#0b0b0a', win: '#0f0f0e', side: '#0b0b0a', sep: '#2a2a28', tx: '#e4e2dc', tx3: '#4a4945', ac: '#ff6a3d', font: "'Geist Mono', monospace" }],
      ['Midnight', 'Cool dark', { bg: '#0e1117', win: '#151a22', side: '#11151c', sep: '#252c38', tx: '#e6ebf2', tx3: '#4b5566', ac: '#ff7a52', font: "'Inter Tight', Inter, sans-serif" }],
      ['High contrast', 'Strongest', { bg: '#000000', win: '#000000', side: '#000000', sep: '#ffffff', tx: '#ffffff', tx3: '#bdbdbd', ac: '#ff8a5c', font: "'Inter Tight', Inter, sans-serif" }]
    ];
    var tsel = st.lookTheme || 'Graphite';
    var themes = TH.map(function (t) {
      var on = t[0] === tsel, c = t[2];
      return { n: t[0], s: t[1], on: on, ring: on ? 'var(--tx2)' : 'var(--sep)', rw: on ? 1 : 0, bg: c.bg, win: c.win, side: c.side, sep: c.sep, tx: c.tx, tx3: c.tx3, ac: c.ac, font: c.font, pick: function () { set('lookTheme', t[0]); } };
    });
    var asel = st.accent || 'Ember';
    var accents = [['Ember', '#ff6a3d'], ['Blue', 'var(--U)'], ['Green', 'var(--F)'], ['Violet', 'var(--H)'], ['Amber', 'var(--K)'], ['Pink', 'var(--P)']].map(function (a) {
      return { n: a[0], c: a[1], rw: a[0] === asel ? 3.5 : 0, pick: function () { set('accent', a[0]); } };
    });
    var lookSegs = [
      { n: 'Density', opts: seg('density', ['Comfortable', 'Compact'], 'Comfortable') },
      { n: 'Motion', opts: seg('motion', ['Full', 'Reduced'], 'Full') },
      { n: 'Detail', opts: seg('detail', ['Casual', 'Everyday', 'Developer'], 'Everyday') }
    ];

    // ---------- Brains ----------
    var picker = !!st.picker;
    function slot(i, model, prov, state, open) {
      var on = state === 'In use';
      return { real: true, join: i > 1, model: model, prov: prov, state: on ? state : '', stc: on ? 'ok' : 'idle', open: !!open, bd: open ? 'var(--tx2)' : (on ? 'var(--tx3)' : 'var(--sep2)'),
        pick: function () { if (open !== undefined) set('picker', !picker); } };
    }
    var roles = [
      { n: 'Main', sub: 'Chats and jobs', slots: [slot(1, 'gpt-5.6-terra', 'ChatGPT', 'In use'), slot(2, 'Claude Sonnet 5.5', 'Anthropic', 'Ready', picker), slot(3, 'Kimi K2.6', 'Workers AI', 'Ready')] },
      { n: 'Voice', sub: 'Thinks while it talks', slots: [slot(1, 'Kimi K2.6', 'Workers AI', 'In use'), slot(2, 'gpt-5.6-terra', 'ChatGPT', 'Ready'), { ghost: true, join: true }] }
    ];
    function mini(i, model, prov) { return { real: true, join: i > 1, model: model, prov: prov }; }
    var named = [
      { n: 'Quick', line: 'Fast and cheap, for routine work.', slots: [mini(1, 'Kimi K2.6', 'Workers AI'), mini(2, 'gpt-5.6-terra', 'ChatGPT')], stat: '1,906 THIS WEEK' },
      { n: 'Deep', line: 'Careful thinking, for hard problems.', slots: [mini(1, 'gpt-5.6-terra', 'ChatGPT'), mini(2, 'Sonnet 5.5', 'Anthropic')], stat: '48 THIS WEEK' },
      { n: 'Long reading', line: 'Whole documents and long threads.', slots: [mini(1, 'Sonnet 5.5', 'Anthropic'), { ghost: true, join: true }], stat: '6 THIS WEEK' }
    ];
    var usedFor = [['Helpers', 'Quick'], ['Research', 'Deep'], ['A job’s work', 'Quick'], ['A job’s looks', 'Deep'], ['Skill review', 'Quick']].map(function (u) { return { k: u[0], v: u[1] }; });
    function meter(n, pct) { var f = Math.round(n * pct / 100); return cells(n, function (k) { return k < f ? 'f' : ''; }); }
    var provs = [
      { n: 'ChatGPT', state: 'Signed in, Plus', k: 'Plan window', v: '62% used', cells: meter(24, 62), foot: 'Resets 4:10 pm. Until then, all in your plan.' },
      { n: 'Anthropic', state: 'API key', k: 'This month', v: '$18.40 of $100', cells: meter(24, 18.4), foot: 'At the cap, it stops and asks you.' },
      { n: 'Workers AI', state: 'Connected', k: 'Free allowance today', v: '41% used', cells: meter(24, 41), foot: 'Resets 8 pm. Then a few cents a day.' }
    ];
    var pv = st.pickProvider || 'Anthropic';
    var pickProv = ['ChatGPT', 'Anthropic', 'Workers AI'].map(function (p) { return { l: p, cls: p === pv ? 'on' : '', pick: function () { set('pickProvider', p); } }; });
    var CAT = {
      Anthropic: [['Claude Opus 5.5', 'Most capable, slower, costs more.', 2, '~55 tok/s', '$5 · $25'], ['Claude Sonnet 5.5', 'Strong and quick. The usual pick.', 3, '~80 tok/s', '$3 · $15'], ['Claude Haiku 5.5', 'Fastest and cheapest.', 5, '~160 tok/s', '$1 · $5']],
      ChatGPT: [['gpt-5.6-terra', 'The plan’s best model.', 3, '~90 tok/s', 'In plan'], ['gpt-5.6-terra-mini', 'Lighter, uses less of the window.', 4, '~140 tok/s', 'In plan'], ['gpt-5.5', 'The one before.', 3, '~85 tok/s', 'In plan']],
      'Workers AI': [['Kimi K2.6', 'The best open model here.', 4, '~120 tok/s', 'Free · then $0.60'], ['gpt-oss-120b', 'Open, good at tools.', 4, '~130 tok/s', 'Free · then $0.35'], ['Llama 4 Scout', 'Small and very fast.', 5, '~210 tok/s', 'Free · then $0.27']]
    };
    var csel = st.pickModel || 'Claude Sonnet 5.5';
    var pickRows = CAT[pv].map(function (m) {
      var on = m[0] === csel;
      return { n: m[0], s: m[1], on: on, bg: on ? 'var(--sel)' : 'transparent', sp: cells(5, function (k) { return k < m[2] ? 'f' : ''; }), tps: m[3], cost: m[4], pick: function () { self.setState({ pickModel: m[0], picker: false }); } };
    });
    var pickNote = pv === 'ChatGPT' ? 'Signed in, Plus' : (pv === 'Anthropic' ? 'By API key' : 'Your Cloudflare account');
    var pickCostHd = pv === 'ChatGPT' ? 'Cost' : 'Per M tokens';
    var pickFoot = pv === 'ChatGPT' ? 'Live from your ChatGPT plan, checked 2 min ago.' : (pv === 'Anthropic' ? 'Live from Anthropic, checked 2 min ago. Prices are in and out.' : 'Live from Workers AI, checked 2 min ago. Free up to the daily allowance.');

    // ---------- Notifications ----------
    var PH = 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2';
    var TGM = 'M22 2 11 13M22 2l-7 20-4-9-9-4z';
    var CALL = 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z';
    var BRIEF = 'M12 3v2M5.6 5.6l1.4 1.4M3 12h2M19 12h2M17 7l1.4-1.4M7 16a5 5 0 0 1 10 0M3 20h18';
    var accepted = !!st.accepted;
    function ch(d, n, s, jl, jw) { return { d: d, n: n, s: s, join: !!jl, jl: jl || '', jw: jw || 0 }; }
    var nowSteps = accepted ? [ch(TGM, 'Telegram', '@maxbarbare'), ch(PH, 'Push', 'Max’s iPhone', 'THEN', 48), ch(CALL, 'Phone call', 'Max’s iPhone', '10 MIN UNSEEN', 100)]
                            : [ch(PH, 'Push', 'Max’s iPhone'), ch(TGM, 'Telegram', '@maxbarbare', 'THEN', 48), ch(CALL, 'Phone call', 'Max’s iPhone', '10 MIN UNSEEN', 100)];
    var urg = [
      { n: 'Now', sub: 'Right away, even at night', steps: nowSteps, stat: '2 THIS WEEK' },
      { n: 'Soon', sub: 'At your next free moment', steps: [ch(TGM, 'Telegram', '@maxbarbare')], stat: '7 TODAY' },
      { n: 'Later', sub: 'Waits for a better time', steps: [ch(BRIEF, 'The next brief', 'Tomorrow, 8:00 am'), ch('M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 15h18', 'Or the app', 'When you next open it', 'OR', 48)], stat: '11 WAITING' }
    ];
    var order = [['1', 'Where you’re talking now'], ['2', 'Where it started'], ['3', 'Your list for its urgency']].map(function (o, k) {
      return { i: o[0], n: o[1], join: k > 0, c: 'var(--tx2)', bd: 'var(--sep2)' };
    });
    // quiet hours strip: 24 hours, 22 to 7 quiet, now at 14
    var dayCells = cells(24, function (k) { if (k === 14) return 'n'; return (k >= 22 || k < 7) ? 'f' : 'q'; });
    var budget = cells(10, function (k) { return k < 4 ? 'f' : ''; });

    // ---------- Permissions ----------
    var KO = ['Always ask', 'Until trusted', 'Don’t ask'];
    var K = [
      ['k_look', 'Looking', 'Your data, the web', 'Don’t ask', false],
      ['k_own', 'Changing your own things', 'Calendar, notes, with undo', 'Don’t ask', false],
      ['k_speak', 'Speaking to others', 'Messages, email, posts', 'Until trusted', false],
      ['k_undo', 'Things that can’t be undone', 'Always asks, with hold to confirm', 'Always ask', true],
      ['k_money', 'Money', 'Always asks, showing the amount', 'Always ask', true]
    ];
    var kinds = K.map(function (k) {
      var cur = k[4] ? k[3] : (st[k[0]] || k[3]);
      return { n: k[1], s: k[2], lock: k[4], segCls: 'seg' + (k[4] ? ' lock' : ''),
        opts: KO.map(function (o) { return { l: o, cls: o === cur ? 'on' : '', pick: function () { if (!k[4]) set(k[0], o); } }; }) };
    });
    var trusted = [
      ['Meeting confirmations', 'Email · trusted Oct 9, after 5 OKs as-is'],
      ['Texts to Mom', 'Messages · trusted Sep 30'],
      ['Keyframes face, to known clients', 'Faces · trusted Oct 14'],
      ['Linear', 'All 12 tools · trusted Oct 2']
    ].map(function (t) { return { n: t[0], s: t[1] }; });
    var R = [
      ['r1', 'Websites the workspace reaches', ['Each site', 'Any site'], 0],
      ['r6', 'Calendar changes with others', ['Asks', 'Does it, tells you'], 0],
      ['r2', 'Forms in the browser', ['Asks', 'Allowed sites'], 0],
      ['r7', 'MCP tools', ['One at a time', 'Whole service'], 0],
      ['r3', 'After reading the web', ['Asks first', 'Known people'], 0],
      ['r8', 'Paid brain when a plan runs out', ['Asks', 'Within the cap'], 0],
      ['r4', 'Email sent as you', ['Always asks', 'Per recipient'], 0],
      ['r9', 'Tools on your devices', ['Until trusted', 'Always asks'], 0],
      ['r5', 'Faces replying to contacts', ['Until trusted', 'Sends'], 0],
      ['r10', 'Phone calls', ['Doesn’t call', 'Calls if urgent'], 1]
    ];
    var rules = R.map(function (r) {
      var cur = st[r[0]] === undefined ? r[3] : st[r[0]];
      return { n: r[1], opts: r[2].map(function (o, k) { return { l: o, cls: k === cur ? 'on' : '', pick: function () { set(r[0], k); } }; }) };
    });

    // ---------- Account ----------
    var passkeys = [
      { d: 'M4 5h16v10H4zM2 19h20', n: 'MacBook Pro', s: 'Touch ID · this device', used: 'In use now' },
      { d: PH, n: 'iPhone 17 Pro', s: 'Face ID', used: 'Yesterday, 9:14 pm' }
    ];
    var vault = [['8', 'logins'], ['2', 'cards'], ['3', 'two-factor codes'], ['1', 'API key']].map(function (v) { return { c: v[0], n: v[1] }; });
    var notes = ['Voice answers start about 80 ms sooner.', 'Approvals on Telegram show the whole draft.', 'Fixes calendar sync stalling after the Mac sleeps.'];
    var days = cells(30, function (k) { return k === 29 ? 'f' : 'q'; });

    var H = {
      atlas: ['Atlas', 'Who Atlas is, how it sounds, and how it looks.', ''],
      brains: ['Brains', 'Who does Atlas’s thinking, and what it costs.', 'Add a provider'],
      notifications: ['Notifications', 'How Atlas reaches you when you aren’t already talking.', 'Send a test'],
      permissions: ['Permissions', 'When Atlas asks first. Each area can raise or lower these; Health asks for everything.', ''],
      account: ['Account', 'How you sign in, your secrets, updates and your data.', '']
    };
    var hd = H[sec];
    return Object.assign(this.shellVals('Settings'), {
      tabs: this.mkTabs([[hd[0], '']], hd[0], 'crumb'), meta: 'Atlas 0.7.0 · 0.7.1 ready',
      secs: secs, secTitle: hd[0], secSub: hd[1], secBtn: hd[2],
      isAtlas: sec === 'atlas', apills: apills,
      isCharacter: sec === 'atlas' && atab === 'Character', isVoice: sec === 'atlas' && atab === 'Voice', isLook: sec === 'atlas' && atab === 'Look',
      traits: traits, sample: sample, voices: voices, segs: segs,
      bargeCls: tg('barge', true), toggleBarge: flip('barge', true),
      themes: themes, accents: accents, lookSegs: lookSegs, followCls: tg('follow', true), toggleFollow: flip('follow', true),
      isBrains: sec === 'brains' && st.level === 'developer', isBrainsSimple: sec === 'brains' && st.level !== 'developer', bs: bsimple, roles: roles, named: named, usedFor: usedFor, provs: provs,
      pickProv: pickProv, pickRows: pickRows, pickNote: pickNote, pickCostHd: pickCostHd, pickFoot: pickFoot,
      isNotif: sec === 'notifications', showSugg: !accepted && !st.dismissed, acceptSugg: function () { set('accepted', true); }, dismissSugg: function () { set('dismissed', true); },
      order: order, urg: urg, dayCells: dayCells, budget: budget,
      quietCls: tg('quiet', true), toggleQuiet: flip('quiet', true), focusCls: tg('focus', true), toggleFocus: flip('focus', true),
      isPerms: sec === 'permissions', kinds: kinds, trusted: trusted, rules: rules,
      isAccount: sec === 'account', passkeys: passkeys, vault: vault, notes: notes, days: days,
      autoCls: tg('auto', false), toggleAuto: flip('auto', false)
    });
  }
"""

if __name__ == '__main__':
    from shell import diamond
    from shell import logos_js
    body = BODY.replace('DIAMOND', diamond(9, 16))
    out = page(title='Atlas · Settings', active='Settings', label='Settings', body=body, js=JS.replace('LOGOS_JS', logos_js()),
               placeholder='Change anything by asking, like: don’t call me before 9 am',
               sheet_height=690, extra_css=CSS,
               state="{ sec: 'atlas', atab: 'Character', warmth: 4, humor: 3, directness: 4, initiative: 3 }")
    open('../Settings.dc.html', 'w').write(out)
    print('wrote Settings')
