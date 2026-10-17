const TZ='America/Chicago';let S=null,ME=null,TITLE='Money Vault';
const $=s=>document.querySelector(s),app=$('#app');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd=n=>(n<0?'-':'')+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
const usd0=n=>(n<0?'-':'')+'$'+Math.round(Math.abs(n)).toLocaleString('en-US');
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:TZ}).format(new Date());
const ym=d=>d.slice(0,7),addDays=(d,n)=>{const x=new Date(d+'T12:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10)};
const daysBetween=(a,b)=>Math.round((Date.parse(b+'T12:00:00Z')-Date.parse(a+'T12:00:00Z'))/864e5);
const dim=(y,m)=>new Date(Date.UTC(y,m,0)).getUTCDate();
const monthName=m=>new Date(m+'-15T12:00:00Z').toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});
const shortMonth=m=>new Date(m+'-15T12:00:00Z').toLocaleString('en-US',{month:'short',timeZone:'UTC'});
const prevMonth=(m,k=1)=>{let [y,mo]=m.split('-').map(Number);mo-=k;while(mo<1){mo+=12;y--}return `${y}-${String(mo).padStart(2,'0')}`};
const ICON={Food:'🍔',Gas:'⛽',Games:'🎮',Bills:'🧾',Rent:'🏠',Fun:'🎉',Shopping:'🛍',Subscriptions:'📺',Other:'🪙',Paycheck:'💵','Side hustle':'💼','Other income':'💰'};
const COL={Food:'#ff9f43',Gas:'#feca57',Games:'#a55eea',Bills:'#54a0ff',Rent:'#ee5253',Fun:'#ff6bcb',Shopping:'#1dd1a1',Subscriptions:'#48dbfb',Other:'#c8d6e5'};
const toast=(t,ms=2600)=>{const e=$('#toast');e.textContent=t;e.classList.add('show');clearTimeout(e._t);e._t=setTimeout(()=>e.classList.remove('show'),ms)};
const api=async(u,m='GET',b)=>{const r=await fetch(u,{method:m,headers:{'Content-Type':'application/json'},body:b&&JSON.stringify(b),credentials:'same-origin'});const j=await r.json().catch(()=>({}));
  if(r.status===401&&!u.startsWith('/api/auth/')){ME=null;authView();throw new Error('Please log in')}if(!r.ok)throw new Error(j.error||'Something broke');return j};
const opts=(a,sel)=>a.map(x=>`<option ${x===sel?'selected':''}>${esc(x)}</option>`).join('');
const pick=a=>a[Math.floor(Math.random()*a.length)];

// ---------- money math ----------
function monthTotals(m){let inc=0,exp=0;const byCat={};for(const t of S.tx)if(ym(t.date)===m){if(t.type==='income')inc+=t.amount;else{exp+=t.amount;byCat[t.category]=(byCat[t.category]||0)+t.amount}}return {inc,exp,left:inc-exp,byCat}}
function nextPayday(){const p=S.pay;if(!p||!p.anchor||!p.amount)return null;const t=today();let d=p.anchor;
  if(p.freq==='monthly'){const day=+p.anchor.slice(8);let [y,m]=t.split('-').map(Number);for(let i=0;i<3;i++){const c=`${y}-${String(m).padStart(2,'0')}-${String(Math.min(day,dim(y,m))).padStart(2,'0')}`;if(c>=t)return c;m++;if(m>12){m=1;y++}}}
  const step=p.freq==='weekly'?7:14;if(d<t){const k=Math.ceil(daysBetween(d,t)/step);d=addDays(d,k*step)}else while(addDays(d,-step)>=t)d=addDays(d,-step);return d}
function billStatus(b,m=ym(today())){const [y,mo]=m.split('-').map(Number),due=`${m}-${String(Math.min(b.dueDay,dim(y,mo))).padStart(2,'0')}`,t=today();
  if(b.paid.includes(m))return {k:'paid',label:'Paid ✓',due};const d=daysBetween(t,due);
  if(d<0)return {k:'over',label:`Overdue ${-d}d`,due,d};if(d<=7)return {k:'soon',label:d===0?'Due today':`Due in ${d}d`,due,d};return {k:'later',label:`Due ${shortMonth(m)} ${+due.slice(8)}`,due,d}}
function unpaidBefore(date){const m=ym(today());return S.bills.filter(b=>{const s=billStatus(b,m);return s.k!=='paid'&&s.due<=date}).reduce((a,b)=>a+b.amount,0)}

// ---------- charts (pure SVG) ----------
function donut(byCat){const ents=Object.entries(byCat).sort((a,b)=>b[1]-a[1]),tot=ents.reduce((a,e)=>a+e[1],0);if(!tot)return '<p class="empty">No spending yet this month. Suspiciously responsible.</p>';
  let a0=-Math.PI/2,paths='';const R=70,r=44,cx=85,cy=85;
  for(const [c,v] of ents){const a1=a0+v/tot*Math.PI*2-(ents.length>1?0.015:0),lg=a1-a0>Math.PI?1:0,P=(a,rad)=>`${(cx+rad*Math.cos(a)).toFixed(2)},${(cy+rad*Math.sin(a)).toFixed(2)}`;
    paths+=ents.length===1?`<circle cx="${cx}" cy="${cy}" r="${(R+r)/2}" fill="none" stroke="${COL[c]}" stroke-width="${R-r}"/>`:`<path d="M${P(a0,R)} A${R},${R} 0 ${lg} 1 ${P(a1,R)} L${P(a1,r)} A${r},${r} 0 ${lg} 0 ${P(a0,r)}Z" fill="${COL[c]}"><title>${c}: ${usd(v)}</title></path>`;a0=a0+v/tot*Math.PI*2}
  return `<div class="donutwrap"><svg viewBox="0 0 170 170" class="chart" role="img" aria-label="Spending by category">${paths}<text x="85" y="82" text-anchor="middle" fill="#9dbfa8" font-size="11">spent</text><text x="85" y="101" text-anchor="middle" fill="#f3c94f" font-size="17" font-family="Bungee">${usd0(tot)}</text></svg>
  <div class="legend" style="flex:1">${ents.map(([c,v])=>`<span><i style="background:${COL[c]}"></i>${ICON[c]} ${c} <b>${usd0(v)}</b> <span class="dim">${Math.round(v/tot*100)}%</span></span>`).join('')}</div></div>`}
function bars(n=6){const m0=ym(today()),ms=[...Array(n)].map((_,i)=>prevMonth(m0,n-1-i)),D=ms.map(m=>({m,...monthTotals(m)})),max=Math.max(1,...D.flatMap(d=>[d.inc,d.exp]));
  const W=320,H=150,bw=W/n,h=v=>v/max*(H-30);
  return `<svg viewBox="0 0 ${W} ${H+18}" class="chart" role="img" aria-label="Income vs spending by month">${D.map((d,i)=>{const x=i*bw+bw*0.15,w=bw*0.33;return `<rect x="${x}" y="${H-h(d.inc)}" width="${w}" height="${h(d.inc)}" rx="3" fill="url(#gI)"><title>${shortMonth(d.m)} income ${usd(d.inc)}</title></rect><rect x="${x+w+2}" y="${H-h(d.exp)}" width="${w}" height="${h(d.exp)}" rx="3" fill="url(#gE)"><title>${shortMonth(d.m)} spent ${usd(d.exp)}</title></rect><text x="${i*bw+bw/2}" y="${H+14}" text-anchor="middle" fill="#9dbfa8" font-size="11">${shortMonth(d.m)}</text>`}).join('')}
  <defs><linearGradient id="gI" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dffb0"/><stop offset="1" stop-color="#1f8a52"/></linearGradient><linearGradient id="gE" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0a8"/><stop offset="1" stop-color="#b8862a"/></linearGradient></defs></svg><div class="legend"><span><i style="background:#4fd98a"></i>Money in</span><span><i style="background:#f3c94f"></i>Money out</span></div>`}
function trend(n=6){const m0=ym(today()),ms=[...Array(n)].map((_,i)=>prevMonth(m0,n-1-i));const before=S.tx.filter(t=>ym(t.date)<ms[0]).reduce((a,t)=>a+(t.type==='income'?t.amount:-t.amount),0);
  let run=before;const pts=ms.map(m=>{run+=monthTotals(m).left;return run});const mn=Math.min(0,...pts),mx=Math.max(1,...pts),W=320,H=110,x=i=>10+i*(W-20)/(n-1),y=v=>H-10-(v-mn)/(mx-mn||1)*(H-24);
  const line=pts.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H+16}" class="chart" role="img" aria-label="Balance trend"><defs><linearGradient id="gT" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f3c94f55"/><stop offset="1" stop-color="#f3c94f00"/></linearGradient></defs>
   ${mn<0?`<line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#ff6b5e55" stroke-dasharray="4"/>`:''}<polygon points="${x(0)},${H-10} ${line} ${x(n-1)},${H-10}" fill="url(#gT)"/><polyline points="${line}" fill="none" stroke="#f3c94f" stroke-width="3" stroke-linejoin="round"/>
   ${pts.map((v,i)=>`<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#0f2a1c" stroke="#f3c94f" stroke-width="2"><title>${shortMonth(ms[i])}: ${usd(v)}</title></circle><text x="${x(i)}" y="${H+12}" text-anchor="middle" fill="#9dbfa8" font-size="11">${shortMonth(ms[i])}</text>`).join('')}</svg><div class="dim small">Running total of everything logged: <b class="${run<0?'neg':'gold'}">${usd(run)}</b></div>`}

// ---------- views ----------
const V={};
V['']=()=>{const t=today(),m=ym(t),T=monthTotals(m),np=nextPayday();
  const billsList=S.bills.map(b=>({b,s:billStatus(b)})).filter(x=>x.s.k!=='paid').sort((a,b)=>a.s.due.localeCompare(b.s.due));
  let payCard='<div class="card stat"><div class="k">Next payday</div><div class="v dim">?</div><div class="s"><a href="#/settings" class="gold">Set your payday</a> to unlock the daily allowance.</div></div>';
  if(np){const days=Math.max(daysBetween(t,np),0),dueB=unpaidBefore(np),spendable=T.left-dueB,per=spendable/Math.max(days,1);
    payCard=`<div class="card stat"><div class="k">Until payday</div><div class="v gold">${days===0?'TODAY 🤑':days+' day'+(days>1?'s':'')}</div><div class="s">${new Date(np+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'})} · ~${usd0(S.pay.amount)} incoming</div></div>
    <div class="card stat"><div class="k">Per-day allowance</div><div class="v ${per<0?'neg':'pos'}">${usd(per)}</div><div class="s">${per<0?"Uh oh. Ramen era until payday.":dueB?`after ${usd0(dueB)} in bills due first`:'Go wild (responsibly-ish)'}</div></div>`}
  const over=Object.entries(S.budgets).filter(([c,l])=>(T.byCat[c]||0)>l);
  app.innerHTML=`<h1>${pick(['Cash check','The Vault','Money moves','Bag report'])} · ${shortMonth(m)}</h1>
  <div class="card hero stat"><div class="k">Left this month</div><div class="v ${T.left<0?'neg':''}">${usd(T.left)}</div><div class="s">${usd(T.inc)} in · ${usd(T.exp)} out${T.left<0?' · spending more than you make, chief':''}</div></div>
  <div class="grid"><div class="card stat"><div class="k">💵 Income</div><div class="v pos">${usd0(T.inc)}</div></div><div class="card stat"><div class="k">💸 Spent</div><div class="v gold">${usd0(T.exp)}</div></div>${payCard}</div>
  ${over.length?`<div class="card"><div class="warn">🚨 Over budget: ${over.map(([c,l])=>`${ICON[c]} ${c} by ${usd0((T.byCat[c]||0)-l)}`).join(', ')}</div></div>`:''}
  <div class="two"><div class="card"><h2>Bills coming up</h2>${billsList.length?billsList.slice(0,5).map(({b,s})=>`<div class="li"><span class="ico">🧾</span><div class="grow"><div class="t">${esc(b.name)}</div><div class="small dim">${usd(b.amount)}</div></div><span class="pill p-${s.k}">${s.label}</span><button class="small ghost" data-pay="${b.id}">Paid</button></div>`).join(''):`<p class="empty">${S.bills.length?'All bills paid this month. Look at you. 👑':'No bills added yet.'}</p>`}<a class="btn ghost" href="#/bills">Manage bills</a></div>
   <div class="card"><h2>Where it went</h2>${donut(T.byCat)}</div></div>
  <div class="two"><div class="card"><h2>Balance trend</h2>${trend()}</div><div class="card"><h2>Month vs month</h2>${bars()}</div></div>
  <div class="card"><h2>Quick add</h2>${quickAdd()}</div>`;
  wireQuick();document.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>markPaid(b.dataset.pay,true))};

function quickAdd(){return `<div class="seg"><button class="ghost sel" data-type="expense" id="qtE">💸 Spent</button><button class="ghost" data-type="income" id="qtI">💵 Got paid</button></div>
  <div class="row"><div><label>Amount</label><input id="qa" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0.00"></div><div><label>Date</label><input id="qd" type="date" value="${today()}"></div></div>
  <label>Category (tap to save)</label><div class="quick" id="qc"></div><label>Note (optional)</label><input id="qn" maxlength="120" placeholder="tacos again">`}
function wireQuick(after){let type='expense';const draw=()=>{$('#qc').innerHTML=(type==='income'?S.INCOME:S.EXPENSE).map(c=>`<button class="ghost" data-c="${esc(c)}">${ICON[c]} ${esc(c)}</button>`).join('');
   document.querySelectorAll('#qc [data-c]').forEach(b=>b.onclick=async()=>{try{const amount=$('#qa').value;await api('/api/tx','POST',{type,amount,category:b.dataset.c,date:$('#qd').value,note:$('#qn').value});await load();
    toast(type==='income'?pick(['Cha-ching! 💰','Money in the bank 🏦','Get that bread 🍞']):pick(['Logged. Wallet says ouch.','Spent it. No regrets (some regrets).','Noted. The vault weeps a little.']));(after||route)()}catch(x){toast('⚠ '+x.message)}})};
  $('#qtE').onclick=()=>{type='expense';$('#qtE').classList.add('sel');$('#qtI').classList.remove('sel');draw()};$('#qtI').onclick=()=>{type='income';$('#qtI').classList.add('sel');$('#qtE').classList.remove('sel');draw()};draw()}

let txF={m:null,c:''};
V.tx=()=>{const m=txF.m||ym(today());const months=[...new Set([ym(today()),...S.tx.map(t=>ym(t.date))])].sort().reverse();
  const L=S.tx.filter(t=>(m==='all'||ym(t.date)===m)&&(!txF.c||t.category===txF.c)).sort((a,b)=>b.date.localeCompare(a.date)||b.createdAt.localeCompare(a.createdAt));
  const inc=L.filter(t=>t.type==='income').reduce((a,t)=>a+t.amount,0),exp=L.filter(t=>t.type==='expense').reduce((a,t)=>a+t.amount,0);
  app.innerHTML=`<h1>Money in & out</h1><div class="card"><h2>Add one</h2>${quickAdd()}</div>
  <div class="card"><div class="filters"><div><label>Month</label><select id="fm"><option value="all">All time</option>${months.map(x=>`<option value="${x}" ${x===m?'selected':''}>${monthName(x)}</option>`).join('')}</select></div><div><label>Category</label><select id="fc"><option value="">Everything</option>${opts([...S.EXPENSE,...S.INCOME],txF.c)}</select></div><a class="btn ghost" href="/api/export.csv" download>⬇ CSV</a></div>
  <p class="small dim">${L.length} transactions · <span class="pos">+${usd(inc)}</span> · <span class="gold">-${usd(exp)}</span></p>
  ${L.map(t=>`<div class="li"><span class="ico">${ICON[t.category]||'🪙'}</span><div class="grow"><div class="t">${esc(t.category)}${t.note?` <span class="dim small">· ${esc(t.note)}</span>`:''}</div><div class="small dim">${new Date(t.date+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'})}</div></div><span class="amt ${t.type==='income'?'pos':'gold'}">${t.type==='income'?'+':'-'}${usd(t.amount)}</span><button class="small ghost" data-e="${t.id}" aria-label="Edit">✎</button></div><div id="ed-${t.id}"></div>`).join('')||'<p class="empty">Nothing here yet. Tap a category above to log something.</p>'}</div>`;
  wireQuick();$('#fm').onchange=e=>{txF.m=e.target.value;V.tx()};$('#fc').onchange=e=>{txF.c=e.target.value;V.tx()};
  document.querySelectorAll('[data-e]').forEach(b=>b.onclick=()=>{const t=S.tx.find(x=>x.id===b.dataset.e),box=$('#ed-'+t.id);if(box.innerHTML){box.innerHTML='';return}
   box.innerHTML=`<div class="card" style="margin:6px 0 12px"><div class="row"><div><label>Type</label><select id="et"><option value="expense" ${t.type==='expense'?'selected':''}>Spent</option><option value="income" ${t.type==='income'?'selected':''}>Income</option></select></div><div><label>Amount</label><input id="ea" type="number" step="0.01" inputmode="decimal" value="${t.amount}"></div></div>
   <div class="row"><div><label>Category</label><select id="ec"></select></div><div><label>Date</label><input id="edt" type="date" value="${t.date}"></div></div><label>Note</label><input id="en" maxlength="120" value="${esc(t.note)}">
   <button id="es">Save</button> <button class="ghost danger" id="ex">Delete</button><div class="err" id="ee"></div></div>`;
   const cats=()=>{$('#ec').innerHTML=opts($('#et').value==='income'?S.INCOME:S.EXPENSE,t.category)};$('#et').onchange=cats;cats();
   $('#es').onclick=async()=>{try{await api('/api/tx/'+t.id,'PUT',{type:$('#et').value,amount:$('#ea').value,category:$('#ec').value,date:$('#edt').value,note:$('#en').value});await load();toast('Saved');V.tx()}catch(x){$('#ee').textContent=x.message}};
   $('#ex').onclick=async()=>{if(!confirm('Delete this transaction?'))return;await api('/api/tx/'+t.id,'DELETE');await load();toast('Poof. Gone.');V.tx()}})};

V.budgets=()=>{const T=monthTotals(ym(today()));
  const roast=(c,over)=>pick([`${ICON[c]} ${c} is ${usd0(over)} over. The vault has filed a complaint.`,`${usd0(over)} over on ${c}. Bold strategy.`,`${c} budget? More like ${c} suggestion. ${usd0(over)} over.`,`You and ${c} need to talk. ${usd0(over)} over.`]);
  app.innerHTML=`<h1>Budgets · ${shortMonth(ym(today()))}</h1><div class="card">${S.EXPENSE.map(c=>{const l=S.budgets[c]||0,sp=T.byCat[c]||0,pct=l?sp/l*100:0,cls=!l?'':pct>=100?'r':pct>=75?'y':'';
   return `<div class="li" style="display:block"><div style="display:flex;align-items:center;gap:10px"><span class="ico">${ICON[c]}</span><div class="grow"><div class="t">${c}</div><div class="small dim">${usd(sp)} spent${l?` of ${usd0(l)} · ${l-sp>=0?usd0(l-sp)+' left':'busted'}`:' · no limit set'}</div></div><input class="blim" data-c="${c}" type="number" inputmode="decimal" min="0" step="1" value="${l||''}" placeholder="limit" style="width:96px" aria-label="${c} monthly limit"></div>
   ${l?`<div class="bar ${cls}"><div style="width:${Math.min(pct,100)}%"></div></div>${pct>=100?`<div class="warn">${roast(c,sp-l)}</div>`:pct>=75?`<div class="small gold">Getting close, easy there.</div>`:''}`:''}</div>`}).join('')}
   <button id="bs">Save limits</button><div class="err" id="be"></div></div>`;
  $('#bs').onclick=async()=>{const b={};document.querySelectorAll('.blim').forEach(i=>{if(i.value)b[i.dataset.c]=i.value});try{await api('/api/budgets','PUT',{budgets:b});await load();toast('Budgets locked in 🔒');V.budgets()}catch(x){$('#be').textContent=x.message}}};

async function markPaid(id,paid){await api(`/api/bills/${id}/paid`,'POST',{month:ym(today()),paid});await load();toast(paid?pick(['Bill slain ⚔','Paid. One less thing.','Bill: defeated.']):'Marked unpaid');route()}
V.bills=()=>{const L=S.bills.map(b=>({b,s:billStatus(b)})).sort((a,b)=>a.s.due.localeCompare(b.s.due)),tot=S.bills.reduce((a,b)=>a+b.amount,0),left=L.filter(x=>x.s.k!=='paid').reduce((a,x)=>a+x.b.amount,0);
  app.innerHTML=`<h1>Bills</h1><div class="grid"><div class="card stat"><div class="k">Monthly bills</div><div class="v gold">${usd0(tot)}</div></div><div class="card stat"><div class="k">Still to pay</div><div class="v ${left?'neg':'pos'}">${usd0(left)}</div></div></div>
  <div class="card">${L.map(({b,s})=>`<div class="li"><span class="ico">🧾</span><div class="grow"><div class="t">${esc(b.name)}</div><div class="small dim">${usd(b.amount)} · due the ${ord(b.dueDay)}${b.recurring?' · monthly':''}</div></div><span class="pill p-${s.k}">${s.label}</span>${s.k==='paid'?`<button class="small ghost" data-un="${b.id}">Undo</button>`:`<button class="small" data-pay="${b.id}">Paid</button>`}<button class="small ghost" data-x="${b.id}" aria-label="Delete">✕</button></div>`).join('')||'<p class="empty">No bills yet. Lucky you, or you forgot some.</p>'}</div>
  <div class="card"><h2>Add a bill</h2><div class="row"><div><label>Name</label><input id="bn" maxlength="40" placeholder="Phone"></div><div><label>Amount</label><input id="ba" type="number" step="0.01" inputmode="decimal"></div><div><label>Due day</label><input id="bd" type="number" min="1" max="31" placeholder="15"></div></div><button id="bg">Add bill</button><div class="err" id="be"></div></div>`;
  document.querySelectorAll('[data-pay]').forEach(b=>b.onclick=()=>markPaid(b.dataset.pay,true));document.querySelectorAll('[data-un]').forEach(b=>b.onclick=()=>markPaid(b.dataset.un,false));
  document.querySelectorAll('[data-x]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this bill?'))return;await api('/api/bills/'+b.dataset.x,'DELETE');await load();V.bills()});
  $('#bg').onclick=async()=>{try{await api('/api/bills','POST',{name:$('#bn').value,amount:$('#ba').value,dueDay:$('#bd').value});await load();toast('Bill added');V.bills()}catch(x){$('#be').textContent=x.message}}};
const ord=n=>n+(['th','st','nd','rd'][(n%100-20)%10]||['th','st','nd','rd'][n%100]||'th');

function confetti(){const c=document.createElement('div');c.className='confetti';c.innerHTML=[...Array(40)].map(()=>`<span style="left:${Math.random()*100}%;animation-delay:${Math.random()*.8}s">${pick(['💵','💰','🪙','🎉','✨','🤑'])}</span>`).join('');document.body.appendChild(c);setTimeout(()=>c.remove(),3800)}
V.goals=()=>{app.innerHTML=`<h1>Savings goals</h1>${S.goals.map(g=>{const pct=Math.min(100,g.saved/g.target*100),done=g.saved>=g.target;return `<div class="card"><div style="display:flex;align-items:center;gap:10px"><span class="ico">${done?'🏆':'🐷'}</span><div class="grow"><div class="t">${esc(g.name)}</div><div class="small dim">${usd(g.saved)} of ${usd(g.target)}${done?' · CRUSHED IT':` · ${usd0(g.target-g.saved)} to go`}</div></div><b class="gold">${Math.floor(pct)}%</b></div>
  <div class="bar"><div style="width:${pct}%"></div></div><div class="row" style="align-items:end"><div><label>Add money</label><input type="number" step="0.01" inputmode="decimal" id="ga-${g.id}" placeholder="20"></div><button data-add="${g.id}" style="flex:0 0 auto">+ Stash it</button><button class="ghost" data-take="${g.id}" style="flex:0 0 auto">− Take out</button><button class="ghost danger" data-gx="${g.id}" style="flex:0 0 auto" aria-label="Delete goal">✕</button></div></div>`}).join('')||'<div class="card"><p class="empty">No goals yet. New PC? Car? Emergency fund? Pick one.</p></div>'}
  <div class="card"><h2>New goal</h2><div class="row"><div><label>Name</label><input id="gn" maxlength="40" placeholder="New GPU"></div><div><label>Target</label><input id="gt" type="number" inputmode="decimal"></div><div><label>Already saved</label><input id="gs" type="number" inputmode="decimal" value="0"></div></div><button id="gg">Create goal</button><div class="err" id="ge"></div></div>`;
  const add=async(id,sign)=>{const g=S.goals.find(x=>x.id===id),was=g.saved>=g.target,v=+$('#ga-'+id).value;if(!v)return toast('Type an amount first');try{const r=await api(`/api/goals/${id}/add`,'POST',{amount:sign*v});await load();V.goals();if(!was&&r.saved>=r.target){confetti();toast(`🎉 ${g.name} goal HIT! Absolute legend.`,4000)}else toast(sign>0?pick(['Stashed 🐷','Into the vault it goes','Future you says thanks']):'Withdrawn. We saw nothing.')}catch(x){toast('⚠ '+x.message)}};
  document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>add(b.dataset.add,1));document.querySelectorAll('[data-take]').forEach(b=>b.onclick=()=>add(b.dataset.take,-1));
  document.querySelectorAll('[data-gx]').forEach(b=>b.onclick=async()=>{if(!confirm('Delete this goal?'))return;await api('/api/goals/'+b.dataset.gx,'DELETE');await load();V.goals()});
  $('#gg').onclick=async()=>{try{await api('/api/goals','POST',{name:$('#gn').value,target:$('#gt').value,saved:$('#gs').value||0});await load();toast('Goal set. Let\'s get it.');V.goals()}catch(x){$('#ge').textContent=x.message}}};

V.settings=()=>{const p=S.pay||{},np=nextPayday();app.innerHTML=`<h1>Payday</h1><div class="card"><p class="dim">Tell the vault when the money lands and it'll count down and work out a per-day allowance.</p>
  <label>How often</label><select id="pf"><option value="weekly">Every week</option><option value="biweekly">Every 2 weeks</option><option value="monthly">Once a month</option></select>
  <div class="row"><div><label>Typical paycheck</label><input id="pa" type="number" step="0.01" inputmode="decimal" value="${p.amount||''}"></div><div><label>A recent payday</label><input id="pd" type="date" value="${p.anchor||''}"></div></div>
  <button id="ps">Save</button><div class="err" id="pe"></div>${np?`<p class="gold" style="margin-top:12px">Next payday: ${np}</p>`:''}</div>
  <div class="card"><h2>Your data</h2><p class="dim small">Private to your account. Nobody else can see it.</p><a class="btn ghost" href="/api/export.csv" download>⬇ Export transactions (CSV)</a></div>`;
  $('#pf').value=p.freq||'biweekly';$('#ps').onclick=async()=>{try{await api('/api/pay','PUT',{freq:$('#pf').value,amount:$('#pa').value||0,anchor:$('#pd').value||null});await load();toast('Payday saved 💵');V.settings()}catch(x){$('#pe').textContent=x.message}}};

// ---------- auth + routing ----------
function authView(mode){document.body.classList.add('locked');$('#userbox').innerHTML='';const reg=mode==='register';
  app.innerHTML=`<div class="card auth"><div class="coin">$</div><h1>${esc(TITLE)}</h1><p class="dim">${reg?'Make an account. No email, just a name and password.':'Log in to open the vault.'}</p>
  <div class="tabs2"><button class="ghost ${reg?'':'on'}" id="tl">Log in</button><button class="ghost ${reg?'on':''}" id="tr">Register</button></div>
  <form id="af"><label for="au">Username</label><input id="au" autocomplete="username" maxlength="24" required><label for="ap">Password</label><input id="ap" type="password" autocomplete="${reg?'new-password':'current-password'}" required>
  ${reg?'<label for="ap2">Confirm password</label><input id="ap2" type="password" autocomplete="new-password" required><p class="small dim">3-24 letters, numbers, _ or -. Password 6+ characters. Forget it and an admin can reset it.</p>':''}
  <button type="submit">${reg?'Create account':'Open the vault'}</button><div class="err" id="ae" role="alert"></div></form></div>`;
  $('#tl').onclick=()=>authView();$('#tr').onclick=()=>authView('register');
  $('#af').onsubmit=async e=>{e.preventDefault();try{if(reg&&$('#ap').value!==$('#ap2').value)throw new Error("Passwords don't match");ME=await api('/api/auth/'+(reg?'register':'login'),'POST',{username:$('#au').value,password:$('#ap').value});S=null;route()}catch(x){$('#ae').textContent=x.message}}}
async function load(){S=await api('/api/state')}
async function route(){try{if(!ME){try{ME=await api('/api/auth/me')}catch{ME=null}}if(!ME)return authView();document.body.classList.remove('locked');
  $('#userbox').innerHTML=`<b>${esc(ME.username)}</b><a href="#" id="lo">log out</a>`;$('#lo').onclick=async e=>{e.preventDefault();await api('/api/auth/logout','POST',{});ME=null;S=null;route()};
  if(!S)await load();const h=location.hash.slice(2).split('/')[0];document.querySelectorAll('#tabs a').forEach(a=>a.classList.toggle('on',a.dataset.t===h));(V[h]||V[''])();window.scrollTo(0,0)}catch(x){if(ME)app.innerHTML=`<p class="err">${esc(x.message)}</p>`}}
addEventListener('hashchange',route);
fetch('/api/config').then(r=>r.json()).then(c=>{TITLE=c.title;document.title=TITLE;$('#title').textContent=TITLE}).catch(()=>{}).finally(route);
