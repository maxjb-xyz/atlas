from shell import page, diamond

# Abilities (M7, VISION §21.2): what Atlas can do. It opens on a live map,
# then Services (the catalog, §17, as cards), Skills (§9.3) and Devices (§16.3).
# A service opens in place on the sheet, never in a side pane.

EXTRA_CSS = r"""
.card{border:1px solid var(--sep);border-radius:8px;background:var(--win);box-sizing:border-box}
.card.hov{transition:border-color .12s,transform .12s}.card.hov:hover{border-color:var(--dash)}
.mk{width:34px;height:34px;border-radius:8px;border:1px solid var(--sep2);background:var(--bg);display:inline-flex;align-items:center;justify-content:center;font-family:'Inter Tight',Inter,sans-serif;font-weight:600;font-size:15px;color:var(--tx);flex:none}
.dot{width:6px;height:6px;border-radius:50%;flex:none}
.tg{width:26px;height:15px;border-radius:8px;position:relative;flex:none;display:inline-block}
.tg::after{content:'';position:absolute;top:2px;width:11px;height:11px;border-radius:50%;background:var(--kn)}
.tg.on{background:var(--btn);--kn:var(--btntx)}.tg.on::after{left:13px}
.tg.off{background:var(--sep2);--kn:var(--win)}.tg.off::after{left:2px}
.chip{height:24px;padding:0 10px;border-radius:12px;border:1px solid var(--sep2);background:var(--win);color:var(--tx2);font-size:12px;display:inline-flex;align-items:center;gap:6px}
.chip.on{background:var(--sel);color:var(--tx);border-color:var(--dash)}
.wire{position:absolute;border-color:var(--dash);border-style:dashed;border-width:0}
"""

ICONS = {
    'brains': 'M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 9h6v6H9z',
    'senses': 'M4.9 19.1a10 10 0 0 1 0-14.2M7.8 16.2a6 6 0 0 1 0-8.4M16.2 7.8a6 6 0 0 1 0 8.4M19.1 4.9a10 10 0 0 1 0 14.2M12 12h.01',
    'channels': 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    'hands': 'M4 17l6-6-6-6M12 19h8',
    'cando': 'M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8z',
    'skills': 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5zM9 9l2 2 4-4',
    'devices': 'M2 18h20M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10',
    'exits': 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
}

# The map is laid out on a fixed board (the sheet is 1100 x 690): boxes 300 wide in three
# columns, the core in the middle, and two buses in the side gaps that join each column's
# boxes to the core.
COLS = [24, 400, 776]
ROWS = [64, 262, 460]
BW, BH = 300, 168

MAP = r"""
            <div style="position: absolute; left: 24px; right: 24px; top: 16px; display: flex; align-items: baseline; gap: 12px;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">Everything Atlas can do</span>
              <span style="color: var(--tx3);">14 on · 2 need you · $31.20 this month</span>
              <span style="flex: 1;"></span>
              <span style="display: inline-flex; gap: 14px; font-size: 12px; color: var(--tx3);">
                <span style="display: inline-flex; align-items: center; gap: 6px;"><span class="dot" style="background: var(--F);"></span>On</span>
                <span style="display: inline-flex; align-items: center; gap: 6px;"><span class="dot" style="background: var(--tx3);"></span>Asleep</span>
                <span style="display: inline-flex; align-items: center; gap: 6px;"><span class="dot" style="background: var(--ac);"></span>Needs you</span>
                <span style="display: inline-flex; align-items: center; gap: 6px;"><span class="dot" style="border: 1px solid var(--tx3); box-sizing: border-box;"></span>Off</span>
              </span>
            </div>
            WIRES
            <sc-for list="{{groups}}" as="g" hint-placeholder-count="8">
              <button type="button" class="card hov" onClick="{{g.go}}" style="position: absolute; left: {{g.x}}px; top: {{g.y}}px; width: BWpx; height: BHpx; padding: 12px 14px; text-align: left; display: flex; flex-direction: column; gap: 8px;">
                <span style="display: flex; align-items: center; gap: 8px; width: 100%;">
                  <svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{g.d}}"></path></svg>
                  <span style="font-weight: 600;">{{g.n}}</span>
                  <span style="font-size: 12px; color: var(--tx3);">{{g.sub}}</span>
                  <span style="flex: 1;"></span>
                  <span class="mono" style="font-size: 11px; color: var(--tx3);">{{g.count}}</span>
                </span>
                <span style="display: flex; flex-direction: column; width: 100%;">
                  <sc-for list="{{g.items}}" as="x" hint-placeholder-count="4">
                    <span style="display: flex; align-items: center; gap: 8px; height: {{g.rh}}px; border-top: 1px {{g.rs}} var(--sep); min-width: 0;">
                      <sc-if value="{{x.lg}}" hint-placeholder-val="{{false}}"><img class="lg {{x.inv}}" src="{{x.lg}}" width="15" height="15" alt=""></sc-if>
                      <sc-if value="{{x.sw}}" hint-placeholder-val="{{false}}"><span style="width: 15px; display: inline-flex; justify-content: center; flex: none;"><span style="width: 8px; height: 8px; border-radius: 2px; background: {{x.sw}};"></span></span></sc-if>
                      <sc-if value="{{x.ic}}" hint-placeholder-val="{{false}}"><svg class="ic" width="15" height="15" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx2);"><path d="{{x.ic}}"></path></svg></sc-if>
                      <span style="white-space: nowrap; color: var(--tx);">{{x.n}}</span>
                      <span style="font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0;">{{x.by}}</span>
                      <span class="{{g.mcls}}" style="font-size: {{g.mfs}}px; color: {{x.mc}}; white-space: nowrap;">{{x.m}}</span>
                      <span class="dot" style="background: {{x.c}}; border: 1px solid {{x.b}}; box-sizing: border-box;"></span>
                    </span>
                  </sc-for>
                </span>
              </button>
            </sc-for>
            <div class="card" style="position: absolute; left: CXpx; top: CYpx; width: BWpx; height: BHpx; padding: 16px 18px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; background: var(--bg); border-color: var(--dash);">
              <span class="node" aria-hidden="true" style="left: 0; top: 0;"></span>
              <span class="node" aria-hidden="true" style="left: 100%; top: 0;"></span>
              <span class="node" aria-hidden="true" style="left: 0; top: 100%;"></span>
              <span class="node" aria-hidden="true" style="left: 100%; top: 100%;"></span>
              DIAMOND
              <span class="disp" style="font-size: 20px; font-weight: 600;">Atlas</span>
              <span style="font-size: 12px; color: var(--tx2);">Working on 2 jobs · next look at 7:30 AM</span>
              <sc-if value="{{isDev}}" hint-placeholder-val="{{false}}"><span class="mono" style="font-size: 11px; color: var(--tx3); display: inline-flex; gap: 10px; align-items: center;"><span><span style="color: var(--F);">✓</span> 142 runs today</span><span>0 failed</span><span>v0.7.1</span></span></sc-if>
              <sc-if value="{{isSimple}}" hint-placeholder-val="{{true}}"><span style="font-size: 12px; color: var(--F);">✓ All good today</span></sc-if>
            </div>
"""


def wires():
    """The dashed connectors: a bus in each side gap, and short links above and below the core."""
    lx = COLS[0] + BW + 38   # left bus, in the gap between columns 1 and 2
    rx = COLS[2] - 38        # right bus, in the gap between columns 2 and 3
    mid = lambda r: ROWS[r] + BH // 2
    cx = COLS[1] + BW // 2
    w = []
    # The buses, from the top box's middle to the bottom box's middle.
    w.append('<div class="wire" aria-hidden="true" style="left: %dpx; top: %dpx; height: %dpx; border-left-width: 1px;"></div>' % (lx, mid(0), mid(2) - mid(0)))
    w.append('<div class="wire" aria-hidden="true" style="left: %dpx; top: %dpx; height: %dpx; border-left-width: 1px;"></div>' % (rx, mid(0), mid(2) - mid(0)))
    for r in range(3):
        # Each side box to its bus.
        w.append('<div class="wire" aria-hidden="true" style="left: %dpx; top: %dpx; width: %dpx; border-top-width: 1px;"></div>' % (COLS[0] + BW, mid(r), lx - COLS[0] - BW))
        w.append('<div class="wire" aria-hidden="true" style="left: %dpx; top: %dpx; width: %dpx; border-top-width: 1px;"></div>' % (rx, mid(r), COLS[2] - rx))
        w.append('<span class="node" aria-hidden="true" style="left: %dpx; top: %dpx;"></span>' % (lx, mid(r)))
        w.append('<span class="node" aria-hidden="true" style="left: %dpx; top: %dpx;"></span>' % (rx, mid(r)))
    # Each bus into the core, marching: something is moving through it.
    w.append('<svg aria-hidden="true" style="position: absolute; left: 0; top: 0; width: 1100px; height: 690px; overflow: visible; pointer-events: none;">'
             '<path class="draw" d="M%d %d H%d" style="fill: none; stroke: var(--dash); stroke-width: 1;"></path>'
             '<path class="draw" d="M%d %d H%d" style="fill: none; stroke: var(--dash); stroke-width: 1;"></path>'
             '<path class="draw" d="M%d %d V%d" style="fill: none; stroke: var(--dash); stroke-width: 1;"></path>'
             '<path class="draw" d="M%d %d V%d" style="fill: none; stroke: var(--dash); stroke-width: 1;"></path>'
             '</svg>' % (lx, mid(1), COLS[1], COLS[1] + BW, mid(1), rx, cx, ROWS[0] + BH, ROWS[1], cx, ROWS[1] + BH, ROWS[2]))
    return '\n            '.join(w)


SERVICES = r"""
            <div style="position: absolute; left: 22px; right: 22px; top: 16px; display: flex; align-items: center; gap: 8px;">
              <sc-for list="{{chips}}" as="c" hint-placeholder-count="7"><span class="chip {{c.cls}}">{{c.n}}<span class="mono" style="font-size: 10.5px; color: var(--tx3);">{{c.k}}</span></span></sc-for>
              <span style="flex: 1;"></span>
              <span style="width: 200px; height: 28px; border: 1px solid var(--sep2); border-radius: 6px; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; box-sizing: border-box; color: var(--tx3); font-size: 12.5px; background: var(--bg);"><svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>Find a service</span>
            </div>
            <div style="position: absolute; left: 22px; right: 22px; top: 58px; bottom: 90px; overflow: hidden; display: flex; flex-direction: column; gap: 10px;">
              <span class="lab">On · 8</span>
              <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px;">
                <sc-for list="{{on}}" as="s" hint-placeholder-count="8">
                  <button type="button" class="card hov" onClick="{{s.open}}" style="height: 118px; padding: 12px 13px; text-align: left; display: flex; flex-direction: column; gap: 8px; border-color: {{s.bd}};">
                    <span style="display: flex; align-items: center; gap: 10px; width: 100%;"><span class="logo" style="width: 34px; height: 34px;"><img class="lg {{s.inv}}" src="{{s.lg}}" width="20" height="20" alt=""></span><span style="display: flex; flex-direction: column; min-width: 0; flex: 1;"><span style="font-weight: 600;">{{s.n}}</span><span style="font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{s.about}}</span></span></span>
                    <span style="font-size: 12px; color: var(--tx2); line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%;">{{s.does}}</span>
                    <span style="display: flex; align-items: center; gap: 7px; width: 100%; margin-top: auto;"><span class="dot" style="background: {{s.c}};"></span><span style="font-size: 12px; color: {{s.sc}};">{{s.state}}</span><span style="flex: 1;"></span><span class="mono" style="font-size: 10.5px; color: var(--tx3);">{{s.cost}}</span></span>
                  </button>
                </sc-for>
              </div>
              <span class="lab" style="padding-top: 6px;">More services · 26</span>
              <div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px;">
                <sc-for list="{{more}}" as="s" hint-placeholder-count="4">
                  <div class="card hov" style="height: 92px; padding: 12px 13px; display: flex; flex-direction: column; gap: 8px; background: var(--bg); border-style: {{s.bs}};">
                    <span style="display: flex; align-items: center; gap: 10px;"><sc-if value="{{s.lg}}" hint-placeholder-val="{{true}}"><span class="logo" style="width: 34px; height: 34px;"><img class="lg {{s.inv}}" src="{{s.lg}}" width="20" height="20" alt=""></span></sc-if><sc-if value="{{s.nolg}}" hint-placeholder-val="{{false}}"><span class="mk" style="background: var(--win);">{{s.m}}</span></sc-if><span style="display: flex; flex-direction: column; min-width: 0; flex: 1;"><span style="font-weight: 600;">{{s.n}}</span><span style="font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{s.about}}</span></span></span>
                    <span style="display: flex; align-items: center; gap: 8px;"><span style="font-size: 12px; color: var(--tx3); flex: 1;">{{s.note}}</span><button type="button" class="btn" style="height: 24px; padding: 0 9px; font-size: 12px;">{{s.act}}</button></span>
                  </div>
                </sc-for>
              </div>
            </div>
"""

OPEN = r"""
            <div style="position: absolute; left: 22px; right: 22px; top: 14px; display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--tx3);">
              <button type="button" class="it" onClick="{{back}}" style="height: 26px; padding: 0 8px 0 4px; border: 0; border-radius: 6px; background: transparent; color: var(--tx2); display: inline-flex; align-items: center; gap: 4px;"><svg class="ic" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>Services</button>
            </div>
            <div class="rise" style="position: absolute; left: 22px; right: 22px; top: 50px; bottom: 86px; display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: 22px;">
              <div style="display: flex; flex-direction: column; gap: 14px;">
                <div style="display: flex; align-items: center; gap: 12px;"><span class="logo" style="width: 48px; height: 48px; border-radius: 11px;"><img class="lg" src="{{linearLogo}}" width="28" height="28" alt=""></span><span style="display: flex; flex-direction: column;"><span class="disp" style="font-size: 22px; font-weight: 600;">Linear</span><span style="color: var(--tx2);">Issues and projects for your team</span></span></div>
                <div style="display: flex; align-items: center; gap: 8px;"><span class="dot" style="background: var(--F);"></span><span>On</span><span style="color: var(--tx3);">· heard 18 min ago</span><span style="flex: 1;"></span><span class="tg on" aria-label="On"></span></div>
                <div class="card" style="background: var(--bg); padding: 12px 14px; display: flex; flex-direction: column; gap: 9px;">
                  <span style="font-weight: 600;">Set up with one key</span>
                  <span style="display: flex; align-items: center; gap: 8px; height: 30px; border: 1px solid var(--sep2); border-radius: 6px; padding: 0 10px; background: var(--win); font-size: 12.5px;"><span class="mono" style="letter-spacing: .1em; color: var(--tx2);">lin_api_••••••••4f2a</span><span style="flex: 1;"></span><span style="color: var(--F); font-size: 12px;">✓ Works</span></span>
                  <span style="font-size: 12px; color: var(--tx3);">Atlas keeps it and adds it as each request leaves. Nothing else ever sees it.</span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px;">
                  <span class="lab">Can reach</span>
                  <span style="display: flex; gap: 6px; flex-wrap: wrap;"><span class="tag">api.linear.app</span><span class="tag">mcp.linear.app</span></span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px;">
                  <span class="lab">Costs</span>
                  <span style="color: var(--tx2);">Nothing. Linear's free plan covers it.</span>
                </div>
                <div style="display: flex; gap: 8px; padding-top: 4px;"><button type="button" class="btn">Turn off</button><button type="button" class="btn">Remove</button></div>
              </div>
              <div style="display: flex; flex-direction: column; gap: 12px; min-width: 0;">
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px;">
                  <div class="card" style="padding: 10px 14px 4px; display: flex; flex-direction: column;">
                    <span style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 6px;"><span style="font-weight: 600;">Hears</span><span style="font-size: 12px; color: var(--tx3);">What Atlas notices from Linear</span></span>
                    <sc-for list="{{hears}}" as="h" hint-placeholder-count="4">
                      <span style="display: flex; align-items: center; gap: 10px; height: 34px; border-top: 1px dashed var(--sep);"><span style="flex: 1;">{{h.n}}</span><span class="mono" style="font-size: 11px; color: var(--tx3);">{{h.m}}</span><span class="tg {{h.t}}"></span></span>
                    </sc-for>
                  </div>
                  <div class="card" style="padding: 12px 14px; display: flex; flex-direction: column;">
                    <span style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 6px;"><span style="font-weight: 600;">Can do</span><span style="font-size: 12px; color: var(--tx3);">What Atlas can do there for you</span></span>
                    <sc-for list="{{cando}}" as="h" hint-placeholder-count="4">
                      <span style="display: flex; align-items: center; gap: 10px; height: 34px; border-top: 1px dashed var(--sep);"><span style="flex: 1;">{{h.n}}</span><span style="font-size: 12px; color: {{h.c}};">{{h.m}}</span></span>
                    </sc-for>
                  </div>
                </div>
                <div class="card" style="padding: 12px 14px; display: flex; flex-direction: column;">
                  <span style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 6px;"><span style="font-weight: 600;">Lately</span><span style="flex: 1;"></span><span style="font-size: 12px; color: var(--tx3);">Every one is in History</span></span>
                  <sc-for list="{{lately}}" as="r" hint-placeholder-count="4">
                    <span style="display: grid; grid-template-columns: 70px minmax(0, 1fr) auto 64px; align-items: center; gap: 12px; height: 33px; border-top: 1px dashed var(--sep);">
                      <span class="tag" style="justify-self: start; color: {{r.tc}}; border-color: {{r.tb}};">{{r.k}}</span>
                      <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{r.n}}</span>
                      <span style="font-size: 12px; color: var(--tx3); white-space: nowrap;">{{r.why}}</span>
                      <span class="mono" style="font-size: 11px; color: var(--tx3); text-align: right;">{{r.t}}</span>
                    </span>
                  </sc-for>
                </div>
                <div class="card" style="padding: 12px 14px; display: flex; flex-direction: column;">
                  <span style="display: flex; align-items: baseline; gap: 8px; padding-bottom: 6px;"><span style="font-weight: 600;">Rules that use it</span><span style="flex: 1;"></span><span style="font-size: 12px; color: var(--tx3);">In Automations</span></span>
                  <sc-for list="{{rules}}" as="r" hint-placeholder-count="2">
                    <span style="display: flex; align-items: center; gap: 10px; height: 36px; border-top: 1px dashed var(--sep);">
                      <svg class="ic" width="13" height="13" viewBox="0 0 24 24" aria-hidden="true" style="color: var(--tx3);"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"></path></svg>
                      <span class="tag">{{r.when}}</span><span class="mono" style="color: var(--dash);">──</span><span class="tag">{{r.do}}</span>
                      <span style="flex: 1;"></span>
                      <span style="font-size: 12px; color: var(--tx3);">{{r.m}}</span>
                    </span>
                  </sc-for>
                </div>
              </div>
            </div>
"""

SKILLS = r"""
            <div style="position: absolute; left: 22px; right: 22px; top: 16px; display: flex; align-items: center; gap: 22px;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">What Atlas knows how to do</span>
              <span style="display: inline-flex; gap: 18px; color: var(--tx3);"><span><span class="num" style="color: var(--tx);">23</span> skills</span><span><span class="num" style="color: var(--tx);">3</span> learned this month</span><span><span class="num" style="color: var(--tx);">41</span> times opened again</span></span>
              <span style="flex: 1;"></span>
              <button type="button" class="btn">Paste a SKILL.md</button>
              <button type="button" class="btnp">Get skills</button>
            </div>
            <div style="position: absolute; left: 22px; right: 22px; top: 62px; display: grid; grid-template-columns: minmax(0, 1fr) 128px 150px 132px 120px; gap: 0 16px; align-items: center;">
              <sc-for list="{{scols}}" as="c" hint-placeholder-count="5"><span class="lab" style="height: 26px; display: flex; align-items: center;">{{c}}</span></sc-for>
            </div>
            <div style="position: absolute; left: 22px; right: 22px; top: 90px; display: flex; flex-direction: column;">
              <sc-for list="{{skills}}" as="s" hint-placeholder-count="8">
                <div class="row" style="display: grid; grid-template-columns: minmax(0, 1fr) 128px 150px 132px 120px; gap: 0 16px; align-items: center; height: 56px; border-top: 1px solid var(--sep); padding: 0 4px; margin: 0 -4px; border-radius: 4px;">
                  <span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;"><span style="display: flex; align-items: center; gap: 8px;"><span style="font-weight: 600;">{{s.n}}</span><sc-if value="{{s.fresh}}" hint-placeholder-val="{{false}}"><span class="tag" style="color: var(--ac); border-color: var(--ac);">{{s.fresh}}</span></sc-if></span><span style="font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">{{s.d}}</span></span>
                  <span><span class="ach" style="--c: {{s.ac}}; --rgb: {{s.argb}};">{{s.area}}</span></span>
                  <span style="display: inline-flex; align-items: center; gap: 8px;"><span class="mono" style="font-size: 11.5px; color: var(--tx2); letter-spacing: .02em;">{{s.bar}}</span><span class="mono" style="font-size: 11px; color: var(--tx3);">{{s.uses}}</span></span>
                  <span style="font-size: 12.5px; color: var(--tx2);">{{s.by}}</span>
                  <span style="font-size: 12px; color: {{s.cc}};">{{s.check}}</span>
                </div>
              </sc-for>
            </div>
"""

DEVICES = r"""
            <div style="position: absolute; left: 22px; right: 22px; top: 16px; display: flex; align-items: baseline; gap: 12px;">
              <span class="disp" style="font-size: 21px; font-weight: 600;">Devices</span>
              <span style="color: var(--tx3);">They dial out to Atlas, so nothing on your network is left open</span>
            </div>
            <div style="position: absolute; left: 22px; right: 22px; top: 60px; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px;">
              <sc-for list="{{devices}}" as="d" hint-placeholder-count="3">
                <div class="card" style="padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; height: 318px;">
                  <span style="display: flex; align-items: center; gap: 10px;"><span class="logo" style="width: 34px; height: 34px;"><img class="lg {{d.inv}}" src="{{d.lg}}" width="18" height="18" alt=""></span><span style="display: flex; flex-direction: column; flex: 1;"><span style="font-weight: 600;">{{d.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{d.kind}}</span></span></span>
                  <span style="display: flex; align-items: center; gap: 7px;"><span class="dot" style="background: {{d.c}};"></span><span style="font-size: 12.5px;">{{d.state}}</span></span>
                  <span style="display: flex; flex-direction: column;">
                    <sc-for list="{{d.caps}}" as="x" hint-placeholder-count="4">
                      <span style="display: flex; align-items: center; gap: 10px; height: 34px; border-top: 1px dashed var(--sep);"><span style="flex: 1;">{{x.n}}</span><span style="font-size: 12px; color: var(--tx3);">{{x.m}}</span><span class="tg {{x.t}}"></span></span>
                    </sc-for>
                  </span>
                  <span style="margin-top: auto; font-size: 12px; color: var(--tx3);">{{d.foot}}</span>
                </div>
              </sc-for>
            </div>
            <div class="card" style="position: absolute; left: 22px; right: 22px; top: 394px; height: 150px; border-style: dashed; background: var(--bg); padding: 16px 18px; display: flex; align-items: center; gap: 22px; box-sizing: border-box;">
              <div aria-hidden="true" style="width: 112px; height: 112px; flex: none; display: grid; grid-template-columns: repeat(11, 1fr); gap: 2px; padding: 6px; box-sizing: border-box; border: 1px solid var(--sep2); border-radius: 6px; background: var(--win);">
                <sc-for list="{{qr}}" as="q" hint-placeholder-count="121"><span style="background: {{q}}; border-radius: 1px;"></span></sc-for>
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px; flex: 1;">
                <span style="font-weight: 600; font-size: 14px;">Add a device</span>
                <span style="color: var(--tx2);">Scan this with your phone, or type the code the desktop app shows.</span>
                <span style="display: flex; align-items: center; gap: 8px; padding-top: 4px;"><span class="mono" style="height: 30px; border: 1px solid var(--sep2); border-radius: 6px; padding: 0 12px; display: inline-flex; align-items: center; letter-spacing: .14em; color: var(--tx3); background: var(--win);">K7Q2-M9</span><button type="button" class="btnp">Pair</button></span>
              </div>
              <div style="display: flex; flex-direction: column; gap: 6px; width: 300px;">
                <span style="font-weight: 600;">Get the apps</span>
                <span style="color: var(--tx2);">Atlas for Mac, and OwnTracks on your phone for where you are.</span>
                <span style="display: flex; gap: 8px; padding-top: 4px;"><button type="button" class="btn">Atlas for Mac</button><button type="button" class="btn">OwnTracks</button></span>
              </div>
            </div>
"""

BODY = r"""
          <sc-if value="{{isMap}}" hint-placeholder-val="{{true}}">MAP</sc-if>
          <sc-if value="{{isServices}}" hint-placeholder-val="{{false}}">SERVICES</sc-if>
          <sc-if value="{{isOpen}}" hint-placeholder-val="{{false}}">OPEN</sc-if>
          <sc-if value="{{isSkills}}" hint-placeholder-val="{{false}}">SKILLS</sc-if>
          <sc-if value="{{isDevices}}" hint-placeholder-val="{{false}}">DEVICES</sc-if>
"""

JS = r"""
  renderVals() {
    var self = this;
    var st = this.state;
    var tab = st.tab || 'Map';
    var open = tab === 'Services' && st.open;
    var ON = 'var(--F)', SLEEP = 'var(--tx3)', NEED = 'var(--ac)';
    LOGOS_JS
    var level = st.level || 'simple';
    var dev = level === 'developer';
    function it(n, by, m, c, mc, look) {
      var o = { n: n, by: by, m: m, c: c === 'off' ? 'transparent' : c, b: c === 'off' ? 'var(--tx3)' : 'transparent', mc: mc || 'var(--tx3)', lg: '', inv: '', sw: '', ic: '' };
      if (look && L[look]) { o.lg = L[look].uri; o.inv = L[look].inv; } else if (look && look.indexOf('var(') === 0) o.sw = look; else if (look) o.ic = look;
      return o;
    }
    var POS = POSITIONS;
    var IC = { computer: 'M4 17l6-6-6-6M12 19h8', browser: 'M3 5h18v14H3zM3 9h18', web: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20', app: 'M2 18h20M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10', ask: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', key: 'M15 7a4 4 0 1 1-3.5 6L5 19.5V22H2v-3l6.5-6.5A4 4 0 0 1 15 7z', money: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6', inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z', mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6' };
    var A = { Personal: 'var(--P)', Keyframes: 'var(--K)', UCF: 'var(--U)', Fitness: 'var(--F)', Health: 'var(--H)' };
    var GD = [
      ['brains', 'Brains', 'thinks with', '5', [it('Main', 'ChatGPT · gpt-5.6-terra', '62% of plan', ON, '', 'openai'), it('Voice', 'Workers AI · Kimi K2.6', 'free', ON, '', 'cloudflare'), it('Deep', 'ChatGPT, then Claude', '$18.40', ON, '', 'claude'), it('Quick', 'Workers AI · Kimi K2.6', 'free', ON, '', 'cloudflare')]],
      ['senses', 'Senses', 'hears', '6', [it('Mail', 'Gmail', 'just now', ON, '', 'gmail'), it('Calendar', 'iCloud', '2 min', ON, '', 'icloud'), it('Location', 'OwnTracks', 'home · 3 h', ON, '', 'owntracks'), it('Work', 'GitHub, Linear', '18 min', ON, '', 'github')]],
      ['channels', 'Channels', 'reaches you on', '4', [it('App', 'open on your Mac', 'now', ON, '', IC.app), it('Telegram', '@maxb', '4 min', ON, '', 'telegram'), it('Phone', 'Telnyx · (407) 555-0134', 'idle', SLEEP, '', 'telnyx'), it('Email', 'atlas@keyframes.studio', '1 h', ON, '', 'cloudflare')]],
      ['hands', 'Hands', 'works with', '3', [it('Workspace', 'asleep until needed', '$0.40', SLEEP, '', IC.computer), it('Browser', 'Browser Run', 'idle', SLEEP, '', IC.browser), it('Web search', 'Cloudflare', '212 today', ON, '', IC.web)]],
      ['cando', 'Services', 'can do', '8', [it('Linear', 'issues, comments', 'trusted', ON, '', 'linear'), it('Notion', 'pages, databases', '1 waiting', NEED, 'var(--ac)', 'notion'), it('GitHub', 'pull requests', 'asks', ON, '', 'github'), it('Stripe', 'invoices', 'off', 'off', '', 'stripe')]],
      ['skills', 'Skills', 'knows how', '23', [it('file-reimbursements', 'Personal', '9 uses', ON, '', A.Personal), it('shoot-gear-checklist', 'Keyframes', '6 uses', ON, '', A.Keyframes), it('client-invoice', 'Keyframes', 'improved', ON, 'var(--ac)', A.Keyframes), it('lab-report-format', 'UCF', '3 uses', ON, '', A.UCF)]],
      ['devices', 'Devices', 'is on', '3', [it('MacBook Pro', 'desktop app', 'online', ON, '', 'apple'), it('iPhone', 'location, push', '3 min', ON, '', 'apple'), it('Home node', 'Raspberry Pi', 'offline', 'off', '', 'raspberrypi')]],
      ['exits', 'Exits', 'checks on the way out', '4', [it('Approvals', '1 waiting on you', 'review', NEED, 'var(--ac)', IC.inbox), it('Vault', '14 logins and cards', 'locked', ON, '', IC.key), it('Spending', '$31.20 of $150', '[■■□□□□]', ON, '', IC.money), it('Permissions', '2 of your own rules', '', ON, '', IC.ask)]]
    ];
    // The same map in plain words, for the Simple detail level (the default).
    var GS = [
      ['brains', 'Thinks with', '', '', [it('ChatGPT', 'most things, on your plan', '', ON, '', 'openai'), it('Workers AI', 'voice and quick jobs', '', ON, '', 'cloudflare'), it('Claude', 'when ChatGPT is busy', '', ON, '', 'claude')]],
      ['senses', 'Keeps up with', '', '', [it('Your mail', 'just now', '', ON, '', 'gmail'), it('Your calendar', '2 min ago', '', ON, '', 'icloud'), it('Where you are', 'home since 4:12', '', ON, '', 'owntracks'), it('Your work', 'GitHub and Linear', '', ON, '', 'github')]],
      ['channels', 'Reaches you on', '', '', [it('This Mac', 'right now', '', ON, '', 'apple'), it('Telegram', 'you replied 4 min ago', '', ON, '', 'telegram'), it('Your phone', 'calls if it’s urgent', '', SLEEP, '', 'telnyx'), it('Its own email', 'atlas@keyframes.studio', '', ON, '', IC.mail)]],
      ['hands', 'Gets things done with', '', '', [it('Its own computer', 'asleep until needed', '', SLEEP, '', IC.computer), it('A browser', 'for sites with no app', '', SLEEP, '', IC.browser), it('The web', '212 searches today', '', ON, '', IC.web)]],
      ['cando', 'Works in', '', '', [it('Linear', 'files your issues', '', ON, '', 'linear'), it('Notion', 'one thing for you to look at', '', NEED, '', 'notion'), it('GitHub', 'opens pull requests', '', ON, '', 'github'), it('Stripe', 'turned off', '', 'off', '', 'stripe')]],
      ['skills', 'Knows how to', '', '', [it('Invoice a client', 'improved yesterday', '', ON, 'var(--ac)', A.Keyframes), it('File reimbursements', 'used 9 times', '', ON, '', A.Personal), it('Pack for a shoot', 'used 6 times', '', ON, '', A.Keyframes), it('Format a lab report', 'used 3 times', '', ON, '', A.UCF)]],
      ['devices', 'Lives on', '', '', [it('MacBook Pro', 'online', '', ON, '', 'apple'), it('iPhone', 'with you', '', ON, '', 'apple'), it('Home node', 'offline since 9:40', '', 'off', '', 'raspberrypi')]],
      ['exits', 'Keeps you safe', '', '', [it('1 thing to approve', 'a reply to Priya', '', NEED, '', IC.inbox), it('14 passwords', 'locked away', '', ON, '', IC.key), it('$31 spent', 'of $150 this month', '', ON, '', IC.money), it('Asks first', 'before it speaks for you', '', ON, '', IC.ask)]]
    ];
    var groups = (dev ? GD : GS).map(function (g) {
      var p = POS[g[0]];
      return { n: g[1], sub: g[2], count: g[3], items: g[4], d: self.icons()[g[0]], x: p[0], y: p[1],
        rh: dev ? 26 : 29, rs: dev ? 'dashed' : 'solid', mcls: dev ? 'mono' : '', mfs: dev ? 11 : 12,
        go: function () { var to = { cando: 'Services', skills: 'Skills', devices: 'Devices' }[g[0]]; if (to) self.setState({ tab: to, open: null }); } };
    });

    function svc(look, n, about, does, state, c, cost, id) { return { lg: L[look].uri, inv: L[look].inv, n: n, about: about, does: does, state: state, c: c, sc: c === NEED ? 'var(--ac)' : 'var(--tx2)', bd: c === NEED ? 'var(--ac)' : 'var(--sep)', cost: cost, open: function () { if (id) self.setState({ open: id }); } }; }
    var on = [
      svc('gmail', 'Gmail', 'Your mail', 'Hears new mail and replies you wait for', 'Heard just now', ON, 'free'),
      svc('icloud', 'iCloud', 'Calendar and contacts', 'Reads and moves events, knows your people', 'Synced 2 min ago', ON, 'free'),
      svc('telegram', 'Telegram', 'Chat with Atlas', 'Messages, voice notes and buttons', 'Replied 4 min ago', ON, 'free'),
      svc('linear', 'Linear', 'Issues and projects', 'Hears your issues, files and updates them', 'Heard 18 min ago', ON, 'free', 'linear'),
      svc('github', 'GitHub', 'Code and reviews', 'Hears reviews, opens pull requests', 'Heard 1 h ago', ON, 'free'),
      svc('notion', 'Notion', 'Pages and databases', 'Reads and writes pages you share with it', '1 waiting on you', NEED, 'free'),
      svc('telnyx', 'Telnyx', 'Phone calls', 'Your number (407) 555-0134, voice only', 'No calls today', SLEEP, '$1/mo'),
      svc('owntracks', 'OwnTracks', 'Where you are', 'Location from your phone', 'Home since 4:12 PM', ON, 'free')
    ];
    function mo(look, n, about, note, act) { return { lg: look ? L[look].uri : '', inv: look ? L[look].inv : '', nolg: !look, m: '+', n: n, about: about, note: note, act: act, bs: look ? 'solid' : 'dashed' }; }
    var more = [
      mo('slack', 'Slack', 'Your team chat', 'Hears and replies', 'Set up'),
      mo('stripe', 'Stripe', 'Invoices and payments', 'Turned off', 'Turn on'),
      mo('mapbox', 'Mapbox', 'Live traffic', 'Free tier, by key', 'Set up'),
      mo('google', 'Google', 'Calendar, mail, contacts', 'Sign in with Google', 'Set up'),
      mo('outlook', 'Outlook', 'Calendar and mail', 'Sign in with Microsoft', 'Set up'),
      mo('homeassistant', 'Home Assistant', 'Lights, locks, sensors', 'Through your home node', 'Set up'),
      mo('claude', 'Claude Code', 'Coding jobs', 'By Anthropic key', 'Set up'),
      mo('', 'Custom', 'Any MCP server or extension', 'An address or a link', 'Add')
    ];
    var chips = [['All', '34', 'on'], ['On', '8'], ['Mail and calendar', '6'], ['Chat and calls', '7'], ['Work', '9'], ['Coding', '4'], ['Maps and weather', '5']].map(function (c) { return { n: c[0], k: c[1], cls: c[2] || '' }; });

    var hears = [{ n: 'Issues assigned to you', m: '3 this week', t: 'on' }, { n: 'Mentions and comments', m: '11 this week', t: 'on' }, { n: 'Reviews waiting on you', m: 'none', t: 'on' }, { n: 'Every change in the team', m: '', t: 'off' }];
    var cando = [{ n: 'Find issues and projects', m: 'Never asks', c: 'var(--tx3)' }, { n: 'File an issue', m: 'Trusted since Oct 20', c: 'var(--F)' }, { n: 'Update an issue', m: 'Asks until trusted', c: 'var(--tx2)' }, { n: 'Comment', m: 'Asks until trusted', c: 'var(--tx2)' }];
    var lately = [
      { k: 'Heard', n: 'KEY-142 Color grade export fails on long clips', why: 'Assigned to you by Jordan Lee', t: '18 min', tc: 'var(--tx2)', tb: 'var(--sep2)' },
      { k: 'Filed', n: 'KEY-141 Client portal shows the wrong invoice', why: 'From Dev Patel’s email, your rule', t: 'Yesterday', tc: 'var(--ac)', tb: 'var(--ac)' },
      { k: 'Heard', n: 'Jordan Lee commented on KEY-138', why: '“Can you check the LUT?”', t: 'Mon', tc: 'var(--tx2)', tb: 'var(--sep2)' },
      { k: 'Updated', n: 'KEY-136 moved to Done', why: 'You asked in Telegram', t: 'Mon', tc: 'var(--tx2)', tb: 'var(--sep2)' }
    ];

    function sk(n, d, area, uses, by, check, fresh) {
      var k = Math.min(6, Math.round(uses / 2));
      var bar = '[' + '■■■■■■'.slice(0, k) + '□□□□□□'.slice(0, 6 - k) + ']';
      return { n: n, d: d, area: area, ac: A[area], argb: { Personal: 'var(--Prgb)', Keyframes: 'var(--Krgb)', UCF: 'var(--Urgb)', Fitness: 'var(--Frgb)', Health: 'var(--Hrgb)' }[area], bar: bar, uses: uses + '×', by: by, check: check, cc: check.indexOf('Broke') === 0 ? 'var(--ac)' : (check.indexOf('✓') === 0 ? 'var(--F)' : 'var(--tx3)'), fresh: fresh || '' };
    }
    var skills = [
      sk('client-invoice', 'Invoice a Keyframes client from the shoot’s hours, in their format', 'Keyframes', 7, 'Atlas · v4', '✓ Checked Sun', 'Improved yesterday'),
      sk('file-reimbursements', 'File a UCF reimbursement with receipts from mail', 'Personal', 9, 'Atlas · v2', '✓ Checked Sun'),
      sk('shoot-gear-checklist', 'The gear list for a shoot, from the shot list and the location', 'Keyframes', 6, 'Atlas · v3', 'No check'),
      sk('lab-report-format', 'Format a lab report the way Prof. Reyes asks for', 'UCF', 3, 'You', 'No check'),
      sk('weekly-review', 'The Sunday review: what moved, what slipped, what’s next', 'Personal', 4, 'From Hermes', '✓ Checked Sun'),
      sk('color-pipeline', 'Export a grade with the studio’s LUTs and naming', 'Keyframes', 2, 'Atlas · v1', 'Broke Sun: LUT folder moved', 'Learned Tue'),
      sk('meal-prep-plan', 'A week of vegetarian meal prep from what’s in season', 'Fitness', 5, 'Atlas · v2', 'No check'),
      sk('pdf-from-page', 'Turn a page into a clean PDF to send', 'Personal', 3, 'From Claude Code', '✓ Checked Sun')
    ];

    var D = { mac: 'M2 18h20M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10', phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2', node: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01' };
    var devices = [
      { n: 'MacBook Pro', kind: 'Atlas for Mac', lg: L.apple.uri, inv: L.apple.inv, d: D.mac, c: ON, state: 'Online · the voice hotkey is ⌥ Space', foot: 'Paired Oct 12. Remove it here and it stops at once.',
        caps: [{ n: 'Notifications', m: '', t: 'on' }, { n: 'Voice overlay', m: '', t: 'on' }, { n: 'Files in Documents', m: 'asks each time', t: 'on' }, { n: 'iMessage', m: '', t: 'off' }, { n: 'Screen', m: '', t: 'off' }] },
      { n: 'iPhone', kind: 'The web app and OwnTracks', lg: L.apple.uri, inv: L.apple.inv, d: D.phone, c: ON, state: 'Home since 4:12 PM · last fix 3 min ago', foot: '12 places pinned, so arriving and leaving are noticed.',
        caps: [{ n: 'Where you are', m: 'OwnTracks', t: 'on' }, { n: 'Notifications', m: '', t: 'on' }, { n: 'Voice', m: 'in the app', t: 'on' }] },
      { n: 'Home node', kind: 'Raspberry Pi in the office', lg: L.raspberrypi.uri, inv: '', d: D.node, c: 'var(--sep2)', state: 'Offline since 9:40 AM', foot: 'While it’s offline, Atlas says so and waits for it.',
        caps: [{ n: 'Home Assistant', m: '14 devices', t: 'on' }, { n: 'Cameras', m: '', t: 'off' }] }
    ];
    var qr = [];
    var seed = 7;
    for (var i = 0; i < 121; i++) { seed = (seed * 37 + 11) % 101; var r = Math.floor(i / 11), c = i % 11; var finder = (r < 3 && c < 3) || (r < 3 && c > 7) || (r > 7 && c < 3); qr.push(finder ? ((r % 2 === 0 || c % 2 === 0) ? 'var(--tx)' : 'transparent') : (seed % 3 ? 'var(--tx)' : 'transparent')); }

    var tabs = this.mkTabs([['Map'], ['Services', '8'], ['Skills', '23'], ['Devices', '3']], tab, 'tab');
    var metas = { Map: 'Live · updated now', Services: '8 on · 26 more in the catalog', Skills: '23 skills · 2 from other agents', Devices: '2 online · 1 offline' };
    return Object.assign(this.shellVals('Abilities'), {
      tabs: tabs, meta: metas[tab],
      isMap: tab === 'Map', isDev: dev, isSimple: !dev, linearLogo: L.linear.uri, isServices: tab === 'Services' && !open, isOpen: !!open, isSkills: tab === 'Skills', isDevices: tab === 'Devices',
      groups: groups, on: on, more: more, chips: chips,
      hears: hears, cando: cando, lately: lately,
      rules: [{ when: 'A client emails about a bug', do: 'File it in Linear', m: 'Ran 3 times · last yesterday' }, { when: 'Friday 4 PM', do: 'Tell Jordan what’s open', m: 'Ran 6 times' }], back: function () { self.setState({ open: null }); },
      scols: ['Skill', 'Area', 'Used', 'Made by', 'Check'], skills: skills,
      devices: devices, qr: qr
    });
  }
"""


def build():
    pos = {'brains': (COLS[0], ROWS[0]), 'senses': (COLS[1], ROWS[0]), 'channels': (COLS[2], ROWS[0]),
           'hands': (COLS[0], ROWS[1]), 'cando': (COLS[2], ROWS[1]),
           'skills': (COLS[0], ROWS[2]), 'devices': (COLS[1], ROWS[2]), 'exits': (COLS[2], ROWS[2])}
    m = (MAP.replace('WIRES', wires()).replace('BW', str(BW)).replace('BH', str(BH))
         .replace('CX', str(COLS[1])).replace('CY', str(ROWS[1])).replace('DIAMOND', diamond(20, 34)))
    body = (BODY.replace('MAP', m).replace('SERVICES', SERVICES).replace('OPEN', OPEN)
            .replace('SKILLS', SKILLS).replace('DEVICES', DEVICES))
    import json
    from shell import logos_js
    js = (JS.replace('LOGOS_JS', logos_js()).replace('POSITIONS', json.dumps({k: list(v) for k, v in pos.items()}))
          .replace('ICONS[', 'self.icons()['))
    js += "\n  icons() { return %s; }\n" % json.dumps(ICONS)
    return page(title='Atlas · Abilities', active='Abilities', label='Abilities', body=body, js=js,
                placeholder='Ask what Atlas can do, or to set something up', extra_css=EXTRA_CSS,
                state="{ tab: 'Map' }")


if __name__ == '__main__':
    open('../Abilities.dc.html', 'w').write(build())
    print('wrote Abilities')
