"use strict";
/* =========================================================================
   สต๊อกร้านเสื้อผ้า — Firebase edition
   UI + logic. Persistence is injected as a backend (Firestore) by index.html.
   Backend contract:
     backend.commit(mutateFn) -> Promise   // runs a transaction; mutateFn(state) mutates in place
     backend.signOut() -> Promise
     backend.user -> { displayName, email, photoURL }
   The module calls StockApp.setBackend(b), StockApp.onData(data|null) on each
   snapshot, and StockApp.mount() once.
   ========================================================================= */
window.StockApp = (function(){

var STATE = null;
var BACKEND = null;
var USER = null;
var mounted = false;
var pendingRender = false;
var IMG_CACHE = {};     // productId -> [{id, data}]
var IMG_LOADING = {};   // productId -> true while fetching

function nowISO(){ return new Date().toISOString(); }
function uid(p){ return (p||'x') + Math.random().toString(36).slice(2,8) + Date.now().toString(36).slice(-3); }

function defaultState(){
  var t = nowISO();
  return {
    meta:{ shopName:'ร้านเสื้อผ้าที่บ้าน', currency:'฿', lowStock:3,
      categories:['เสื้อยืด','เสื้อเชิ้ต','กางเกงขายาว','กางเกงขาสั้น','กระโปรง','เดรส','อื่นๆ'],
      locations:['ชั้น A','ชั้น B','กล่อง 1','กล่อง 2','ตู้หน้าร้าน'], updatedAt:t },
    products:[], purchases:[], sales:[], expenses:[]
  };
}
function normalize(s){
  s = s || defaultState();
  s.meta = s.meta || defaultState().meta;
  s.meta.categories = s.meta.categories || defaultState().meta.categories;
  s.meta.locations = s.meta.locations || [];
  if(typeof s.meta.lowStock!=='number') s.meta.lowStock=3;
  s.products = s.products || []; s.purchases = s.purchases || [];
  s.sales = s.sales || []; s.expenses = s.expenses || [];
  return s;
}

/* ---------- Public API used by the Firebase module ---------- */
function setBackend(b){ BACKEND=b; USER=b&&b.user||null; }
function onData(data){
  STATE = normalize(data);
  if(!mounted){ return; }
  if(document.getElementById('modalBg')){ pendingRender=true; return; }
  render();
}
function mount(){ mounted=true; if(STATE) render(); }

/* ---------- Commit (transactional write) ---------- */
function commit(mutateFn, toastOpts){
  if(!BACKEND){ toast('ยังไม่ได้เชื่อมต่อฐานข้อมูล','bad'); return; }
  setSync('saving');
  BACKEND.commit(mutateFn).then(function(){
    if(toastOpts) toast(toastOpts.msg, toastOpts.kind);
    setSync();
  }).catch(function(err){
    console.error('commit error',err);
    var code = err && (err.code||err.message) || '';
    if((''+code).indexOf('permission')>=0){ toast('ไม่มีสิทธิ์แก้ไขข้อมูล (ตรวจสอบ Firestore Rules / อีเมลที่อนุญาต)','bad'); }
    else { toast('บันทึกไม่สำเร็จ ลองใหม่อีกครั้ง','bad'); }
    setSync();
  });
}

/* ---------- Sync badge ---------- */
function setSync(state){
  var el = document.getElementById('syncBadge');
  if(!el) return;
  el.className='sync'; var dot='<span class="dot"></span>';
  if(state==='saving'){ el.classList.add('saving'); el.innerHTML=dot+'กำลังบันทึก…'; return; }
  el.classList.add('on'); el.innerHTML=dot+'ซิงก์เรียลไทม์';
}

/* ---------- Format helpers ---------- */
var baht = new Intl.NumberFormat('th-TH',{maximumFractionDigits:0});
var baht2 = new Intl.NumberFormat('th-TH',{minimumFractionDigits:0,maximumFractionDigits:2});
function money(n){ return '฿'+baht.format(Math.round(n||0)); }
function money2(n){ n=n||0; return '฿'+baht2.format(Math.round(n*100)/100); }
function num(n){ return baht.format(n||0); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
function fmtDate(iso){ try{ return new Date(iso).toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'2-digit'}); }catch(e){ return ''; } }
function fmtDateTime(iso){ try{ var d=new Date(iso); return d.toLocaleDateString('th-TH',{day:'numeric',month:'short'})+' '+d.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'}); }catch(e){ return ''; } }

/* ---------- Derived (operate on STATE for display) ---------- */
function productById(id){ for(var i=0;i<STATE.products.length;i++) if(STATE.products[i].id===id) return STATE.products[i]; return null; }
function pin(s,id){ for(var i=0;i<s.products.length;i++) if(s.products[i].id===id) return s.products[i]; return null; }
function stockValue(){ var v=0; STATE.products.forEach(function(p){ v+=(p.qty||0)*(p.avgCost||0); }); return v; }
function totalUnits(){ var v=0; STATE.products.forEach(function(p){ v+=(p.qty||0); }); return v; }
function salesTotals(){ var rev=0,cogs=0; STATE.sales.forEach(function(s){ rev+=s.qty*s.price; cogs+=s.qty*s.cost; }); return {rev:rev,cogs:cogs,profit:rev-cogs}; }
function expenseTotal(){ var v=0; STATE.expenses.forEach(function(e){ v+=e.amount||0; }); return v; }
function lowStockItems(){ var th=STATE.meta.lowStock||0; return STATE.products.filter(function(p){ return (p.qty||0)<=th; }); }
function byDateDesc(a,b){ return (b.date||'').localeCompare(a.date||''); }

/* ---------- Pure mutation appliers (operate on transaction state s) ---------- */
function applyReceive(s, productId, qty, unitCost, extraCost, note){
  var p=pin(s,productId); if(!p) return;
  qty=+qty; unitCost=+unitCost; extraCost=+(extraCost||0);
  var landed = unitCost + (qty>0 ? extraCost/qty : 0);
  var q0=p.qty||0, a0=p.avgCost||0, nq=q0+qty;
  p.avgCost = nq>0 ? (q0*a0 + qty*landed)/nq : landed;
  p.qty = nq;
  s.purchases.push({id:uid('b'),productId:productId,date:nowISO(),qty:qty,unitCost:unitCost,extraCost:extraCost,note:note||''});
}
function applySale(s, productId, qty, price, note){
  var p=pin(s,productId); if(!p) return;
  qty=+qty; price=+price;
  s.sales.push({id:uid('s'),productId:productId,date:nowISO(),qty:qty,price:price,cost:p.avgCost||0,note:note||''});
  p.qty=(p.qty||0)-qty;
}
function genSku(s, cat){
  var pre='SKU', map={'เสื้อยืด':'TS','เสื้อเชิ้ต':'SH','กางเกงขายาว':'PT','กางเกงขาสั้น':'SP','กระโปรง':'SK','เดรส':'DR'};
  if(map[cat]) pre=map[cat];
  var n=1; s.products.forEach(function(p){ if((p.sku||'').indexOf(pre+'-')===0){ var m=parseInt(p.sku.split('-')[1],10); if(m>=n) n=m+1; } });
  return pre+'-'+String(n).padStart(3,'0');
}

/* =========================================================================
   Icons
   ========================================================================= */
var IC = {
  dash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  box:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>',
  cart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h3l2.4 12.5a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.2L22 7H6"/></svg>',
  truck:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h11v10H3z"/><path d="M14 9h4l3 3v4h-7z"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/></svg>',
  chart:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 4-6"/></svg>',
  search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>',
  plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  print:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M6 17h12v4H6z"/></svg>',
  edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  back:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  gear:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 7 2.6a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 17 2.6a1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
  warn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 16H3z"/><path d="M12 9v5M12 17v.01"/></svg>',
  out:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  image:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
};

/* =========================================================================
   Rendering
   ========================================================================= */
var ROUTE = {view:'dash', id:null};
var PRODQ = {q:'', cat:'__all'};

function navItems(){
  var low = lowStockItems().length;
  return [
    {k:'dash', label:'ภาพรวม', icon:IC.dash},
    {k:'products', label:'สินค้า', icon:IC.box, badge: low||0},
    {k:'sell', label:'ขาย', icon:IC.cart},
    {k:'buy', label:'ซื้อเข้า', icon:IC.truck},
    {k:'reports', label:'รายงาน', icon:IC.chart}
  ];
}

function render(){
  pendingRender=false;
  var root = document.getElementById('root'); if(!root) return;
  var items = navItems();
  var side = '<nav class="sidenav"><div class="navlabel">เมนู</div>'+
    items.map(function(it){ return '<button class="navitem'+(ROUTE.view===it.k?' active':'')+'" data-nav="'+it.k+'">'+it.icon+'<span>'+it.label+'</span>'+(it.badge?'<span class="badge">'+it.badge+'</span>':'')+'</button>'; }).join('')+
    '<div style="flex:1"></div>'+
    '<button class="navitem" data-nav="settings">'+IC.gear+'<span>ตั้งค่า</span></button>'+
    '</nav>';
  var tab = '<nav class="tabbar">'+
    items.map(function(it){ return '<button class="tabitem'+(ROUTE.view===it.k?' active':'')+'" data-nav="'+it.k+'">'+it.icon+'<span>'+it.label+'</span>'+(it.badge?'<span class="badge">'+it.badge+'</span>':'')+'</button>'; }).join('')+'</nav>';

  var body;
  switch(ROUTE.view){
    case 'products': body=viewProducts(); break;
    case 'product': body=viewProduct(ROUTE.id); break;
    case 'sell': body=viewSell(); break;
    case 'buy': body=viewBuy(); break;
    case 'reports': body=viewReports(); break;
    case 'settings': body=viewSettings(); break;
    default: body=viewDash();
  }
  root.innerHTML = '<div class="app">'+topbar()+'<div class="shell">'+side+'<main class="main">'+body+'</main></div>'+tab+'</div>'+'<div class="print-area" id="printArea"></div>';
  setSync(); bind();
}

function topbar(){
  var who = USER? (USER.displayName||USER.email||'') : '';
  return '<header class="topbar">'+
    '<div class="brandmark"><div class="logo">'+esc((STATE.meta.shopName||'ร')[0])+'</div>'+
      '<div style="min-width:0"><div class="nm">'+esc(STATE.meta.shopName)+'</div><div class="sub">'+esc(who||'ระบบสต๊อก & กำไร-ขาดทุน')+'</div></div></div>'+
    '<div class="topbar-spring"></div>'+
    '<div class="sync" id="syncBadge"><span class="dot"></span></div>'+
    '<button class="iconbtn no-print" data-nav="settings" title="ตั้งค่า">'+IC.gear+'</button>'+
    '</header>';
}

/* ---------- Dashboard ---------- */
function viewDash(){
  var st=salesTotals(), exp=expenseTotal(); var net=st.profit-exp;
  var low=lowStockItems();
  var recent = STATE.sales.slice().sort(byDateDesc).slice(0,6);
  var kpis =
    stat('มูลค่าสต๊อกคงเหลือ', money(stockValue()), num(totalUnits())+' ชิ้น • '+STATE.products.length+' รายการ','brand')+
    stat('ยอดขายรวม', money(st.rev), STATE.sales.length+' ครั้ง','brand')+
    stat('กำไรขั้นต้น', money(st.profit), 'ยอดขาย − ต้นทุนขาย', st.profit>=0?'good':'bad')+
    stat('กำไรสุทธิ', money(net), 'หักค่าใช้จ่ายอื่น '+money(exp), net>=0?'good':'bad');
  var lowCard = '<div class="card pad"><h3 class="sec-title">'+IC.warn+' ของใกล้หมด <span class="n">เกณฑ์ ≤ '+STATE.meta.lowStock+' ชิ้น</span></h3>'+
    (low.length? '<div class="tablewrap" style="border:none"><table><tbody>'+
      low.sort(function(a,b){return a.qty-b.qty;}).slice(0,6).map(function(p){ return '<tr class="clickable" data-open="'+p.id+'"><td>'+prodCell(p)+'</td><td class="num">'+stockChip(p.qty)+'</td><td>'+locTag(p.location)+'</td></tr>'; }).join('')+'</tbody></table></div>'
      : '<div class="empty" style="padding:24px">'+IC.box+'<div>ยังไม่มีสินค้าใกล้หมด 👍</div></div>')+'</div>';
  var recentCard = '<div class="card pad"><h3 class="sec-title">'+IC.cart+' ขายล่าสุด</h3>'+
    (recent.length? '<div class="tablewrap" style="border:none"><table><tbody>'+
      recent.map(function(s){ var p=productById(s.productId); var profit=s.qty*(s.price-s.cost);
        return '<tr><td>'+prodCell(p, s.qty+' ชิ้น × '+money(s.price))+'</td><td class="num money '+(profit>=0?'pos':'neg')+'">'+(profit>=0?'+':'')+money(profit)+'</td></tr>'; }).join('')+'</tbody></table></div>'
      : '<div class="empty" style="padding:24px">'+IC.cart+'<div>ยังไม่มีรายการขาย</div><button class="btn primary sm" data-nav="sell" style="margin-top:10px">'+IC.plus+'คีย์ขายแรก</button></div>')+'</div>';
  return pageHead('ภาพรวมร้าน','สรุปสต๊อก ยอดขาย และกำไรวันนี้',
      '<button class="btn primary" data-nav="sell">'+IC.cart+'คีย์ขาย</button><button class="btn" data-add-product="1">'+IC.plus+'เพิ่มสินค้า</button>')+
    '<div class="grid kpis" style="margin-bottom:16px">'+kpis+'</div>'+
    '<div class="two-col">'+lowCard+recentCard+'</div>';
}
function stat(lab,val,sub,kind){ return '<div class="card stat '+(kind||'')+'"><div class="rail"></div><div class="lab">'+esc(lab)+'</div><div class="val tnum">'+val+'</div><div class="sub">'+esc(sub)+'</div></div>'; }

/* ---------- Products ---------- */
function viewProducts(){
  var cat=PRODQ.cat;
  var list = STATE.products.slice();
  if(PRODQ.q){ var qq=PRODQ.q.toLowerCase(); list=list.filter(function(p){ return (p.name+' '+p.sku+' '+(p.color||'')+' '+(p.size||'')+' '+(p.location||'')).toLowerCase().indexOf(qq)>=0; }); }
  if(cat && cat!=='__all'){ list=list.filter(function(p){return p.category===cat;}); }
  list.sort(function(a,b){ return (a.name||'').localeCompare(b.name||'','th'); });
  var catOpts='<option value="__all">ทุกประเภท</option>'+STATE.meta.categories.map(function(c){return '<option value="'+esc(c)+'"'+(cat===c?' selected':'')+'>'+esc(c)+'</option>';}).join('');
  var rows = list.map(function(p){ return '<tr class="clickable" data-open="'+p.id+'"><td>'+prodCell(p)+'</td><td>'+locTag(p.location)+'</td><td class="num">'+stockChip(p.qty)+'</td><td class="num tnum">'+money2(p.avgCost)+'</td><td class="num tnum">'+money(p.qty*p.avgCost)+'</td></tr>'; }).join('');
  var table = list.length?
    '<div class="tablewrap"><table><thead><tr><th>สินค้า</th><th>ที่เก็บ</th><th class="num">คงเหลือ</th><th class="num">ต้นทุน/ชิ้น</th><th class="num">มูลค่า</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    : (STATE.products.length? '<div class="empty">'+IC.search+'<h3>ไม่พบสินค้าที่ค้นหา</h3><div>ลองคำอื่น หรือล้างตัวกรอง</div></div>'
        : '<div class="empty">'+IC.box+'<h3>ยังไม่มีสินค้า</h3><div>เริ่มด้วยการเพิ่มสินค้าชิ้นแรก</div><button class="btn primary" data-add-product="1" style="margin-top:12px">'+IC.plus+'เพิ่มสินค้า</button></div>');
  return pageHead('สินค้า & สต๊อก', STATE.products.length+' รายการ • '+num(totalUnits())+' ชิ้น • มูลค่า '+money(stockValue()),
      '<button class="btn" data-print-labels="1">'+IC.print+'ปริ้น QR</button><button class="btn primary" data-add-product="1">'+IC.plus+'เพิ่มสินค้า</button>')+
    '<div class="toolbar"><div class="search">'+IC.search+'<input id="q" placeholder="ค้นหาชื่อ / รหัส SKU / สี / ที่เก็บ" value="'+esc(PRODQ.q)+'"></div><div class="field"><select id="catf">'+catOpts+'</select></div></div>'+ table;
}
function prodCell(p, sub){
  if(!p) return '<span class="prod-cell"><span class="nm">(ลบแล้ว)</span></span>';
  var meta = sub || [p.category,p.size?('ไซส์ '+p.size):'',p.color].filter(Boolean).join(' • ');
  return '<span class="prod-cell"><span class="nm">'+esc(p.name)+'</span><span class="meta"><span class="mono">'+esc(p.sku)+'</span> · '+esc(meta)+'</span></span>';
}
function stockChip(q){ var th=STATE.meta.lowStock||0; var cls=q<=0?'bad':(q<=th?'warn':'good'); return '<span class="chip '+cls+'">'+num(q)+' ชิ้น</span>'; }
function locTag(loc){ return loc? '<span class="loc-tag">📍 '+esc(loc)+'</span>' : '<span class="loc-tag" style="opacity:.6">—</span>'; }

/* ---------- Product detail ---------- */
function viewProduct(id){
  var p=productById(id);
  if(!p) return pageHead('ไม่พบสินค้า','',' ')+'<button class="btn" data-nav="products">'+IC.back+'กลับ</button>';
  var pu = STATE.purchases.filter(function(x){return x.productId===id;}).sort(byDateDesc);
  var sa = STATE.sales.filter(function(x){return x.productId===id;}).sort(byDateDesc);
  var soldQty=0, soldProfit=0; sa.forEach(function(s){ soldQty+=s.qty; soldProfit+=s.qty*(s.price-s.cost); });
  var head = '<div class="page-head"><button class="btn ghost sm" data-nav="products">'+IC.back+'</button>'+
    '<div><h1>'+esc(p.name)+'</h1><div class="desc"><span class="mono">'+esc(p.sku)+'</span> · '+esc([p.category,p.size?('ไซส์ '+p.size):'',p.color].filter(Boolean).join(' • '))+'</div></div>'+
    '<div class="page-head-actions"><button class="btn sm" data-edit="'+p.id+'">'+IC.edit+'แก้ไข</button></div></div>';
  var detail = '<div class="card pad"><div class="detail-top">'+
    '<div><dl class="spec">'+
      '<dt>คงเหลือ</dt><dd>'+stockChip(p.qty)+'</dd>'+
      '<dt>ที่เก็บ</dt><dd>'+locTag(p.location)+'</dd>'+
      '<dt>ต้นทุนเฉลี่ย/ชิ้น</dt><dd class="tnum">'+money2(p.avgCost)+'</dd>'+
      '<dt>มูลค่าคงเหลือ</dt><dd class="tnum">'+money(p.qty*p.avgCost)+'</dd>'+
      '<dt>ขายไปแล้ว</dt><dd class="tnum">'+num(soldQty)+' ชิ้น</dd>'+
      '<dt>กำไรสะสม</dt><dd class="tnum money '+(soldProfit>=0?'pos':'neg')+'">'+(soldProfit>=0?'+':'')+money(soldProfit)+'</dd>'+
    '</dl><div class="detail-actions"><button class="btn primary sm" data-sell="'+p.id+'">'+IC.cart+'ขายชิ้นนี้</button><button class="btn sm" data-receive="'+p.id+'">'+IC.truck+'รับของเข้า</button></div></div>'+
    '<div class="qr-card"><div id="qrbox"></div><div class="sku mono">'+esc(p.sku)+'</div><div style="font-size:12px;color:var(--ink-3);margin-top:2px">สแกนเพื่อเปิดสินค้านี้</div><button class="btn sm no-print" data-print-one="'+p.id+'" style="margin-top:10px">'+IC.print+'ปริ้น QR</button></div>'+
    '</div></div>';
  var puCard = '<div class="card pad"><h3 class="sec-title">'+IC.truck+' ประวัติซื้อเข้า <span class="n">'+pu.length+' ครั้ง</span></h3>'+
    (pu.length? '<div class="tablewrap" style="border:none"><table><thead><tr><th>วันที่</th><th class="num">จำนวน</th><th class="num">ทุน/ชิ้น</th><th class="num">ค่าใช้จ่ายอื่น</th><th class="num">ทุนรวม/ชิ้น</th></tr></thead><tbody>'+
      pu.map(function(b){ var landed=b.unitCost+(b.qty>0?b.extraCost/b.qty:0); return '<tr><td>'+fmtDate(b.date)+(b.note?' <span style="color:var(--ink-3)">· '+esc(b.note)+'</span>':'')+'</td><td class="num tnum">'+num(b.qty)+'</td><td class="num tnum">'+money2(b.unitCost)+'</td><td class="num tnum">'+money2(b.extraCost)+'</td><td class="num tnum">'+money2(landed)+'</td></tr>'; }).join('')+'</tbody></table></div>' : '<div class="empty" style="padding:20px">ยังไม่มีประวัติซื้อเข้า</div>')+'</div>';
  var saCard = '<div class="card pad"><h3 class="sec-title">'+IC.cart+' ประวัติการขาย <span class="n">'+sa.length+' ครั้ง</span></h3>'+
    (sa.length? '<div class="tablewrap" style="border:none"><table><thead><tr><th>วันที่</th><th class="num">จำนวน</th><th class="num">ราคาขาย</th><th class="num">ทุน</th><th class="num">กำไร</th></tr></thead><tbody>'+
      sa.map(function(s){ var pf=s.qty*(s.price-s.cost); return '<tr><td>'+fmtDate(s.date)+'</td><td class="num tnum">'+num(s.qty)+'</td><td class="num tnum">'+money2(s.price)+'</td><td class="num tnum">'+money2(s.cost)+'</td><td class="num tnum money '+(pf>=0?'pos':'neg')+'">'+(pf>=0?'+':'')+money(pf)+'</td></tr>'; }).join('')+'</tbody></table></div>' : '<div class="empty" style="padding:20px">ยังไม่มีการขาย</div>')+'</div>';
  return head+detail+galleryCard(p.id)+'<div class="two-col" style="margin-top:14px">'+saCard+puCard+'</div><div style="margin-top:16px"><button class="btn danger sm" data-delete="'+p.id+'">'+IC.trash+'ลบสินค้านี้</button></div>';
}

/* ---------- Product image gallery (stored free as data in Firestore) ---------- */
function galleryCard(pid){
  var imgs = IMG_CACHE[pid];
  var body;
  if(imgs===undefined){
    loadImages(pid);
    body = '<div class="empty" style="padding:20px;color:var(--ink-3)">กำลังโหลดรูป…</div>';
  } else if(!imgs.length){
    body = '<div class="empty" style="padding:22px">'+IC.image+'<div>ยังไม่มีรูปสินค้า</div><div style="font-size:12px;margin-top:2px">เพิ่มได้หลายรูป ระบบย่อขนาดให้อัตโนมัติ</div></div>';
  } else {
    body = '<div class="gallery">'+ imgs.map(function(im){
      return '<div class="gal-item"><img src="'+im.data+'" alt="รูปสินค้า" data-lightbox="'+im.id+'"><button class="gal-del no-print" data-del-img="'+im.id+'" title="ลบรูป">'+IC.close+'</button></div>';
    }).join('') +'</div>';
  }
  return '<div class="card pad" style="margin-top:14px"><h3 class="sec-title">'+IC.image+' รูปสินค้า'+(imgs&&imgs.length?' <span class="n">'+imgs.length+' รูป</span>':'')+
    '<button class="btn primary sm no-print" data-add-img="'+pid+'" style="margin-left:auto">'+IC.plus+'เพิ่มรูป</button></h3>'+ body +'</div>';
}
function loadImages(pid){
  if(IMG_LOADING[pid] || !BACKEND || !BACKEND.getImages) return;
  IMG_LOADING[pid]=true;
  BACKEND.getImages(pid).then(function(list){
    IMG_CACHE[pid]=list||[]; IMG_LOADING[pid]=false;
    if(ROUTE.view==='product' && ROUTE.id===pid && !document.getElementById('modalBg')) render();
  }).catch(function(e){ console.error('getImages',e); IMG_CACHE[pid]=[]; IMG_LOADING[pid]=false;
    if(ROUTE.view==='product' && ROUTE.id===pid) render(); });
}
/* Resize an image file to a compact JPEG data URL (keeps Firestore docs < 1MB, all free) */
function resizeImage(file, maxDim, quality){
  return new Promise(function(resolve, reject){
    var reader=new FileReader();
    reader.onerror=function(){ reject(new Error('read')); };
    reader.onload=function(){
      var img=new Image();
      img.onerror=function(){ reject(new Error('decode')); };
      img.onload=function(){
        var w=img.width, h=img.height, scale=Math.min(1, maxDim/Math.max(w,h));
        var cw=Math.round(w*scale), ch=Math.round(h*scale);
        var c=document.createElement('canvas'); c.width=cw; c.height=ch;
        var ctx=c.getContext('2d'); ctx.drawImage(img,0,0,cw,ch);
        var q=quality;
        var out=c.toDataURL('image/jpeg', q);
        // step quality down if the encoded string is too large for a Firestore doc
        while(out.length>820000 && q>0.4){ q-=0.1; out=c.toDataURL('image/jpeg', q); }
        resolve(out);
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function addImagesFlow(pid){
  if(!BACKEND||!BACKEND.addImage){ toast('ยังไม่พร้อมอัปโหลดรูป','bad'); return; }
  var inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.multiple=true;
  inp.onchange=function(){
    var files=Array.prototype.slice.call(inp.files||[]); if(!files.length) return;
    files=files.filter(function(f){ return /^image\//.test(f.type); });
    if(!files.length){ toast('เลือกได้เฉพาะไฟล์รูปภาพ','bad'); return; }
    toast('กำลังเพิ่มรูป '+files.length+' รูป…');
    setSync('saving');
    var chain=Promise.resolve();
    files.forEach(function(f){
      chain=chain.then(function(){ return resizeImage(f,1280,0.72); }).then(function(data){ return BACKEND.addImage(pid, data); });
    });
    chain.then(function(){
      delete IMG_CACHE[pid]; // force refetch
      loadImages(pid); setSync();
      toast('เพิ่มรูปแล้ว','good');
    }).catch(function(e){ console.error('addImages',e); setSync(); toast('เพิ่มรูปไม่สำเร็จ','bad'); });
  };
  inp.click();
}
function deleteImageFlow(imageId, pid){
  if(!BACKEND||!BACKEND.deleteImage) return;
  setSync('saving');
  BACKEND.deleteImage(imageId).then(function(){
    delete IMG_CACHE[pid]; loadImages(pid); setSync(); toast('ลบรูปแล้ว','good');
  }).catch(function(e){ console.error('delImg',e); setSync(); toast('ลบรูปไม่สำเร็จ','bad'); });
}
function lightbox(imageId, pid){
  var list=IMG_CACHE[pid]||[]; var im=null; list.forEach(function(x){ if(x.id===imageId) im=x; }); if(!im) return;
  var bg=document.createElement('div'); bg.className='lightbox'; bg.id='lightbox';
  bg.innerHTML='<img src="'+im.data+'" alt="รูปสินค้า"><button class="lb-close">'+IC.close+'</button>';
  bg.onclick=function(){ bg.remove(); };
  document.body.appendChild(bg);
}

/* ---------- Sell ---------- */
function viewSell(){
  var recent = STATE.sales.slice().sort(byDateDesc); var st=salesTotals();
  var rows = recent.map(function(s){ var p=productById(s.productId); var pf=s.qty*(s.price-s.cost);
    return '<tr'+(p?' class="clickable" data-open="'+p.id+'"':'')+'><td>'+fmtDateTime(s.date)+'</td><td>'+prodCell(p)+'</td><td class="num tnum">'+num(s.qty)+'</td><td class="num tnum">'+money2(s.price)+'</td><td class="num tnum">'+money2(s.cost)+'</td><td class="num tnum money '+(pf>=0?'pos':'neg')+'">'+(pf>=0?'+':'')+money(pf)+'</td><td class="num no-print"><button class="btn ghost sm" data-del-sale="'+s.id+'">'+IC.trash+'</button></td></tr>'; }).join('');
  var table = recent.length? '<div class="tablewrap"><table><thead><tr><th>เวลา</th><th>สินค้า</th><th class="num">จำนวน</th><th class="num">ราคาขาย</th><th class="num">ทุน</th><th class="num">กำไร</th><th></th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    : '<div class="empty">'+IC.cart+'<h3>ยังไม่มีรายการขาย</h3><div>กดปุ่มคีย์ขายเพื่อบันทึกการขายและดูกำไรทันที</div></div>';
  return pageHead('คีย์ขาย & กำไร','ยอดขายรวม '+money(st.rev)+' • กำไรขั้นต้น '+money(st.profit),
      '<button class="btn primary" data-add-sale="1">'+IC.plus+'คีย์ขายใหม่</button>')+
    '<div class="grid kpis" style="margin-bottom:16px">'+stat('ยอดขายรวม',money(st.rev),STATE.sales.length+' ครั้ง','brand')+stat('ต้นทุนขายรวม',money(st.cogs),'ตามต้นทุนเฉลี่ย','brand')+stat('กำไรขั้นต้น',money(st.profit),st.rev>0?('มาร์จิ้น '+Math.round(st.profit/st.rev*100)+'%'):'',st.profit>=0?'good':'bad')+'</div>'+ table;
}

/* ---------- Buy ---------- */
function viewBuy(){
  var recent = STATE.purchases.slice().sort(byDateDesc);
  var totalCost=0; STATE.purchases.forEach(function(b){ totalCost+=b.qty*b.unitCost+(b.extraCost||0); });
  var rows = recent.map(function(b){ var p=productById(b.productId); var landed=b.unitCost+(b.qty>0?b.extraCost/b.qty:0);
    return '<tr'+(p?' class="clickable" data-open="'+p.id+'"':'')+'><td>'+fmtDateTime(b.date)+'</td><td>'+prodCell(p)+'</td><td class="num tnum">'+num(b.qty)+'</td><td class="num tnum">'+money2(b.unitCost)+'</td><td class="num tnum">'+money2(b.extraCost)+'</td><td class="num tnum">'+money2(landed)+'</td><td class="num tnum">'+money(b.qty*b.unitCost+(b.extraCost||0))+'</td></tr>'; }).join('');
  var table = recent.length? '<div class="tablewrap"><table><thead><tr><th>เวลา</th><th>สินค้า</th><th class="num">จำนวน</th><th class="num">ทุน/ชิ้น</th><th class="num">ค่าใช้จ่ายอื่น</th><th class="num">ทุนรวม/ชิ้น</th><th class="num">รวมเงิน</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
    : '<div class="empty">'+IC.truck+'<h3>ยังไม่มีการซื้อเข้า</h3><div>บันทึกล็อตที่ซื้อมา ระบบจะคำนวณต้นทุนเฉลี่ยให้อัตโนมัติ</div></div>';
  return pageHead('ซื้อเข้า / รับของ','รวมเงินซื้อเข้าทั้งหมด '+money(totalCost),
      '<button class="btn primary" data-add-purchase="1">'+IC.plus+'บันทึกซื้อเข้า</button>')+
    '<div class="banner warn" style="background:var(--brand-ink);color:var(--brand);border-color:color-mix(in srgb,var(--brand) 25%,transparent)">'+IC.truck+'<div>ทุก ๆ ครั้งที่รับของเข้า ระบบจะรวม “ค่าใช้จ่ายอื่น” (ค่าส่ง/ค่าแพ็ค ฯลฯ) เข้ากับต้นทุน แล้วคิด<b>ต้นทุนเฉลี่ยถ่วงน้ำหนัก</b>ให้ใหม่เอง</div></div>'+ table;
}

/* ---------- Reports ---------- */
function viewReports(){
  var st=salesTotals(), exp=expenseTotal(); var net=st.profit-exp;
  var byProd={}; STATE.sales.forEach(function(s){ var k=s.productId; if(!byProd[k]) byProd[k]={qty:0,rev:0,profit:0}; byProd[k].qty+=s.qty; byProd[k].rev+=s.qty*s.price; byProd[k].profit+=s.qty*(s.price-s.cost); });
  var prodRows = Object.keys(byProd).map(function(k){ return {p:productById(k),d:byProd[k]}; }).sort(function(a,b){return b.d.profit-a.d.profit;});
  var pr = prodRows.length? prodRows.map(function(r){ return '<tr'+(r.p?' class="clickable" data-open="'+r.p.id+'"':'')+'><td>'+prodCell(r.p)+'</td><td class="num tnum">'+num(r.d.qty)+'</td><td class="num tnum">'+money(r.d.rev)+'</td><td class="num tnum money '+(r.d.profit>=0?'pos':'neg')+'">'+(r.d.profit>=0?'+':'')+money(r.d.profit)+'</td></tr>'; }).join('') : '<tr><td colspan="4"><div class="empty" style="padding:20px">ยังไม่มีข้อมูลการขาย</div></td></tr>';
  var exRows = STATE.expenses.slice().sort(byDateDesc);
  var exHtml = exRows.length? exRows.map(function(e){ return '<tr><td>'+fmtDate(e.date)+'</td><td>'+esc(e.category)+(e.note?' <span style="color:var(--ink-3)">· '+esc(e.note)+'</span>':'')+'</td><td class="num tnum">'+money2(e.amount)+'</td><td class="num no-print"><button class="btn ghost sm" data-del-exp="'+e.id+'">'+IC.trash+'</button></td></tr>'; }).join('') : '<tr><td colspan="4"><div class="empty" style="padding:18px">ยังไม่มีค่าใช้จ่ายอื่น</div></td></tr>';
  return pageHead('รายงานกำไร-ขาดทุน','สรุปผลประกอบการจากข้อมูลทั้งหมด',
      '<button class="btn" data-export="1">ดาวน์โหลด CSV</button><button class="btn" data-print-report="1">'+IC.print+'ปริ้น</button>')+
    '<div class="grid kpis" style="margin-bottom:16px">'+stat('ยอดขายรวม',money(st.rev),'','brand')+stat('ต้นทุนขาย (COGS)',money(st.cogs),'','brand')+stat('กำไรขั้นต้น',money(st.profit),st.rev>0?('มาร์จิ้น '+Math.round(st.profit/st.rev*100)+'%'):'',st.profit>=0?'good':'bad')+stat('กำไรสุทธิ',money(net),'หักค่าใช้จ่ายอื่น '+money(exp),net>=0?'good':'bad')+'</div>'+
    '<div class="two-col"><div class="card pad"><h3 class="sec-title">'+IC.chart+' กำไรรายสินค้า</h3><div class="tablewrap" style="border:none"><table><thead><tr><th>สินค้า</th><th class="num">ขาย</th><th class="num">ยอดขาย</th><th class="num">กำไร</th></tr></thead><tbody>'+pr+'</tbody></table></div></div>'+
      '<div class="card pad"><h3 class="sec-title">'+IC.truck+' ค่าใช้จ่ายอื่น <span class="n">รวม '+money(exp)+'</span></h3><div style="margin-bottom:10px"><button class="btn sm" data-add-exp="1">'+IC.plus+'เพิ่มค่าใช้จ่าย</button></div><div class="tablewrap" style="border:none"><table><thead><tr><th>วันที่</th><th>รายการ</th><th class="num">จำนวนเงิน</th><th></th></tr></thead><tbody>'+exHtml+'</tbody></table></div></div></div>';
}

/* ---------- Settings ---------- */
function viewSettings(){
  var who = USER? (USER.displayName||USER.email||'') : '';
  return pageHead('ตั้งค่า','ชื่อร้าน เกณฑ์ของใกล้หมด และการจัดการข้อมูล',' ')+
    '<div class="card pad" style="max-width:520px"><div class="form-grid">'+
      '<div class="form-row full"><label>ชื่อร้าน</label><input id="set-shop" value="'+esc(STATE.meta.shopName)+'"></div>'+
      '<div class="form-row"><label>เตือนของใกล้หมดเมื่อ ≤ (ชิ้น)</label><input id="set-low" type="number" min="0" value="'+esc(STATE.meta.lowStock)+'"></div>'+
    '</div><div style="margin-top:14px"><button class="btn primary" data-save-settings="1">บันทึกการตั้งค่า</button></div></div>'+
    '<div class="card pad" style="max-width:520px;margin-top:14px"><h3 class="sec-title">ข้อมูล</h3><div style="display:flex;gap:8px;flex-wrap:wrap">'+
      '<button class="btn" data-export="1">ดาวน์โหลด CSV</button><button class="btn" data-backup="1">สำรองข้อมูล (JSON)</button><button class="btn" data-import="1">นำเข้าข้อมูล (JSON)</button><button class="btn danger" data-clear="1">'+IC.trash+'ล้างข้อมูลทั้งหมด</button>'+
    '</div><div class="hint" style="margin-top:10px;font-size:12px;color:var(--ink-3)">อัปเดตล่าสุด: '+fmtDateTime(STATE.meta.updatedAt)+'</div></div>'+
    '<div class="card pad" style="max-width:520px;margin-top:14px"><h3 class="sec-title">บัญชี</h3><div style="font-size:13.5px;color:var(--ink-2);margin-bottom:10px">เข้าใช้งานในชื่อ <b>'+esc(who)+'</b></div><button class="btn" data-signout="1">'+IC.out+'ออกจากระบบ</button></div>';
}

function pageHead(title,desc,actions){ return '<div class="page-head"><div><h1>'+esc(title)+'</h1>'+(desc?'<div class="desc">'+esc(desc)+'</div>':'')+'</div>'+(actions&&actions.trim()?'<div class="page-head-actions no-print">'+actions+'</div>':'')+'</div>'; }

/* =========================================================================
   QR
   ========================================================================= */
function baseUrl(){ return location.origin+location.pathname+location.search; }
function qrSvg(id){ var q=qrcode(0,'M'); q.addData(baseUrl()+'#p='+id); q.make(); return q.createSvgTag({cellSize:4,margin:1,scalable:true}); }
function renderProductQR(){ var box=document.getElementById('qrbox'); if(box && ROUTE.view==='product' && ROUTE.id){ try{ box.innerHTML=qrSvg(ROUTE.id); }catch(e){ box.textContent='(QR error)'; } } }

/* =========================================================================
   Modals
   ========================================================================= */
function openModal(title, bodyHtml, footHtml){
  closeModal();
  var bg=document.createElement('div'); bg.className='modal-bg'; bg.id='modalBg';
  bg.innerHTML='<div class="modal" role="dialog" aria-modal="true"><div class="modal-head"><h2>'+esc(title)+'</h2><div style="flex:1"></div><button class="iconbtn" data-close="1">'+IC.close+'</button></div><div class="modal-body">'+bodyHtml+'</div>'+(footHtml?'<div class="modal-foot">'+footHtml+'</div>':'')+'</div>';
  document.body.appendChild(bg);
  bg.addEventListener('click',function(e){ if(e.target===bg) closeModal(); });
  bg.querySelectorAll('[data-close]').forEach(function(b){ b.onclick=function(){ closeModal(); }; });
  var first=bg.querySelector('input,select,textarea'); if(first) setTimeout(function(){first.focus();},60);
}
function closeModal(){ var m=document.getElementById('modalBg'); if(m) m.remove(); if(pendingRender) render(); }
document.addEventListener('keydown',function(e){ if(e.key==='Escape') closeModal(); });

function productSelect(id, selId){ var opts=STATE.products.slice().sort(function(a,b){return (a.name||'').localeCompare(b.name||'','th');}).map(function(p){ return '<option value="'+p.id+'"'+(p.id===selId?' selected':'')+'>'+esc(p.name)+' ('+esc(p.sku)+') — เหลือ '+num(p.qty)+'</option>'; }).join(''); return '<select id="'+id+'">'+opts+'</select>'; }
function catSelect(id, sel){ return '<select id="'+id+'">'+STATE.meta.categories.map(function(c){return '<option'+(c===sel?' selected':'')+'>'+esc(c)+'</option>';}).join('')+'</select>'; }
function locDatalist(){ return '<datalist id="locs">'+STATE.meta.locations.map(function(l){return '<option value="'+esc(l)+'">';}).join('')+'</datalist>'; }
function val(id){ var e=document.getElementById(id); return e?e.value.trim():''; }
function fval(id){ var e=document.getElementById(id); return e?parseFloat(e.value||'0')||0:0; }

function addProductModal(existing){
  var p=existing||{};
  var body='<div class="form-grid">'+
    '<div class="form-row full"><label>ชื่อสินค้า *</label><input id="f-name" value="'+esc(p.name||'')+'" placeholder="เช่น เสื้อยืดคอกลม"></div>'+
    '<div class="form-row"><label>รหัส SKU</label><input id="f-sku" value="'+esc(p.sku||'')+'" placeholder="เว้นว่างให้ระบบสร้างให้"></div>'+
    '<div class="form-row"><label>ประเภท</label>'+catSelect('f-cat',p.category)+'</div>'+
    '<div class="form-row"><label>ไซส์</label><input id="f-size" value="'+esc(p.size||'')+'" placeholder="S / M / L / 32"></div>'+
    '<div class="form-row"><label>สี</label><input id="f-color" value="'+esc(p.color||'')+'" placeholder="เช่น ขาว"></div>'+
    '<div class="form-row full"><label>ที่เก็บของ</label><input id="f-loc" list="locs" value="'+esc(p.location||'')+'" placeholder="เช่น ชั้น A / กล่อง 1">'+locDatalist()+'</div>'+
    (existing? '<div class="form-row"><label>คงเหลือ (ปรับมือ)</label><input id="f-qty" type="number" value="'+esc(p.qty)+'"></div><div class="form-row"><label>ต้นทุนเฉลี่ย/ชิ้น</label><input id="f-cost" type="number" min="0" step="0.01" value="'+esc(p.avgCost)+'"></div>'
             : '<div class="form-row"><label>จำนวนเริ่มต้น</label><input id="f-qty" type="number" min="0" value="0"></div><div class="form-row"><label>ต้นทุน/ชิ้น</label><input id="f-cost" type="number" min="0" step="0.01" value="0"></div>')+
    '</div>';
  openModal(existing?'แก้ไขสินค้า':'เพิ่มสินค้าใหม่', body, '<button class="btn ghost" data-close="1">ยกเลิก</button><button class="btn primary" id="saveProd">บันทึก</button>');
  document.getElementById('saveProd').onclick=function(){
    var name=val('f-name'); if(!name){ toast('กรุณาใส่ชื่อสินค้า','bad'); return; }
    var sku=val('f-sku'), cat=val('f-cat'), size=val('f-size'), color=val('f-color'), loc=val('f-loc'), qty=fval('f-qty'), cost=fval('f-cost');
    if(existing){
      commit(function(s){ var p2=pin(s,existing.id); if(!p2) return; p2.name=name; p2.sku=sku||p2.sku; p2.category=cat; p2.size=size; p2.color=color; p2.location=loc; p2.qty=qty; p2.avgCost=cost; rememberLoc(s,loc); },{msg:'บันทึกการแก้ไขแล้ว',kind:'good'});
    } else {
      commit(function(s){ var id=uid('p'); s.products.push({id:id,sku:sku||genSku(s,cat),name:name,category:cat,size:size,color:color,location:loc,qty:0,avgCost:0,createdAt:nowISO()}); if(qty>0) applyReceive(s,id,qty,cost,0,'ยอดยกมา'); rememberLoc(s,loc); },{msg:'เพิ่มสินค้าแล้ว',kind:'good'});
    }
    closeModal();
  };
}
function rememberLoc(s,l){ if(l && s.meta.locations.indexOf(l)<0) s.meta.locations.push(l); }

function sellModal(preId){
  if(!STATE.products.length){ toast('ยังไม่มีสินค้า เพิ่มสินค้าก่อน','bad'); return; }
  var body='<div class="form-grid"><div class="form-row full"><label>สินค้า</label>'+productSelect('s-prod',preId)+'</div><div class="form-row"><label>จำนวนที่ขาย</label><input id="s-qty" type="number" min="1" value="1"></div><div class="form-row"><label>ราคาขาย/ชิ้น</label><input id="s-price" type="number" min="0" step="0.01" value="" placeholder="0"></div><div class="form-row full"><label>หมายเหตุ</label><input id="s-note" placeholder="เช่น ช่องทางขาย / ลูกค้า"></div></div><div class="calc-box" id="s-calc"></div>';
  openModal('คีย์ขาย', body, '<button class="btn ghost" data-close="1">ยกเลิก</button><button class="btn primary" id="saveSale">บันทึกการขาย</button>');
  function recalc(){ var p=productById(val('s-prod')); if(!p) return; var qty=fval('s-qty'), price=fval('s-price'); var cost=p.avgCost*qty, rev=price*qty, pf=rev-cost; var over=qty>p.qty;
    document.getElementById('s-calc').innerHTML='<div class="calc-line"><span>ต้นทุนเฉลี่ย ('+num(qty)+' × '+money2(p.avgCost)+')</span><span class="tnum">'+money2(cost)+'</span></div><div class="calc-line"><span>ยอดขาย</span><span class="tnum">'+money2(rev)+'</span></div><div class="calc-line total"><span>'+(pf>=0?'กำไร':'ขาดทุน')+'</span><span class="tnum money '+(pf>=0?'pos':'neg')+'">'+(pf>=0?'+':'')+money2(pf)+'</span></div>'+(over?'<div style="color:var(--bad);font-size:12.5px;margin-top:6px">⚠️ ขายมากกว่าที่มีในสต๊อก (เหลือ '+num(p.qty)+') — บันทึกได้ แต่สต๊อกจะติดลบ</div>':''); }
  ['s-prod','s-qty','s-price'].forEach(function(id){ var e=document.getElementById(id); if(e){ e.addEventListener('input',recalc); e.addEventListener('change',recalc);} }); recalc();
  document.getElementById('saveSale').onclick=function(){ var pid=val('s-prod'), qty=fval('s-qty'), price=fval('s-price'); if(qty<=0){ toast('ใส่จำนวนให้ถูกต้อง','bad'); return; } commit(function(s){ applySale(s,pid,qty,price,val('s-note')); },{msg:'บันทึกการขายแล้ว',kind:'good'}); closeModal(); };
}

function receiveModal(preId){
  if(!STATE.products.length){ toast('ยังไม่มีสินค้า เพิ่มสินค้าก่อน','bad'); return; }
  var body='<div class="form-grid"><div class="form-row full"><label>สินค้า</label>'+productSelect('r-prod',preId)+'</div><div class="form-row"><label>จำนวนที่รับเข้า</label><input id="r-qty" type="number" min="1" value="1"></div><div class="form-row"><label>ต้นทุน/ชิ้น</label><input id="r-cost" type="number" min="0" step="0.01" value="" placeholder="0"></div><div class="form-row full"><label>ค่าใช้จ่ายอื่นทั้งล็อต (ค่าส่ง/แพ็ค ฯลฯ)</label><input id="r-extra" type="number" min="0" step="0.01" value="0"></div><div class="form-row full"><label>หมายเหตุ</label><input id="r-note" placeholder="เช่น ร้านที่ซื้อ / เลขบิล"></div></div><div class="calc-box" id="r-calc"></div>';
  openModal('รับของเข้า', body, '<button class="btn ghost" data-close="1">ยกเลิก</button><button class="btn primary" id="saveRecv">บันทึกรับเข้า</button>');
  function recalc(){ var p=productById(val('r-prod')); if(!p) return; var qty=fval('r-qty'), cost=fval('r-cost'), extra=fval('r-extra'); var landed=cost+(qty>0?extra/qty:0); var q0=p.qty,a0=p.avgCost,nq=q0+qty; var na=nq>0?(q0*a0+qty*landed)/nq:landed;
    document.getElementById('r-calc').innerHTML='<div class="calc-line"><span>ทุนรวม/ชิ้น (รวมค่าใช้จ่ายอื่น)</span><span class="tnum">'+money2(landed)+'</span></div><div class="calc-line"><span>เงินที่จ่ายล็อตนี้</span><span class="tnum">'+money2(qty*cost+extra)+'</span></div><div class="calc-line"><span>ต้นทุนเฉลี่ยเดิม → ใหม่</span><span class="tnum">'+money2(a0)+' → '+money2(na)+'</span></div><div class="calc-line total"><span>คงเหลือหลังรับเข้า</span><span class="tnum">'+num(nq)+' ชิ้น</span></div>'; }
  ['r-prod','r-qty','r-cost','r-extra'].forEach(function(id){ var e=document.getElementById(id); if(e){ e.addEventListener('input',recalc); e.addEventListener('change',recalc);} }); recalc();
  document.getElementById('saveRecv').onclick=function(){ var pid=val('r-prod'), qty=fval('r-qty'), cost=fval('r-cost'), extra=fval('r-extra'); if(qty<=0){ toast('ใส่จำนวนให้ถูกต้อง','bad'); return; } commit(function(s){ applyReceive(s,pid,qty,cost,extra,val('r-note')); },{msg:'รับของเข้าแล้ว',kind:'good'}); closeModal(); };
}

function expenseModal(){
  var body='<div class="form-grid"><div class="form-row full"><label>รายการค่าใช้จ่าย</label><input id="e-cat" list="ecats" placeholder="เช่น ค่าเช่า / ค่าถุง / ค่าโฆษณา"><datalist id="ecats"><option value="ค่าเช่าที่"><option value="ค่าถุง/แพ็ค"><option value="ค่าโฆษณา"><option value="ค่าขนส่ง"><option value="ค่าน้ำ/ไฟ"><option value="อื่นๆ"></datalist></div><div class="form-row"><label>จำนวนเงิน</label><input id="e-amt" type="number" min="0" step="0.01" value=""></div><div class="form-row full"><label>หมายเหตุ</label><input id="e-note"></div></div>';
  openModal('เพิ่มค่าใช้จ่ายอื่น', body, '<button class="btn ghost" data-close="1">ยกเลิก</button><button class="btn primary" id="saveExp">บันทึก</button>');
  document.getElementById('saveExp').onclick=function(){ var cat=val('e-cat')||'อื่นๆ', amt=fval('e-amt'); if(amt<=0){ toast('ใส่จำนวนเงิน','bad'); return; } commit(function(s){ s.expenses.push({id:uid('e'),date:nowISO(),category:cat,amount:amt,note:val('e-note')}); },{msg:'บันทึกค่าใช้จ่ายแล้ว',kind:'good'}); closeModal(); };
}

function confirmModal(title,msg,onYes){
  openModal(title,'<p style="margin:0;color:var(--ink-2)">'+esc(msg)+'</p>','<button class="btn ghost" data-close="1">ยกเลิก</button><button class="btn danger" id="cfmYes">ยืนยัน</button>');
  document.getElementById('cfmYes').onclick=function(){ closeModal(); onYes(); };
}

/* =========================================================================
   Print / export / import
   ========================================================================= */
function printLabels(ids){
  var list = ids? STATE.products.filter(function(p){return ids.indexOf(p.id)>=0;}) : STATE.products.slice();
  if(!list.length){ toast('ไม่มีสินค้าให้ปริ้น','bad'); return; }
  var area=document.getElementById('printArea');
  area.innerHTML=list.map(function(p){ var q=qrcode(0,'M'); q.addData(baseUrl()+'#p='+p.id); q.make(); return '<div class="label">'+q.createSvgTag({cellSize:4,margin:1,scalable:true})+'<div class="nm">'+esc(p.name)+'</div><div class="sku">'+esc(p.sku)+'</div><div class="loc">📍 '+esc(p.location||'-')+'</div></div>'; }).join('');
  window.print();
}
function download(name, text, type){ try{ var blob=new Blob([text],{type:type||'text/plain;charset=utf-8'}); var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; document.body.appendChild(a); a.click(); setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); },100); }catch(e){ toast('ดาวน์โหลดไม่สำเร็จ','bad'); } }
function exportCSV(){
  var rows=[['ประเภทข้อมูล','วันที่','สินค้า','SKU','จำนวน','ราคา/ทุนต่อชิ้น','ค่าใช้จ่ายอื่น','กำไร','หมายเหตุ']];
  STATE.sales.slice().sort(byDateDesc).forEach(function(s){ var p=productById(s.productId); rows.push(['ขาย',fmtDate(s.date),p?p.name:'',p?p.sku:'',s.qty,s.price,'',(s.price-s.cost)*s.qty,s.note||'']); });
  STATE.purchases.slice().sort(byDateDesc).forEach(function(b){ var p=productById(b.productId); rows.push(['ซื้อเข้า',fmtDate(b.date),p?p.name:'',p?p.sku:'',b.qty,b.unitCost,b.extraCost,'',b.note||'']); });
  STATE.expenses.slice().sort(byDateDesc).forEach(function(e){ rows.push(['ค่าใช้จ่าย',fmtDate(e.date),e.category,'','','',e.amount,'',e.note||'']); });
  var csv='﻿'+rows.map(function(r){return r.map(function(c){var s=String(c==null?'':c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(',');}).join('\n');
  download('รายงานสต๊อก.csv',csv,'text/csv;charset=utf-8'); toast('ดาวน์โหลด CSV แล้ว','good');
}
function backupJSON(){ download('backup-stock.json',JSON.stringify(STATE,null,2),'application/json'); toast('สำรองข้อมูลแล้ว','good'); }
function importJSON(){
  var inp=document.createElement('input'); inp.type='file'; inp.accept='.json,application/json';
  inp.onchange=function(){ var f=inp.files&&inp.files[0]; if(!f) return; var r=new FileReader();
    r.onload=function(){ var data; try{ data=JSON.parse(r.result); }catch(e){ toast('อ่านไฟล์ไม่ได้ (ต้องเป็นไฟล์ .json สำรอง)','bad'); return; }
      if(!data||!data.meta||!Array.isArray(data.products)){ toast('ไฟล์ไม่ใช่ข้อมูลสำรองของแอปนี้','bad'); return; }
      confirmModal('นำเข้าข้อมูลจากไฟล์นี้?','ข้อมูลปัจจุบันทั้งหมดจะถูกแทนที่ด้วยข้อมูลในไฟล์',function(){ var nd=normalize(data); commit(function(s){ s.meta=nd.meta; s.products=nd.products; s.purchases=nd.purchases; s.sales=nd.sales; s.expenses=nd.expenses; },{msg:'นำเข้าข้อมูลเรียบร้อยแล้ว',kind:'good'}); go('dash'); }); };
    r.readAsText(f); };
  inp.click();
}

/* =========================================================================
   Toast
   ========================================================================= */
function toast(msg,kind){
  var wrap=document.getElementById('toastWrap'); if(!wrap){ wrap=document.createElement('div'); wrap.id='toastWrap'; wrap.className='toast-wrap'; document.body.appendChild(wrap); }
  var t=document.createElement('div'); t.className='toast'+(kind?(' '+kind):''); t.textContent=msg; wrap.appendChild(t);
  setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(function(){t.remove();},320); },2200);
}

/* =========================================================================
   Events + routing
   ========================================================================= */
function go(view,id){ ROUTE={view:view,id:id||null}; var h=(view==='product'&&id)?('p='+id):view; if((location.hash||'').replace(/^#/,'')!==h){ location.hash=h; } render(); }

function bind(){
  var root=document.getElementById('root');
  root.querySelectorAll('[data-nav]').forEach(function(b){ b.onclick=function(){ go(b.getAttribute('data-nav')); }; });
  root.querySelectorAll('[data-open]').forEach(function(b){ b.onclick=function(){ go('product', b.getAttribute('data-open')); }; });
  root.querySelectorAll('[data-add-product]').forEach(function(b){ b.onclick=function(){ addProductModal(); }; });
  root.querySelectorAll('[data-edit]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); addProductModal(productById(b.getAttribute('data-edit'))); }; });
  root.querySelectorAll('[data-add-sale],[data-sell]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); sellModal(b.getAttribute('data-sell')||null); }; });
  root.querySelectorAll('[data-add-purchase],[data-receive]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); receiveModal(b.getAttribute('data-receive')||null); }; });
  root.querySelectorAll('[data-add-exp]').forEach(function(b){ b.onclick=function(){ expenseModal(); }; });
  root.querySelectorAll('[data-print-labels]').forEach(function(b){ b.onclick=function(){ printLabels(null); }; });
  root.querySelectorAll('[data-print-one]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); printLabels([b.getAttribute('data-print-one')]); }; });
  root.querySelectorAll('[data-print-report]').forEach(function(b){ b.onclick=function(){ window.print(); }; });
  root.querySelectorAll('[data-export]').forEach(function(b){ b.onclick=function(){ exportCSV(); }; });
  root.querySelectorAll('[data-backup]').forEach(function(b){ b.onclick=function(){ backupJSON(); }; });
  root.querySelectorAll('[data-import]').forEach(function(b){ b.onclick=function(){ importJSON(); }; });
  root.querySelectorAll('[data-signout]').forEach(function(b){ b.onclick=function(){ if(BACKEND&&BACKEND.signOut) BACKEND.signOut(); }; });
  root.querySelectorAll('[data-add-img]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); addImagesFlow(b.getAttribute('data-add-img')); }; });
  root.querySelectorAll('[data-del-img]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); deleteImageFlow(b.getAttribute('data-del-img'), ROUTE.id); }; });
  root.querySelectorAll('[data-lightbox]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); lightbox(b.getAttribute('data-lightbox'), ROUTE.id); }; });

  root.querySelectorAll('[data-delete]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); var id=b.getAttribute('data-delete'); var p=productById(id); if(!p) return; confirmModal('ลบสินค้า “'+p.name+'”?','ประวัติซื้อ/ขายของสินค้านี้จะยังอยู่ในรายงาน แต่สินค้าและรูปจะถูกนำออกจากสต๊อก',function(){ if(BACKEND&&BACKEND.deleteImagesFor){ BACKEND.deleteImagesFor(id).catch(function(){}); } delete IMG_CACHE[id]; commit(function(s){ s.products=s.products.filter(function(x){return x.id!==id;}); },{msg:'ลบสินค้าแล้ว',kind:'good'}); go('products'); }); }; });
  root.querySelectorAll('[data-del-sale]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); var id=b.getAttribute('data-del-sale'); var s0=null; STATE.sales.forEach(function(x){if(x.id===id)s0=x;}); if(!s0) return; confirmModal('ลบรายการขายนี้?','สต๊อกจะถูกคืนกลับ '+s0.qty+' ชิ้น',function(){ commit(function(s){ var sale=null; s.sales.forEach(function(x){if(x.id===id)sale=x;}); if(sale){ var p=pin(s,sale.productId); if(p) p.qty+=sale.qty; s.sales=s.sales.filter(function(x){return x.id!==id;}); } },{msg:'ลบรายการขายแล้ว',kind:'good'}); }); }; });
  root.querySelectorAll('[data-del-exp]').forEach(function(b){ b.onclick=function(e){ e.stopPropagation(); var id=b.getAttribute('data-del-exp'); commit(function(s){ s.expenses=s.expenses.filter(function(x){return x.id!==id;}); },{msg:'ลบค่าใช้จ่ายแล้ว',kind:'good'}); }; });

  root.querySelectorAll('[data-save-settings]').forEach(function(b){ b.onclick=function(){ var nm=val('set-shop')||'ร้านของฉัน', low=Math.max(0,fval('set-low')); commit(function(s){ s.meta.shopName=nm; s.meta.lowStock=low; },{msg:'บันทึกการตั้งค่าแล้ว',kind:'good'}); }; });
  root.querySelectorAll('[data-clear]').forEach(function(b){ b.onclick=function(){ confirmModal('ล้างข้อมูลทั้งหมด?','สินค้า ประวัติซื้อ-ขาย และค่าใช้จ่ายทั้งหมดจะถูกลบถาวร',function(){ commit(function(s){ var nm=s.meta.shopName; var d=defaultState(); d.meta.shopName=nm; s.meta=d.meta; s.products=[]; s.purchases=[]; s.sales=[]; s.expenses=[]; },{msg:'ล้างข้อมูลแล้ว',kind:'good'}); go('dash'); }); }; });

  var q=document.getElementById('q'); if(q){ q.oninput=function(){ PRODQ.q=q.value; reRenderProducts(); }; }
  var cf=document.getElementById('catf'); if(cf){ cf.onchange=function(){ PRODQ.cat=cf.value; reRenderProducts(); }; }

  renderProductQR();
}
function reRenderProducts(){
  var main=document.querySelector('.main'); if(!main||ROUTE.view!=='products'){ render(); return; }
  var scroll=window.scrollY, active=document.activeElement, selStart=active&&active.selectionStart;
  main.innerHTML=viewProducts();
  main.querySelectorAll('[data-open]').forEach(function(b){ b.onclick=function(){ go('product', b.getAttribute('data-open')); }; });
  main.querySelectorAll('[data-add-product]').forEach(function(b){ b.onclick=function(){ addProductModal(); }; });
  main.querySelectorAll('[data-print-labels]').forEach(function(b){ b.onclick=function(){ printLabels(null); }; });
  var q=document.getElementById('q'); if(q){ q.oninput=function(){ PRODQ.q=q.value; reRenderProducts(); }; if(active&&active.id==='q'){ q.focus(); try{q.setSelectionRange(selStart,selStart);}catch(e){} } }
  var cf=document.getElementById('catf'); if(cf){ cf.onchange=function(){ PRODQ.cat=cf.value; reRenderProducts(); }; }
  window.scrollTo(0,scroll);
}

function parseHash(){ var h=(location.hash||'').replace(/^#/,''); if(!h) return {view:'dash',id:null}; if(h.indexOf('p=')===0) return {view:'product',id:h.slice(2)}; var known={dash:1,products:1,sell:1,buy:1,reports:1,settings:1}; return {view:known[h]?h:'dash',id:null}; }
window.addEventListener('hashchange',function(){ var r=parseHash(); if(r.view!==ROUTE.view||r.id!==ROUTE.id){ ROUTE=r; if(mounted&&STATE) render(); } });
ROUTE=parseHash();

return { setBackend:setBackend, onData:onData, mount:mount };
})();
