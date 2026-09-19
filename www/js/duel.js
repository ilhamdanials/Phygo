"use strict";

// =====================================================================
// DUEL.JS — Mode Duel 1v1 real-time (Tugas 4 & 5)
//
// KONSEP INTI (PENTING, biar gampang di-maintain nanti):
// Soal antara 2 pemain BEDA-BEDA — masing-masing HP generate soal sendiri
// pakai generator yang SAMA PERSIS dengan Survival (survGenerateQuestion,
// lihat survival.js). Yang disinkronkan real-time cuma 2 ANGKA per pemain:
// skor & sisa nyawa, lewat 1 dokumen Firestore (duels/{duelId}) yang
// didengarkan (onSnapshot) oleh KEDUA HP. Sengaja TIDAK ada Cloud Function
// (project ini murni client + Firestore) — semua logic termasuk
// matchmaking pakai Firestore transaction dari sisi client.
//
// STRUKTUR FIRESTORE:
//   matchmakingQueue/{uid}        -> antrian "cari lawan acak"
//   duels/{duelId}                -> { playerUids:[a,b], status, winnerUid }
//   duels/{duelId}/players/{uid}  -> { usernameDisplay, avatarId, rankValue,
//                                      score, lives, status, updatedAt }
//   users/{uid}/duelInvites/{fromUid} -> ajakan duel personal dari teman
//
// Poin per soal PERSIS sama seperti Survival (lihat survHitungPoin() di
// survival.js) — dan SETIAP kali dapat/kehilangan poin, langsung ditulis
// permanen ke users/{uid}.poinDuel + totalPoin lewat awardPoin('duel', delta)
// (lihat auth.js), SEKALIGUS ke duels/{duelId}/players/{uid}.score (buat
// disinkronkan real-time ke layar lawan & halaman hasil).
// =====================================================================

const DUEL_LIVES_START = SURV_LIVES_START; // 3, sama seperti Survival
const DUEL_RANK_WINDOW_NARROW = 1500; // toleransi selisih poinDuel di 10 detik pertama pencarian
const DUEL_WIDEN_AFTER_MS = 10000;    // setelah ini, kriteria diperlonggar jadi "siapa aja"
const DUEL_GIVEUP_AFTER_MS = 45000;   // kalau sampai segini belum ketemu, nyerah
const DUEL_POLL_INTERVAL_MS = 3000;

// ===== State global mode Duel — direset tiap mulai matchmaking/game baru =====
const duelMM = {
  searching: false, myUid: null, myProfile: null, startedAt: 0,
  unsubOwnQueue: null, pollTimer: null, giveupTimer: null, matched: false,
  triedUids: new Set(),
  // Timer UI (lihat duelUpdateMatchmakingUi) — misahin dari pollTimer di
  // atas karena ini cuma buat gerakin progress bar/teks secara halus tiap
  // sepersekian detik, BUKAN buat query Firestore (itu tetap tugas
  // pollTimer/duelAttemptMatchTick, jangan digabung biar gak boros baca).
  uiTimer: null,
  // FIX BUG "PENCARIAN TETAP JALAN DI BELAKANG WALAU SUDAH DIBATALKAN":
  // startDuelMatchmaking() & duelAttemptMatchTick() sama-sama ASYNC (ada
  // beberapa `await` network di tengah jalan). Kalau user pencet "Batalkan"
  // PAS lagi nunggu salah satu await itu, clearInterval/clearTimeout di
  // cancelDuelMatchmaking() cuma nyetop timer yang akan datang — kode yang
  // SUDAH terlanjur jalan (lagi nunggu await) tetap lanjut begitu awaitnya
  // selesai, seolah-olah gak pernah dibatalkan. `session` ini adalah
  // "nomor sesi pencarian" yang naik tiap kali mulai/batal — tiap fungsi
  // async simpan angka ini SEBELUM await, lalu setelah await WAJIB cek
  // apakah masih sama dengan duelMM.session sekarang; kalau beda, berarti
  // sudah dibatalkan/digantikan sesi baru selagi nunggu -> langsung stop.
  session: 0,
};
const duelState = {
  duelId: null, myUid: null, opponentUid: null, opponentInfo: null, myInfo: null,
  lives: DUEL_LIVES_START, score: 0, lastTopic: null, current: null,
  timeLeft: SURV_QUESTION_TIME, timerId: null, deadline: null, answering: false,
  questionStartedAt: null, finished: false,
  // Nilai TERBARU milik lawan yang diketahui dari onSnapshot (dipakai buat
  // menentukan pemenang & buat tahu kapan lawan JUGA sudah kehabisan nyawa
  // — lihat Tugas 6: "duel wajib diselesaikan sampai kedua nyawa habis").
  oppLives: DUEL_LIVES_START, oppScore: 0,
  // true begitu nyawa SENDIRI habis duluan (masuk mode nunggu/nonton lawan).
  iAmDead: false,
  unsubOpponent: null, unsubDuelDoc: null,
};

function duelInitialPlayerDoc(profileLike){
  return {
    uid: profileLike.uid,
    usernameDisplay: profileLike.usernameDisplay || 'User',
    avatarId: profileLike.avatarId || 1,
    rankValue: profileLike.poinDuel || profileLike.rankValue || 0,
    score: 0,
    lives: DUEL_LIVES_START,
    status: 'playing',
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
}

// =====================================================================
// KARTU ENTRY POINT DI HOME
// =====================================================================
function renderDuelCard(holder){
  if(!holder) return;
  holder.innerHTML = `
    <button class="duel-card ripple-host" id="duelCardBtn">
      <div class="duel-card-icon-box">${svgIcon('swords')}</div>
      <div class="duel-card-text">
        <span class="duel-card-eyebrow">1 vs 1 Real-time</span>
        <div class="duel-card-title">Mode Duel</div>
        <div class="duel-card-sub">Adu cepat jawab soal fisika lawan pemain lain</div>
      </div>
      <div class="duel-card-go">${svgIcon('chevronRight')}</div>
    </button>
  `;
  document.getElementById('duelCardBtn').addEventListener('click', ()=> navigate('duelmatch', {}));
}

// =====================================================================
// MATCHMAKING — cari lawan acak (Tugas 4 poin 2)
// =====================================================================
async function startDuelMatchmaking(){
  // FIX TAMBAHAN buat bug "udah dibatalkan tapi tetap muncul notif 'tidak
  // ada lawan'": SEBELUM apa pun, bersih-bersih dulu sisa timer/listener
  // dari sesi manapun sebelumnya yang mungkin masih nempel (jaga-jaga kalau
  // ada overlap start/cancel yang bikin duelMM.giveupTimer/pollTimer/
  // uiTimer ke-timpa sebelum sempat di-clear).
  duelStopMatchmakingTimers();

  const mySession = ++duelMM.session; // sesi baru — otomatis membatalkan sesi lama yg mungkin masih nyangkut di await
  duelMM.searching = true;
  duelMM.matched = false;
  duelMM.startedAt = Date.now();
  duelMM.triedUids = new Set();

  document.getElementById('duelmatchStatusText').textContent = 'Mencari lawan setara...';
  document.getElementById('duelmatchStatusChip').classList.remove('duel-match-status-chip-widened', 'duel-match-status-chip-found');
  document.getElementById('duelmatchStatusChip').style.width = '';
  document.getElementById('duelmatchStatusChip').style.height = '';
  document.getElementById('duelmatchStatusText').style.opacity = '1';
  const oppLabelInit = document.getElementById('duelmatchOppLabel');
  oppLabelInit.textContent = 'Mencari...';
  oppLabelInit.dataset.txt = 'n';
  oppLabelInit.style.opacity = '1';
  document.getElementById('duelmatchProgressFill').style.width = '0%';
  document.getElementById('duelmatchProgressFill').classList.remove('widened');
  document.getElementById('duelmatchMyAvatar').innerHTML = '';
  document.getElementById('duelmatchOppAvatar').innerHTML = '?';
  document.getElementById('duelmatchCancelBtn').disabled = false;
  document.getElementById('duelmatchCancelBtn').style.display = '';
  document.querySelector('#duelmatchCancelBtn .duel-match-cancel-label').textContent = 'Batalkan';
  document.querySelectorAll('.duel-match-avatar-frame').forEach(f => f.classList.remove('duel-match-frame-found'));

  // Gerakin progress bar + teks status tiap 250ms biar mulus (bukan
  // nyentak tiap 3 detik ikut ritme pollTimer/query Firestore).
  duelMM.uiTimer = setInterval(duelUpdateMatchmakingUi, 250);
  duelUpdateMatchmakingUi();

  const me = fbAuth.currentUser;
  if(!me){ navigate('home', {}, true); return; }

  try{
    const profile = await getCurrentUserProfile();
    if(mySession !== duelMM.session) return; // dibatalkan selagi nunggu profil
    if(!profile){ navigate('home', {}, true); return; }
    duelMM.myUid = me.uid;
    duelMM.myProfile = profile;
    document.getElementById('duelmatchMyAvatar').innerHTML = avatarSvg(profile.avatarId);

    // Daftar ke antrian supaya orang lain juga bisa nemuin kita
    await db.collection('matchmakingQueue').doc(me.uid).set({
      uid: me.uid,
      usernameDisplay: profile.usernameDisplay || 'User',
      avatarId: profile.avatarId || 1,
      rankValue: profile.poinDuel || 0,
      status: 'waiting',
      matchId: null,
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    if(mySession !== duelMM.session){
      // Dibatalkan PAS/PAS SETELAH nulis ke antrian selesai — bersihin lagi
      // biar gak ninggalin dokumen antrian nyangkut di server.
      db.collection('matchmakingQueue').doc(me.uid).delete().catch(()=>{});
      return;
    }

    // Dengarkan dokumen antrian MILIK SENDIRI — kalau ada HP lain yang
    // berhasil "mencocokkan" kita lewat transaction mereka, statusnya
    // bakal berubah jadi 'matched' di sini.
    duelMM.unsubOwnQueue = db.collection('matchmakingQueue').doc(me.uid).onSnapshot((snap)=>{
      if(mySession !== duelMM.session) return;
      if(!snap.exists || duelMM.matched) return;
      const d = snap.data();
      if(d.status === 'matched' && d.matchId){
        duelFinalizeMatch(d.matchId);
      }
    }, (err)=> console.error('[Phygo] listener antrian duel gagal:', err));

    // Mulai coba mencocokkan dari sisi sendiri juga, berkala.
    duelMM.pollTimer = setInterval(duelAttemptMatchTick, DUEL_POLL_INTERVAL_MS);
    duelAttemptMatchTick();

    duelMM.giveupTimer = setTimeout(() => {
      // FIX: cek ULANG sesi tepat sebelum benar-benar munculin notif "tidak
      // ada lawan". Ini jaring pengaman TERAKHIR — kalaupun karena alasan
      // apa pun clearTimeout() di cancelDuelMatchmaking() gagal membatalkan
      // timer ini (misal timer sempat ke-overwrite sebelum di-clear), guard
      // di sini memastikan Swal "Lawan Tidak Ditemukan" TETAP TIDAK PERNAH
      // muncul untuk sesi yang sudah dibatalkan/digantikan sesi baru.
      if(mySession !== duelMM.session) return;
      duelGiveUpSearching();
    }, DUEL_GIVEUP_AFTER_MS);
  } catch(e){
    if(mySession !== duelMM.session) return; // dibatalkan, gak perlu tampilin error apa pun
    console.error('[Phygo] Gagal mulai matchmaking duel:', e);
    Swal.fire({ icon:'error', title:'Gagal Memulai Pencarian', text: e.message, background:'#1C2426', color:'#E3E3E6', confirmButtonColor:'var(--error)' })
      .then(()=> navigate('home', {}, true));
  }
}

// Digerakkan tiap 250ms (lihat duelMM.uiTimer) — SEMUA update tampilan
// yang gak butuh network (progress bar, warna chip "diperluas")
// dipusatkan di sini biar mulus, terpisah dari duelAttemptMatchTick yang
// tugasnya khusus query Firestore tiap beberapa detik.
//
// CATATAN: teks capsule status SENGAJA gak ganti-ganti lagi jadi "Masih
// mencari... memperluas kriteria lawan" (dulu ada, dihapus atas
// permintaan — kepanjangan/ganggu). Sinyal "kriteria udah diperluas"
// sekarang CUKUP lewat perubahan warna chip & progress bar aja (lihat
// class duel-match-status-chip-widened / .widened di CSS), teksnya tetap
// "Mencari lawan setara..." terus dari awal sampai ketemu.
function duelUpdateMatchmakingUi(){
  if(!duelMM.searching || duelMM.matched) return;
  const elapsed = Date.now() - duelMM.startedAt;
  const widened = elapsed >= DUEL_WIDEN_AFTER_MS;
  const pct = Math.max(0, Math.min(100, (elapsed / DUEL_GIVEUP_AFTER_MS) * 100));

  const fill = document.getElementById('duelmatchProgressFill');
  if(fill){ fill.style.width = pct + '%'; fill.classList.toggle('widened', widened); }

  duelAnimateStatusChipText('Mencari lawan setara...', widened);

  const oppLabel = document.getElementById('duelmatchOppLabel');
  if(oppLabel) oppLabel.textContent = 'Mencari...';
}

// =====================================================================
// FIX "TRANSISI CAPSULE STATUS PATAH-PATAH": sebelumnya teks di dalam
// chip status diganti pakai textContent langsung -> ukuran chip (yang
// selebar isi tulisannya) langsung LONCAT ke ukuran baru dalam SATU
// FRAME, dan karena chip ini anggota flex-column, elemen di bawahnya
// (progress bar, tombol Batal) ikut "nge-flick" terdorong seketika juga.
//
// FIX-nya: animasikan lebar & tinggi chip secara eksplisit (dari ukuran
// SEKARANG ke ukuran TARGET, lewat CSS transition di .duel-match-status-chip)
// SAMBIL teks-nya di-crossfade (fade out -> ganti isi -> fade in). Karena
// tinggi/lebar chip berubah secara animasi (bukan loncat instan), reflow
// elemen-elemen di bawahnya pun ikut mulus mengikuti — bukan nge-flick lagi.
// =====================================================================
let _duelChipAnimTimer1 = null, _duelChipAnimTimer2 = null;
function duelAnimateStatusChipText(newText, widened){
  const chip = document.getElementById('duelmatchStatusChip');
  const textEl = document.getElementById('duelmatchStatusText');
  if(!chip || !textEl) return;

  const isWidenedNow = chip.classList.contains('duel-match-status-chip-widened');
  if(textEl.textContent === newText && isWidenedNow === widened) return; // gak ada perubahan sama sekali, jangan animasi mubazir tiap 250ms

  clearTimeout(_duelChipAnimTimer1);
  clearTimeout(_duelChipAnimTimer2);

  // Kunci ukuran SEKARANG sebagai titik AWAL animasi.
  const startRect = chip.getBoundingClientRect();
  chip.style.width = startRect.width + 'px';
  chip.style.height = startRect.height + 'px';
  void chip.offsetWidth; // paksa browser "commit" ukuran awal ini dulu sebelum lanjut

  textEl.style.opacity = '0';

  _duelChipAnimTimer1 = setTimeout(() => {
    textEl.textContent = newText;
    chip.classList.toggle('duel-match-status-chip-widened', widened);

    // Ukur ukuran TARGET (biarin auto sesaat buat ngukur doang).
    chip.style.width = 'auto';
    chip.style.height = 'auto';
    const targetRect = chip.getBoundingClientRect();
    chip.style.width = startRect.width + 'px';
    chip.style.height = startRect.height + 'px';
    void chip.offsetWidth;

    // Sekarang beneran jalanin transisi dari ukuran lama -> ukuran baru.
    chip.style.width = targetRect.width + 'px';
    chip.style.height = targetRect.height + 'px';
    textEl.style.opacity = '1';

    _duelChipAnimTimer2 = setTimeout(() => {
      // Lepas ukuran fixed setelah animasi kelar, biar tetap responsive
      // (misal rotate layar / font-scale beda).
      chip.style.width = '';
      chip.style.height = '';
    }, 420);
  }, 150);
}

async function duelAttemptMatchTick(){
  const mySession = duelMM.session; // catat sesi SEKARANG, dicek ulang tiap habis await di bawah
  if(duelMM.matched || !duelMM.searching) return;
  const elapsed = Date.now() - duelMM.startedAt;
  const widened = elapsed >= DUEL_WIDEN_AFTER_MS;

  try{
    const snap = await db.collection('matchmakingQueue').where('status', '==', 'waiting').limit(25).get();
    // FIX: kalau dibatalkan SELAGI query di atas lagi jalan, jangan lanjut
    // sama sekali — ini inti dari bug "pencarian tetap jalan di belakang
    // walau sudah dibatalkan".
    if(mySession !== duelMM.session || duelMM.matched || !duelMM.searching) return;

    let candidates = snap.docs
      .filter(d => d.id !== duelMM.myUid && !duelMM.triedUids.has(d.id))
      .map(d => ({ id: d.id, data: d.data() }));

    if(!widened){
      const myRank = duelMM.myProfile.poinDuel || 0;
      candidates = candidates.filter(c => Math.abs((c.data.rankValue||0) - myRank) <= DUEL_RANK_WINDOW_NARROW);
    }
    // Lawan ter-dekat rank-nya dicoba duluan.
    const myRank = duelMM.myProfile.poinDuel || 0;
    candidates.sort((a,b)=> Math.abs((a.data.rankValue||0)-myRank) - Math.abs((b.data.rankValue||0)-myRank));

    for(const cand of candidates){
      if(mySession !== duelMM.session || duelMM.matched) return;
      const duelId = await duelTryMatchTransaction(cand.id);
      if(mySession !== duelMM.session){
        // Dibatalkan PAS transaction-nya lagi jalan. Kalau ternyata transaction
        // ini SEMPAT sukses (duelId ada), match-nya udah kejadian di server —
        // gak bisa "dibatalkan" lagi, tapi minimal jangan paksa navigate ke
        // layar VS-nya karena user udah pindah context duluan.
        return;
      }
      if(duelId){
        duelFinalizeMatch(duelId);
        return;
      }
      duelMM.triedUids.add(cand.id); // gagal (kemungkinan udah diambil HP lain), jangan dicoba lagi
    }
  } catch(e){
    if(mySession !== duelMM.session) return; // dibatalkan, abaikan errornya
    console.error('[Phygo] Gagal cek antrian duel:', e);
  }
}

// Transaction LANGKAH 1: baca dokumen antrian kandidat, kalau masih
// 'waiting' bikin dokumen duel (parent) + tandai antrian kandidat 'matched'.
// Kalau ternyata udah diambil HP lain (race condition), transaction ini
// otomatis gagal (dilempar dari dalam) dan kita coba kandidat berikutnya.
//
// PENTING: dokumen players/ SENGAJA TIDAK dibuat di transaction yang sama!
// Firestore security rules TIDAK BISA get() dokumen yang baru ditulis DI
// DALAM transaction yang sama (rules melihat state SEBELUM transaction
// commit) — jadi rule create players/{uid} yang butuh cek
// get(duels/{duelId}).data.playerUids bakal selalu gagal kalau dibarengin.
// Makanya players/ dibuat di LANGKAH 2, setelah dokumen duel dipastikan
// sudah benar-benar ke-commit.
async function duelTryMatchTransaction(candidateUid){
  const duelRef = db.collection('duels').doc();
  let candData = null;
  try{
    await db.runTransaction(async (tx)=>{
      const candRef = db.collection('matchmakingQueue').doc(candidateUid);
      const candSnap = await tx.get(candRef);
      if(!candSnap.exists || candSnap.data().status !== 'waiting'){
        throw new Error('kandidat sudah diambil');
      }
      candData = candSnap.data();
      tx.set(duelRef, {
        playerUids: [duelMM.myUid, candidateUid],
        status: 'starting',
        winnerUid: null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        finishedAt: null,
      });
      tx.update(candRef, { status: 'matched', matchId: duelRef.id });
      tx.delete(db.collection('matchmakingQueue').doc(duelMM.myUid));
    });
  } catch(e){
    return null;
  }

  // LANGKAH 2: dokumen duel udah pasti ke-commit di titik ini — baru
  // sekarang bikin 2 dokumen player-nya.
  try{
    await Promise.all([
      duelRef.collection('players').doc(duelMM.myUid).set(duelInitialPlayerDoc(Object.assign({uid: duelMM.myUid}, duelMM.myProfile))),
      duelRef.collection('players').doc(candidateUid).set(duelInitialPlayerDoc(candData)),
    ]);
  } catch(e){
    console.error('[Phygo] Gagal membuat dokumen player duel:', e);
    return null;
  }
  return duelRef.id;
}

function duelFinalizeMatch(duelId){
  if(duelMM.matched) return;
  duelMM.matched = true;
  duelMM.searching = false;
  duelStopMatchmakingTimers();
  duelPlayMatchFoundAnimation(() => navigate('duelvs', { duelId }));
}

// =====================================================================
// ANIMASI "LAWAN DITEMUKAN!" — sebelumnya begitu ketemu lawan, app
// LANGSUNG lompat ke layar VS tanpa jeda/animasi sama sekali (berasa
// "tiba-tiba"). Sekarang kasih jeda singkat (~900ms) dengan chip status
// berubah hijau + centang, kedua bingkai avatar "pop", baru pindah layar.
// =====================================================================
function duelPlayMatchFoundAnimation(onDone){
  const screen = document.getElementById('screen-duelmatch');
  // Kalau layar ini ternyata udah gak aktif/kelihatan (edge case), langsung
  // lanjut aja tanpa animasi — gak ada gunanya animasi yang gak keliatan,
  // dan JANGAN sampai malah nunda navigasi yang seharusnya segera terjadi.
  if(!screen || !screen.classList.contains('active')){ onDone(); return; }

  duelAnimateStatusChipText('Lawan Ditemukan!', false);
  const chip = document.getElementById('duelmatchStatusChip');
  if(chip) chip.classList.add('duel-match-status-chip-found');

  document.querySelectorAll('.duel-match-avatar-frame').forEach(f => f.classList.add('duel-match-frame-found'));

  const oppAvatar = document.getElementById('duelmatchOppAvatar');
  if(oppAvatar){
    oppAvatar.innerHTML = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  }
  const oppLabel = document.getElementById('duelmatchOppLabel');
  if(oppLabel){
    oppLabel.style.opacity = '0';
    setTimeout(()=>{ oppLabel.textContent = 'Siap!'; oppLabel.style.opacity = '1'; }, 150);
  }

  const progressTrack = document.getElementById('duelmatchProgressFill');
  if(progressTrack && progressTrack.parentElement) progressTrack.parentElement.style.opacity = '0';
  const cancelBtn = document.getElementById('duelmatchCancelBtn');
  if(cancelBtn){ cancelBtn.style.opacity = '0'; cancelBtn.disabled = true; }

  setTimeout(onDone, 900);
}

function duelStopMatchmakingTimers(){
  if(duelMM.pollTimer) clearInterval(duelMM.pollTimer);
  if(duelMM.giveupTimer) clearTimeout(duelMM.giveupTimer);
  if(duelMM.uiTimer) clearInterval(duelMM.uiTimer);
  if(duelMM.unsubOwnQueue) duelMM.unsubOwnQueue();
  duelMM.pollTimer = null; duelMM.giveupTimer = null; duelMM.uiTimer = null; duelMM.unsubOwnQueue = null;
}

function cancelDuelMatchmaking(){
  if(duelMM.matched) return; // udah ketemu lawan, jangan dibatalin lagi
  duelMM.session++; // batal DETIK INI JUGA — semua await yg lagi jalan (tick/transaction) akan berhenti begitu sadar sesinya udah beda
  duelMM.searching = false;
  duelStopMatchmakingTimers();
  if(duelMM.myUid){
    db.collection('matchmakingQueue').doc(duelMM.myUid).delete().catch(()=>{});
  }
}

function duelGiveUpSearching(){
  if(duelMM.matched) return;
  cancelDuelMatchmaking();
  Swal.fire({
    icon: 'info', title: 'Lawan Tidak Ditemukan',
    text: 'Gak ada lawan yang tersedia, coba lagi nanti.',
    background:'#1C2426', color:'#E3E3E6', confirmButtonColor:'var(--primary)',
  }).then(()=> navigate('home', {}, true));
}

// Tombol "Batalkan" manual di layar matchmaking
document.addEventListener('DOMContentLoaded', ()=>{
  const btn = document.getElementById('duelmatchCancelBtn');
  if(btn) btn.addEventListener('click', ()=>{
    cancelDuelMatchmaking();
    navigate('home', {}, true);
  });
});

// =====================================================================
// LAYAR VS + COUNTDOWN (Tugas 4 poin 3) — dipakai baik hasil matchmaking
// acak MAUPUN hasil menerima ajakan duel dari teman (Tugas 5).
// =====================================================================
async function renderDuelVsScreen(opts){
  const duelId = opts && opts.duelId;
  const me = fbAuth.currentUser;
  if(!duelId || !me){ navigate('home', {}, true); return; }

  try{
    const duelDoc = await db.collection('duels').doc(duelId).get();
    if(!duelDoc.exists){ navigate('home', {}, true); return; }
    const playerUids = duelDoc.data().playerUids || [];
    const opponentUid = playerUids.find(u => u !== me.uid);
    if(!opponentUid){ navigate('home', {}, true); return; }

    const [myDoc, oppDoc] = await Promise.all([
      db.collection('duels').doc(duelId).collection('players').doc(me.uid).get(),
      db.collection('duels').doc(duelId).collection('players').doc(opponentUid).get(),
    ]);
    const myInfo = myDoc.exists ? myDoc.data() : { usernameDisplay:'Kamu', avatarId:1, rankValue:0 };
    const oppInfo = oppDoc.exists ? oppDoc.data() : { usernameDisplay:'Lawan', avatarId:1, rankValue:0 };

    duelState.duelId = duelId;
    duelState.myUid = me.uid;
    duelState.opponentUid = opponentUid;
    duelState.myInfo = myInfo;
    duelState.opponentInfo = oppInfo;

    const myRank = getRankBadge(myInfo.rankValue || 0);
    const oppRank = getRankBadge(oppInfo.rankValue || 0);

    document.getElementById('duelvsMyAvatar').innerHTML = avatarSvg(myInfo.avatarId);
    document.getElementById('duelvsMyName').textContent = myInfo.usernameDisplay || 'Kamu';
    const myRankEl = document.getElementById('duelvsMyRank');
    myRankEl.textContent = myRank.rank; myRankEl.style.color = myRank.color;

    document.getElementById('duelvsOppAvatar').innerHTML = avatarSvg(oppInfo.avatarId);
    document.getElementById('duelvsOppName').textContent = oppInfo.usernameDisplay || 'Lawan';
    const oppRankEl = document.getElementById('duelvsOppRank');
    oppRankEl.textContent = oppRank.rank; oppRankEl.style.color = oppRank.color;

    // Animasi VS masuk
    gsap.fromTo('.duel-vs-player', {opacity:0, y:20}, {opacity:1, y:0, duration:0.5, stagger:0.12, ease:'back.out(1.4)'});
    gsap.fromTo('.duel-vs-mark', {scale:0, rotate:-15}, {scale:1, rotate:0, duration:0.5, delay:0.2, ease:'back.out(2.2)'});

    // Countdown 3-2-1-MULAI, TIDAK perlu presisi antar HP (cuma buat feel)
    setTimeout(()=>{
      const overlay = document.getElementById('duelvsCountdownOverlay');
      const numEl = document.getElementById('duelvsCountdownNum');
      overlay.classList.add('show');
      const seq = ['3','2','1','MULAI!'];
      let i = 0;
      numEl.textContent = seq[0];
      phygoSound.play('countdown');
      gsap.fromTo(numEl, {scale:0.5, opacity:0}, {scale:1, opacity:1, duration:0.3, ease:'back.out(2)'});
      const tick = setInterval(()=>{
        i++;
        if(i >= seq.length){
          clearInterval(tick);
          navigate('duelgame', { duelId }, true);
          return;
        }
        numEl.textContent = seq[i];
        gsap.fromTo(numEl, {scale:0.5, opacity:0}, {scale:1, opacity:1, duration:0.3, ease:'back.out(2)'});
      }, COUNTDOWN_STEP_MS);
    }, 900);
  } catch(e){
    console.error('[Phygo] Gagal memuat layar VS duel:', e);
    navigate('home', {}, true);
  }
}

// =====================================================================
// GAMEPLAY DUEL (Tugas 4 poin 4) — generator & UI PERSIS Survival, cuma
// nambah HUD lawan yang disinkron real-time lewat onSnapshot.
// =====================================================================
function startDuelGame(opts){
  const duelId = (opts && opts.duelId) || duelState.duelId;
  duelState.duelId = duelId;
  duelState.lives = DUEL_LIVES_START;
  duelState.score = 0;
  duelState.lastTopic = null;
  duelState.answering = false;
  duelState.finished = false;
  duelState.oppLives = DUEL_LIVES_START;
  duelState.oppScore = 0;
  duelState.iAmDead = false;
  clearInterval(duelState.timerId);

  document.getElementById('duelOppNameLabel').textContent = (duelState.opponentInfo && duelState.opponentInfo.usernameDisplay) || 'Lawan';
  document.getElementById('duelWaitingOppName').textContent = (duelState.opponentInfo && duelState.opponentInfo.usernameDisplay) || 'lawan';
  hideDuelWaitingOverlay();
  renderDuelLives('duelMyLives', DUEL_LIVES_START);
  renderDuelLives('duelOppLives', DUEL_LIVES_START);
  document.getElementById('duelMyScoreVal').textContent = '0';
  document.getElementById('duelOppScoreVal').textContent = '0';
  document.getElementById('duelOpts').innerHTML = '';
  document.getElementById('duelQuestionText').textContent = '';

  duelTeardownListeners();

  // Dengarkan dokumen player LAWAN — buat update HUD skor/nyawa lawan
  // realtime, DAN buat tahu kapan lawan JUGA kehabisan nyawa (dipakai buat
  // finalisasi duel kalau kita sendiri sudah lebih dulu mati & lagi
  // nunggu/nonton, lihat Tugas 6).
  duelState.unsubOpponent = db.collection('duels').doc(duelId).collection('players').doc(duelState.opponentUid)
    .onSnapshot((snap)=>{
      if(!snap.exists) return;
      const d = snap.data();
      duelState.oppScore = d.score || 0;
      duelState.oppLives = d.lives != null ? d.lives : DUEL_LIVES_START;
      document.getElementById('duelOppScoreVal').textContent = duelState.oppScore;
      renderDuelLives('duelOppLives', duelState.oppLives);

      // Kita sudah lebih dulu mati & lagi nunggu — begitu lawan JUGA
      // kehabisan nyawa, duel resmi selesai, finalisasi (tentukan
      // pemenang lewat skor akhir).
      if(duelState.iAmDead && duelState.oppLives <= 0 && !duelState.finished){
        duelFinalizeDuel();
      }
    }, (err)=> console.error('[Phygo] listener player lawan gagal:', err));

  // Dengarkan dokumen duel utama — buat tahu kapan game berakhir (baik
  // karena nyawa kita abis, MAUPUN karena nyawa lawan abis duluan).
  duelState.unsubDuelDoc = db.collection('duels').doc(duelId).onSnapshot((snap)=>{
    if(!snap.exists) return;
    const d = snap.data();
    if(d.status === 'finished' && !duelState.finished){
      duelState.finished = true;
      duelTeardownListeners();
      clearInterval(duelState.timerId);
      navigate('duelresult', { duelId, winnerUid: d.winnerUid }, true);
    }
  }, (err)=> console.error('[Phygo] listener dokumen duel gagal:', err));

  duelNextQuestion();
}

function duelTeardownListeners(){
  if(duelState.unsubOpponent) duelState.unsubOpponent();
  if(duelState.unsubDuelDoc) duelState.unsubDuelDoc();
  duelState.unsubOpponent = null; duelState.unsubDuelDoc = null;
}

// Nyawa Duel: 3 heart-icon berjejer, dikasih gap yang cukup renggang
// (lihat .duel-hud-lives di style.css) supaya gak dempet/tumpang tindih
// di layar sempit — masing-masing heart pudar sendiri-sendiri begitu
// nyawa berkurang, bukan 1 heart + label "×N".
function renderDuelLives(elId, livesLeft){
  const el = document.getElementById(elId);
  if(!el) return;
  let html = '';
  for(let i = 0; i < DUEL_LIVES_START; i++){
    const isLost = i >= livesLeft;
    html += `<div class="heart-icon ${isLost ? 'lost' : ''}">${svgIcon('heart')}</div>`;
  }
  el.innerHTML = html;
}

function duelNextQuestion(){
  if(duelState.finished) return;
  duelState.answering = false;
  // Generator SAMA PERSIS dengan Survival (survGenerateQuestion, survival.js)
  const q = survGenerateQuestion(duelState.lastTopic);
  duelState.lastTopic = q.topic;
  duelState.current = q;

  const qText = document.getElementById('duelQuestionText');
  const opts = document.getElementById('duelOpts');
  qText.textContent = q.text;
  opts.classList.remove('frozen');
  opts.innerHTML = q.options.map((opt, i) => `
    <div class="quiz-opt ripple-host" data-idx="${i}">
      <div class="quiz-opt-letter">${String.fromCharCode(65+i)}</div>
      <div class="quiz-opt-text">${opt}</div>
    </div>
  `).join('');
  opts.querySelectorAll('.quiz-opt').forEach(el => {
    el.addEventListener('click', () => duelHandleAnswer(parseInt(el.dataset.idx)));
  });

  gsap.fromTo([qText, ...opts.querySelectorAll('.quiz-opt')], {opacity:0, y:14}, {opacity:1, y:0, duration:0.4, stagger:0.05, ease:'back.out(1.4)'});

  duelState.questionStartedAt = Date.now();
  duelStartTimer();
}

function duelStartTimer(){
  clearInterval(duelState.timerId);
  duelState.timeLeft = SURV_QUESTION_TIME;
  duelState.deadline = Date.now() + SURV_QUESTION_TIME * 1000;
  const timerEl = document.getElementById('duelTimerVal');
  const fillEl = document.getElementById('duelProgressFill');
  duelUpdateTimerUI(timerEl, fillEl);
  duelState.timerId = setInterval(()=> duelTick(timerEl, fillEl), 100);
}

function duelTick(timerEl, fillEl){
  if(duelState.deadline == null || duelState.finished) return;
  const remain = Math.max(0, survRound1((duelState.deadline - Date.now()) / 1000));
  duelState.timeLeft = remain;
  duelUpdateTimerUI(timerEl, fillEl);
  if(remain <= 0){
    clearInterval(duelState.timerId);
    duelHandleTimeout();
  }
}

function duelUpdateTimerUI(timerEl, fillEl){
  if(!timerEl || !fillEl) return;
  timerEl.textContent = duelState.timeLeft.toFixed(1);
  fillEl.style.width = (duelState.timeLeft / SURV_QUESTION_TIME * 100) + '%';
  const panic = duelState.timeLeft <= SURV_PANIC_AT;
  timerEl.classList.toggle('panic', panic);
  fillEl.classList.toggle('panic', panic);
}

function duelHandleTimeout(){
  if(duelState.answering || duelState.finished) return;
  duelState.answering = true;
  document.getElementById('duelOpts').classList.add('frozen');
  duelApplyPoin(false, SURV_QUESTION_TIME);
  duelLoseLife();
}

function duelHandleAnswer(idx){
  if(duelState.answering || duelState.finished) return;
  duelState.answering = true;
  clearInterval(duelState.timerId);

  const opts = document.getElementById('duelOpts');
  opts.classList.add('frozen');
  const optEl = opts.querySelector(`.quiz-opt[data-idx="${idx}"]`);
  const isCorrect = idx === duelState.current.correctIdx;
  if(optEl) optEl.classList.add(isCorrect ? 'correct' : 'wrong');
  // Suara jawaban — nyawa terakhir (lives masih 1, belum dikurangi) punya suara sendiri.
  phygoSound.play(isCorrect ? 'correct' : (duelState.lives <= 1 ? 'wrongLast' : 'wrong'));

  const waktuJawab = (Date.now() - (duelState.questionStartedAt || Date.now())) / 1000;
  duelApplyPoin(isCorrect, waktuJawab);

  setTimeout(()=>{
    if(isCorrect){
      duelNextQuestion();
    } else {
      duelLoseLife();
    }
  }, SURV_ANSWER_DELAY);
}

// Nulis poin ke 2 tempat sekaligus: (1) permanen ke profil (poinDuel +
// totalPoin, lewat awardPoin di auth.js), (2) skor duel yang lagi jalan
// (buat disinkronkan real-time ke layar lawan & halaman hasil).
// Sejak jawaban salah/waktu habis bernilai 0 (bukan minus lagi, lihat
// survHitungPoin di survival.js), skor duel TIDAK PERNAH turun — jadi
// "0 sudah paling mentok paling kecil" otomatis benar dengan sendirinya.
function duelApplyPoin(isCorrect, waktuJawabDetik){
  const delta = survHitungPoin(isCorrect, waktuJawabDetik);
  duelState.score += delta;
  document.getElementById('duelMyScoreVal').textContent = duelState.score;
  if(delta !== 0) spawnScorePopup('duelMyScoreVal', delta);
  awardPoin('duel', delta);
  if(duelState.duelId){
    db.collection('duels').doc(duelState.duelId).collection('players').doc(duelState.myUid)
      .update({ score: firebase.firestore.FieldValue.increment(delta), updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
      .catch((e)=> console.error('[Phygo] Gagal sync skor duel:', e));
  }
}

// =====================================================================
// Tugas 6: duel sekarang WAJIB berlanjut sampai KEDUA pemain kehabisan
// nyawa (bukan langsung selesai begitu SALAH SATU pemain mati). Kalau
// nyawa sendiri habis duluan sementara lawan masih hidup, kita MASUK MODE
// NUNGGU/NONTON (overlay di atas layar gameplay, HUD lawan tetap update
// realtime) sampai lawan juga kehabisan nyawa (dicek di listener lawan,
// lihat startDuelGame) atau kita pencet "Menyerah". Pemenang ditentukan
// dari SKOR AKHIR begitu keduanya sudah mati (lihat duelFinalizeDuel).
// =====================================================================
function duelLoseLife(){
  duelState.lives--;
  renderDuelLives('duelMyLives', duelState.lives);
  const myRef = db.collection('duels').doc(duelState.duelId).collection('players').doc(duelState.myUid);

  if(duelState.lives <= 0){
    duelState.iAmDead = true;
    clearInterval(duelState.timerId);
    myRef.update({ lives: 0, status: 'dead', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});

    if(duelState.oppLives <= 0){
      // Lawan sudah lebih dulu mati (kita mati belakangan) — duel resmi
      // selesai sekarang, tentukan pemenang lewat skor akhir.
      duelFinalizeDuel();
    } else {
      // Lawan masih hidup — jangan langsung ke halaman hasil, tampilkan
      // overlay nunggu di atas layar gameplay (HUD lawan tetap kelihatan).
      showDuelWaitingOverlay();
    }
  } else {
    myRef.update({ lives: duelState.lives, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
    duelNextQuestion();
  }
}

function showDuelWaitingOverlay(){
  const overlay = document.getElementById('duelWaitingOverlay');
  if(overlay) overlay.classList.add('show');
}
function hideDuelWaitingOverlay(){
  const overlay = document.getElementById('duelWaitingOverlay');
  if(overlay) overlay.classList.remove('show');
}

// Menentukan pemenang dari skor akhir (dipanggil begitu KEDUA pemain
// dipastikan sudah kehabisan nyawa). Dibungkus transaction supaya aman
// kalau kedua HP kebetulan sama-sama mencoba finalisasi hampir bersamaan
// (siapa pun yang commit duluan menang, sisanya cukup skip — client yang
// gak sempat nulis tetap kebawa pindah layar lewat listener dokumen duel
// yang sudah aktif dari awal, lihat startDuelGame & duelTeardownListeners).
async function duelFinalizeDuel(){
  if(duelState.finished || !duelState.duelId) return;
  const duelRef = db.collection('duels').doc(duelState.duelId);
  try{
    await db.runTransaction(async (tx)=>{
      const snap = await tx.get(duelRef);
      if(!snap.exists || snap.data().status === 'finished') return;
      const myScore = duelState.score;
      const oppScore = duelState.oppScore || 0;
      let winnerUid = null;
      if(myScore > oppScore) winnerUid = duelState.myUid;
      else if(oppScore > myScore) winnerUid = duelState.opponentUid;
      tx.update(duelRef, { status: 'finished', winnerUid, finishedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
  } catch(e){
    console.error('[Phygo] Gagal finalisasi duel:', e);
  }
}

// Tombol "Menyerah" di overlay nunggu — langsung selesaikan duel dengan
// lawan sebagai pemenang, gak perlu nunggu lawan kehabisan nyawa juga.
async function duelSurrenderFromWaiting(){
  if(duelState.finished || !duelState.duelId) return;
  const duelRef = db.collection('duels').doc(duelState.duelId);
  try{
    await db.runTransaction(async (tx)=>{
      const snap = await tx.get(duelRef);
      if(!snap.exists || snap.data().status === 'finished') return;
      tx.update(duelRef, { status: 'finished', winnerUid: duelState.opponentUid, finishedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    db.collection('duels').doc(duelState.duelId).collection('players').doc(duelState.myUid)
      .update({ status: 'surrendered', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }).catch(()=>{});
  } catch(e){
    console.error('[Phygo] Gagal menyerah dari duel:', e);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  const surrenderBtn = document.getElementById('duelWaitingSurrenderBtn');
  if(surrenderBtn){
    surrenderBtn.addEventListener('click', ()=>{
      surrenderBtn.disabled = true;
      duelSurrenderFromWaiting().finally(()=>{ surrenderBtn.disabled = false; });
    });
  }
});

// =====================================================================
// HALAMAN HASIL (Tugas 4 poin 6)
// =====================================================================
// Pecah teks jadi span per-huruf supaya bisa di-stagger animasinya satu-
// satu (efek "teks meletup" ala Material 3 Expressive). Spasi dibungkus
// non-breaking space biar gak collapse pas display:inline-block.
function _duelResultSplitLetters(text){
  return String(text).split('').map((ch) => `<span class="drt-letter">${ch === ' ' ? '&nbsp;' : ch}</span>`).join('');
}

async function renderDuelResultScreen(opts){
  const duelId = (opts && opts.duelId) || duelState.duelId;
  const me = fbAuth.currentUser;
  duelTeardownListeners();
  clearInterval(duelState.timerId);
  if(!duelId || !me){ navigate('home', {}, true); return; }

  // Sembunyikan dulu shell hasil SEBELUM data selesai di-fetch — kalau
  // enggak, layar ini sempat kelihatan pakai konten default/sisa duel
  // sebelumnya (misal masih "Menang!") selama beberapa milidetik sebelum
  // ke-timpa dengan hasil yang sebenarnya.
  const shell = document.getElementById('duelResultShell');
  if(shell) shell.style.opacity = '0';

  try{
    const [myDoc, oppDoc, duelDoc] = await Promise.all([
      db.collection('duels').doc(duelId).collection('players').doc(me.uid).get(),
      db.collection('duels').doc(duelId).collection('players').doc(duelState.opponentUid || (opts && opts.opponentUid)).get(),
      db.collection('duels').doc(duelId).get(),
    ]);
    const myName = myDoc.exists ? (myDoc.data().usernameDisplay || 'Kamu') : 'Kamu';
    const myScore = myDoc.exists ? (myDoc.data().score || 0) : duelState.score;
    const oppScore = oppDoc.exists ? (oppDoc.data().score || 0) : 0;
    const oppName = oppDoc.exists ? (oppDoc.data().usernameDisplay || 'Lawan') : 'Lawan';
    // winnerUid null = seri (skor akhir sama persis setelah kedua nyawa habis).
    let winnerUid = null;
    if(opts && Object.prototype.hasOwnProperty.call(opts, 'winnerUid')){
      winnerUid = opts.winnerUid;
    } else if(duelDoc.exists){
      winnerUid = duelDoc.data().winnerUid;
    }
    const isDraw = !winnerUid;
    const iWon = winnerUid === me.uid;

    // resultKind menentukan palet warna (CSS var --result-c/--result-on-c,
    // lihat style.css) SEKALIGUS ikon yang dipakai — 1 sumber kebenaran
    // biar warna & ikon gak pernah "kelewat" salah satunya.
    const resultKind = isDraw ? 'draw' : (iWon ? 'win' : 'lose');
    const resultIcon = isDraw ? 'scale' : (iWon ? 'trophy' : 'cross');

    // Menang -> suara Menang, kalah -> suara Game Over, seri -> tanpa suara.
    if(!isDraw) phygoSound.play(iWon ? 'win' : 'gameover');

    if(shell){
      shell.classList.remove('win', 'lose', 'draw');
      shell.classList.add(resultKind);
    }
    const iconWrap = document.getElementById('duelResultIconWrap');
    if(iconWrap){
      iconWrap.classList.remove('win', 'lose', 'draw');
      iconWrap.classList.add(resultKind);
    }
    document.getElementById('duelResultIcon').innerHTML = svgIcon(resultIcon);

    document.getElementById('duelResultTitleTop').textContent = 'Kamu';
    const titleMainEl = document.getElementById('duelResultTitleMain');
    titleMainEl.classList.remove('win', 'lose', 'draw');
    titleMainEl.classList.add(resultKind);
    titleMainEl.innerHTML = _duelResultSplitLetters(isDraw ? 'Seri!' : (iWon ? 'Menang!' : 'Kalah'));

    document.getElementById('duelResultScoreList').innerHTML = `
      <div class="duel-result-score-row me">${escapeHtml(myName)}: <b>${myScore}</b></div>
      <div class="duel-result-score-row">${escapeHtml(oppName)}: <b>${oppScore}</b></div>
    `;

    if(shell) shell.style.opacity = '1';

    // ===== Animasi masuk ala Material 3 Expressive =====
    // Ikon meletup dengan pantulan elastis, judul turun bertahap, tiap
    // huruf "MENANG!/KALAH/SERI!" muncul satu-satu dengan sedikit rotasi
    // (bukan cuma fade rata), baris skor & tombol nyusul dari bawah.
    const tl = gsap.timeline();
    tl.fromTo('#duelResultIconWrap', { opacity:0, scale:0.3, rotate:-20 }, { opacity:1, scale:1, rotate:0, duration:0.7, ease:'elastic.out(1, 0.55)' })
      .fromTo('#duelResultTitleTop', { opacity:0, y:14 }, { opacity:1, y:0, duration:0.35, ease:'power2.out' }, '-=0.35')
      .fromTo('#duelResultTitleMain .drt-letter', { opacity:0, y:24, scale:0.5, rotate:8 }, { opacity:1, y:0, scale:1, rotate:0, duration:0.5, ease:'back.out(2.4)', stagger:0.045 }, '-=0.15')
      .fromTo('#duelResultScoreList .duel-result-score-row', { opacity:0, x:-18 }, { opacity:1, x:0, duration:0.35, ease:'power2.out', stagger:0.08 }, '-=0.15')
      .fromTo('#duelResultActions .btn', { opacity:0, y:20 }, { opacity:1, y:0, duration:0.4, ease:'back.out(1.6)', stagger:0.08 }, '-=0.1');
  } catch(e){
    console.error('[Phygo] Gagal memuat hasil duel:', e);
    if(shell) shell.style.opacity = '1';
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  const retryBtn = document.getElementById('duelResultRetryBtn');
  const homeBtn = document.getElementById('duelResultHomeBtn');
  const retryIcon = document.getElementById('duelResultRetryIcon');
  const homeIcon = document.getElementById('duelResultHomeIcon');
  if(retryIcon) retryIcon.innerHTML = svgIcon('replay');
  if(homeIcon) homeIcon.innerHTML = svgIcon('home');
  if(retryBtn) retryBtn.addEventListener('click', ()=> navigate('duelmatch', {}, true));
  if(homeBtn) homeBtn.addEventListener('click', ()=> navigate('home', {}, true));
});

// =====================================================================
// AJAKAN DUEL DARI SOSIAL (Tugas 5)
// =====================================================================
let duelInviteUnsub = null;
let duelInviteShownFrom = null; // uid pengirim undangan yang lagi ditampilkan di banner

// =====================================================================
// TUGAS 2 (update profil teman): dulu tombol "Ajak Duel" di modal Lihat
// Profil Teman selalu tampil sama walau ternyata TEMAN ITU SENDIRI yang
// sudah lebih dulu ngajak kita duel (undangannya lagi pending, biasanya
// lagi nongol juga di banner). Klik "Ajak Duel" saat itu bikin 2 undangan
// nyilang di kedua arah — membingungkan & rawan "bentrok".
//
// Solusinya: simpan SEMUA uid pengirim undangan pending yang MASUK ke
// kita (bukan cuma yang "terbaru" kayak di banner) dalam 1 Set global,
// supaya social.js bisa cek cepat "apakah orang ini udah ngajak aku
// duel?" tanpa perlu query Firestore lagi tiap buka profilnya.
window.duelPendingInviteFromUids = new Set();

function hasPendingDuelInviteFrom(uid){
  return !!(window.duelPendingInviteFromUids && window.duelPendingInviteFromUids.has(uid));
}

function initDuelInviteListener(){
  const me = fbAuth.currentUser;
  if(!me) return;
  const phygoLog = window.phygoLog || ((tag, msg)=> console.log(`[${tag}] ${msg}`));
  phygoLog('DUEL_INVITE_LISTEN', 'Init listener');
  
  teardownDuelInviteListener();
  duelInviteUnsub = db.collection('users').doc(me.uid).collection('duelInvites')
    .where('status', '==', 'pending')
    .onSnapshot((snap)=>{
      phygoLog('DUEL_INVITE_LISTEN', `Received: ${snap.size} invites`);

      // Update Set uid pengirim SEBELUM cek "busy" atau "empty" di bawah —
      // ini harus selalu akurat gak peduli layar apa yang lagi aktif,
      // karena dipakai social.js buat modal Lihat Profil Teman kapan saja.
      const fromUids = new Set();
      snap.forEach(doc => fromUids.add(doc.id));
      window.duelPendingInviteFromUids = fromUids;
      if(typeof onDuelPendingInvitesChanged === 'function') onDuelPendingInvitesChanged();

      // Jangan ganggu kalau lagi di tengah VS/gameplay Duel.
      const busyScreens = ['screen-duelvs', 'screen-duelgame'];
      const isBusy = busyScreens.some(id => document.getElementById(id) && document.getElementById(id).classList.contains('active'));
      if(isBusy) { phygoLog('DUEL_INVITE_LISTEN', 'Busy'); return; }
      if(snap.empty){ phygoLog('DUEL_INVITE_LISTEN', 'No invites'); hideDuelInviteBanner(); return; }
      // Tampilkan undangan TERBARU
      let latest = null;
      snap.forEach(doc => {
        const d = doc.data();
        if(!latest || (d.createdAt && latest.createdAt && d.createdAt.toMillis() > latest.createdAt.toMillis())) latest = Object.assign({ inviteId: doc.id }, d);
      });
      if(latest) { phygoLog('DUEL_INVITE_LISTEN', `Show: ${latest.fromUsername}`); showDuelInviteBanner(latest); }
    }, (err)=> { phygoLog('DUEL_INVITE_LISTEN', `ERROR: ${err.message}`); console.error('[Phygo] listener undangan duel gagal:', err); });
}

function teardownDuelInviteListener(){
  if(duelInviteUnsub) duelInviteUnsub();
  duelInviteUnsub = null;
  window.duelPendingInviteFromUids = new Set();
  if(typeof onDuelPendingInvitesChanged === 'function') onDuelPendingInvitesChanged();
  hideDuelInviteBanner();
}

function showDuelInviteBanner(invite){
  const phygoLog = window.phygoLog || ((tag, msg)=> console.log(`[${tag}] ${msg}`));
  duelInviteShownFrom = invite.fromUid;
  // PENTING: avatarSvg() dibungkus try/catch sendiri — kalau ini throw
  // (misal fromAvatarId gak cocok format yang diharapkan avatars.js),
  // dulu itu bikin SELURUH fungsi berhenti SEBELUM sempat nge-show
  // banner-nya, dan errornya sering ke-telan diam-diam oleh callback
  // onSnapshot Firestore (gak nyampe ke window.onerror). Sekarang avatar
  // yang gagal di-skip, banner-nya tetap WAJIB muncul.
  try{
    document.getElementById('duelInviteAvatar').innerHTML = avatarSvg(invite.fromAvatarId);
  } catch(e){
    phygoLog('DUEL_INVITE_LISTEN', `avatarSvg GAGAL: ${e.message} (fromAvatarId=${invite.fromAvatarId})`);
  }
  document.getElementById('duelInviteName').textContent = invite.fromUsername || 'User';
  const banner = document.getElementById('duelInviteBanner');
  banner.classList.add('show');
  phygoLog('DUEL_INVITE_LISTEN', 'Banner .show ditambahkan');
  // ===== DIAGNOSTIK SEMENTARA — biar ketahuan pasti kenapa gak keliatan
  // secara visual walau class .show udah nempel. Aman dihapus lagi nanti
  // kalau bannernya udah kebukti muncul normal. =====
  try{
    const rect = banner.getBoundingClientRect();
    const cs = getComputedStyle(banner);
    phygoLog('DUEL_INVITE_LISTEN', `DIAG rect: top=${rect.top.toFixed(0)} left=${rect.left.toFixed(0)} w=${rect.width.toFixed(0)} h=${rect.height.toFixed(0)}`);
    phygoLog('DUEL_INVITE_LISTEN', `DIAG style: display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity} zIndex=${cs.zIndex} transform=${cs.transform}`);
  } catch(e){
    phygoLog('DUEL_INVITE_LISTEN', `DIAG gagal: ${e.message}`);
  }
}

function hideDuelInviteBanner(){
  duelInviteShownFrom = null;
  const banner = document.getElementById('duelInviteBanner');
  if(banner) banner.classList.remove('show');
}

document.addEventListener('DOMContentLoaded', ()=>{
  const acceptBtn = document.getElementById('duelInviteAcceptBtn');
  const declineBtn = document.getElementById('duelInviteDeclineBtn');
  if(acceptBtn) acceptBtn.addEventListener('click', async ()=>{
    if(!duelInviteShownFrom) return;
    const fromUid = duelInviteShownFrom;
    acceptBtn.disabled = true;
    try{ await acceptDuelInvite(fromUid); }
    catch(e){
      console.error('[Phygo] Gagal menerima ajakan duel:', e);
      Swal.fire({ icon:'error', title:'Gagal', text: e.message, background:'#1C2426', color:'#E3E3E6', confirmButtonColor:'var(--error)' });
    } finally { acceptBtn.disabled = false; }
  });
  if(declineBtn) declineBtn.addEventListener('click', async ()=>{
    if(!duelInviteShownFrom) return;
    const fromUid = duelInviteShownFrom;
    hideDuelInviteBanner();
    const me = fbAuth.currentUser;
    if(me){
      db.collection('users').doc(me.uid).collection('duelInvites').doc(fromUid).delete().catch(()=>{});
      db.collection('duelInviteLinks').doc(`${fromUid}_${me.uid}`).set({ status: 'declined' }, { merge: true }).catch(()=>{});
    }
  });
});

// Dipanggil dari social.js (tombol "Ajak Duel" di modal Lihat Profil Teman)
//
// CATATAN DESAIN: pengirim perlu tahu kapan penerima menerima ajakannya.
// Awalnya saya pakai query `duels` (array-contains + where status) buat
// mendeteksi ini, TAPI kombinasi array-contains + where field lain itu
// BUTUH composite index yang belum tentu ke-generate otomatis di project
// kamu — jadi query-nya gagal diam-diam dan pengirim stuck selamanya di
// "Menunggu Balasan...". Sekarang diganti pakai 1 dokumen sinyal langsung
// (duelInviteLinks/{fromUid}_{targetUid}) yang di-dengarkan by ID (bukan
// query), jadi TIDAK butuh index sama sekali.
async function sendDuelInvite(targetUid, targetInfo){
  const me = fbAuth.currentUser;
  if(!me) return;
  const phygoLog = window.phygoLog || ((tag, msg)=> console.log(`[${tag}] ${msg}`));

  phygoLog('DUEL_INVITE', `START: target=${targetInfo?.usernameDisplay||'unknown'}`);

  // Tugas 6: kalau target lagi ada di antrian matchmaking acak (status
  // 'waiting'), tolak undangan di sisi pengirim — jangan sampai target
  // kena 2 alur duel sekaligus (matchmaking acak + ajakan personal).
  try{
    const targetQueueSnap = await db.collection('matchmakingQueue').doc(targetUid).get();
    if(targetQueueSnap.exists && targetQueueSnap.data().status === 'waiting'){
      phygoLog('DUEL_INVITE', 'BLOCKED: target sedang matchmaking');
      Swal.fire({
        icon: 'info', title: 'Sedang Mencari Lawan',
        text: `${targetInfo && targetInfo.usernameDisplay ? targetInfo.usernameDisplay : 'User ini'} lagi mencari lawan lewat matchmaking, gak bisa diajak duel sekarang. Coba lagi nanti.`,
        background:'#1C2426', color:'#E3E3E6', confirmButtonColor:'var(--primary)',
      });
      return;
    }
  } catch(e){
    phygoLog('DUEL_INVITE', `Gagal cek status matchmaking target: ${e.message}`);
    // Kalau pengecekan gagal (misal offline), tetap lanjut kirim undangan
    // seperti biasa — jangan blokir user cuma karena 1 read gagal.
  }

  const linkRef = db.collection('duelInviteLinks').doc(`${me.uid}_${targetUid}`);
  let myProfile;
  try{
    myProfile = await getCurrentUserProfile();
    phygoLog('DUEL_INVITE', `Profile loaded: ${myProfile?.usernameDisplay}`);
    
    phygoLog('DUEL_INVITE', 'Writing invite...');
    await db.collection('users').doc(targetUid).collection('duelInvites').doc(me.uid).set({
      fromUid: me.uid,
      fromUsername: (myProfile && myProfile.usernameDisplay) || 'User',
      fromAvatarId: (myProfile && myProfile.avatarId) || 1,
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    phygoLog('DUEL_INVITE', 'Invite written OK');
    
    phygoLog('DUEL_INVITE', 'Writing link...');
    await linkRef.set({
      fromUid: me.uid, targetUid, status: 'pending', duelId: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    phygoLog('DUEL_INVITE', 'SUCCESS - terkirim');
    
  } catch(e){
    phygoLog('DUEL_INVITE', `ERROR: ${e.code} - ${e.message}`);
    console.error('[Phygo] Gagal mengirim ajakan duel:', e);
    Swal.fire({ icon:'error', title:'Gagal Mengirim Ajakan', text: e.message, background:'#1C2426', color:'#E3E3E6', confirmButtonColor:'var(--error)' });
    return;
  }

  if(typeof closeProfileViewModal === 'function') closeProfileViewModal(false);

  let settled = false;
  const unsub = linkRef.onSnapshot((snap)=>{
    if(!snap.exists || settled) return;
    const d = snap.data();
    phygoLog('DUEL_INVITE', `Link status: ${d.status}`);
    if(d.status === 'accepted' && d.duelId){
      settled = true;
      unsub();
      Swal.close();
      navigate('duelvs', { duelId: d.duelId });
    } else if(d.status === 'declined'){
      settled = true;
      unsub();
      Swal.close();
      Swal.fire({ icon:'info', title:'Ajakan Ditolak', background:'#1C2426', color:'#E3E3E6', confirmButtonColor:'var(--primary)', timer:1800, showConfirmButton:false });
    }
  }, (err)=> {
    phygoLog('DUEL_INVITE', `Listener error: ${err.code}`);
    console.error('[Phygo] listener status ajakan duel gagal:', err);
  });

  await Swal.fire({
    icon: 'info',
    title: 'Menunggu Balasan...',
    text: `Undangan duel dikirim ke ${targetInfo && targetInfo.usernameDisplay ? targetInfo.usernameDisplay : 'teman kamu'}.`,
    showConfirmButton: false,
    showCancelButton: true,
    cancelButtonText: 'Batalkan',
    allowOutsideClick: false,
    background: '#1C2426', color: '#E3E3E6', cancelButtonColor: 'var(--surface-c-high)',
  });

  if(!settled){
    phygoLog('DUEL_INVITE', 'Cancelled');
    unsub();
    db.collection('users').doc(targetUid).collection('duelInvites').doc(me.uid).delete().catch(()=>{});
    linkRef.delete().catch(()=>{});
  }
}

// Dipanggil dari banner ajakan duel (Terima) — bikin dokumen duel dulu
// (LANGKAH 1), BARU bikin 2 dokumen player setelah dokumen duel-nya
// dipastikan ke-commit (LANGKAH 2) — alasan yang sama seperti di
// duelTryMatchTransaction di atas (get() dalam rules gak bisa lihat
// tulisan transaction/operasi yang sama). Ga perlu transaction sama
// sekali di sini karena gak ada pembacaan bersyarat (beda dari matchmaking
// acak yang harus adu cepat rebutan kandidat).
async function acceptDuelInvite(fromUid){
  const me = fbAuth.currentUser;
  if(!me) throw new Error('Anda belum login.');
  const [myProfile, fromSnap] = await Promise.all([
    getCurrentUserProfile(),
    db.collection('users').doc(fromUid).get(),
  ]);
  if(!fromSnap.exists) throw new Error('Profil pengundang tidak ditemukan.');
  const fromProfile = Object.assign({ uid: fromUid }, fromSnap.data());

  const duelRef = db.collection('duels').doc();
  await duelRef.set({
    playerUids: [fromUid, me.uid],
    status: 'starting',
    winnerUid: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    finishedAt: null,
  });
  await Promise.all([
    duelRef.collection('players').doc(me.uid).set(duelInitialPlayerDoc(Object.assign({uid: me.uid}, myProfile))),
    duelRef.collection('players').doc(fromUid).set(duelInitialPlayerDoc(fromProfile)),
  ]);

  // Kasih tahu pengirim (yang lagi nunggu di layar "Menunggu Balasan...")
  // lewat dokumen sinyal — pakai set({merge:true}) buat jaga-jaga kalau
  // dokumennya belum sempat dibuat pengirim (harusnya udah ada duluan).
  db.collection('duelInviteLinks').doc(`${fromUid}_${me.uid}`)
    .set({ status: 'accepted', duelId: duelRef.id }, { merge: true }).catch(()=>{});

  hideDuelInviteBanner();
  db.collection('users').doc(me.uid).collection('duelInvites').doc(fromUid).delete().catch(()=>{});
  navigate('duelvs', { duelId: duelRef.id });
}
