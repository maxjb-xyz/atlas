from shell import page, diamond

CSS = r"""
.dk{--Hm:#5cc2c9;--Hmrgb:92,194,201}
.lt{--Hm:#23909a;--Hmrgb:35,144,154}
.av{border-radius:50%;background:var(--sel);color:var(--tx2);font-weight:600;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--tx2);white-space:nowrap}
.sq{width:7px;height:7px;border-radius:2px;flex:none;display:inline-block}
.pill{height:20px;padding:0 8px;border-radius:10px;border:1px solid var(--sep2);font-size:11.5px;color:var(--tx2);display:inline-flex;align-items:center;gap:5px;white-space:nowrap;box-sizing:border-box}
.fchip{height:26px;padding:0 11px;border-radius:13px;border:1px solid var(--sep2);background:transparent;font-size:12px;color:var(--tx2);display:inline-flex;align-items:center;gap:6px}
.fchip:hover{background:var(--hover)}
.sh{font-size:13px;font-weight:600;color:var(--tx)}
.lnk{border:0;background:transparent;padding:0;color:var(--tx2);font-size:12.5px;display:inline-flex;align-items:center;gap:6px}
.lnk:hover{color:var(--tx)}
.qb{border:0;background:transparent;padding:0 2px;color:var(--tx3);font-size:12px}
.qb:hover{color:var(--tx)}
.tg{width:26px;height:15px;border-radius:8px;background:var(--sep2);position:relative;flex:none;display:inline-block;border:0;padding:0}
.tg::after{content:'';position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--win);transition:transform .15s}
.tg.on{background:var(--btn)}
.tg.on::after{background:var(--btntx);transform:translateX(11px)}
.card{transition:border-color .12s,background .12s;cursor:pointer}
.card:hover{border-color:var(--dash)}
.live{animation:live 2.4s ease-in-out infinite}
@keyframes live{50%{opacity:.35}}
.srch{height:28px;width:220px;box-sizing:border-box;border:1px solid var(--sep2);border-radius:6px;background:var(--bg);display:inline-flex;align-items:center;gap:7px;padding:0 9px;color:var(--tx3);font-size:12.5px}
"""

ADM = diamond(8, 14)
DIA_AC = '<svg viewBox="290 128 444 768" width="8" height="14" aria-hidden="true" style="flex: none;"><polygon points="512,128.96 290.84,418.52 512,895.04 733.16,418.52" style="fill: var(--ac);"></polygon></svg>'
LOCK = '<svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2); stroke-width: 1.9;"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>'
BACK = '<svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>'
ARROW = '<div aria-hidden="true" style="flex: 1; min-width: 18px; align-self: center; position: relative; border-top: 1px dashed var(--tx3);"><span class="node" style="left: 0; top: 0;"></span><span style="position: absolute; right: -1px; top: -4px; width: 0; height: 0; border-left: 6px solid var(--tx3); border-top: 3.5px solid transparent; border-bottom: 3.5px solid transparent;"></span></div>'

BODY = r"""
          <sc-if value="{{isContacts}}" hint-placeholder-val="{{true}}">
            <div style="display: flex; align-items: center; gap: 12px; padding: 16px 22px 0;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">Contacts</span>
              <span class="num" style="color: var(--tx3);">214 people · 6 new this month</span>
              <span style="flex: 1;"></span>
              <span class="srch"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>Find someone</span>
            </div>
            <div style="display: flex; align-items: center; gap: 6px; padding: 14px 22px 14px;">
              <sc-for list="{{filters}}" as="f" hint-placeholder-count="6">
                <button type="button" class="fchip" onClick="{{f.pick}}" style="background: {{f.bg}}; border-color: {{f.bd}}; color: {{f.fg}};">{{f.n}}<span class="num" style="font-size: 11px; color: var(--tx3);">{{f.c}}</span></button>
              </sc-for>
              <span style="flex: 1;"></span>
              <span style="font-size: 12px; color: var(--tx3);">Most recent first</span>
            </div>
            <div style="display: grid; grid-template-columns: 30px minmax(0, 1fr) 104px 80px 196px 116px 112px; gap: 14px; padding: 0 22px 7px; border-bottom: 1px solid var(--sep); font-size: 11.5px; color: var(--tx3);">
              <span></span><span>Name</span><span>Trust</span><span>Reach on</span><span>Areas</span><span>Last talked</span><span>Atlas knows</span>
            </div>
            <sc-for list="{{people}}" as="p" hint-placeholder-count="10">
              <div class="row" onClick="{{p.open}}" style="cursor: pointer; display: grid; grid-template-columns: 30px minmax(0, 1fr) 104px 80px 196px 116px 112px; gap: 14px; align-items: center; padding: 0 22px; height: 47px; border-bottom: 1px solid var(--sep);">
                <span class="avc" style="width: 30px; height: 30px; font-size: 10.5px; --c: {{p.ac}}; --rgb: {{p.argb}};">{{p.i}}</span>
                <span style="display: flex; flex-direction: column; min-width: 0;">
                  <span style="display: flex; align-items: center; gap: 7px;"><span style="font-weight: 500;">{{p.n}}</span><sc-if value="{{p.tag}}" hint-placeholder-val="{{false}}"><span style="font-size: 11px; color: var(--tx3); border: 1px solid var(--sep2); border-radius: 4px; padding: 0 5px; line-height: 15px;">{{p.tag}}</span></sc-if></span>
                  <span style="font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{p.rel}}</span>
                </span>
                <span><span class="pill" style="border-style: {{p.tbs}}; color: {{p.tfg}};">{{p.trust}}</span></span>
                <span style="display: inline-flex; align-items: center; gap: 9px;">
                  <sc-for list="{{p.ch}}" as="c" hint-placeholder-count="3"><svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-label="{{c.l}}" style="color: {{c.c}}; opacity: {{c.op}};"><path d="{{c.d}}"></path></svg></sc-for>
                </span>
                <span style="display: inline-flex; align-items: center; gap: 12px; min-width: 0; overflow: hidden;">
                  <sc-for list="{{p.areas}}" as="a" hint-placeholder-count="1"><span class="ach" style="--c: {{a.c}}; --rgb: {{a.rgb}};">{{a.n}}</span></sc-for>
                </span>
                <span style="display: flex; flex-direction: column;"><span class="num" style="font-size: 12.5px; color: {{p.lc}};">{{p.last}}</span><span style="font-size: 11.5px; color: var(--tx3);">{{p.via}}</span></span>
                <span style="display: inline-flex; align-items: center; gap: 8px;"><span aria-hidden="true" style="display: inline-flex; gap: 2px;"><sc-for list="{{p.segs}}" as="g" hint-placeholder-count="5"><span style="width: 4px; height: 10px; background: {{g}};"></span></sc-for></span><span class="num" style="font-size: 12px; color: var(--tx2);">{{p.k}}</span></span>
              </div>
            </sc-for>
            <div style="display: flex; align-items: center; gap: 10px; padding: 13px 22px;">
              DIA_AC
              <span>Atlas guessed the trust level for 3 new people this week.</span>
              <button type="button" class="btn" style="height: 26px; padding: 0 10px; font-size: 12px;">Check them</button>
              <span style="flex: 1;"></span>
              <span style="font-size: 12px; color: var(--tx3);">+ 204 more</span>
            </div>
          </sc-if>

          <sc-if value="{{isPerson}}" hint-placeholder-val="{{false}}">
            <div class="rise" style="padding: 16px 22px 0;">
              <div style="display: flex; align-items: center; gap: 8px; height: 30px;">
                <button type="button" class="lnk" onClick="{{closePerson}}">BACKAll contacts</button>
                <span style="flex: 1;"></span>
                <button type="button" class="btn">Pin</button>
                <button type="button" class="btnp">Message Priya</button>
              </div>
              <div style="display: flex; align-items: center; gap: 14px; margin-top: 12px;">
                <span class="av" style="width: 46px; height: 46px; font-size: 15px; color: var(--tx);">PN</span>
                <div style="display: flex; flex-direction: column; gap: 4px;">
                  <div style="display: flex; align-items: center; gap: 10px;">
                    <span class="disp" style="font-size: 26px; font-weight: 600; line-height: 1.1;">Priya Nair</span>
                    <span class="pill" style="margin-left: 2px;">Client</span>
                    <span class="chip" style="margin-left: 4px;"><span class="sq" style="background: var(--K);"></span>Keyframes</span>
                  </div>
                  <span style="color: var(--tx2);">Getting married Nov 15 and wants a wedding film. Last talked today at 11:22 AM, through the front desk.</span>
                </div>
              </div>

              <div style="display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 34px; margin-top: 22px;">
                <div style="display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--sep);"><span class="sh">What Atlas knows</span><span style="font-size: 12px; color: var(--tx3);">6 facts, each with its source</span></div>
                  <sc-for list="{{facts}}" as="f" hint-placeholder-count="6">
                    <div class="row" style="display: grid; grid-template-columns: minmax(0, 1fr) 176px 52px; gap: 12px; align-items: center; min-height: 34px; border-bottom: 1px solid var(--sep);">
                      <span style="font-size: 13px;">{{f.t}}</span>
                      <span style="font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{f.s}}</span>
                      <button type="button" class="qb" style="justify-self: end;">Correct</button>
                    </div>
                  </sc-for>

                  <div style="display: flex; align-items: baseline; gap: 8px; padding: 22px 0 8px; border-bottom: 1px solid var(--sep);"><span class="sh">Recent threads</span><span style="font-size: 12px; color: var(--tx3);">One thread, whichever way she writes</span></div>
                  <sc-for list="{{threads}}" as="t" hint-placeholder-count="3">
                    <div class="row" style="display: grid; grid-template-columns: 16px minmax(0, 1fr) auto 70px; gap: 12px; align-items: center; height: 44px; border-bottom: 1px solid var(--sep);">
                      <svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{t.d}}"></path></svg>
                      <span style="display: flex; flex-direction: column; min-width: 0;"><span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{t.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{t.sub}}</span></span>
                      <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: {{t.sc}};"><span style="width: 6px; height: 6px; background: {{t.dot}};"></span>{{t.st}}</span>
                      <span class="mono" style="font-size: 11px; color: var(--tx3); text-align: right;">{{t.time}}</span>
                    </div>
                  </sc-for>
                </div>

                <div style="display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--sep);"><span class="sh">Channels</span><span style="font-size: 12px; color: var(--tx3);">Atlas knows it’s her on all three</span></div>
                  <sc-for list="{{chans}}" as="c" hint-placeholder-count="3">
                    <div style="display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 10px; align-items: center; height: 34px; border-bottom: 1px solid var(--sep);">
                      <svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{c.d}}"></path></svg>
                      <span class="mono" style="font-size: 12px; color: var(--tx);">{{c.v}}</span>
                      <span style="font-size: 12px; color: var(--tx3);">{{c.note}}</span>
                    </div>
                  </sc-for>

                  <div style="display: flex; align-items: baseline; gap: 8px; padding: 22px 0 8px; border-bottom: 1px solid var(--sep);"><span class="sh">Open commitments</span><span style="font-size: 12px; color: var(--tx3);">3</span></div>
                  <sc-for list="{{commits}}" as="c" hint-placeholder-count="3">
                    <div style="display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 10px; align-items: center; height: 44px; border-bottom: 1px solid var(--sep);">
                      <span style="display: inline-flex; justify-content: center;">
                        <sc-if value="{{c.isAtlas}}" hint-placeholder-val="{{false}}">ADM</sc-if>
                        <sc-if value="{{c.isYou}}" hint-placeholder-val="{{false}}"><span style="width: 7px; height: 7px; box-sizing: border-box; border: 1.5px solid var(--ac);"></span></sc-if>
                        <sc-if value="{{c.isHold}}" hint-placeholder-val="{{false}}"><span style="width: 7px; height: 7px; box-sizing: border-box; border: 1px dashed var(--tx3);"></span></sc-if>
                      </span>
                      <span style="display: flex; flex-direction: column; min-width: 0;"><span style="font-weight: 500;">{{c.t}}</span><span style="font-size: 12px; color: var(--tx3);">{{c.sub}}</span></span>
                      <span style="font-size: 12px; color: {{c.dc}};">{{c.due}}</span>
                    </div>
                  </sc-for>

                  <div style="display: flex; align-items: baseline; gap: 8px; padding: 22px 0 10px;"><span class="sh">Trust</span><span style="font-size: 12px; color: var(--tx3);">Sets what faces may share with her</span></div>
                  <div style="display: inline-flex; align-self: flex-start; border: 1px solid var(--sep2); border-radius: 6px; overflow: hidden;">
                    <sc-for list="{{trustSeg}}" as="o" hint-placeholder-count="5"><button type="button" onClick="{{o.pick}}" style="height: 26px; padding: 0 11px; border: 0; border-left: 1px solid {{o.bl}}; background: {{o.bg}}; color: {{o.fg}}; font-size: 12px; font-weight: {{o.fw}};">{{o.l}}</button></sc-for>
                  </div>
                  <span style="font-size: 12px; color: var(--tx3); margin-top: 14px; padding-bottom: 6px; border-bottom: 1px solid var(--sep);">Faces that may talk to her</span>
                  <div style="display: flex; flex-direction: column;">
                    <sc-for list="{{pfaces}}" as="f" hint-placeholder-count="2">
                      <div style="display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: center; height: 40px; border-bottom: 1px solid var(--sep);">
                        <span style="display: flex; flex-direction: column; min-width: 0;"><span style="display: inline-flex; align-items: center; gap: 7px;"><span style="font-weight: 500;">{{f.n}}</span><span class="sq" style="background: {{f.c}};"></span></span><span style="font-size: 12px; color: var(--tx3);">{{f.sub}}</span></span>
                        <button type="button" role="switch" aria-checked="{{f.on}}" aria-label="{{f.n}} may talk to her" class="tg {{f.cls}}" onClick="{{f.flip}}"></button>
                      </div>
                    </sc-for>
                  </div>
                </div>
              </div>
            </div>
          </sc-if>

          <sc-if value="{{isMembers}}" hint-placeholder-val="{{false}}">
            <div style="display: flex; align-items: center; gap: 12px; padding: 16px 22px 0;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">Members</span>
              <span class="num" style="color: var(--tx3);">3 people share this Atlas, each with their own</span>
              <span style="flex: 1;"></span>
              <button type="button" class="btnp"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="stroke-width: 2.1;"><path d="M12 5v14M5 12h14"></path></svg>Invite someone</button>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 16px 22px 0;">
              <sc-for list="{{members}}" as="m" hint-placeholder-count="3">
                <div style="border: 1px solid {{m.bd}}; border-radius: 8px; background: var(--win); padding: 14px 16px 0; display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: center; gap: 11px;">
                    <span class="av" style="width: 36px; height: 36px; font-size: 12px; color: var(--tx);">{{m.i}}</span>
                    <span style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                      <span style="display: flex; align-items: center; gap: 8px;"><span class="disp" style="font-size: 16px; font-weight: 600;">{{m.n}}</span><sc-if value="{{m.you}}" hint-placeholder-val="{{false}}"><span style="font-size: 12px; color: var(--tx3);">You</span></sc-if></span>
                      <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx3);"><span class="{{m.lcls}}" style="width: 6px; height: 6px; border-radius: 50%; background: {{m.lc}};"></span>{{m.live}}</span>
                    </span>
                    <sc-if value="{{m.you}}" hint-placeholder-val="{{false}}"><span class="pill" style="color: var(--tx);">Owner</span></sc-if>
                  </div>
                  <div style="display: grid; grid-template-columns: 68px minmax(0, 1fr); gap: 0 10px; margin-top: 14px; font-size: 12.5px;">
                    <sc-for list="{{m.rows}}" as="r" hint-placeholder-count="3">
                      <span style="color: var(--tx3); font-size: 12px; padding: 7px 0; border-top: 1px solid var(--sep);">{{r.k}}</span>
                      <span style="padding: 7px 0; border-top: 1px solid var(--sep); display: flex; align-items: center; gap: 12px; flex-wrap: wrap; min-width: 0;">
                        <sc-for list="{{r.chips}}" as="a" hint-placeholder-count="1"><span class="chip" style="font-size: 12.5px; color: var(--tx);"><span class="sq" style="background: {{a.c}};"></span>{{a.n}}</span></sc-for>
                        <sc-if value="{{r.v}}" hint-placeholder-val="{{false}}"><span style="color: {{r.vc}};">{{r.v}}</span></sc-if>
                      </span>
                    </sc-for>
                  </div>
                  <div style="display: flex; align-items: center; gap: 10px; height: 44px; margin: 4px -16px 0; padding: 0 12px 0 16px; border-top: 1px dashed var(--dash);">
                    <sc-if value="{{m.canEdit}}" hint-placeholder-val="{{true}}">
                      <span style="font-size: 12px; color: var(--tx3);">Role</span>
                      <div style="display: inline-flex; border: 1px solid var(--sep2); border-radius: 6px; overflow: hidden;">
                        <sc-for list="{{m.seg}}" as="o" hint-placeholder-count="2"><button type="button" onClick="{{o.pick}}" style="height: 24px; padding: 0 10px; border: 0; border-left: 1px solid {{o.bl}}; background: {{o.bg}}; color: {{o.fg}}; font-size: 12px; font-weight: {{o.fw}};">{{o.l}}</button></sc-for>
                      </div>
                      <span style="flex: 1;"></span>
                      <button type="button" class="qb">Remove</button>
                    </sc-if>
                    <sc-if value="{{m.you}}" hint-placeholder-val="{{false}}">
                      <span style="font-size: 12px; color: var(--tx3);">Full control of this Atlas, its bills and its keys.</span>
                    </sc-if>
                  </div>
                </div>
              </sc-for>
            </div>

            <div style="display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; padding: 22px 22px 0;">
              <div style="display: flex; flex-direction: column;">
                <div style="display: flex; align-items: center; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--sep);"><span class="sh">Shared areas</span><span style="font-size: 12px; color: var(--tx3);">Everything else stays with whoever it belongs to</span><span style="flex: 1;"></span><button type="button" class="qb">Share an area</button></div>
                <sc-for list="{{shared}}" as="s" hint-placeholder-count="2">
                  <div class="row" style="display: grid; grid-template-columns: 140px 76px minmax(0, 1fr); gap: 14px; align-items: center; min-height: 58px; border-bottom: 1px solid var(--sep);">
                    <span style="display: flex; flex-direction: column; gap: 2px;"><span style="display: inline-flex; align-items: center; gap: 8px; font-weight: 500;"><span class="sq" style="width: 8px; height: 8px; background: {{s.c}};"></span>{{s.n}}</span><span style="font-size: 12px; color: var(--tx3); padding-left: 16px;">{{s.count}}</span></span>
                    <span style="display: inline-flex;"><sc-for list="{{s.who}}" as="w" hint-placeholder-count="2"><span class="av" style="width: 24px; height: 24px; font-size: 9px; margin-right: -6px; border: 2px solid var(--win);">{{w}}</span></sc-for></span>
                    <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span>{{s.what}}</span><span style="font-size: 12px; color: var(--tx3);">{{s.how}}</span></span>
                  </div>
                </sc-for>
                <div style="display: flex; align-items: center; gap: 9px; padding: 14px 0 0;">
                  LOCK
                  <span style="color: var(--tx2);">No one can read another member’s private records. That includes you.</span>
                </div>
                <span style="font-size: 12px; color: var(--tx3); padding: 6px 0 0 22px;">Admins can also invite people and change Atlas settings.</span>
              </div>

              <div style="border: 1px dashed var(--dash); border-radius: 8px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; align-self: start;">
                <span class="sh">Invite someone</span>
                <span style="font-size: 12.5px; color: var(--tx2);">They get their own thread, records and voice. You pick what to share.</span>
                <div style="display: flex; align-items: center; gap: 8px; height: 32px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; background: var(--bg); padding: 0 4px 0 10px;">
                  <svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>
                  <span class="mono" style="font-size: 11.5px; color: var(--tx2); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">atlas.barbare.me/join</span>
                  <button type="button" class="btn" style="height: 24px; padding: 0 9px; font-size: 12px;">Copy link</button>
                </div>
                <span style="font-size: 12px; color: var(--tx3);">Works once and expires in 7 days.</span>
                <div style="display: flex; align-items: center; gap: 10px; padding-top: 10px; border-top: 1px solid var(--sep);">
                  <span class="av" style="width: 24px; height: 24px; font-size: 9px; border: 1px dashed var(--dash); background: transparent;">SO</span>
                  <span style="display: flex; flex-direction: column; flex: 1; min-width: 0;"><span style="font-weight: 500;">Sam Ortiz</span><span style="font-size: 12px; color: var(--tx3);">Invited to Home on Oct 22</span></span>
                  <button type="button" class="qb">Resend</button>
                </div>
              </div>
            </div>
          </sc-if>

          <sc-if value="{{isFaces}}" hint-placeholder-val="{{false}}">
            <div style="display: flex; align-items: center; gap: 12px; padding: 16px 22px 0;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">Faces</span>
              <span style="color: var(--tx3);">Atlas, for people who aren’t you. Every face says it’s an AI.</span>
              <span style="flex: 1;"></span>
              <button type="button" class="btn"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>New face</button>
            </div>
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding: 16px 22px 0;">
              <sc-for list="{{faces}}" as="f" hint-placeholder-count="2">
                <div role="button" tabindex="0" class="card" onClick="{{f.open}}" style="border: 1px solid var(--sep2); border-radius: 8px; background: var(--win); padding: 15px 16px 0; display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: center; gap: 11px;">
                    <span style="width: 34px; height: 34px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 7px; display: inline-flex; align-items: center; justify-content: center; background: var(--bg);">FDIA</span>
                    <span style="display: flex; flex-direction: column; flex: 1; min-width: 0;">
                      <span style="display: flex; align-items: center; gap: 10px;"><span class="disp" style="font-size: 17px; font-weight: 600;">{{f.n}}</span><span class="chip"><span class="sq" style="background: {{f.c}};"></span>{{f.area}}</span></span>
                      <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2);"><span class="{{f.lcls}}" style="width: 6px; height: 6px; border-radius: 50%; background: {{f.lc}};"></span>{{f.live}}</span>
                    </span>
                    <button type="button" role="switch" aria-checked="true" aria-label="On" class="tg on"></button>
                  </div>
                  <span style="margin-top: 12px; color: var(--tx2); font-size: 12.5px;">“{{f.intro}}”</span>
                  <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 11px;">
                    <sc-for list="{{f.addr}}" as="a" hint-placeholder-count="3">
                      <span style="height: 24px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; padding: 0 8px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx);"><svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="{{a.d}}"></path></svg><span class="{{a.cls}}" style="font-size: {{a.fs}};">{{a.v}}</span></span>
                    </sc-for>
                  </div>
                  <div style="display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 0 12px; margin: 12px 0 4px; font-size: 12.5px;">
                    <sc-for list="{{f.rows}}" as="r" hint-placeholder-count="6">
                      <span style="color: var(--tx3); font-size: 12px; padding: 6px 0; border-top: 1px solid var(--sep);">{{r.k}}</span>
                      <span style="padding: 6px 0; border-top: 1px solid var(--sep); color: var(--tx);">{{r.v}}</span>
                    </sc-for>
                  </div>
                  <div style="display: flex; align-items: center; gap: 12px; height: 46px; margin: auto -16px 0; padding-top: 0; padding: 0 14px 0 16px; border-top: 1px dashed var(--dash);">
                    <span aria-label="Conversations per day this week" style="display: inline-flex; align-items: flex-end; gap: 3px; height: 18px;"><sc-for list="{{f.bars}}" as="b" hint-placeholder-count="7"><span style="width: 5px; height: {{b.h}}px; background: {{b.c}};"></span></sc-for></span>
                    <span style="font-size: 12px; color: var(--tx2);"><span class="num" style="color: var(--tx); font-weight: 500;">{{f.convs}}</span> conversations this week<span style="color: var(--tx3);"> · </span><span class="num" style="color: var(--tx); font-weight: 500;">{{f.handed}}</span> handed to you</span>
                    <span style="flex: 1;"></span>
                    <sc-if value="{{f.waiting}}" hint-placeholder-val="{{false}}"><span class="tag" style="color: var(--ac); border-color: var(--ac);"><span style="width: 5px; height: 5px; background: var(--ac);"></span>{{f.waiting}}</span></sc-if>
                    <sc-if value="{{f.quiet}}" hint-placeholder-val="{{false}}"><span style="font-size: 12px; color: var(--tx3);">{{f.quiet}}</span></sc-if>
                  </div>
                </div>
              </sc-for>
            </div>
            <div style="display: flex; flex-direction: column; padding: 20px 22px 0;">
              <div style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--sep);"><span class="sh">Latest conversations</span><span style="font-size: 12px; color: var(--tx3);">All of them are in History. What a face hands you goes to Inbox.</span></div>
              <sc-for list="{{latest}}" as="c" hint-placeholder-count="4">
                <div class="row" style="display: grid; grid-template-columns: 24px 140px minmax(0, 1fr) 150px 200px 70px; gap: 12px; align-items: center; height: 40px; border-bottom: 1px solid var(--sep);">
                  <span class="av" style="width: 24px; height: 24px; font-size: 9px; border: {{c.avb}}; background: {{c.avbg}};">{{c.i}}</span>
                  <span style="display: flex; align-items: center; gap: 7px; min-width: 0;"><span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.n}}</span><svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="{{c.d}}"></path></svg></span>
                  <span style="color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.what}}</span>
                  <span class="chip"><span class="sq" style="background: {{c.fc}};"></span>{{c.face}}</span>
                  <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: {{c.oc}}; white-space: nowrap;"><span style="color: {{c.mc}};">{{c.m}}</span>{{c.out}}</span>
                  <span class="mono" style="font-size: 11px; color: var(--tx3); text-align: right;">{{c.t}}</span>
                </div>
              </sc-for>
            </div>
          </sc-if>

          <sc-if value="{{isFace}}" hint-placeholder-val="{{false}}">
            <div class="rise" style="padding: 16px 22px 0; display: flex; flex-direction: column;">
              <div style="display: flex; align-items: center; gap: 8px; height: 30px;">
                <button type="button" class="lnk" onClick="{{closeFace}}">BACKAll faces</button>
                <span style="flex: 1;"></span>
                <span style="font-size: 12px; color: var(--tx3); margin-right: 2px;">Speaks as</span>
                <div style="display: inline-flex; border: 1px solid var(--sep2); border-radius: 6px; overflow: hidden; margin-right: 8px;">
                  <sc-for list="{{asSeg}}" as="o" hint-placeholder-count="2"><button type="button" onClick="{{o.pick}}" style="height: 28px; padding: 0 11px; border: 0; border-left: 1px solid {{o.bl}}; background: {{o.bg}}; color: {{o.fg}}; font-size: 12px; font-weight: {{o.fw}};">{{o.l}}</button></sc-for>
                </div>
                <button type="button" class="btnp"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="stroke-width: 2;"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>Talk to it as a stranger</button>
                <button type="button" class="btn">Pause</button>
              </div>
              <div style="display: flex; align-items: center; gap: 12px; margin-top: 12px;">
                <span style="width: 36px; height: 36px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: var(--bg);">FDIA</span>
                <span class="disp" style="font-size: 26px; font-weight: 600; line-height: 1.1;">Keyframes front desk</span>
                <span class="chip" style="margin-left: 4px;"><span class="sq" style="background: var(--K);"></span>Keyframes</span>
                <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--tx2); margin-left: 8px;"><span class="live" style="width: 6px; height: 6px; border-radius: 50%; background: var(--F);"></span>Live · replied 4 min ago on Telegram</span>
              </div>
              <span style="color: var(--tx2); margin-top: 7px; padding-left: 48px;">Introduces itself: “Hi, this is Atlas at Keyframes Studio. I’m an AI that helps Max with bookings.”</span>

              <div style="display: flex; align-items: stretch; margin-top: 22px;">
                <sc-for list="{{flow}}" as="b" hint-placeholder-count="5">
                  <sc-if value="{{b.join}}" hint-placeholder-val="{{false}}">ARROW</sc-if>
                  <div style="flex: 0 0 {{b.w}}px; box-sizing: border-box; border: 1px dashed var(--dash); border-radius: 8px; padding: 10px 10px 10px; display: flex; flex-direction: column; gap: 6px; min-width: 0;">
                    <span style="font-size: 12px; font-weight: 600; color: var(--tx); padding: 0 2px 2px;">{{b.t}}</span>
                    <sc-for list="{{b.items}}" as="x" hint-placeholder-count="3">
                      <div style="border: 1px solid var(--sep2); border-radius: 6px; background: var(--win); padding: 6px 9px; display: flex; align-items: center; gap: 7px; min-height: 30px; box-sizing: border-box; min-width: 0;">
                        <sc-if value="{{x.d}}" hint-placeholder-val="{{false}}"><svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="{{x.d}}"></path></svg></sc-if>
                        <sc-if value="{{x.sq}}" hint-placeholder-val="{{false}}"><span class="sq" style="background: {{x.sq}};"></span></sc-if>
                        <span class="{{x.cls}}" style="font-size: {{x.fs}}; font-weight: {{x.fw}}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;">{{x.v}}</span>
                      </div>
                    </sc-for>
                    <span style="margin-top: auto; padding: 4px 2px 0; font-size: 11.5px; color: var(--tx3); display: inline-flex; align-items: center; gap: 6px;"><sc-if value="{{b.ac}}" hint-placeholder-val="{{false}}"><span style="width: 5px; height: 5px; background: var(--ac); flex: none;"></span></sc-if>{{b.foot}}</span>
                  </div>
                </sc-for>
              </div>

              <div style="display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 28px; margin-top: 22px;">
                <div style="display: flex; flex-direction: column;">
                  <div style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--sep);"><span class="sh">Recent conversations</span><span style="font-size: 12px; color: var(--tx3);">All of them are in History</span></div>
                  <sc-for list="{{convs}}" as="c" hint-placeholder-count="4">
                    <div class="row" style="display: grid; grid-template-columns: 24px 128px minmax(0, 1fr) 176px 70px; gap: 12px; align-items: center; height: 40px; border-bottom: 1px solid var(--sep);">
                      <span class="av" style="width: 24px; height: 24px; font-size: 9px; border: {{c.avb}}; background: {{c.avbg}};">{{c.i}}</span>
                      <span style="display: flex; align-items: center; gap: 7px; min-width: 0;"><span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.n}}</span><svg class="ic" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="{{c.d}}"></path></svg></span>
                      <span style="color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{c.what}}</span>
                      <span style="display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: {{c.oc}}; white-space: nowrap;"><span style="color: {{c.mc}};">{{c.m}}</span>{{c.out}}</span>
                      <span class="mono" style="font-size: 11px; color: var(--tx3); text-align: right;">{{c.t}}</span>
                    </div>
                  </sc-for>
                </div>
                <div style="border: 1px solid var(--sep); border-radius: 8px; background: var(--bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; align-self: start;">
                  <div style="display: flex; align-items: baseline;"><span class="sh">This week</span><span style="flex: 1;"></span><span style="font-size: 12px; color: var(--tx3);">Mon to today</span></div>
                  <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;">
                    <sc-for list="{{stats}}" as="s" hint-placeholder-count="3"><span style="display: flex; flex-direction: column;"><span class="disp num" style="font-size: 22px; font-weight: 600; color: {{s.c}};">{{s.v}}</span><span style="font-size: 12px; color: var(--tx3);">{{s.l}}</span></span></sc-for>
                  </div>
                  <div style="display: flex; align-items: flex-end; gap: 6px; height: 34px; padding-top: 4px;">
                    <sc-for list="{{week}}" as="d" hint-placeholder-count="7"><span style="flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;"><span style="width: 100%; height: {{d.h}}px; background: {{d.c}};"></span></span></sc-for>
                  </div>
                  <div class="mono" style="display: flex; gap: 6px; font-size: 10px; color: var(--tx3); margin-top: -4px;"><sc-for list="{{week}}" as="d" hint-placeholder-count="7"><span style="flex: 1; text-align: center;">{{d.l}}</span></sc-for></div>
                  <div style="display: flex; align-items: center; gap: 8px; padding-top: 10px; border-top: 1px solid var(--sep); font-size: 12.5px;"><span style="color: var(--F);">✓</span><span style="color: var(--tx2); flex: 1;">Digest sent at 6:00 PM</span><button type="button" class="qb">Read it</button></div>
                </div>
              </div>
            </div>
          </sc-if>
""".replace('DIA_AC', DIA_AC).replace('ADM', ADM).replace('LOCK', LOCK).replace('BACK', BACK).replace('ARROW', ARROW).replace('FDIA', diamond(9, 16))

JS = r"""
  renderVals() {
    var self = this;
    var st = this.state;
    var tab = st.tab || 'Contacts';
    var A = { Personal: 'var(--P)', Keyframes: 'var(--K)', UCF: 'var(--U)', Fitness: 'var(--F)', Health: 'var(--H)', Home: 'var(--Hm)' };
    var G = {
      mail: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3.5 6.5 12 13l8.5-6.5',
      phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z',
      tg: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
      web: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20',
      msg: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
    };
    var RGB = { Personal: 'var(--Prgb)', Keyframes: 'var(--Krgb)', UCF: 'var(--Urgb)', Fitness: 'var(--Frgb)', Health: 'var(--Hrgb)', Home: '45,170,160' };
    function chip(n) { return { n: n, c: A[n], rgb: RGB[n] || '145,141,134' }; }
    function segc(opts, cur, key) {
      return opts.map(function (o, k) {
        var on = o === cur;
        return { l: o, bl: k === 0 ? 'transparent' : 'var(--sep2)', bg: on ? 'var(--sel)' : 'transparent', fg: on ? 'var(--tx)' : 'var(--tx3)', fw: on ? 500 : 400, pick: function () { var s = {}; s[key] = o; self.setState(s); } };
      });
    }

    // Contacts
    var trustF = st.trust || 'All';
    var F = [['All', '214'], ['Family', '9'], ['Friend', '41'], ['Colleague', '32'], ['Client', '58'], ['Unknown', '74']];
    var plural = { All: 'All', Family: 'Family', Friend: 'Friends', Colleague: 'Colleagues', Client: 'Clients', Unknown: 'Unknown' };
    var filters = F.map(function (f) {
      var on = f[0] === trustF;
      return { n: plural[f[0]], c: f[1], bg: on ? 'var(--sel)' : 'transparent', bd: on ? 'var(--dash)' : 'var(--sep2)', fg: on ? 'var(--tx)' : 'var(--tx2)', pick: function () { self.setState({ trust: f[0] }); } };
    });
    function pr(i, n, rel, trust, chans, usual, as, last, via, k, o) {
      o = o || {};
      var lvl = k > 60 ? 5 : k > 30 ? 4 : k > 12 ? 3 : k > 5 ? 2 : 1, segs = [];
      for (var j = 0; j < 5; j++) segs.push(j < lvl ? 'var(--tx2)' : 'var(--sep2)');
      var ch = ['mail', 'phone', 'tg'].map(function (c) {
        var has = chans.indexOf(c) >= 0;
        return { d: G[c], l: { mail: 'Email', phone: 'Phone', tg: 'Telegram' }[c], c: c === usual ? 'var(--tx)' : 'var(--tx3)', op: has ? 1 : 0 };
      });
      return { i: i, n: n, ac: A[as[0]] || 'var(--tx2)', argb: RGB[as[0]] || '145,141,134', rel: rel, trust: trust, tbs: trust === 'Unknown' ? 'dashed' : 'solid', tfg: trust === 'Unknown' ? 'var(--tx3)' : 'var(--tx2)',
        ch: ch, areas: as.map(chip), last: last, via: via, lc: o.today ? 'var(--tx)' : 'var(--tx2)', k: k + ' facts', segs: segs, tag: o.tag || '',
        open: o.open || function () {} };
    }
    var openPriya = function () { self.setState({ person: 'priya' }); };
    var people = [
      pr('TB', 'Taylor Brooks', 'Asked the front desk about a music video', 'Unknown', ['tg'], 'tg', ['Keyframes'], '4 min ago', 'front desk', 2, { today: true, tag: 'New' }),
      pr('M', 'Mom', 'Calls on Sundays', 'Family', ['mail', 'phone'], 'phone', ['Personal'], '18 min ago', 'by text', 86, { today: true }),
      pr('PN', 'Priya Nair', 'Wedding film on Nov 15', 'Client', ['mail', 'phone', 'tg'], 'mail', ['Keyframes'], 'Today, 11:22 AM', 'front desk', 6, { today: true, open: openPriya }),
      pr('JP', 'Jordan Park', 'Calc II study group', 'Friend', ['phone'], 'phone', ['UCF'], 'Yesterday', 'by text', 9),
      pr('SO', 'Sam Ortiz', 'Roommate and gym buddy', 'Friend', ['phone', 'tg'], 'phone', ['Personal', 'Fitness'], 'Yesterday', 'by text', 37),
      pr('DP', 'Dev Patel', 'Riverside promo', 'Client', ['mail', 'phone'], 'mail', ['Keyframes'], 'Oct 19', 'by email', 18),
      pr('D', 'Dad', 'Fixes everything, calls rarely', 'Family', ['mail', 'phone'], 'phone', ['Personal'], 'Oct 19', 'by phone', 64),
      pr('MC', 'Mike Chen', 'Trainer at Crunch', 'Friend', ['phone'], 'phone', ['Fitness'], 'Oct 17', 'by text', 7),
      pr('HR', 'Hannah Reyes', 'Professor, Film Theory', 'Colleague', ['mail'], 'mail', ['UCF'], 'Oct 16', 'by email', 12),
      pr('JL', 'Jordan Lee', 'Editor at Keyframes', 'Colleague', ['mail', 'phone'], 'mail', ['Keyframes', 'Personal'], 'Oct 14', 'by email', 41, { tag: 'Member' })
    ];

    // Priya
    var facts = [
      { t: 'Getting married Nov 15 at Lake Eola Park', s: 'Her email, today' },
      { t: 'Wants a highlight film and the full ceremony', s: 'Her email, today' },
      { t: 'Budget is around $2,500', s: 'Told the front desk, today' },
      { t: 'Her fiancé is Rohan Mehta', s: 'Her email, today' },
      { t: 'Found Keyframes through Dev Patel', s: 'Dev’s intro email, Oct 19' },
      { t: 'Prefers email and replies within a day', s: 'Atlas noticed, 3 threads' }
    ];
    var threads = [
      { d: G.mail, n: 'Wedding film, Nov 15', sub: 'The front desk handed it to you: she wants extras', st: 'Waiting on you', sc: 'var(--ac)', dot: 'var(--ac)', time: '11:22 AM' },
      { d: G.tg, n: 'Rates and open dates', sub: 'The front desk sent the 2026 rate card', st: 'Done', sc: 'var(--tx3)', dot: 'var(--sep2)', time: 'Oct 20' },
      { d: G.mail, n: 'Intro from Dev Patel', sub: 'Dev introduced her to you', st: 'Done', sc: 'var(--tx3)', dot: 'var(--sep2)', time: 'Oct 19' }
    ];
    var chans = [
      { d: G.mail, v: 'priya.nair@gmail.com', note: 'Usual' },
      { d: G.phone, v: '(407) 555-0186', note: 'From her signature' },
      { d: G.tg, v: '@priyanair', note: 'Since Oct 20' }
    ];
    var commits = [
      { isYou: true, t: 'Send her a quote', sub: 'The front desk said you’d reply today', due: 'Today', dc: 'var(--ac)' },
      { isHold: true, t: 'Nov 15 is held, all day', sub: 'A soft hold by the front desk', due: 'Until Oct 31', dc: 'var(--tx2)' },
      { isAtlas: true, t: 'Send the contract', sub: 'Atlas will, once you agree a price', due: 'After the call', dc: 'var(--tx2)' }
    ];
    commits.forEach(function (c) { c.isYou = !!c.isYou; c.isHold = !!c.isHold; c.isAtlas = !!c.isAtlas; });
    var trustSeg = segc(['Family', 'Friend', 'Colleague', 'Client', 'Unknown'], st.ptrust || 'Client', 'ptrust');
    var famOn = !!st.famOn, deskOn = st.deskOn !== false;
    var pfaces = [
      { n: 'Keyframes front desk', c: 'var(--K)', sub: 'Answers her by email and Telegram', on: deskOn, cls: deskOn ? 'on' : '', flip: function () { self.setState({ deskOn: !deskOn }); } },
      { n: 'Family', c: 'var(--P)', sub: 'Only for family and friends', on: famOn, cls: famOn ? 'on' : '', flip: function () { self.setState({ famOn: !famOn }); } }
    ];

    // Members
    var alexRole = st.alexRole || 'Admin', jlRole = st.jlRole || 'Member';
    function mrows(shares, voice, own, joined) { return [{ k: 'Shares', chips: shares.map(chip), v: '' }, { k: 'Private', chips: [], v: own, vc: 'var(--tx)' }, { k: 'Voice', chips: [], v: voice, vc: 'var(--tx)' }, { k: 'Joined', chips: [], v: joined, vc: 'var(--tx2)' }]; }
    var members = [
      { i: 'MB', n: 'Max Barbare', you: true, canEdit: false, role: 'Owner', live: 'Here now', lc: 'var(--F)', lcls: 'live', bd: 'var(--dash)', rows: mrows(['Home', 'Keyframes'], 'Harlan', '4 areas only you see', 'Set up this Atlas on Sep 2') },
      { i: 'AR', n: 'Alex Rivera', you: false, canEdit: true, role: alexRole, live: 'Active 20 min ago', lc: 'var(--tx3)', lcls: '', bd: 'var(--sep)', rows: mrows(['Home'], 'Wren', '2 areas only they see', 'Sep 9, invited by you'), seg: segc(['Admin', 'Member'], alexRole, 'alexRole') },
      { i: 'JL', n: 'Jordan Lee', you: false, canEdit: true, role: jlRole, live: 'Last here yesterday', lc: 'var(--tx3)', lcls: '', bd: 'var(--sep)', rows: mrows(['Keyframes'], 'Inés', '1 area only they see', 'Sep 20, invited by you'), seg: segc(['Admin', 'Member'], jlRole, 'jlRole') }
    ];
    var shared = [
      { n: 'Home', c: A.Home, count: '146 items', who: ['MB', 'AR'], what: 'Bills, groceries, the lease, the thermostat', how: 'Both of you can ask about it and add to it' },
      { n: 'Keyframes', c: A.Keyframes, count: '388 items', who: ['MB', 'JL'], what: 'Clients, shoots, projects, the front desk', how: 'Jordan sees shoots and projects, not money' }
    ];

    // Faces
    var openDesk = function () { self.setState({ face: 'desk' }); };
    function bars(v) { var out = []; for (var k = 0; k < 7; k++) { var x = v[k]; out.push(x == null ? { h: 2, c: 'var(--sep2)' } : { h: Math.max(2, Math.round(x / 4 * 18)), c: k === v.length - 1 ? 'var(--tx)' : 'var(--tx3)' }); } return out; }
    var faces = [
      { n: 'Keyframes front desk', area: 'Keyframes', c: 'var(--K)', live: 'Live · replied 4 min ago on Telegram', lc: 'var(--F)', lcls: 'live', open: openDesk,
        intro: 'Hi, this is Atlas at Keyframes Studio. I’m an AI that helps Max with bookings.',
        addr: [{ d: G.mail, v: 'bookings@keyframes.studio', cls: 'mono', fs: '11.5px' }, { d: G.tg, v: 'Telegram', cls: '', fs: '12px' }, { d: G.web, v: 'Website chat', cls: '', fs: '12px' }],
        rows: [{ k: 'Answers', v: 'Anyone' }, { k: 'Shares', v: 'Rate card, FAQs, free or busy' }, { k: 'Can', v: 'Book and hold time, take messages, answer FAQs, send the rate card' }, { k: 'Pulls you in', v: 'When money’s involved, it’s urgent, or it can’t answer' }, { k: 'Speaks as', v: 'Atlas' }, { k: 'Digest', v: 'Daily at 6 PM' }],
        bars: bars([2, 3, 1, 4, 4]), convs: 14, handed: 3, waiting: '1 in Inbox', quiet: '' },
      { n: 'Family', area: 'Personal', c: 'var(--P)', live: 'On · last replied yesterday, to Dad', lc: 'var(--tx3)', lcls: '', open: function () {},
        intro: 'Hi, it’s Atlas, Max’s AI assistant. Max can’t pick up right now.',
        addr: [{ d: G.msg, v: 'Atlas’s main number', cls: '', fs: '12px' }, { d: G.tg, v: 'Telegram', cls: '', fs: '12px' }],
        rows: [{ k: 'Answers', v: 'Known contacts only: family and friends' }, { k: 'Shares', v: 'Whether Max is free or busy' }, { k: 'Can', v: 'Say when Max is free, take messages' }, { k: 'Pulls you in', v: 'When it’s urgent, or it can’t answer' }, { k: 'Speaks as', v: 'Atlas' }, { k: 'Digest', v: 'Daily at 9 PM' }],
        bars: bars([1, 0, 2, 1, 1]), convs: 5, handed: 0, waiting: '', quiet: 'Nothing waiting' }
    ];

    // Front desk, opened
    function it(v, o) { o = o || {}; return { v: v, d: o.d || '', sq: o.sq || '', cls: o.mono ? 'mono' : '', fs: o.mono ? '11px' : '12.5px', fw: o.b ? 600 : 400 }; }
    var flow = [
      { join: false, w: 226, t: 'Who it answers', items: [it('Anyone', { b: true }), it('bookings@keyframes.studio', { d: G.mail, mono: true }), it('Telegram', { d: G.tg }), it('Website chat', { d: G.web })], foot: 'Always says it’s an AI', ac: false },
      { join: true, w: 182, t: 'Covers and shares', items: [it('Keyframes', { sq: 'var(--K)', b: true }), it('2026 rate card'), it('FAQs, 18 answers'), it('Free or busy')], foot: 'Never mentions other areas', ac: false },
      { join: true, w: 182, t: 'What it can do', items: [it('Book and hold time'), it('Take messages'), it('Answer FAQs'), it('Send the rate card')], foot: 'Holds last 7 days', ac: false },
      { join: true, w: 176, t: 'When it pulls you in', items: [it('Money’s involved'), it('Something’s urgent'), it('It can’t answer')], foot: 'Straight to Inbox', ac: true },
      { join: true, w: 164, t: 'Digest', items: [it('Daily at 6 PM', { b: true }), it('Urgent ones at once')], foot: 'To your phone', ac: false }
    ];
    var convs = [
      { i: 'TB', n: 'Taylor Brooks', d: G.tg, what: 'Music video in December, asked for dates', m: '◇', mc: 'var(--tx3)', out: 'Held Dec 6, waiting on them', oc: 'var(--tx2)', t: '4 min ago', avb: '0', avbg: 'var(--sel)' },
      { i: '?', n: 'Website visitor', d: G.web, what: 'Do you shoot real estate?', m: '✓', mc: 'var(--F)', out: 'Answered from the FAQs', oc: 'var(--tx2)', t: '2:10 PM', avb: '1px dashed var(--dash)', avbg: 'transparent' },
      { i: 'PN', n: 'Priya Nair', d: G.mail, what: 'Full-day wedding film with extras', m: '■', mc: 'var(--ac)', out: 'Handed to you: price', oc: 'var(--ac)', t: '11:22 AM', avb: '0', avbg: 'var(--sel)' },
      { i: 'MH', n: 'Marcus Hill', d: G.tg, what: 'Rates for a 30 second product spot', m: '✓', mc: 'var(--F)', out: 'Sent the rate card', oc: 'var(--tx2)', t: 'Mon', avb: '0', avbg: 'var(--sel)' }
    ];
    var latest = convs.slice(0, 3).map(function (c) { return Object.assign({ face: 'Front desk', fc: 'var(--K)' }, c); });
    latest.push({ i: 'D', n: 'Dad', d: G.msg, what: 'Is Max free for lunch on Sunday?', face: 'Family', fc: 'var(--P)', m: '✓', mc: 'var(--F)', out: 'Said Max is free after 1 PM', oc: 'var(--tx2)', t: 'Yesterday', avb: '0', avbg: 'var(--sel)' });
    var stats = [{ v: '14', l: 'conversations', c: 'var(--tx)' }, { v: '11', l: 'handled alone', c: 'var(--tx)' }, { v: '3', l: 'handed to you', c: 'var(--tx)' }];
    var wk = [2, 3, 1, 4, 4], wl = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    var week = wl.map(function (l, k) { var v = wk[k]; return { l: l, h: v == null ? 2 : Math.round(v / 4 * 28), c: v == null ? 'var(--sep)' : (k === 4 ? 'var(--tx)' : 'var(--tx3)') }; });

    var person = tab === 'Contacts' && st.person === 'priya';
    var face = tab === 'Faces' && st.face === 'desk';
    var tabs = this.mkTabs([['Contacts', '214'], ['Members', '3'], ['Faces', '2']], tab, 'tab');
    tabs.forEach(function (t) { var p = t.pick; t.pick = function () { self.setState({ person: '', face: '' }); p(); }; });
    var meta = person ? 'Contact · 6 facts' : face ? 'Face · since Sep 20' : { Contacts: 'Synced 7:14 PM', Members: '3 members · 1 invite out', Faces: '2 faces · 1 live now' }[tab];

    return Object.assign(this.shellVals('People'), {
      tabs: tabs, meta: meta,
      isContacts: tab === 'Contacts' && !person, isPerson: person, isMembers: tab === 'Members', isFaces: tab === 'Faces' && !face, isFace: face,
      filters: filters, people: people,
      closePerson: function () { self.setState({ person: '' }); },
      facts: facts, threads: threads, chans: chans, commits: commits, trustSeg: trustSeg, pfaces: pfaces,
      members: members, shared: shared,
      faces: faces, latest: latest,
      closeFace: function () { self.setState({ face: '' }); },
      asSeg: segc(['Atlas', 'You'], st.speaks || 'Atlas', 'speaks'), flow: flow, convs: convs, stats: stats, week: week
    });
  }
"""

if __name__ == '__main__':
    out = page(title='Atlas · People', active='People', label='People', body=BODY, js=JS, extra_css=CSS,
               placeholder='Ask about anyone, or say who a face should answer', state="{ tab: 'Contacts' }")
    open('../People.dc.html', 'w').write(out)
    print('wrote People')
