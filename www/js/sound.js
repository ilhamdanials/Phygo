"use strict";

// =====================================================================
// SOUND — efek suara Phygo (Survival, Duel, Kuis Ujian Akhir Level 1-3)
//
// File mp3 ditaruh di: www/assets/sounds/  (nama file HARUS sama persis
// dengan tabel SOUND_FILES di bawah).
//
// Pakai Web Audio API (bukan <audio> biasa) supaya delay-nya kecil —
// suara langsung bunyi pas opsi diklik, gak telat. Kalau Web Audio gagal
// di device tertentu, otomatis fallback ke <audio> biasa.
//
// API yang dipakai file lain:
//   phygoSound.play('correct' | 'wrong' | 'wrongLast' | 'countdown' | 'gameover' | 'win')
//   phygoSound.stop(nama) / phygoSound.stopAll()
//   phygoSound.isMuted() / phygoSound.setMuted(true|false)
// =====================================================================

const SOUND_BASE = 'assets/sounds/';
const SOUND_MUTE_KEY = 'phygo_muted';

const SOUND_FILES = {
  correct:   'opsi-benar.mp3',                // opsi benar (1 dtk)
  wrong:     'opsi-salah.mp3',                // opsi salah (1 dtk)
  wrongLast: 'opsi-salah-nyawa-terakhir.mp3', // opsi salah pas nyawa terakhir (1 dtk)
  countdown: 'countdown.mp3',                 // countdown 3-2-1-MULAI (4 dtk)
  gameover:  'game-over.mp3',                 // game over survival / kalah duel (1 dtk)
  win:       'menang.mp3',                    // menang duel / rekor baru survival
};

// Jarak antar angka countdown (ms). 4 langkah (3, 2, 1, MULAI!) x 1000 ms
// = 4 detik = durasi countdown.mp3. Dipakai survival.js & duel.js supaya
// tampilan layar & suara selalu seirama. Kalau ketukan di file suaramu
// ternyata beda, cukup ubah angka ini.
const COUNTDOWN_STEP_MS = 1000;

const phygoSound = (function(){
  let muted = false;
  try{ muted = localStorage.getItem(SOUND_MUTE_KEY) === '1'; }catch(e){}

  const Ctx = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  try{ if(Ctx) ctx = new Ctx(); }catch(e){ ctx = null; }

  const buffers = {};   // nama -> AudioBuffer (hasil decode)
  const playing = {};   // nama -> source yang lagi bunyi
  const fallback = {};  // nama -> <audio> (cadangan)

  function url(name){ return SOUND_BASE + SOUND_FILES[name]; }

  function decode(arrayBuf){
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuf, resolve, reject); // callback utk WebView lama
      if(p && p.then) p.then(resolve, reject);                  // promise utk WebView baru
    });
  }

  function preload(){
    if(!ctx) return;
    Object.keys(SOUND_FILES).forEach(name => {
      fetch(url(name))
        .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(decode)
        .then(buf => { buffers[name] = buf; })
        .catch(e => console.warn('[Phygo] Gagal load sound "' + name + '", pakai fallback:', e));
    });
  }

  // Browser/WebView baru ngizinin audio setelah ada sentuhan pertama dari user.
  function unlock(){
    if(ctx && ctx.state === 'suspended') ctx.resume().catch(()=>{});
  }
  ['pointerdown', 'touchstart', 'keydown'].forEach(ev =>
    document.addEventListener(ev, unlock, { passive: true })
  );

  function stop(name){
    const src = playing[name];
    if(src){ try{ src.stop(); }catch(e){} delete playing[name]; }
    const a = fallback[name];
    if(a){ try{ a.pause(); a.currentTime = 0; }catch(e){} }
  }

  function stopAll(){
    Object.keys(SOUND_FILES).forEach(stop);
  }

  function play(name){
    if(muted || !SOUND_FILES[name]) return;
    stop(name); // biar gak numpuk kalau kepencet cepat berkali-kali

    if(ctx && buffers[name]){
      unlock();
      try{
        const src = ctx.createBufferSource();
        src.buffer = buffers[name];
        src.connect(ctx.destination);
        src.onended = () => { if(playing[name] === src) delete playing[name]; };
        playing[name] = src;
        src.start(0);
        return;
      }catch(e){ /* lanjut ke fallback */ }
    }

    try{
      if(!fallback[name]) fallback[name] = new Audio(url(name));
      fallback[name].currentTime = 0;
      const p = fallback[name].play();
      if(p && p.catch) p.catch(()=>{});
    }catch(e){}
  }

  function setMuted(v){
    muted = !!v;
    try{ localStorage.setItem(SOUND_MUTE_KEY, muted ? '1' : '0'); }catch(e){}
    if(muted) stopAll();
  }

  // App di-minimize -> matiin suara yang lagi jalan.
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'hidden') stopAll();
  });

  preload();

  return { play, stop, stopAll, isMuted: () => muted, setMuted };
})();

