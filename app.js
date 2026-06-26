/* ============================================================
   app.js — YKS Rota: adaptif çalışma motoru
   ------------------------------------------------------------
   Mantık özeti:
   1) Kullanıcının GERÇEK günlük rutini sabit slotlar olarak
      tanımlı (22:00 kütüphane girişi -> bloklar -> molalar).
   2) "Çalışma günü" takvim gününden BAĞIMSIZ bir sayaçtır.
      Kullanıcı bir günü "yapmadım" derse o günün TÜM kalan
      blokları sıraya geri konur, hiçbir konu atlanmaz —
      sadece bir sonraki güne kayar. 357 günlük plan bu yüzden
      "sabit tarih" değil "sabit sıra"dır.
   3) Konu havuzu öncelik ağırlıklı round-robin ile karılır:
      p1 (Mat/Fizik) en sık, p4 (Coğ/Din/Felsefe) en seyrek
      blok alır. Bu TRACK_ORDER dizisi olarak önceden üretilir
      ve currentBlockIndex ile ilerlenir.
   ============================================================ */

const STORAGE_KEY = "yksRotaState_v1";
// TYT 2027 tahmini tarihi: 19 Haziran 2027, 10:15 (ÖSYM henüz resmi açıklamadı —
// geçmiş yıllardaki "Haziran'ın 3. cumartesi" düzenine göre tahmin, kullanıcının
// kendi geri sayımıyla uyumlu). ÖSYM resmi tarihi açıkladığında bu satırı güncelle.
const EXAM_DATE = new Date("2027-06-19T10:15:00");

/* ---------- Günlük sabit zaman çizelgesi (dakika bazlı, 22:00'dan itibaren) ---------- */
/* Kullanıcının rutini: 22:00 kütüphaneye giriş, bloklar 25/25/25/25/25/45/45 dk,
   aralarda mola 10/10/10/10/10/15/15 dk. Kütüphane kapanışı kullanıcıya bağlı,
   biz sadece blok dizisini üretiyoruz; uygulama kapanış saati sormuyor çünkü
   kullanıcı net süre vermedi — bloklar bitince "kütüphane bitti" gösterilir. */
const DAILY_BLOCK_PLAN = [
  { kind: "study", minutes: 25 },
  { kind: "break", minutes: 10 },
  { kind: "study", minutes: 25 },
  { kind: "break", minutes: 10 },
  { kind: "study", minutes: 25 },
  { kind: "break", minutes: 10 },
  { kind: "study", minutes: 25 },
  { kind: "break", minutes: 10 },
  { kind: "study", minutes: 25 },
  { kind: "break", minutes: 10 },
  { kind: "study", minutes: 45 },
  { kind: "break", minutes: 15 },
  { kind: "study", minutes: 45 },
  { kind: "break", minutes: 15 }
];

const FIXED_DAY_EVENTS = [
  { time: "16:00", label: "Uyanış", desc: "Uyku biter." },
  { time: "17:30", label: "Ayılma molası", desc: "Kendine gelme, ekran/telefon, yavaş başlangıç." },
  { time: "18:30", label: "Yemek (1.)", desc: "Akşam yemeği." },
  { time: "19:30", label: "Hazırlanma", desc: "Dışarı çıkmak için hazırlık." },
  { time: "20:30", label: "Yemek (2.)", desc: "Çıkmadan önce ikinci öğün / atıştırma." },
  { time: "20:45", label: "Otobüs", desc: "Kütüphaneye gidiş yolu." },
  { time: "21:30", label: "Kütüphane önü — kahve", desc: "Kahve içip zihni toplama." },
  { time: "22:00", label: "Kütüphaneye giriş", desc: "Çalışma blokları başlar." },
  { time: "07:30", label: "Uyku", desc: "Gün biter, uyku başlar." }
];

/* ---------- Yardımcılar ---------- */
function pad(n){ return n.toString().padStart(2,"0"); }
function addMinutesToTimeStr(hhmm, mins){
  let [h,m] = hhmm.split(":").map(Number);
  let total = h*60+m+mins;
  total = ((total % (24*60)) + 24*60) % (24*60);
  return pad(Math.floor(total/60)) + ":" + pad(total%60);
}
function uid(){ return Math.random().toString(36).slice(2,9); }

/* ---------- Konu kuyruğu üretimi (öncelik ağırlıklı round robin) ---------- */
/* NOT: Elimizdeki gerçek konu havuzu (~293 blok) 357 günlük programın tamamını
   doldurmaz — TYT+AYT müfredatı normalde bu kadar bloğa ilk-geçiş için yeter,
   ama 357 gün x 7 blok/gün = 2499 slot var. Bu yüzden 1. tur bittiğinde
   otomatik olarak EK TURLAR üretiyoruz: 2. tur = aynı konular ama daha
   yüksek soru hedefiyle tekrar; 3. tur ve sonrası = haftalık deneme sınavı
   döngüsü + karışık genel tekrar. Böylece son güne kadar her blok anlamlı
   bir iş içerir, "tüm müfredat bitti, boş kaldı" durumu oluşmaz. */
function buildRound1(){
  const queues = {};
  TRACKS.forEach(t => { queues[t.id] = t.topics.map(x => ({...x, track:t.id, round:1})); });
  queues["p1"] = ALREADY_KNOWN.map(x => ({...x, track:"p1", round:1})).concat(queues["p1"]);

  const weights = {}; TRACKS.forEach(t => weights[t.id]=t.weight);
  const order = TRACKS.map(t=>t.id);
  const masterQueue = [];
  const pointers = {}; order.forEach(id=>pointers[id]=0);

  let active = [...order];
  while(active.length){
    for(const tid of [...active]){
      const w = weights[tid];
      for(let i=0;i<w;i++){
        if(pointers[tid] < queues[tid].length){
          masterQueue.push(queues[tid][pointers[tid]]);
          pointers[tid]++;
        } else {
          active = active.filter(a=>a!==tid);
          break;
        }
      }
    }
  }
  return masterQueue;
}

function buildRound2(){
  // 2. tur: sadece soru bloklarını al, hedef soru sayısını yükselt (tekrar + hız çalışması).
  const queues = {};
  TRACKS.forEach(t => {
    queues[t.id] = t.topics
      .filter(x=>x.type==="soru")
      .map(x => ({...x, id:x.id+"-r2", name:x.name+" (2. Tur Tekrar)", qCount:Math.round((x.qCount||30)*1.3), track:t.id, round:2}));
  });
  const weights = {}; TRACKS.forEach(t => weights[t.id]=t.weight);
  const order = TRACKS.map(t=>t.id);
  const out = [];
  const pointers = {}; order.forEach(id=>pointers[id]=0);
  let active = [...order];
  while(active.length){
    for(const tid of [...active]){
      const w = weights[tid];
      for(let i=0;i<w;i++){
        if(pointers[tid] < queues[tid].length){
          out.push(queues[tid][pointers[tid]]);
          pointers[tid]++;
        } else {
          active = active.filter(a=>a!==tid);
          break;
        }
      }
    }
  }
  return out;
}

function buildRound3Plus(roundNum){
  // 3. tur ve sonrası: her track'ten karışık genel tekrar + deneme sınavı blokları.
  // Sonsuz döngü değil ama çok uzun bir tur — 357 günü doldurmaya yeter kadar üretiyoruz.
  const out = [];
  const order = TRACKS.map(t=>t.id);
  const weights = {}; TRACKS.forEach(t => weights[t.id]=t.weight);
  // Her "mini tur" 1 deneme sınavı bloğu + track ağırlıklarına göre genel tekrar bloğu içerir.
  const miniTurSize = order.reduce((a,id)=>a+weights[id],0) + 1;
  const REPEATS = 220; // 357 günün tamamını (ve biraz fazlasını) güvenle doldurur
  for(let r=0;r<REPEATS;r++){
    out.push({
      id:`exam-${roundNum}-${r}`, name:"Karma Deneme Sınavı (TYT+AYT)", type:"soru",
      src:"none", qCount:1, track:"exam", round:roundNum, isExam:true
    });
    order.forEach(tid=>{
      const t = TRACKS.find(x=>x.id===tid);
      for(let i=0;i<weights[tid];i++){
        out.push({
          id:`gentekrar-${roundNum}-${r}-${tid}-${i}`,
          name:`${t.label} — Genel Tekrar & Hata Analizi`,
          type:"soru", src:"none", qCount:35, track:tid, round:roundNum
        });
      }
    });
  }
  return out;
}

function buildMasterQueue(){
  const r1 = buildRound1();
  const r2 = buildRound2();
  const r3 = buildRound3Plus(3);
  return r1.concat(r2).concat(r3);
}

const MASTER_QUEUE = buildMasterQueue();

/* ---------- State ---------- */
function defaultState(){
  return {
    cursor: 0,              // MASTER_QUEUE içinde sırada bekleyen konu indexi
    studyDay: 1,            // kaçıncı çalışma günündeyiz (takvimden bağımsız)
    history: [],            // [{studyDay, dateISO, results:[{topicId,name,status}], note}]
    todayAssignments: null, // bugünün blok ataması (oluşturulmuşsa)
    todayStatuses: {},      // {blockIndex: 'done'|'partial'|'skip'}
    lastOpenedDateISO: null
  };
}
function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(!raw) return defaultState();
    const parsed = JSON.parse(raw);
    return Object.assign(defaultState(), parsed);
  }catch(e){ return defaultState(); }
}
function saveState(){ localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

let state = loadState();

/* ---------- Bugünün bloklarını ata (eğer yoksa) ---------- */
function studyBlockCount(){
  return DAILY_BLOCK_PLAN.filter(b=>b.kind==="study").length; // 7
}

function ensureTodayAssignments(){
  const todayISO = new Date().toISOString().slice(0,10);
  if(state.todayAssignments && state.lastOpenedDateISO === todayISO) return;

  // Önceki gün açıktıysa ve kapatılmadıysa, finalize et (yapılmayanlar ertelenir).
  if(state.todayAssignments){
    finalizeDayIfNeeded();
  }

  if(!state.prependQueue) state.prependQueue = [];
  const need = studyBlockCount();
  const assigned = [];
  for(let i=0;i<need;i++){
    if(state.prependQueue.length){
      assigned.push(state.prependQueue.shift());
    } else if(state.cursor < MASTER_QUEUE.length){
      assigned.push(MASTER_QUEUE[state.cursor]);
      state.cursor++;
    } else {
      assigned.push({ id:"done-"+i+"-"+uid(), name:"Tüm müfredat tamamlandı — genel tekrar", type:"soru", src:"none", qCount:30, track:"p1" });
    }
  }
  state.todayAssignments = assigned;
  state.todayStatuses = {};
  state.lastOpenedDateISO = todayISO;
  saveState();
}

/* Eğer kullanıcı bir bloğu işaretlemeden günü kapattıysa, o blok bir sonraki
   güne devralınır: "done" OLMAYAN blokları bir sonraki günün başına
   (prependQueue) koyuyoruz, hiçbir konu atlanmaz — sadece kayar. */
function finalizeDayIfNeeded(){
  const pending = [];
  state.todayAssignments.forEach((topic, idx) => {
    const st = state.todayStatuses[idx];
    if(st !== "done"){
      pending.push(topic);
    }
  });
  state.history.unshift({
    studyDay: state.studyDay,
    dateISO: state.lastOpenedDateISO || new Date().toISOString().slice(0,10),
    results: state.todayAssignments.map((topic, idx) => ({
      topicId: topic.id, name: topic.name,
      status: state.todayStatuses[idx] || "skip"
    }))
  });
  if(!state.prependQueue) state.prependQueue = [];
  state.prependQueue = pending.concat(state.prependQueue);
  state.studyDay++;
}

/* ---------- Zaman dilimi etiketleri için çalışma bloklarına saat ata ---------- */
function getTimedBlocks(){
  let cursorTime = "22:00";
  let studyIdx = 0;
  const out = [];
  for(const b of DAILY_BLOCK_PLAN){
    const start = cursorTime;
    const end = addMinutesToTimeStr(cursorTime, b.minutes);
    if(b.kind === "study"){
      out.push({ kind:"study", start, end, minutes:b.minutes, studyIndex: studyIdx });
      studyIdx++;
    } else {
      out.push({ kind:"break", start, end, minutes:b.minutes });
    }
    cursorTime = end;
  }
  return out;
}

/* ---------- Renk/etiket yardımcıları ---------- */
function trackColorClass(trackId){ return trackId || "p1"; }
function trackLabel(trackId){
  if(trackId === "exam") return "Deneme Sınavı";
  const t = TRACKS.find(x=>x.id===trackId);
  return t ? t.label : "Genel";
}
function sourceLabel(srcKey){
  const v = SOURCES[srcKey];
  return v || "Kaynağın elinde yok — not al / videodan takip et";
}

/* ============================================================
   RENDER: Bugün paneli
   ============================================================ */
function renderToday(){
  ensureTodayAssignments();
  const el = document.getElementById("panel-today");
  const timed = getTimedBlocks();
  const assignments = state.todayAssignments;

  let html = "";

  // Sabit gün olayları (özet, katlanabilir)
  html += `<details><summary>Günün sabit saatleri (uyku, yemek, yol)</summary><div class="card">`;
  FIXED_DAY_EVENTS.forEach(ev=>{
    html += `<div class="block"><div class="time">${ev.time}</div><div class="body">
      <div class="subj">${ev.label}</div><div class="desc">${ev.desc}</div></div></div>`;
  });
  html += `</div></details>`;

  html += `<h3 style="margin:16px 0 8px;font-size:1rem;">Çalışma Günü ${state.studyDay} — Bloklar</h3>`;

  timed.forEach(b=>{
    if(b.kind === "break"){
      html += `<div class="card" style="opacity:.7">
        <div class="block">
          <div class="time">${b.start}–${b.end}</div>
          <div class="body"><span class="tag break">MOLA</span><span class="desc">${b.minutes} dk dinlen, ekran molası ver.</span></div>
        </div></div>`;
      return;
    }
    const topic = assignments[b.studyIndex];
    if(!topic) return;
    const idx = b.studyIndex;
    const status = state.todayStatuses[idx];
    html += `<div class="card">
      <div class="block">
        <div class="time">${b.start}–${b.end}</div>
        <div class="body">
          <span class="tag ${trackColorClass(topic.track)}">${trackLabel(topic.track)}</span>
          <div class="subj" style="margin-top:6px;">${topic.name}</div>
          <div class="desc">${topic.isExam ? "Tam süreli karma deneme çöz (TYT veya AYT, gün sırasına göre değiştir)." : (topic.type === "anlatim" ? "Konu anlatımı çalış." : `Hedef: ${topic.qCount || 30} soru çöz.`)}</div>
          ${topic.isExam ? "" : `<div class="source">Kaynak: ${sourceLabel(topic.src)}</div>`}
          <div class="statusbtns">
            <button data-idx="${idx}" data-status="done" class="${status==='done'?'sel-done':''}">Yapıldı</button>
            <button data-idx="${idx}" data-status="partial" class="${status==='partial'?'sel-partial':''}">Kısmen</button>
            <button data-idx="${idx}" data-status="skip" class="${status==='skip'?'sel-skip':''}">Yapılmadı</button>
          </div>
        </div>
      </div>
    </div>`;
  });

  html += `<div class="actionbar">
    <button id="finishDayBtn">Günü Bitir &amp; Sonrakine Geç</button>
  </div>
  <p class="small">Günü bitirdiğinde işaretlenmemiş ya da "Yapılmadı" dediğin konular otomatik olarak yarının programına aktarılır. Hiçbir konu atlanmaz, sadece kayar.</p>`;

  el.innerHTML = html;

  el.querySelectorAll(".statusbtns button").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = btn.dataset.idx;
      state.todayStatuses[idx] = btn.dataset.status;
      saveState();
      renderToday();
    });
  });
  document.getElementById("finishDayBtn").addEventListener("click", ()=>{
    if(!confirm("Günü bitirip yarının programına geçmek istediğine emin misin? İşaretlemediğin bloklar otomatik olarak ertelenecek.")) return;
    finalizeDayIfNeeded();
    state.todayAssignments = null; // zorla yeniden ata
    saveState();
    renderToday();
    renderTopBar();
  });
}

/* ============================================================
   RENDER: İlerleme paneli
   ============================================================ */
function renderProgress(){
  const el = document.getElementById("panel-progress");
  const totalTopics = MASTER_QUEUE.length;
  const doneCount = state.history.reduce((acc,day)=>{
    return acc + day.results.filter(r=>r.status==="done").length;
  }, 0);
  const partialCount = state.history.reduce((acc,day)=>{
    return acc + day.results.filter(r=>r.status==="partial").length;
  }, 0);

  // track bazlı tamamlanma
  const trackStats = {};
  TRACKS.forEach(t=>trackStats[t.id] = {done:0,total:t.topics.length});
  state.history.forEach(day=>{
    day.results.forEach(r=>{
      if(r.status==="done"){
        for(const t of TRACKS){
          if(t.topics.some(x=>x.id===r.topicId)){ trackStats[t.id].done++; break; }
        }
      }
    });
  });

  let html = `<div class="statgrid">
    <div class="statbox"><div class="v">${state.studyDay-1}</div><div class="l">Tamamlanan Çalışma Günü</div></div>
    <div class="statbox"><div class="v">${doneCount}</div><div class="l">Tamamlanan Konu/Blok</div></div>
    <div class="statbox"><div class="v">${partialCount}</div><div class="l">Kısmen Yapılan</div></div>
    <div class="statbox"><div class="v">${totalTopics - state.cursor}</div><div class="l">Sırada Bekleyen</div></div>
  </div>`;

  const trackColors = ["var(--accent)","var(--accent-2)","var(--accent-3)","var(--accent-4)"];
  html += `<div class="card"><h3>Ders Bazlı İlerleme</h3>`;
  TRACKS.forEach((t,i)=>{
    const pct = Math.min(100, Math.round((trackStats[t.id].done / trackStats[t.id].total)*100));
    html += `<div class="barrow">
      <div class="lbl">${t.label}</div>
      <div class="barouter"><div class="barinner" style="width:${pct}%;background:${trackColors[i]}"></div></div>
      <div style="min-width:38px;text-align:right;">${pct}%</div>
    </div>`;
  });
  html += `</div>`;

  el.innerHTML = html;
}

/* ============================================================
   RENDER: Geçmiş (log) paneli
   ============================================================ */
function renderLog(){
  const el = document.getElementById("panel-log");
  if(!state.history.length){
    el.innerHTML = `<div class="empty">Henüz tamamlanmış bir gün yok. İlk gününü bitirdiğinde burada görünecek.</div>`;
    return;
  }
  let html = `<div class="card">`;
  state.history.slice(0,60).forEach(day=>{
    const doneN = day.results.filter(r=>r.status==="done").length;
    const totalN = day.results.length;
    html += `<div class="log-entry">
      <div class="d">${day.dateISO} — Çalışma Günü ${day.studyDay} — ${doneN}/${totalN} tamamlandı</div>
      <div>${day.results.map(r=>{
        const mark = r.status==="done"?"✓":r.status==="partial"?"~":"✗";
        return `${mark} ${r.name}`;
      }).join(" · ")}</div>
    </div>`;
  });
  html += `</div>`;
  el.innerHTML = html;
}

/* ============================================================
   RENDER: Ayarlar paneli
   ============================================================ */
function renderSettings(){
  const el = document.getElementById("panel-settings");
  el.innerHTML = `
    <div class="card">
      <h3>Veri Yönetimi</h3>
      <p class="small">Tüm verilerin bu cihazın tarayıcı belleğinde (localStorage) tutuluyor. Telefon değiştirirsen ya da yedek almak istersen aşağıdan dışa aktarabilirsin.</p>
      <button class="linklike" id="exportBtn">Verileri dışa aktar (JSON göster)</button>
      <br><br>
      <label class="fieldlbl">İçe aktarmak için JSON yapıştır:</label>
      <textarea id="importArea" placeholder="Buraya önceden dışa aktardığın JSON'u yapıştır"></textarea>
      <div class="actionbar"><button id="importBtn">İçe Aktar</button></div>
      <div class="actionbar"><button class="secondary" id="resetBtn">Tüm Verileri Sıfırla</button></div>
      <textarea id="exportArea" style="display:none;"></textarea>
    </div>
    <div class="card">
      <h3>Sınav Bilgisi</h3>
      <p class="small">Sınav: YKS (TYT, AYT) · Hedef bölüm: Havacılık ve Uzay Mühendisliği (tam burslu) · Hedef üniversiteler: İzmir Ekonomi, Samsun, Atılım.</p>
      <p class="small" style="color:var(--bad)">Not: TYT 2027 tarihi ÖSYM tarafından henüz resmi açıklanmadı. Sayaç şu an 19 Haziran 2027 tahmini tarihine göre hesaplanıyor (geçmiş yılların "Haziran'ın 3. cumartesi" düzenine göre). ÖSYM resmi tarihi duyurduğunda app.js dosyasındaki EXAM_DATE satırını güncellemen gerekecek.</p>
    </div>
  `;
  document.getElementById("exportBtn").addEventListener("click", ()=>{
    const area = document.getElementById("exportArea");
    area.style.display = "block";
    area.value = JSON.stringify(state, null, 2);
    area.select();
  });
  document.getElementById("importBtn").addEventListener("click", ()=>{
    try{
      const parsed = JSON.parse(document.getElementById("importArea").value);
      state = Object.assign(defaultState(), parsed);
      saveState();
      alert("İçe aktarıldı.");
      renderAll();
    }catch(e){ alert("Geçersiz JSON."); }
  });
  document.getElementById("resetBtn").addEventListener("click", ()=>{
    if(!confirm("Tüm ilerleme silinecek, emin misin?")) return;
    state = defaultState();
    saveState();
    renderAll();
  });
}

/* ============================================================
   Üst bar: gün sayaçları
   ============================================================ */
function renderTopBar(){
  const now = new Date();
  const diffMs = EXAM_DATE - now;
  const days = Math.max(0, Math.ceil(diffMs / (1000*60*60*24)));
  document.getElementById("examCountdown").textContent = days;
  document.getElementById("studyDayNum").textContent = state.studyDay;
  document.getElementById("topDayCount").textContent = `Gün ${state.studyDay} / 357`;
}

/* ============================================================
   Tabs
   ============================================================ */
function renderAll(){
  renderTopBar();
  renderToday();
  renderProgress();
  renderLog();
  renderSettings();
}

document.querySelectorAll(".tab").forEach(tab=>{
  tab.addEventListener("click", ()=>{
    document.querySelectorAll(".tab").forEach(t=>t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p=>p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("panel-"+tab.dataset.panel).classList.add("active");
  });
});

renderAll();
