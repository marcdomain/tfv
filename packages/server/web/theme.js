// Applies the saved theme before the page paints. "system" follows the OS.
(() => {
  let t = 'system';
  try { t = localStorage.getItem('teriac-theme') || 'system'; } catch { /* storage blocked */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
})();
