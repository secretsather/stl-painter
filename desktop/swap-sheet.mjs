import { pauseWindow, suggestedPauseHeight } from '../src/swap-plan.js';

const escapeHtml = text => String(text).replace(/[&<>"']/g, ch =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[ch]);

export function swapSheetHtml(filename, {plan, bottom, palette}) {
  function spool(index) {
    const hex = palette[index];
    if (!/^#[a-f\d]{6}$/i.test(hex)) throw Error('Invalid filament color in the swap plan.');
    return '<span class="spool"><i style="background:' + hex + '"></i>Color ' +
      (index+1) + ' <small>' + hex.toUpperCase() + '</small></span>';
  }
  const loads = plan.heads.map(([first,...later], i) =>
    '<tr><td>' + (i+1) + '</td><td>' + spool(first) + '</td><td>' +
    (later.map(spool).join('<br>') || '—') + '</td></tr>').join('');
  const pauses = plan.pauses.map((pause, i) =>
    '<tr><td>' + (i+1) + '</td><td>' + suggestedPauseHeight(pause,bottom).toFixed(3) +
    ' mm</td><td>' + pauseWindow(pause,bottom) + '</td><td>' +
    pause.swaps.map(({head,from,to}) => '<div class="change">Head ' + (head+1) +
      ' &nbsp; ' + spool(from) + ' → ' + spool(to) + '</div>').join('') + '</td></tr>').join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <title>Toolhead swap plan</title><style>
      *{box-sizing:border-box}body{margin:0;color:#24372c;font:10pt/1.45 "Segoe UI",sans-serif}
      header{border-bottom:2px solid #497052;padding-bottom:12pt}
      h1{font-size:23pt;line-height:1.15;margin:0 0 4pt}header p{margin:0;overflow-wrap:anywhere}
      h2{font-size:14pt;margin:16pt 0 5pt;break-after:avoid}p{margin:5pt 0}
      table{width:100%;border-collapse:collapse}thead{display:table-header-group}
      th{text-align:left;background:#edf2eb}td,th{padding:5pt 6pt;border-bottom:1px solid #cbd5cc;vertical-align:top}
      tr{break-inside:avoid}.spool{display:inline-block;white-space:nowrap}i{display:inline-block;width:9pt;height:9pt;
      border:1px solid #778478;border-radius:2pt;vertical-align:-1pt;margin-right:3pt}small{color:#516257}
      .change+.change{margin-top:4pt}.window{width:21%}
    </style></head><body>
    <header><h1>Toolhead swap plan</h1><p>${escapeHtml(filename)}</p></header>
    <h2>Load before printing</h2><p>Match each filament slot in the 3MF to the same numbered printer head.
    The slicer preview uses the starting spool colors for the entire print.</p>
    <table><thead><tr><th>Head / slot</th><th>Load first</th><th>Also uses</th></tr></thead><tbody>${loads}</tbody></table>
    <h2>Scheduled pauses</h2>
    ${pauses ? `<p>Heights are approximate millimeters above the model base in its exported orientation.
    In Snapmaker Orca Preview, confirm a layer break in each window after the outgoing color finishes and before the incoming color starts.
    The 3MF includes a suggested pause in each window. Check the actual pause layers, infill, supports and paint penetration.
    Adjust markers and re-slice if needed.</p>
    <p>At each pause, change the spools listed for that pause, purge until the new color runs clean, then resume.</p>
    <table><thead><tr><th>Pause</th><th>3MF marker</th><th class="window">Height window</th><th>Spool changes</th></tr></thead><tbody>${pauses}</tbody></table>` :
    '<p>No spool changes are needed for the painted model.</p>'}
    </body></html>`;
}
