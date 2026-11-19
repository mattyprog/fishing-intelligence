/* Applica il tema prima del primo disegno, per evitare il lampo di colore sbagliato.
   Script classico e minuscolo: la logica completa del tema sta in js/app.js. */
(function () {
  var theme = 'auto';
  try {
    var raw = localStorage.getItem('fi2_prefs');
    if (raw) theme = JSON.parse(raw).theme || 'auto';
    else {
      var old = localStorage.getItem('fi_prefs_v1');
      if (old) theme = JSON.parse(old).theme === 'sunlight' ? 'light' : 'auto';
    }
  } catch (e) {
    theme = 'auto';
  }
  if (theme !== 'dark' && theme !== 'light') {
    var hour = new Date().getHours();
    var prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    theme = prefersLight && hour >= 7 && hour < 18 ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
