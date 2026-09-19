"use strict";

// Terapkan tema tersimpan sedini mungkin (masih ketutup #appLoader, jadi ga ada "flash" warna)
setTheme(getTheme());

// Kutipan fisika di Home berganti tiap kali aplikasi dibuka (lihat juga
// bumpQuoteIndex() yang dipanggil tiap naik level, di screens.js) — ini
// SENGAJA tetap dipanggil di sini (bukan per-akun, aman dipakai bersama).
bumpQuoteIndex();

// CATATAN: bumpStreak() TIDAK lagi dipanggil di sini — sekarang dipanggil
// dari goToDashboardAfterAuth() (auth-ui.js) SETELAH progres akun yang
// login berhasil di-hydrate dari Firestore (lihat state.js & auth.js untuk
// detail lengkapnya kenapa).

// Init tombol exit wizard (butuh els dari state.js + svgIcon dari helpers.js + goToDashboard dari screens.js)
if(els.wizExit){ els.wizExit.innerHTML = svgIcon('doorExit'); els.wizExit.onclick = goToDashboard; }

// Init tombol exit wizard Sejarah
if(hwEls.exit){ hwEls.exit.innerHTML = svgIcon('doorExit'); hwEls.exit.onclick = closeHistoryWizard; }

// ===== Ikon statis Bottom Navigation (berubah: navSettings → navProfile) =====
document.getElementById('navHome').querySelector('.bn-icon').innerHTML = svgIcon('home');
document.getElementById('navLevel').querySelector('.bn-icon').innerHTML = svgIcon('mapRoute');
document.getElementById('navHistory').querySelector('.bn-icon').innerHTML = svgIcon('history');
document.getElementById('navProfile').querySelector('.bn-icon').innerHTML = svgIcon('user');
document.querySelectorAll('.bn-item').forEach(btn=>{
  btn.addEventListener('click', ()=> navigate(btn.dataset.screen, {}, true));
});

// ===== Ikon & aksi statis di Pengaturan (Settings screen terpisah) =====
document.getElementById('settingsBackBtn').innerHTML = svgIcon('arrowBack');
document.getElementById('settingsBackBtn').addEventListener('click', ()=>{
  navigate('profile', {}, false);
});

document.getElementById('btnAppInfo').querySelector('.settings-row-icon').innerHTML = svgIcon('info');
document.getElementById('btnEditProfile').querySelector('.settings-row-icon').innerHTML = svgIcon('edit');
document.getElementById('btnLogout').querySelector('.settings-row-icon').innerHTML = svgIcon('logout');
document.querySelectorAll('.settings-row-chevron').forEach(el => el.innerHTML = svgIcon('chevronRight'));

document.getElementById('btnAppInfo').addEventListener('click', ()=> navigate('appinfo', {}, false));
document.getElementById('btnEditProfile').addEventListener('click', openEditProfileModal);
document.getElementById('btnLogout').addEventListener('click', confirmLogout);

// ===== Fitur Sosial — sambungkan tombol statis modal (Tambah Teman, Undangan,
// Lihat Profil, Edit Profil). Modal-modal ini ada di luar #app (langsung anak
// <body>) supaya posisinya fixed & selalu di atas layar apa pun yang aktif.
initAddFriendModalOnce();
initInboxModalOnce();
initProfileViewModalOnce();
initEditProfileModalOnce();
initAvatarPickerModalOnce();

// ===== Halaman "Tentang Aplikasi" =====
document.getElementById('btnAppInfoBack').innerHTML = svgIcon('arrowBack');
document.getElementById('btnAppInfoBack').addEventListener('click', ()=> navigate('settings', {}, false));

// ===== Halaman "Tingkatan Rank" =====
document.getElementById('rankInfoBackBtn').innerHTML = svgIcon('arrowBack');
document.getElementById('rankInfoBackBtn').addEventListener('click', ()=> navigate('profile', {}, false));

// ===== Theme Swatches =====
document.querySelectorAll('#themeGrid .theme-swatch').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    setTheme(btn.dataset.theme);
    document.querySelectorAll('#themeGrid .theme-swatch').forEach(el => el.classList.toggle('active', el === btn));
  });
});

// ===== Mode Senyap (di Settings screen) — lihat js/sound.js =====
const muteToggle = document.getElementById('muteToggle');
if(muteToggle){
  muteToggle.checked = phygoSound.isMuted();
  muteToggle.addEventListener('change', (e)=>{
    phygoSound.setMuted(e.target.checked);
  });
}

// ===== Privacy Toggle (di Settings screen) =====
const privacyToggle = document.getElementById('privacyToggle');
if(privacyToggle){
  privacyToggle.addEventListener('change', (e)=>{
    savePrivacySetting(e.target.checked);
  });
}

// Entry point — dijalankan setelah semua module lain ke-load.
// Ga langsung ke home: initAuthGate() cek dulu status login (lihat
// js/auth-ui.js), baru mutusin tampilin layar auth atau dashboard.
initAuthGate();

// Loading screen awal: dashboard sebenarnya udah dirender di atas (synchronous),
// tapi kita tetap kasih jeda kecil + tunggu font siap sebelum loader-nya
// di-fade-out, biar transisinya mulus dan gak "ngedip"/patah pas pertama kali dibuka.
//
// FIX BUG "LOGIN SCREEN NGEDIP SEBENTAR PAS BUKA APP LAGI": sebelumnya loader
// ini cuma nunggu `minDelay` + `fontsReady`, TIDAK nunggu status login
// selesai dicek (fbAuth.onAuthStateChanged). Kalau pengecekan sesi login
// belum selesai pas loader keburu hilang, yang kelihatan sesaat adalah
// form login (tampilan default #screen-auth), baru pindah ke dashboard
// begitu status login-nya diketahui — jadi kelihatan "ngedip". Sekarang
// loader ini IKUT menunggu `window.authGateReady` (dibuat di auth-ui.js,
// baru resolve setelah status login benar-benar diketahui pasti), jadi
// begitu loader hilang, layar yang tampil sudah pasti benar sejak awal.
(function initialLoadFadeOut(){
  const loader = document.getElementById('appLoader');
  if(!loader) return;
  const minDelay = new Promise(res => setTimeout(res, 400));
  const fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
  const authReady = window.authGateReady || Promise.resolve();
  Promise.all([minDelay, fontsReady, authReady]).then(() => {
    requestAnimationFrame(() => {
      loader.classList.add('hide');
      setTimeout(() => loader.remove(), 400);
    });
  });
})();
