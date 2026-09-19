"use strict";

// =====================================================================
// MODE SURVIVAL — Kuis arcade cepat berbasis Kurikulum Merdeka (GLB/GLBB/GJB)
// =====================================================================

// v2: skala poin berubah jadi ratusan (dulu cuma +1/soal) — key dibedakan
// dari versi lama supaya highscore lama (skala kecil) ga nyampur/nyasar
// jadi kelihatan "kecil" dibanding skala baru.
const SURV_QUESTION_TIME = 60; // detik per soal
const SURV_PANIC_AT = 5;       // detik tersisa saat efek panik aktif
const SURV_LIVES_START = 3;
const SURV_ANSWER_DELAY = 1000; // ms — jeda validasi jawaban (morphing + feedback warna)

// ===== SISTEM POIN (dipakai SAMA PERSIS oleh Survival & Duel) =====
// Jawab benar <10 detik = +100, jawab benar >=10 detik = +80,
// jawab salah ATAU waktu habis = 0 (TIDAK ada pengurangan/"mines" lagi —
// nyawa tetap berkurang seperti biasa, tapi skor tidak pernah turun).
const SURV_POIN_CEPAT = 100;
const SURV_POIN_LAMBAT = 80;
const SURV_POIN_SALAH = 0;
const SURV_BATAS_CEPAT = 10; // detik

function survHitungPoin(isCorrect, waktuJawabDetik){
  if(!isCorrect) return SURV_POIN_SALAH;
  return waktuJawabDetik < SURV_BATAS_CEPAT ? SURV_POIN_CEPAT : SURV_POIN_LAMBAT;
}

// FIX "SKOR SURVIVAL IKUT NYANGKUT DI DEVICE WALAU GANTI AKUN": dulu
// disimpan ke localStorage (SURV_HS_KEY, nempel per-device). Skor tertinggi
// yang OTENTIK sebenarnya SUDAH ada di Firestore (field poinSolo, ditulis
// lewat submitSurvivalScore() di auth.js) — jadi sekarang fungsi ini cuma
// baca/tulis app.survivalHighScore (in-memory, di-hydrate dari poinSolo
// Firestore tiap login, lihat hydrateAppProgressFromFirestore di auth.js).
// TIDAK ada lagi penulisan ke Firestore di sini — itu sudah tugas
// submitSurvivalScore(), fungsi ini murni buat update tampilan instan.
function survGetHighScore(){ return app.survivalHighScore || 0; }
function survSaveHighScore(v){ app.survivalHighScore = v; }

// ===== A. Massive Array Kamus Kata =====
const SURV_KENDARAAN = ['mobil sport','kereta komuter','truk ekspedisi','skuter listrik','gokart','bus pariwisata','mobil listrik otonom','motor balap','mobil SUV','taksi online','van logistik','becak motor','trem kota','bus rapid transit','mobil patroli','truk kontainer','mobil pickup','mobil hybrid','kereta cepat Whoosh','mobil sedan','ojek pangkalan','mobil pemadam','ambulans','mobil box','traktor ladang','skuter matik','motor trail','mobil jeep','bus sekolah','mobil boks pendingin'];
const SURV_ORANG = ['Budi','Siti','seorang kurir ojol','atlet sepeda','pembalap gokart','insinyur lalu lintas','pak polisi','Andi','Rina','teknisi lapangan','pengemudi teladan','kurir logistik','peneliti muda','petugas survei','mahasiswa teknik','masinis kereta','penguji kendaraan','narator uji','sopir bus','atlet maraton','pengendara skuter','navigator darat','petugas sensor','pengawas proyek','warga lokal','koordinator uji','pengendara uji','staf telemetri','pengamat jalan raya','analis data'];
const SURV_BENDA = ['bola basket','genteng','buah mangga','koper','obeng','kelereng','batu kali','buah kelapa','kaleng cat','pipa besi','helm proyek','bola tenis','buku ensiklopedia','bola kasti','kotak logistik','batako','bola sepak','palu besi','botol kaca','guci keramik','baut baja','buah durian','helm keselamatan','kotak perkakas','bola voli','batu bata','tegel lantai','papan kayu','bola bekel','buah pepaya'];
const SURV_TEMPAT = ['balkon lantai 5','dahan pohon mangga','jembatan penyeberangan','helikopter SAR','atap gedung perkantoran','tebing curam','menara air','lantai 3 sekolah','balkon apartemen','menara pengawas','struktur jembatan tol','tebing bukit','lantai atas rumah susun','atap stadion','puncak mercusuar','dinding tebing','menara telekomunikasi','atap gudang logistik','jembatan gantung','lantai atas pusat perbelanjaan','balkon hotel','dahan pohon beringin','anjungan pelabuhan','rangka atap stadion','menara mercusuar','tepi jurang','pelataran helipad','atap terminal bus','balkon rumah kaca','titik pantau tebing'];

function survPick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
function survRound1(x){ return Math.round(x*10)/10; }
function survFmtID(n){ return survRound1(n).toFixed(1).replace('.', ','); }

// ===== C. 30 Template Soal (10 GLB, 10 GLBB, 10 GJB) =====
// given: variabel yang ditampilkan di soal. find: variabel yang ditanyakan.
const SURV_TEMPLATES = [
  // ---- GLB ----
  { topic:'GLB', given:['v','t'], find:'s', text:(g,e)=>`Berdasarkan data aplikasi navigasi, ${e.ORANG} sedang melakukan perjalanan menggunakan ${e.KEND} dengan laju stabil ${g.v} m/s. Jarak tempuh yang tercatat setelah ${g.t} detik adalah...` },
  { topic:'GLB', given:['s','t'], find:'v', text:(g,e)=>`Dalam sebuah analisis sistem transportasi pintar, sebuah ${e.KEND} terpantau melaju konstan menempuh jarak ${g.s} meter selama ${g.t} detik. Kecepatan rata-rata kendaraan adalah...` },
  { topic:'GLB', given:['v','s'], find:'t', text:(g,e)=>`${e.ORANG} ditugaskan menguji efisiensi energi ${e.KEND} pada kelajuan stabil ${g.v} m/s. Waktu yang dibutuhkan untuk mencapai titik uji sejauh ${g.s} meter adalah...` },
  { topic:'GLB', given:['s','t'], find:'v', text:(g,e)=>`Sebuah sistem radar otomatis mendeteksi pergerakan ${e.KEND} yang melaju lurus stabil. Jika jarak ${g.s} meter ditempuh dalam waktu ${g.t} detik, maka kecepatan yang terekam radar adalah...` },
  { topic:'GLB', given:['v','t'], find:'s', text:(g,e)=>`Untuk distribusi logistik, ${e.ORANG} harus menjaga laju ${e.KEND} tetap ${g.v} m/s. Perpindahan posisi yang berhasil dicapai selama ${g.t} detik adalah...` },
  { topic:'GLB', given:['v','s'], find:'t', text:(g,e)=>`${e.ORANG} mengendarai ${e.KEND} dengan kelajuan tetap ${g.v} m/s. Waktu tempuh untuk lintasan lurus sepanjang ${g.s} meter adalah...` },
  { topic:'GLB', given:['s','t'], find:'v', text:(g,e)=>`Sensor jalan tol mencatat ${e.KEND} melaju stabil menempuh jarak ${g.s} meter dalam waktu ${g.t} detik. Laju kendaraan tersebut bernilai...` },
  { topic:'GLB', given:['s','t'], find:'v', text:(g,e)=>`Dalam uji coba kecepatan, ${e.KEND} melaju konstan dan berhasil melewati sensor sejauh ${g.s} meter selama ${g.t} detik. Kecepatannya adalah...` },
  { topic:'GLB', given:['t','s'], find:'v', text:(g,e)=>`${e.ORANG} mencatat waktu ${g.t} detik saat ${e.KEND} miliknya melaju stabil sejauh ${g.s} meter. Kelajuan kendaraannya tercatat sebesar...` },
  { topic:'GLB', given:['v','t'], find:'s', text:(g,e)=>`Sebuah wahana uji meluncurkan ${e.KEND} dengan kecepatan tetap ${g.v} m/s. Jarak yang ditempuh setelah ${g.t} detik adalah...` },

  // ---- GLBB ----
  { topic:'GLBB', given:['a','t'], find:'v', text:(g,e)=>`Dalam uji kelayakan jalan, sebuah ${e.KEND} yang berhenti mulai bergerak dengan percepatan konstan ${g.a} m/s² sesaat setelah lampu hijau. Laju kendaraan pada detik ke-${g.t} adalah...` },
  { topic:'GLBB', given:['a','t'], find:'s', text:(g,e)=>`Berdasarkan grafik telemetri, ${e.ORANG} memacu ${e.KEND} miliknya dari keadaan diam dengan percepatan ${g.a} m/s². Jarak aman yang telah dilalui dalam ${g.t} detik adalah...` },
  { topic:'GLBB', given:['a','v'], find:'t', text:(g,e)=>`Untuk menganalisis pengereman, sebuah ${e.KEND} dipacu dari posisi diam dengan percepatan ${g.a} m/s² hingga mencapai kelajuan ${g.v} m/s. Rentang waktu akselerasinya adalah...` },
  { topic:'GLBB', given:['a','t'], find:'s', text:(g,e)=>`Sensor mencatat bahwa ${e.ORANG} memacu ${e.KEND} dengan akselerasi ${g.a} m/s². Panjang lintasan yang dibutuhkan selama ${g.t} detik adalah...` },
  { topic:'GLBB', given:['v','a'], find:'t', text:(g,e)=>`Dalam simulasi lalu lintas, ${e.KEND} dirancang melaju dari diam menuju kecepatan ${g.v} m/s dengan percepatan ${g.a} m/s². Durasi pergerakan idealnya adalah...` },
  { topic:'GLBB', given:['a','t'], find:'v', text:(g,e)=>`${e.ORANG} menguji daya dorong ${e.KEND} dari keadaan diam dengan percepatan ${g.a} m/s². Kecepatan akhir setelah ${g.t} detik adalah...` },
  { topic:'GLBB', given:['a','t'], find:'s', text:(g,e)=>`Sebuah mobil eksperimen melaju dari posisi diam dengan percepatan konstan ${g.a} m/s². Jarak tempuh setelah bergerak selama ${g.t} detik adalah...` },
  { topic:'GLBB', given:['v','t'], find:'a', text:(g,e)=>`Dalam uji performa, ${e.KEND} digas dari keadaan diam hingga mencapai kelajuan ${g.v} m/s dalam waktu ${g.t} detik. Percepatan kendaraan tersebut adalah...` },
  { topic:'GLBB', given:['a','t'], find:'s', text:(g,e)=>`${e.ORANG} memacu ${e.KEND} dengan percepatan ${g.a} m/s² dari garis start. Jarak total yang dilalui setelah ${g.t} detik adalah...` },
  { topic:'GLBB', given:['a','t'], find:'v', text:(g,e)=>`Sistem otomatis merekam ${e.KEND} yang bergerak dari keadaan diam dengan percepatan ${g.a} m/s². Kelajuan kendaraan pada detik ke-${g.t} adalah...` },

  // ---- GJB (g = 9,8 m/s²) ----
  { topic:'GJB', given:['h'], find:'t', text:(g,e)=>`Seorang peneliti menjatuhkan ${e.BENDA} tanpa kecepatan awal dari ${e.TEMPAT} setinggi ${g.h} meter. Waktu jatuh benda hingga menyentuh dasar adalah...` },
  { topic:'GJB', given:['t'], find:'h', text:(g,e)=>`Dalam upaya pengiriman bantuan darurat, ${e.BENDA} dilepaskan bebas dan mendarat dalam waktu ${g.t} detik. Estimasi ketinggian vertikal pelepasan benda adalah...` },
  { topic:'GJB', given:['h'], find:'t', text:(g,e)=>`Tim mitigasi menggunakan drone untuk menjatuhkan ${e.BENDA} dari ${e.TEMPAT} setinggi ${g.h} meter. Waktu benda tiba di sasaran adalah...` },
  { topic:'GJB', given:['t'], find:'h', text:(g,e)=>`Untuk mengukur tinggi struktur, siswa menjatuhkan ${e.BENDA} dari ${e.TEMPAT}. Jika waktu jatuh terukur ${g.t} detik, perkiraan tinggi struktur adalah...` },
  { topic:'GJB', given:['t'], find:'v', text:(g,e)=>`Dalam analisis kinematika vertikal, ${e.BENDA} tergelincir bebas dari ${e.TEMPAT}. Kecepatan sesaat sebelum menghantam tanah pada detik ke-${g.t} adalah...` },
  { topic:'GJB', given:['h'], find:'v', text:(g,e)=>`Sebuah ${e.BENDA} dilepaskan tanpa kecepatan awal dari ${e.TEMPAT} setinggi ${g.h} meter. Kecepatan benda saat menyentuh permukaan tanah adalah...` },
  { topic:'GJB', given:['t'], find:'h', text:(g,e)=>`Dalam eksperimen fisika, ${e.BENDA} jatuh bebas dari ${e.TEMPAT} dan mencapai tanah dalam waktu ${g.t} detik. Ketinggian tempat tersebut adalah...` },
  { topic:'GJB', given:['h'], find:'t', text:(g,e)=>`Suatu benda berbentuk ${e.BENDA} dijatuhkan dari atas ${e.TEMPAT} setinggi ${g.h} meter. Waktu yang diperlukan untuk mencapai tanah adalah...` },
  { topic:'GJB', given:['t'], find:'v', text:(g,e)=>`Proyek konstruksi mengalami insiden jatuhnya ${e.BENDA} dari ${e.TEMPAT}. Jika waktu jatuh tercatat ${g.t} detik, kecepatan benda saat membentur tanah adalah...` },
  { topic:'GJB', given:['h'], find:'thalf', text:(g,e)=>`Sebuah ${e.BENDA} dijatuhkan bebas dari ${e.TEMPAT} setinggi ${g.h} meter. Waktu yang dibutuhkan benda untuk menempuh setengah perjalanan ke tanah adalah...` },
];

const SURV_UNITS = { s:'meter', v:'m/s', t:'detik', a:'m/s²', h:'meter', thalf:'detik' };

// Menghasilkan nilai variabel "given" + jawaban benar (variabel "find"),
// dengan hubungan fisis yang selalu konsisten satu sama lain.
function survGenerateValues(tpl){
  const g = {}; let correct;
  const G = tpl.given;
  if(tpl.topic === 'GLB'){
    if(G.includes('v') && G.includes('t') && tpl.find === 's'){
      g.v = survRound1(rand(10,30)); g.t = Math.round(rand(4,12));
      correct = survRound1(g.v * g.t);
    } else if(G.includes('s') && G.includes('t') && tpl.find === 'v'){
      const v0 = survRound1(rand(10,30)); g.t = Math.round(rand(4,12));
      g.s = survRound1(v0 * g.t);
      correct = survRound1(g.s / g.t);
    } else { // given v & s, find t
      g.v = survRound1(rand(10,30)); const t0 = Math.round(rand(4,12));
      g.s = survRound1(g.v * t0);
      correct = survRound1(g.s / g.v);
    }
  } else if(tpl.topic === 'GLBB'){
    if(G.includes('a') && G.includes('t') && tpl.find === 'v'){
      g.a = survRound1(rand(1,5)); g.t = Math.round(rand(3,10));
      correct = survRound1(g.a * g.t);
    } else if(G.includes('a') && G.includes('t') && tpl.find === 's'){
      g.a = survRound1(rand(1,5)); g.t = Math.round(rand(3,10));
      correct = survRound1(0.5 * g.a * g.t * g.t);
    } else if((tpl.find === 't')){ // given a & v (dua urutan), find t
      g.a = survRound1(rand(1,5)); const t0 = Math.round(rand(3,10));
      g.v = survRound1(g.a * t0);
      correct = survRound1(g.v / g.a);
    } else { // given v & t, find a
      const a0 = survRound1(rand(1,5)); g.t = Math.round(rand(3,10));
      g.v = survRound1(a0 * g.t);
      correct = survRound1(g.v / g.t);
    }
  } else { // GJB
    const GRAV = 9.8;
    if(tpl.find === 't' && G.includes('h')){
      g.h = Math.round(rand(13,80));
      correct = survRound1(Math.sqrt(2*g.h/GRAV));
    } else if(tpl.find === 'h' && G.includes('t')){
      g.t = survRound1(rand(1.2,4.5));
      correct = survRound1(0.5 * GRAV * g.t * g.t);
    } else if(tpl.find === 'v' && G.includes('t')){
      g.t = survRound1(rand(1.2,4.5));
      correct = survRound1(GRAV * g.t);
    } else if(tpl.find === 'v' && G.includes('h')){
      g.h = Math.round(rand(13,80));
      correct = survRound1(Math.sqrt(2*GRAV*g.h));
    } else { // find thalf, given h
      g.h = Math.round(rand(13,80));
      correct = survRound1(Math.sqrt(g.h/GRAV));
    }
  }
  return { given:g, correct };
}

// Pengecoh pintar: 3 angka berdekatan secara matematis dengan jawaban benar.
function survGenerateDecoys(correct){
  const used = new Set([correct]);
  const decoys = [];
  const magnitude = Math.max(Math.abs(correct)*0.18, 1.2);
  let guard = 0;
  while(decoys.length < 3 && guard < 60){
    guard++;
    const sign = Math.random() < 0.5 ? -1 : 1;
    let val = survRound1(correct + sign * (0.3 + Math.random()*0.9) * magnitude);
    if(val <= 0) val = survRound1(correct + (0.3 + Math.random()*0.9) * magnitude);
    if(!used.has(val)){ used.add(val); decoys.push(val); }
  }
  return decoys;
}

function survGenerateQuestion(lastTopic){
  let pool = SURV_TEMPLATES.filter(t => t.topic !== lastTopic);
  if(!pool.length) pool = SURV_TEMPLATES;
  const tpl = survPick(pool);
  const { given, correct } = survGenerateValues(tpl);
  const entities = { KEND: survPick(SURV_KENDARAAN), ORANG: survPick(SURV_ORANG), BENDA: survPick(SURV_BENDA), TEMPAT: survPick(SURV_TEMPAT) };

  const gDisplay = {};
  for(const k in given) gDisplay[k] = survFmtID(given[k]);

  let text = tpl.text(gDisplay, entities);
  text = text.charAt(0).toUpperCase() + text.slice(1);

  const unit = SURV_UNITS[tpl.find];
  const decoys = survGenerateDecoys(correct);
  const optionValues = [correct, ...decoys];
  // acak posisi opsi
  for(let i = optionValues.length - 1; i > 0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [optionValues[i], optionValues[j]] = [optionValues[j], optionValues[i]];
  }
  const correctIdx = optionValues.indexOf(correct);
  const options = optionValues.map(v => `${survFmtID(v)} ${unit}`);

  return { topic: tpl.topic, text, options, correctIdx, correctLabel: `${survFmtID(correct)} ${unit}` };
}

// ===== State & Alur Permainan =====
// recordAtStart = rekor tertinggi SEBELUM sesi ini dimulai (dibekukan di
// startSurvivalGame, dipakai sebagai acuan tetap buat badge "Rekor:" di
// HUD — lihat survUpdateRecordBadge()). recordBroken = penanda supaya
// animasi/efek "pecah rekor" (lihat survCheckRecordBreak()) cuma sekali
// nyala per sesi, gak berulang tiap poin nambah setelah rekor kelewatan.
const survState = { lives: SURV_LIVES_START, score: 0, lastTopic: null, current: null, timeLeft: SURV_QUESTION_TIME, timerId: null, deadline: null, answering: false, questionStartedAt: null, recordAtStart: 0, recordBroken: false, countdownTimerId: null };

// =====================================================================
// FIX BUG "SURVIVAL MASIH JALAN DI LATAR BELAKANG WALAU UDAH DI-CLOSE":
// layar Survival sebelumnya TIDAK PUNYA tombol keluar/X sama sekali —
// satu-satunya cara "menutup" mode ini di tengah permainan adalah tombol
// back HP. Masalahnya, survStartTimer() jalan pakai setInterval yang DIIKAT
// ke survState (objek global), BUKAN ke layar Survival itu sendiri — jadi
// walau user udah pindah ke layar lain (misal Home) lewat tombol back,
// timer-nya TETAP JALAN TERUS di belakang layar. Begitu waktu abis, alur
// survTick -> survHandleTimeout -> survLoseLife -> survGameOver tetap
// berjalan seperti biasa, dan survGameOver() MEMAKSA pindah ke layar hasil
// (survivalresult) — user yang udah pindah ke Home pun TIBA-TIBA dilempar
// ke layar "kekalahan" tanpa peringatan sama sekali.
//
// FIX: fungsi ini dipanggil dari router.js setiap kali user PINDAH KELUAR
// dari layar Survival (lihat showScreen() di router.js) — menghentikan
// semua timer terkait Survival secara paksa, jadi sesi yang ditinggalkan
// beneran BERHENTI TOTAL, bukan cuma "gak keliatan doang".
// =====================================================================
function survAbandonGame(){
  clearInterval(survState.timerId);
  survState.timerId = null;
  survState.deadline = null;
  survState.answering = true; // cegah proses lanjutan (misal timeout yg lagi diproses) nyelonong lanjut

  if(survState.countdownTimerId){ clearInterval(survState.countdownTimerId); survState.countdownTimerId = null; }
  const overlay = document.getElementById('survCountdownOverlay');
  if(overlay) overlay.classList.remove('show');
  phygoSound.stopAll();
}

function renderSurvivalCard(holder){
  if(!holder) return;
  const hs = survGetHighScore();
  holder.innerHTML = `
    <button class="survival-card home-card ripple-host" id="survivalCardBtn">
      <div class="home-card-icon-bg">${svgIcon('fire')}</div>
      <div class="survival-icon-box">${svgIcon('fire')}</div>
      <div class="survival-info">
        <h3>Mode Survival</h3>
      </div>
      <div class="survival-badge">
        <span class="sv-trophy">${svgIcon('trophy')}</span>
        <span>${hs} poin</span>
      </div>
    </button>
  `;
  document.getElementById('survivalCardBtn').addEventListener('click', ()=> navigate('survival', {}));
}

function startSurvivalGame(){
  survState.lives = SURV_LIVES_START;
  survState.score = 0;
  survState.lastTopic = null;
  survState.answering = false;
  survState.recordAtStart = survGetHighScore();
  survState.recordBroken = false;
  clearInterval(survState.timerId);

  renderSurvivalLives();
  renderSurvivalScore();
  renderSurvivalRecordBadge();
  document.getElementById('survOpts').innerHTML = '';
  document.getElementById('survQuestionText').textContent = '';

  const overlay = document.getElementById('survCountdownOverlay');
  const numEl = document.getElementById('survCountdownNum');
  overlay.classList.add('show');
  const seq = ['3','2','1','MULAI!'];
  let i = 0;
  numEl.textContent = seq[0];
  phygoSound.play('countdown');
  gsap.fromTo(numEl, {scale:0.5, opacity:0}, {scale:1, opacity:1, duration:0.3, ease:'back.out(2)'});
  survState.countdownTimerId = setInterval(()=>{
    i++;
    if(i >= seq.length){
      clearInterval(survState.countdownTimerId);
      survState.countdownTimerId = null;
      overlay.classList.remove('show');
      survNextQuestion();
      return;
    }
    numEl.textContent = seq[i];
    gsap.fromTo(numEl, {scale:0.5, opacity:0}, {scale:1, opacity:1, duration:0.3, ease:'back.out(2)'});
  }, COUNTDOWN_STEP_MS);
}

function renderSurvivalLives(){
  const el = document.getElementById('survLives');
  if(!el) return;
  el.innerHTML = Array(SURV_LIVES_START).fill(0).map((_,i)=>`<div class="heart-icon ${i >= survState.lives ? 'lost' : ''}">${svgIcon('heart')}</div>`).join('');
}

function renderSurvivalScore(){
  const el = document.getElementById('survScoreVal');
  if(el) el.textContent = survState.score;
}

// Reset tampilan badge "Rekor:" ke rekor yang dibekukan di awal sesi (lihat
// startSurvivalGame) + lepas class 'broken' dari sesi sebelumnya kalau ada
// (elemennya statis di HTML, bukan dibuat ulang tiap game, jadi class lama
// bisa nempel terus kalau gak sengaja dibersihkan di sini).
function renderSurvivalRecordBadge(){
  const badge = document.getElementById('survRecordBadge');
  const val = document.getElementById('survRecordVal');
  if(badge) badge.classList.remove('broken');
  if(val) val.textContent = survState.recordAtStart;
}

// Dipanggil tiap kali skor berubah (lihat survHandleAnswer & survHandleTimeout)
// — begitu skor hidup pertama kali melampaui rekor yang dibekukan di awal
// sesi, badge "Rekor:" berubah warna jadi palet sukses (permanen sepanjang
// sisa sesi ini) + muncul toast kecil "Rekor Baru!" sekali sebagai penanda.
function survCheckRecordBreak(){
  if(survState.recordBroken) return;
  if(survState.score <= survState.recordAtStart) return;
  survState.recordBroken = true;
  const badge = document.getElementById('survRecordBadge');
  if(badge){
    badge.classList.add('broken');
    gsap.fromTo(badge, { scale: 1 }, { scale: 1.22, duration: 0.22, ease: 'back.out(3)', yoyo: true, repeat: 1 });
  }
  spawnRecordToast('survScoreCol');
}

// Toast kecil "Rekor Baru!" yang melayang lalu memudar — polanya sama
// seperti spawnScorePopup() di animation.js, cuma teks bukan angka.
// `elId` HARUS punya CSS position:relative (lihat .surv-score-col).
function spawnRecordToast(elId){
  const anchor = document.getElementById(elId);
  if(!anchor) return;
  const el = document.createElement('span');
  el.className = 'surv-record-toast';
  el.textContent = 'Rekor Baru!';
  anchor.appendChild(el);
  gsap.fromTo(el,
    { opacity: 0, y: 6, scale: 0.7 },
    {
      opacity: 1, y: -10, scale: 1, duration: 0.32, ease: 'back.out(2.4)',
      onComplete: () => {
        gsap.to(el, { opacity: 0, y: -28, duration: 0.6, delay: 0.6, ease: 'power1.in', onComplete: () => el.remove() });
      }
    }
  );
}

function survNextQuestion(){
  survState.answering = false;
  const q = survGenerateQuestion(survState.lastTopic);
  survState.lastTopic = q.topic;
  survState.current = q;

  const qText = document.getElementById('survQuestionText');
  const opts = document.getElementById('survOpts');
  qText.textContent = q.text;
  opts.classList.remove('frozen');
  opts.innerHTML = q.options.map((opt, i) => `
    <div class="quiz-opt ripple-host" data-idx="${i}">
      <div class="quiz-opt-letter">${String.fromCharCode(65+i)}</div>
      <div class="quiz-opt-text">${opt}</div>
    </div>
  `).join('');
  opts.querySelectorAll('.quiz-opt').forEach(el => {
    el.addEventListener('click', () => survHandleAnswer(parseInt(el.dataset.idx)));
  });

  gsap.fromTo([qText, ...opts.querySelectorAll('.quiz-opt')], {opacity:0, y:14}, {opacity:1, y:0, duration:0.4, stagger:0.05, ease:'back.out(1.4)'});

  survState.questionStartedAt = Date.now();
  survStartTimer();
}

// Anti-Cheat (Strict): waktu dihitung dari selisih waktu mutlak (Date.now())
// terhadap sebuah deadline tetap, bukan dengan mengurangi timeLeft per-tick.
// Dengan begitu, saat user minimize/pindah tab/keluar app lalu kembali,
// setInterval boleh saja "tertahan" oleh browser, tapi begitu tick berikutnya
// (atau event visibilitychange) berjalan, sisa waktu akan langsung terpotong
// secara akurat sesuai waktu nyata yang sudah berlalu — tidak bisa dicurangi.
function survStartTimer(){
  clearInterval(survState.timerId);
  survState.timeLeft = SURV_QUESTION_TIME;
  survState.deadline = Date.now() + SURV_QUESTION_TIME * 1000;
  const timerEl = document.getElementById('survTimerVal');
  const fillEl = document.getElementById('survProgressFill');
  survUpdateTimerUI(timerEl, fillEl);

  survState.timerId = setInterval(()=> survTick(timerEl, fillEl), 100);
}

function survTick(timerEl, fillEl){
  if(survState.deadline == null) return;
  const remain = Math.max(0, survRound1((survState.deadline - Date.now()) / 1000));
  survState.timeLeft = remain;
  survUpdateTimerUI(timerEl, fillEl);
  if(remain <= 0){
    clearInterval(survState.timerId);
    survHandleTimeout();
  }
}

// Saat aplikasi kembali terlihat (kembali dari minimize/tab lain), langsung
// hitung ulang sisa waktu dari selisih waktu mutlak, tanpa menunggu tick
// interval berikutnya — memastikan sisa waktu terpotong akurat seketika itu.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && survState.timerId != null && !survState.answering){
    const timerEl = document.getElementById('survTimerVal');
    const fillEl = document.getElementById('survProgressFill');
    survTick(timerEl, fillEl);
  }
});

function survUpdateTimerUI(timerEl, fillEl){
  if(!timerEl || !fillEl) return;
  timerEl.textContent = survState.timeLeft.toFixed(1);
  fillEl.style.width = (survState.timeLeft / SURV_QUESTION_TIME * 100) + '%';
  const panic = survState.timeLeft <= SURV_PANIC_AT;
  timerEl.classList.toggle('panic', panic);
  fillEl.classList.toggle('panic', panic);
}

function survHandleTimeout(){
  if(survState.answering) return;
  survState.answering = true;
  const opts = document.getElementById('survOpts');
  opts.classList.add('frozen');

  // Waktu habis diperlakukan SAMA seperti jawab salah: 0 poin (TIDAK ada
  // "mines"/pengurangan lagi) + tetap kehilangan 1 nyawa.
  const delta = survHitungPoin(false, SURV_QUESTION_TIME);
  survState.score += delta;
  renderSurvivalScore();
  if(delta !== 0) spawnScorePopup('survScoreVal', delta);
  survCheckRecordBreak();

  survLoseLife();
}

function survHandleAnswer(idx){
  if(survState.answering) return;
  survState.answering = true;
  clearInterval(survState.timerId);

  const opts = document.getElementById('survOpts');
  opts.classList.add('frozen');
  const optEl = opts.querySelector(`.quiz-opt[data-idx="${idx}"]`);
  const isCorrect = idx === survState.current.correctIdx;
  if(optEl) optEl.classList.add(isCorrect ? 'correct' : 'wrong');
  // Suara jawaban — nyawa terakhir (lives masih 1, belum dikurangi) punya suara sendiri.
  phygoSound.play(isCorrect ? 'correct' : (survState.lives <= 1 ? 'wrongLast' : 'wrong'));

  const waktuJawab = (Date.now() - (survState.questionStartedAt || Date.now())) / 1000;
  const delta = survHitungPoin(isCorrect, waktuJawab);
  survState.score += delta;
  renderSurvivalScore();
  if(delta !== 0) spawnScorePopup('survScoreVal', delta);
  survCheckRecordBreak();
  // CATATAN: poin Survival TIDAK lagi ditulis ke Firestore per-soal.
  // poinSolo di profil sekarang berarti "skor tertinggi dalam 1 sesi"
  // (tinggi-tinggian), bukan akumulasi — makanya baru dikirim SEKALI di
  // akhir permainan lewat submitSurvivalScore() (lihat survGameOver()).

  // Validasi jeda 1 detik penuh (morphing bentuk + feedback warna) + anti-spam click
  setTimeout(()=>{
    if(isCorrect){
      survNextQuestion();
    } else {
      survLoseLife();
    }
  }, SURV_ANSWER_DELAY);
}

function survLoseLife(){
  survState.lives--;
  renderSurvivalLives();
  if(survState.lives <= 0){
    survGameOver();
  } else {
    survNextQuestion();
  }
}

function survGameOver(){
  clearInterval(survState.timerId);
  survState.deadline = null;
  const hs = survGetHighScore();
  const isRecord = survState.score > hs;
  if(isRecord) survSaveHighScore(survState.score);

  // Kirim skor sesi ini ke Firestore — HANYA dipakai kalau lebih tinggi
  // dari rekor sebelumnya (poinSolo = "tinggi-tinggian", bukan akumulasi).
  submitSurvivalScore(survState.score);

  const correctionText = survState.current
    ? `Jawaban benar untuk soal terakhir adalah: ${survState.current.correctLabel}`
    : '';

  // Pindah ke layar hasil (bukan popup lagi, lihat renderSurvivalResultScreen
  // di bawah) — pakai replace:true supaya tombol back HP gak bisa balik ke
  // tengah-tengah permainan yang udah selesai (sama seperti pola Hasil Duel).
  navigate('survivalresult', { score: survState.score, isRecord, correctionText }, true);
}

// =====================================================================
// LAYAR HASIL SURVIVAL — dulu cuma popup kecil di tengah layar
// (surv-gameover-modal), sekarang jadi layar penuh dengan animasi &
// layout PERSIS sama seperti Halaman Hasil Duel (lihat renderDuelResultScreen
// di duel.js) — pakai class CSS yang SAMA PERSIS (duel-result-shell/
// icon-wrap/title/scorelist/actions) supaya gaya & animasinya benar-benar
// senada, cuma datanya disesuaikan buat mode 1 pemain: skor akhir + rekor
// tertinggi (bukan skor vs lawan), dan pakai palet "win" kalau berhasil
// pecahin rekor baru, atau "lose" kalau enggak (mirip konsep menang/kalah
// di Duel, biar tetap terasa "hidup" bukan cuma 1 tampilan itu-itu saja).
// =====================================================================
function _survResultSplitLetters(text){
  return String(text).split('').map((ch) => `<span class="drt-letter">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
}

function renderSurvivalResultScreen(opts){
  clearInterval(survState.timerId);
  survState.deadline = null;

  const finalScore = (opts && typeof opts.score === 'number') ? opts.score : survState.score;
  const highScore = survGetHighScore();
  const isRecord = !!(opts && opts.isRecord);
  const correctionText = (opts && opts.correctionText) || '';

  // Rekor baru -> suara Menang, selain itu -> suara Game Over.
  phygoSound.play(isRecord ? 'win' : 'gameover');

  const shell = document.getElementById('survResultShell');
  if(shell) shell.style.opacity = '0';

  const resultKind = isRecord ? 'win' : 'lose';
  const resultIcon = isRecord ? 'trophy' : 'cross';

  if(shell){
    shell.classList.remove('win', 'lose', 'draw');
    shell.classList.add(resultKind);
  }
  const iconWrap = document.getElementById('survResultIconWrap');
  if(iconWrap){
    iconWrap.classList.remove('win', 'lose', 'draw');
    iconWrap.classList.add(resultKind);
  }
  document.getElementById('survResultIcon').innerHTML = svgIcon(resultIcon);

  document.getElementById('survResultTitleTop').textContent = 'Skor Kamu';
  const titleMainEl = document.getElementById('survResultTitleMain');
  titleMainEl.classList.remove('win', 'lose', 'draw');
  titleMainEl.classList.add(resultKind);
  titleMainEl.innerHTML = _survResultSplitLetters(isRecord ? 'Rekor Baru!' : 'Game Over');

  document.getElementById('survResultScoreList').innerHTML = `
    <div class="duel-result-score-row me">Skor Akhir: <b>${finalScore}</b></div>
    <div class="duel-result-score-row">Rekor Tertinggi: <b>${highScore}</b></div>
  `;

  const corrEl = document.getElementById('survResultCorrection');
  if(corrEl) corrEl.textContent = correctionText;

  if(shell) shell.style.opacity = '1';

  // ===== Animasi masuk — SAMA PERSIS dengan renderDuelResultScreen() =====
  const tl = gsap.timeline();
  tl.fromTo('#survResultIconWrap', { opacity:0, scale:0.3, rotate:-20 }, { opacity:1, scale:1, rotate:0, duration:0.7, ease:'elastic.out(1, 0.55)' })
    .fromTo('#survResultTitleTop', { opacity:0, y:14 }, { opacity:1, y:0, duration:0.35, ease:'power2.out' }, '-=0.35')
    .fromTo('#survResultTitleMain .drt-letter', { opacity:0, y:24, scale:0.5, rotate:8 }, { opacity:1, y:0, scale:1, rotate:0, duration:0.5, ease:'back.out(2.4)', stagger:0.045 }, '-=0.15')
    .fromTo('#survResultScoreList .duel-result-score-row', { opacity:0, x:-18 }, { opacity:1, x:0, duration:0.35, ease:'power2.out', stagger:0.08 }, '-=0.15')
    .fromTo('#survResultCorrection', { opacity:0, y:10 }, { opacity:1, y:0, duration:0.3, ease:'power2.out' }, '-=0.15')
    .fromTo('#survResultActions .btn', { opacity:0, y:20 }, { opacity:1, y:0, duration:0.4, ease:'back.out(1.6)', stagger:0.08 }, '-=0.1');
}

function survRetry(){
  navigate('survival', {}, true);
}

function survGoHome(){
  clearInterval(survState.timerId);
  goToDashboard();
}

document.addEventListener('DOMContentLoaded', ()=>{
  const retryBtn = document.getElementById('survResultRetryBtn');
  const homeBtn = document.getElementById('survResultHomeBtn');
  const retryIcon = document.getElementById('survResultRetryIcon');
  const homeIcon = document.getElementById('survResultHomeIcon');
  if(retryIcon) retryIcon.innerHTML = svgIcon('replay');
  if(homeIcon) homeIcon.innerHTML = svgIcon('home');
  if(retryBtn) retryBtn.addEventListener('click', survRetry);
  if(homeBtn) homeBtn.addEventListener('click', survGoHome);

  const recordIcon = document.getElementById('survRecordIcon');
  if(recordIcon) recordIcon.innerHTML = svgIcon('trophy');
});

