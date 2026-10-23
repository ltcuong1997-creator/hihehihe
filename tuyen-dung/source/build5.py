src=open('build.py').read(); exec(src[:src.index('# ---------- A')])
FADE=lambda l,r,t,b: ("-webkit-mask-image:"+",".join(
  [f"linear-gradient(to right,{'transparent 0,#000 '+l if l else '#000 0'},{'#000 '+str(100-int(r[:-1]))+'%,transparent 100%' if r else '#000 100%'})",
   f"linear-gradient(to bottom,{'transparent 0,#000 '+t if t else '#000 0'},{'#000 '+str(100-int(b[:-1]))+'%,transparent 100%' if b else '#000 100%'})"])
  +";-webkit-mask-composite:source-in;mask-composite:intersect")
def PH(x,y,w,h,fade,pos='center 55%'):
    return f'<div style="position:absolute;left:{x}px;top:{y}px;width:{w}px;height:{h}px;background:url(shop.jpg) {pos}/cover;{fade}"></div>'
def page(bg,body,extra=''):
    return f'<!doctype html><html><head>{HEAD}</head><body><div class="poster grain" style="background:{bg}"><div class="stripes" style="position:absolute;inset:0;{extra}"></div>{body}{TICK}</div></body></html>'
INC_GOLD='<div class="leader" style="background:var(--gold);border-radius:99px;padding:13px 24px;color:var(--brick2);font-size:15px"><span style="font-weight:700">Thu nhập</span><i></i><span style="font-weight:700">Trao đổi khi phỏng vấn</span></div>'
def ADDR(col,chipbg,chipfg,apply=True,top=0,left=0,w=290,fs=46):
    return f'''<div style="position:absolute;left:{left}px;top:{top}px;width:{w}px;color:var(--cream)"><span class="chip" style="background:{chipbg};color:{chipfg};font-size:11px;padding:7px 12px">Địa chỉ làm việc</span>
<div class="bc" style="font-size:{fs}px;margin-top:10px;color:#fff;white-space:nowrap">251D Hậu Giang</div><div style="font-size:14px;font-weight:500;margin-top:6px;opacity:.92">P. 5, Quận 6, TP. HCM</div>
{'<div style="font-size:12.5px;line-height:1.5;margin-top:10px;color:var(--gold)">'+APPLY+'</div>' if apply else ''}</div>'''
LOGO_CARD=lambda x,y,w: f'<div style="position:absolute;left:{x}px;top:{y}px;background:var(--cream2);border-radius:18px;padding:11px 15px 9px;box-shadow:0 10px 20px -10px rgba(0,0,0,.45)"><img src="logo.png" style="display:block;width:{w}px"></div>'
TEALBAND='<div style="position:absolute;left:0;right:0;top:880px;height:243px;background:var(--teal)" class="stripes"></div>'

# 1 kem: ảnh phải, mờ viền trái/trên/dưới
p1=f'''<img src="logo.png" style="position:absolute;left:40px;top:34px;width:150px">
<span class="chip" style="position:absolute;right:40px;top:44px;background:var(--teal);color:var(--cream)">Quận 6 · TP.HCM</span>
{PH(330,430,464,462,FADE('30%',None,'22%','18%'),'center 50%')}
<div style="position:absolute;left:40px;top:122px"><div class="bc" style="font-size:52px;color:var(--teal);letter-spacing:3px">HiHê đang tuyển</div>
<div class="bc" style="font-size:138px;color:var(--brick);margin-top:16px">Phục vụ</div><div class="bc" style="font-size:138px;color:var(--brick);margin-top:14px">&amp; pha chế</div></div>
<div style="position:absolute;left:40px;top:500px;width:392px;display:flex;flex-direction:column;gap:12px">
<div class="card role" style="padding:16px 24px 12px">{SERVE}</div><div class="card role" style="padding:16px 24px 12px">{BREW}</div>{INC_GOLD}</div>
{TEALBAND}<div style="position:absolute;left:40px;top:896px">{MAP(400,170,'box-shadow:0 0 0 5px var(--cream2)')}</div>{ADDR(0,'var(--gold)','var(--teal2)',top=900,left=468)}'''
open('assets/p1.html','w').write(page('var(--cream)',p1,'background-image:repeating-linear-gradient(115deg,rgba(139,51,38,.035) 0 1.5px,transparent 1.5px 13px)'))

# 2 xanh ngọc: dải ly mờ dần vào nền
p2=f'''<div style="position:absolute;left:0;top:0;width:794px;height:300px;background:var(--cream)"></div>
<img src="cups.png" style="position:absolute;left:0;top:0;width:794px;height:229px;object-fit:cover;-webkit-mask-image:linear-gradient(to bottom,#000 62%,transparent 100%)">
<div style="position:absolute;left:0;top:0;width:794px;height:300px;background:linear-gradient(to bottom,transparent 55%,var(--teal) 88%)"></div>
{LOGO_CARD(36,206,118)}
<span class="chip" style="position:absolute;right:36px;top:262px;background:var(--gold);color:var(--teal2)">Quận 6 · TP.HCM</span>
<div style="position:absolute;left:40px;top:300px;color:var(--cream)"><div class="bc" style="font-size:48px;letter-spacing:3px">Cùng làm với HiHê</div>
<div class="bc" style="font-size:132px;color:var(--gold);margin-top:16px">Phục vụ</div><div class="bc" style="font-size:132px;color:#fff;margin-top:14px">&amp; pha chế</div></div>
<div style="position:absolute;left:40px;right:40px;top:690px;display:grid;grid-template-columns:1fr 1fr;gap:16px"><div class="card role" style="padding:20px 22px 14px">{SERVE}</div><div class="card role" style="padding:20px 22px 14px">{BREW}</div></div>
<div class="leader" style="position:absolute;left:40px;right:40px;top:882px;background:var(--brick);border-radius:99px;padding:14px 26px;color:#fff;font-size:15px;box-shadow:0 0 0 3px rgba(246,238,226,.25)"><span style="font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:13px;color:var(--gold)">Thu nhập</span><i></i><span style="font-weight:700">Trao đổi khi phỏng vấn</span></div>
<div style="position:absolute;left:40px;top:942px">{MAP(300,138,'box-shadow:0 0 0 4px var(--cream2)',80)}</div>{ADDR(0,'var(--cream2)','var(--teal2)',top=944,left=366,w=390,fs=44)}'''
open('assets/p2.html','w').write(page('var(--teal)',p2))

# 3 đỏ gạch: ảnh ngang mờ 4 phía
p3=f'''{LOGO_CARD(36,30,124)}
<div style="position:absolute;right:40px;top:38px;text-align:right;color:var(--cream)"><div class="bc" style="font-size:28px;letter-spacing:3px">Tiệm trà &amp; cà phê</div><div style="font-size:12px;letter-spacing:.2em;margin-top:6px;opacity:.8">QUẬN 6 · TP.HCM</div></div>
{PH(0,120,794,360,FADE('18%','18%','22%','26%'),'center 52%')}
<div style="position:absolute;left:0;right:0;top:396px;text-align:center"><div style="display:inline-block;background:var(--gold);border-radius:12px;padding:6px 26px 9px;transform:rotate(-2deg);box-shadow:0 12px 22px -10px rgba(0,0,0,.55)"><div class="bc" style="font-size:36px;color:var(--brick2);letter-spacing:3px">HiHê đang tuyển</div></div></div>
<div style="position:absolute;left:0;right:0;top:468px;text-align:center"><div class="bc" style="font-size:112px;color:#fff">Phục vụ</div><div class="bc" style="font-size:112px;color:var(--gold);margin-top:12px">&amp; pha chế</div></div>
<div class="card" style="position:absolute;left:40px;right:40px;top:728px;height:128px;display:grid;grid-template-columns:1fr 1fr;padding:15px 26px 8px;gap:0 26px">{SERVE}{BREW}</div>
<div style="position:absolute;left:40px;right:40px;top:870px">{INC_GOLD}</div>
<div style="position:absolute;left:40px;top:924px">{MAP(330,142,'box-shadow:0 0 0 4px var(--cream2)',80)}</div>{ADDR(0,'var(--cream2)','var(--brick2)',top=924,left=392,w=362,fs=44)}'''
open('assets/p3.html','w').write(page('var(--brick)',p3))

# 4 xanh ngọc: ảnh quán cao bên phải, tan vào nền
p4=f'''{PH(250,0,544,700,FADE('34%',None,None,'34%'),'center 40%')}
{LOGO_CARD(36,30,124)}
<span class="chip" style="position:absolute;left:36px;top:128px;background:var(--gold);color:var(--teal2)">Quận 6 · TP.HCM</span>
<div style="position:absolute;left:40px;top:430px;color:var(--cream)"><div class="bc" style="font-size:46px;letter-spacing:3px;color:var(--gold)">HiHê đang tuyển</div>
<div class="bc" style="font-size:128px;color:#fff;margin-top:12px">Phục vụ</div><div class="bc" style="font-size:128px;color:#fff;margin-top:12px">&amp; pha chế</div></div>
<div class="card" style="position:absolute;left:40px;right:40px;top:752px;height:122px;display:grid;grid-template-columns:1fr 1fr;padding:14px 26px 8px;gap:0 26px">{SERVE}{BREW}</div>
<div style="position:absolute;left:40px;right:40px;top:888px">{INC_GOLD}</div>
<div style="position:absolute;left:40px;top:942px">{MAP(330,128,'box-shadow:0 0 0 4px var(--cream2)',80)}</div>{ADDR(0,'var(--cream2)','var(--teal2)',top=940,left=392,w=362,fs=44)}'''
open('assets/p4.html','w').write(page('var(--teal)',p4))

# 5 kem: ảnh elip mờ giữa trang
p5=f'''<img src="logo.png" style="position:absolute;left:40px;top:34px;width:140px">
<span class="chip" style="position:absolute;right:40px;top:42px;background:var(--brick);color:var(--cream)">Quận 6 · TP.HCM</span>
<div style="position:absolute;left:0;right:0;top:112px;text-align:center"><div class="bc" style="font-size:44px;color:var(--teal);letter-spacing:4px">HiHê đang tuyển</div>
<div class="bc" style="font-size:90px;color:var(--brick);margin-top:12px;white-space:nowrap">Phục vụ &amp; pha chế</div></div>
<style>.role li{{font-size:12.6px}}</style>{PH(60,290,674,520,'-webkit-mask-image:radial-gradient(ellipse 50% 50% at 50% 50%,#000 52%,transparent 100%)','center 50%')}
<div class="card" style="position:absolute;left:40px;top:660px;width:352px;padding:16px 18px 12px">{SERVE}</div>
<div class="card" style="position:absolute;right:40px;top:660px;width:352px;padding:16px 18px 12px">{BREW}</div>
{TEALBAND}<div style="position:absolute;left:40px;right:40px;top:822px">{INC_GOLD}</div>'''
# bản đồ dưới dải teal cần chỗ: đẩy dải teal lên
p5=p5.replace(TEALBAND,'<div style="position:absolute;left:0;right:0;top:880px;height:243px;background:var(--teal)" class="stripes"></div>')
p5=p5.replace('top:822px">','top:826px">')
p5+=f'''<div style="position:absolute;left:40px;top:896px">{MAP(400,170,'box-shadow:0 0 0 5px var(--cream2)')}</div>{ADDR(0,'var(--gold)','var(--teal2)',top=900,left=468)}'''
open('assets/p5.html','w').write(page('var(--cream)',p5,'background-image:repeating-linear-gradient(115deg,rgba(139,51,38,.035) 0 1.5px,transparent 1.5px 13px)'))
