const API = 'https://video-downloader-api.onrender.com'; // ganti sesuai backend

const q = (id) => document.getElementById(id);
const prepare = q('prepare'), urlIn = q('url');
const opts = q('opts'), fmtSel = q('fmt'), mp3 = q('mp3'),
      dlBtn = q('dl'), bar = q('bar'), pct = q('pct'),
      progWrap = q('progWrap'), msg = q('msg');

let currentURL = '';

prepare.addEventListener('submit', async (e) => {
  e.preventDefault();
  currentURL = urlIn.value.trim();
  msg.textContent = 'Mengambil format…';
  fmtSel.innerHTML = '';
  try {
    const r  = await fetch(`${API}/api/formats?url=${encodeURIComponent(currentURL)}`);
    const jd = await r.json();
    jd.formats.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      opt.text  = `${f.res} • ${f.ext} • ${f.size} MB`;
      fmtSel.appendChild(opt);
    });
    opts.hidden = false;
    msg.textContent = '';
  } catch {
    msg.textContent = 'Gagal mengambil format';
  }
});

dlBtn.addEventListener('click', () => {
  const id   = crypto.randomUUID();
  const qs   = new URLSearchParams({ url: currentURL, id });
  if (mp3.checked) qs.append('audio', '1'); else qs.append('fmt', fmtSel.value);

  /* progress via SSE */
  const es = new EventSource(`${API}/api/progress/${id}`);
  es.onmessage = (ev) => {
    const d = JSON.parse(ev.data);
    if (d.pct !== undefined) {
      progWrap.hidden = false;
      bar.value = d.pct;  pct.textContent = d.pct.toFixed(1) + '%';
    }
    if (d.done) es.close();
  };

  /* mulai download (browser auto-save) */
  window.location = `${API}/api/download?${qs.toString()}`;
});
