src=open('build5.py').read(); exec(src[:src.index('# 1 kem')])
MONO="font-family:'JetBrains Mono','Courier New',monospace"
# 6 bảng menu
p6=f'''{LOGO_CARD(36,26,118)}
<span class="chip" style="position:absolute;right:40px;top:44px;background:var(--teal);color:var(--cream)">Quận 6 · TP.HCM</span>
<div class="stripes" style="position:absolute;left:36px;right:36px;top:118px;height:400px;border-radius:30px;background-color:var(--brick);overflow:hidden">
 {PH(380,0,378,400,FADE('50%',None,None,None),'60% 45%')}
 <div style="position:absolute;left:26px;top:0;bottom:0;width:60px"><div class="bc" style="position:absolute;left:0;top:50%;white-space:nowrap;transform:translate(-50%,-50%) rotate(-90deg);transform-origin:center;font-size:30px;color:var(--gold);letter-spacing:6px;left:30px">Nên thử · Đang tuyển</div></div>
 <div style="position:absolute;left:100px;top:46px;color:#fff"><div class="bc" style="font-size:44px;color:var(--gold);letter-spacing:3px">HiHê đang tuyển</div><div class="bc" style="font-size:104px;margin-top:14px">Phục vụ</div><div class="bc" style="font-size:104px;margin-top:12px">&amp; pha chế</div></div>
 <div style="position:absolute;right:20px;bottom:20px;width:70px;height:70px;border-radius:50%;background:var(--cream2);display:grid;place-items:center;box-shadow:0 6px 12px -6px #000"><div class="bc" style="font-size:20px;color:var(--brick);text-align:center;line-height:1">Cần<br>thêm<br>bạn</div></div>
</div>
<div style="position:absolute;left:36px;top:540px;width:456px;height:528px;display:flex;flex-direction:column;gap:16px">
 <div class="card role" style="padding:22px 26px 20px;flex:1;display:flex;flex-direction:column;justify-content:center"><h3 style="font-size:34px">Nhân viên phục vụ</h3><ul style="font-size:15px"><li>Đón khách, ghi order, mang nước ra bàn</li><li>Giữ bàn ghế, khu vực quán sạch gọn</li><li>Vui vẻ, nhanh nhẹn, biết lắng nghe khách</li></ul><div class="leader" style="margin-top:14px;color:var(--brick);font-size:15px"><span>Thu nhập</span><i></i><span>Trao đổi khi PV</span></div></div>
 <div class="card role" style="padding:22px 26px 20px;flex:1;display:flex;flex-direction:column;justify-content:center"><h3 style="font-size:34px">Nhân viên pha chế</h3><ul style="font-size:15px"><li>Pha trà, cà phê theo công thức của tiệm</li><li>Chuẩn bị nguyên liệu, topping, vệ sinh quầy</li><li>Cẩn thận, ngăn nắp, chịu khó học hỏi</li></ul><div class="leader" style="margin-top:14px;color:var(--brick);font-size:15px"><span>Thu nhập</span><i></i><span>Trao đổi khi PV</span></div></div>
</div>
<div class="stripes" style="position:absolute;left:508px;right:36px;top:540px;height:528px;border-radius:26px;background:var(--teal);color:var(--cream);padding:24px 20px">
 <div class="bc" style="font-size:36px;color:#fff;line-height:1">Địa chỉ<br>làm việc</div><div style="height:3px;background:var(--gold);width:40px;margin:12px 0"></div>
 <div class="bc" style="font-size:44px;color:var(--gold);line-height:1">251D<br>Hậu Giang</div><div style="font-size:13.5px;margin-top:8px;opacity:.92">P. 5, Quận 6, TP. HCM</div>
 <div style="margin:16px 0 0;">{MAP(210,170,'',70)}</div>
 <div style="font-size:12.5px;line-height:1.5;margin-top:14px;color:var(--gold)">{APPLY}</div></div>
'''
open('assets/p6.html','w').write(page('var(--cream)',p6,'background-image:repeating-linear-gradient(115deg,rgba(139,51,38,.035) 0 1.5px,transparent 1.5px 13px)'))

# 7 riso duotone
p7=f'''<div style="position:absolute;inset:0;background:url(shop_duo.jpg) 38% 40%/cover"></div>
<div style="position:absolute;inset:0;background:linear-gradient(to bottom,rgba(18,58,59,.55) 0,transparent 30%,transparent 48%,rgba(18,58,59,.9) 76%,var(--teal2) 100%)"></div>
{LOGO_CARD(36,30,124)}
<span class="chip" style="position:absolute;right:40px;top:44px;background:var(--gold);color:var(--teal2)">Quận 6 · TP.HCM</span>
<div style="position:absolute;left:40px;top:372px"><div class="bc" style="font-size:54px;color:var(--gold);letter-spacing:4px">HiHê đang tuyển</div><div class="bc" style="font-size:176px;color:var(--cream);margin-top:6px;text-shadow:0 6px 0 var(--brick)">Phục vụ</div><div class="bc" style="font-size:176px;color:var(--cream);margin-top:12px;text-shadow:0 6px 0 var(--brick)">&amp; pha chế</div></div>
<div style="position:absolute;left:40px;right:40px;top:820px;display:grid;grid-template-columns:1fr 1fr;gap:34px;color:var(--cream)">
 <div class="role" style="border-top:3px solid var(--gold);padding-top:12px"><h3 style="color:var(--gold)">Phục vụ</h3><ul>{SERVE[SERVE.index('<ul>')+4:SERVE.index('</ul>')].replace('color:#4a362b','')}</ul></div>
 <div class="role" style="border-top:3px solid var(--gold);padding-top:12px"><h3 style="color:var(--gold)">Pha chế</h3><ul>{BREW[BREW.index('<ul>')+4:BREW.index('</ul>')]}</ul></div></div>
<div style="position:absolute;right:40px;top:104px">{MAP(250,150,'box-shadow:0 0 0 4px var(--cream2)',76)}</div>
<style>.p7 .role li{{color:var(--cream)}}</style>
<div class="leader" style="position:absolute;left:40px;right:40px;top:968px;color:#fff;font-size:15px"><span style="color:var(--gold);letter-spacing:.12em;text-transform:uppercase;font-size:13px;font-weight:700">Thu nhập</span><i></i><span style="font-weight:700">Trao đổi khi phỏng vấn</span></div>
<div style="position:absolute;left:40px;top:1008px;font-size:14px;color:var(--cream);font-weight:600">📍 <b style="color:var(--gold)">251D Hậu Giang</b>, P. 5, Quận 6, TP. HCM · nhắn Fanpage HiHê hoặc ghé quán</div>
'''
p7=p7.replace('<div class="role"','<div class="role p7"')
open('assets/p7.html','w').write(page('var(--teal2)',p7.replace('<div class="role p7"','<div class="role p7"')).replace('</head>','<style>.p7 li{color:#F6EEE2!important}</style></head>'))

# 8 phiếu order
zig="polygon("+",".join([f"{i*10}px 0" if i%2==0 else f"{i*10}px 8px" for i in range(0,57)])+",560px 100%,"+",".join([f"{(56-i)*10}px calc(100% - {0 if i%2==0 else 8}px)" for i in range(0,57)])+")"
rc=f"{MONO};color:#3a2a22"
p8=f'''{PH(0,0,794,520,FADE(None,None,None,'45%'),'center 30%')}
<div style="position:absolute;left:0;top:0;width:794px;height:520px;background:linear-gradient(rgba(18,58,59,.55),rgba(18,58,59,.15) 70%,transparent)"></div>
<div style="position:absolute;left:0;right:0;top:50px;text-align:center"><div class="bc" style="font-size:128px;color:var(--cream);letter-spacing:2px;text-shadow:0 5px 0 var(--brick)">Tuyển người</div></div>
<div style="position:absolute;left:117px;top:236px;width:560px;transform:rotate(-1.6deg);filter:drop-shadow(0 18px 18px rgba(0,0,0,.45))">
<div style="background:#FBF6EC;clip-path:{zig};padding:34px 34px 40px;{rc}">
 <div style="text-align:center"><img src="logo.png" style="width:150px"><div style="font-size:12px;letter-spacing:.2em;margin-top:8px">PHIẾU TUYỂN DỤNG</div><div style="font-size:11px;margin-top:4px;opacity:.7">251D Hậu Giang · P.5 · Q.6 · TP.HCM</div></div>
 <div style="border-top:2px dashed #3a2a22;margin:14px 0 12px"></div>
 <div style="font-size:11px;display:flex;justify-content:space-between;opacity:.7"><span>SL</span><span>VỊ TRÍ / CÔNG VIỆC</span></div>
 <div style="margin-top:8px"><div style="font-size:18px;font-weight:700">1 × NHÂN VIÊN PHỤC VỤ</div><div style="font-size:12.5px;line-height:1.6;margin:4px 0 0 20px">+ đón khách, ghi order, mang nước ra bàn<br>+ giữ bàn ghế, khu vực quán sạch gọn<br>+ vui vẻ, nhanh nhẹn</div></div>
 <div style="margin-top:12px"><div style="font-size:18px;font-weight:700">1 × NHÂN VIÊN PHA CHẾ</div><div style="font-size:12.5px;line-height:1.6;margin:4px 0 0 20px">+ pha trà, cà phê theo công thức của tiệm<br>+ chuẩn bị nguyên liệu, topping, vệ sinh quầy<br>+ cẩn thận, ngăn nắp, chịu khó học hỏi</div></div>
 <div style="border-top:2px dashed #3a2a22;margin:14px 0 10px"></div>
 <div style="display:flex;justify-content:space-between;font-size:17px;font-weight:700"><span>THU NHẬP</span><span>TRAO ĐỔI KHI PV</span></div>
 <div style="border-top:2px dashed #3a2a22;margin:10px 0 12px"></div>
 <div style="border-radius:10px;overflow:hidden">{MAP(492,150,'border-radius:6px;filter:grayscale(.55) contrast(1.05)',76)}</div>
 <div style="text-align:center;font-size:12px;margin-top:12px;line-height:1.6">NHẮN FANPAGE HIHÊ HOẶC GHÉ QUÁN<br><span style="letter-spacing:.3em">* * * CẢM ƠN BẠN * * *</span></div>
</div></div>'''
open('assets/p8.html','w').write(page('var(--teal)',p8))

# 9 chữ khổng lồ, ảnh trong chữ
p9=f'''{LOGO_CARD(36,26,118)}
<span class="chip" style="position:absolute;right:40px;top:44px;background:var(--teal);color:var(--cream)">Quận 6 · TP.HCM</span>
<div style="position:absolute;left:0;right:0;top:112px;text-align:center">
 <div class="bc" style="font-size:46px;color:var(--teal);letter-spacing:6px">HiHê đang tuyển</div>
 <div class="bc" style="font-size:216px;color:var(--brick);margin-top:0;line-height:1.04">Phục vụ</div>
 <div style="position:relative;height:0"><div style="position:absolute;left:50%;top:-34px;transform:translateX(-50%) rotate(-6deg);background:var(--gold);color:var(--brick2);padding:4px 26px 6px;border-radius:10px;z-index:2;box-shadow:0 8px 14px -8px rgba(0,0,0,.5)" class="bc"><span style="font-size:52px">&amp;</span></div></div>
 <div class="bc" style="font-size:216px;line-height:1.04;margin-top:8px;color:var(--teal)">Pha chế</div>
</div>
<div style="position:absolute;left:40px;right:40px;top:688px;display:grid;grid-template-columns:1fr 1fr;gap:36px">
 <div class="role" style="border-top:4px solid var(--brick);padding-top:12px"><h3>Phục vụ</h3><ul>{SERVE[SERVE.index('<ul>')+4:SERVE.index('</ul>')]}</ul></div>
 <div class="role" style="border-top:4px solid var(--brick);padding-top:12px"><h3>Pha chế</h3><ul>{BREW[BREW.index('<ul>')+4:BREW.index('</ul>')]}</ul></div></div>
<div style="position:absolute;left:40px;right:40px;top:816px">{INC_GOLD}</div>
{TEALBAND}<div style="position:absolute;left:40px;top:896px">{MAP(400,170,'box-shadow:0 0 0 5px var(--cream2)')}</div>{ADDR(0,'var(--gold)','var(--teal2)',top=900,left=468)}'''
open('assets/p9.html','w').write(page('var(--cream)',p9,'background-image:repeating-linear-gradient(115deg,rgba(139,51,38,.035) 0 1.5px,transparent 1.5px 13px)'))

# 10 cắt xéo như logo
p10=f'''{PH(300,0,494,600,FADE('40%',None,None,'25%'),'center 35%')}
<div class="bc" style="position:absolute;left:30px;top:590px;transform-origin:left top;transform:rotate(-90deg);white-space:nowrap;font-size:92px;color:var(--gold);letter-spacing:4px;line-height:1">Đang tuyển</div>
{LOGO_CARD(150,26,118)}
<div style="position:absolute;left:150px;top:300px;color:#fff"><div class="bc" style="font-size:128px">Phục vụ</div><div class="bc" style="font-size:128px;margin-top:10px">&amp; pha chế</div></div>
<div style="position:absolute;left:0;right:0;top:586px;height:540px;background:var(--teal);clip-path:polygon(0 70px,100% 0,100% 100%,0 100%)" class="stripes"></div>
<div style="position:absolute;left:150px;right:40px;top:618px;display:grid;grid-template-columns:1fr 1fr;gap:16px"><div class="card role" style="padding:16px 18px 10px">{SERVE}</div><div class="card role" style="padding:16px 18px 10px">{BREW}</div></div>
<style>.role li{{font-size:12.4px}}</style>
<div style="position:absolute;left:150px;right:40px;top:782px">{INC_GOLD}</div>
<div style="position:absolute;left:150px;top:846px">{MAP(250,215,'box-shadow:0 0 0 4px var(--cream2)',80)}</div>
{ADDR(0,'var(--cream2)','var(--teal2)',top=850,left=424,w=330,fs=44)}'''
open('assets/p10.html','w').write(page('var(--brick)',p10))
