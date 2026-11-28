// From the repository root, run npm run build, then node scripts/record-tool-demos.mjs.
// FFmpeg must be on PATH. Pass a tool slug (e.g. fill-lasso) to refresh just that GIF.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { mixHex } from '../src/mixes.js';
import { readProject, writeProject } from '../src/files.js';

const demos = {
  brush: 'Brush', fill: 'Fill', 'fill-gaps': 'Fill Gaps', 'fill-band': 'Fill Band',
  'fill-lasso': 'Fill Lasso', seam: 'Seam', stamps: 'Stamps', text: 'Text', eraser: 'Eraser',
};
const targets = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(demos);
for (const slug of targets) assert.ok(Object.hasOwn(demos, slug), 'Unknown demo: ' + slug);
const output = path.resolve('docs/demos');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'stlp-demos-'));
let app;
try {
  await fs.mkdir(output, {recursive: true});
  app = await _electron.launch({args: ['.', '--force-device-scale-factor=1', '--user-data-dir=' + path.join(scratch, 'profile')]});
  const page = await app.firstWindow();
  page.setDefaultTimeout(12000);
  await page.locator('#faces').filter({hasText: 'source triangles'}).waitFor();
  await app.evaluate(({BrowserWindow, dialog}) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(1000, 700);
    win.setIgnoreMouseEvents(true);
    dialog.showMessageBox = async () => ({response: 1});
  });
  await page.locator('[aria-controls="palette"]').click();
  // Screenshots omit the system pointer. Show its hotspot and mouse-down state.
  await page.evaluate(() => {
    const overlay = document.createElement('div');
    overlay.id = 'demo-pointer';
    overlay.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:9999;display:none';
    overlay.innerHTML = '<svg width="28" height="32" style="overflow:visible"><circle cx="0" cy="0" r="14" fill="#fff6" stroke="#256944" stroke-width="2" visibility="hidden"/><path d="M0 0 L1 20 L6 15 L11 24 L15 22 L10 13 L18 13 Z" fill="#243c30" stroke="white" stroke-width="1.8" stroke-linejoin="round"/></svg>';
    const key = document.createElement('kbd');
    key.textContent = 'Backspace';
    key.style.cssText = 'position:absolute;left:22px;top:-10px;padding:4px 8px;background:#fff;color:#243c30;border:1px solid #66806c;border-radius:5px;font-size:14px';
    key.hidden = true;
    overlay.append(key);
    document.body.append(overlay);
    window.addEventListener('keydown', e => { if (e.key === 'Backspace') key.hidden = false; }, true);
    for (const event of ['pointermove','pointerdown','pointerup']) {
      window.addEventListener(event, e => {
        overlay.style.display = 'block';
        key.hidden = true;
        overlay.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)';
        overlay.querySelector('circle').setAttribute('visibility', e.buttons ? 'visible' : 'hidden');
      }, true);
    }
  });

  for (const slug of targets) {
    const project = readProject(await fs.readFile('assets/juniper.stlp'));
    if (slug === 'fill-gaps') {
      const parts = [{slot:2,percent:33},{slot:3,percent:67}];
      project.mixes = {4:parts};
      project.palette.push(mixHex(project.palette,parts));
    }
    const selected = slug === 'fill-gaps' ? 4 : slug === 'fill-band' ? 1 : slug === 'eraser' ? 3 : 0;
    Object.assign(project.editingContext, {
      color: project.palette[selected],
      sizes: {brush:{unit:'px',px:slug === 'fill-gaps' ? 13 : 12},stamp:{unit:'px',px:42},text:{unit:'px',px:36}},
      gapWidth: 2.5,
    });
    const projectPath = path.join(scratch, 'Juniper - ' + demos[slug] + '.stlp');
    await fs.writeFile(projectPath, writeProject(project));
    await app.evaluate(({dialog}, file) => {
      dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]});
    }, projectPath);
    await page.locator('#open').click();
    await page.locator('#busy').waitFor({state: 'hidden'});
    await page.locator('#docname').filter({hasText:path.basename(projectPath)}).waitFor();
    await page.locator('#busy').waitFor({state:'hidden'});

    const canvas = page.locator('#viewport > canvas');
    const viewport = await canvas.boundingBox(), clip = await page.locator('main').boundingBox();
    const cx = Math.round(viewport.x + viewport.width / 2), cy = Math.round(viewport.y + viewport.height / 2);
    await page.mouse.move(cx, cy);
    const spots = [[500,431],[523,412],[547,396]];
    if (slug === 'fill-gaps') {
      for (const [x,y] of spots) await page.mouse.click(x,y);
      for (let i=0; i<4; i++) await page.locator('#palette .swatch-lock').nth(i).evaluate(b=>b.click());
    }
    if (slug === 'eraser') {
      await page.mouse.move(550,340);
      await page.mouse.down();
      await page.mouse.move(575,323,{steps:8});
      await page.mouse.up();
    }
    if (slug === 'stamps') {
      // Import a five-point flight star drawn at source resolution into the real stamp library.
      const png = await page.evaluate(() => {
        const c = document.createElement('canvas'); c.width = c.height = 96;
        const ctx = c.getContext('2d'); ctx.translate(48,48);
        ctx.fillStyle = '#E7DDC8';
        ctx.beginPath();
        for(let i=0;i<10;i++) {
          const radius=i%2 ? 18 : 44, angle=i*Math.PI/5 - Math.PI/2;
          const x=radius*Math.cos(angle), y=radius*Math.sin(angle);
          if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.closePath(); ctx.fill();
        return c.toDataURL().split(',')[1];
      });
      await page.locator('[data-tool="Stamps"]').click();
      await page.locator('#image-input').setInputFiles({name:'Flight star.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
      await page.locator('#confirm-import').click();
      await page.locator('.stamp-choice').waitFor();
      await page.locator('[data-tool="Brush"]').click();
    }
    const frames = [], frameDir = path.join(scratch, slug);
    await fs.mkdir(frameDir);
    async function frame(seconds = 0.12) {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const name = frames.length + '.png';
      await page.screenshot({clip, path:path.join(frameDir,name),scale:'css'});
      frames.push({name,seconds});
    }
    async function move(x, y, duration) {
      await page.mouse.move(x, y, {steps: 3});
      await frame(duration);
    }
    async function tap(x, y) {
      await move(x,y);
      await page.mouse.down(); await frame(0.16);
      await page.mouse.up(); await frame(0.24);
    }
    async function button(locator) {
      await locator.scrollIntoViewIfNeeded();
      const b = await locator.boundingBox();
      await tap(b.x + b.width / 2, b.y + b.height / 2);
    }
    async function apply(id) {
      const control = page.locator('#' + id + ':enabled');
      await control.waitFor();
      await frame(0.65);
      await button(control);
      await page.locator('#busy').waitFor({state:'hidden'});
    }
    const tool = page.locator('.toolrail').getByRole('button',{name:demos[slug],exact:true});
    await page.mouse.move(viewport.x + 95, cy);
    await frame(0.55);
    if (slug === 'text') {
      const view = page.locator('#view');
      const box = await view.boundingBox();
      await move(box.x+box.width/2,box.y+box.height/2);
      await view.selectOption({label:'Back'});
      await frame(0.7);
      await page.mouse.move(cx,cy);
      await page.mouse.wheel(0,-120);
      await frame(0.65);
      await page.locator('#text-bold').evaluate(b=>{ if (!b.checked) b.click(); });
    }
    await button(tool);
    if (slug === 'brush' || slug === 'eraser') {
      const erasing = slug === 'eraser';
      const [x0,y0] = erasing ? [548,341] : [474,448];
      await move(x0,y0,0.45);
      await page.mouse.down();
      for (let i=1;i<=12;i++) {
        const t=i/12;
        await move(x0+(erasing?30:68)*t,y0-(erasing?21:17)*t-(erasing?0:7)*Math.sin(t*Math.PI),0.11);
      }
      await page.mouse.up();
    } else if (slug === 'fill') {
      await move(375, 434);
      await page.locator('#fill-highlight').waitFor({state:'visible'});
      await frame(1.2);
      await tap(375, 434);
    } else if (slug === 'fill-gaps') {
      await page.locator('#apply-gaps:enabled').waitFor();
      assert.equal(await page.locator('#gap-count').innerText(),'3 gaps to fill');
      await frame(1.2);
      await apply('apply-gaps');
    } else if (slug === 'fill-band') {
      await tap(370, 463);
      for (let i=1; i<=6; i++) await move(370, 463 + i*2.7);
      await tap(370, 479);
      await apply('apply-band');
    } else if (slug === 'fill-lasso') {
      const points = [[510,398],[533,381],[553,387],[564,407]];
      for (const [x,y] of points) await tap(x,y);
      await page.keyboard.press('Backspace'); await frame(0.8);
      for (const [x,y] of [[560,402],[540,397],[514,408],points[0]]) await tap(x,y);
      await apply('apply-lasso');
    } else if (slug === 'seam') {
      // Draw a closed marking within the orange paint so the seam sets the Fill boundary.
      const origin = [478, 452];
      await tap(...origin);
      await move(498, 433);
      await page.mouse.down();
      for (const [x,y] of [[503,430],[512,424],[523,418],[533,412]]) await move(x,y,0.16);
      await frame(0.5);
      await page.mouse.up();
      await frame(0.35);
      await tap(534,430);
      await tap(507,449);
      await tap(...origin);
      assert.match(await page.locator('#status').innerText(), /Closed seam/);
      await apply('apply-seam');
      await page.locator('.seam-row').filter({hasText:'Seam 4'}).waitFor();
      await button(page.locator('[data-tool="Fill"]'));
      await button(page.locator('label').filter({has:page.locator('#stop-seams')}));
      assert.ok(await page.locator('#stop-seams').isChecked());
      await move(510,435);
      await page.locator('#fill-highlight').waitFor({state:'visible'});
      await frame(0.8);
      await tap(510,435);
      await page.locator('#busy').waitFor({state:'hidden'});
    } else if (slug === 'stamps' || slug === 'text') {
      if (slug === 'stamps') await button(page.locator('.stamp-choice'));
      else {
        await tap(387,425);
        const field = page.locator('#text-content');
        await button(field); await field.fill('');
        for (const letter of 'AIR') { await page.keyboard.type(letter); await frame(0.2); }
      }
      const [x,y]=slug==='stamps' ? [520,413] : [389,430];
      await move(x-12,y-8,0.4);
      await page.mouse.down();
      for (let i=1;i<=6;i++) await move(x-12+i*2,y-8+i*4/3);
      await page.mouse.up();
      await apply('apply');
      assert.match(await page.locator('#status').innerText(), slug === 'text' ? /Applied text/ : /Applied stamp/);
    }
    await page.locator('#undo:enabled').waitFor();
    await move(viewport.x + 100, cy + 100, 1.45);
    if (slug==='fill-gaps') {
      for(const [x,y] of spots){
        await page.keyboard.down('Alt'); await page.mouse.click(x,y); await page.keyboard.up('Alt');
        assert.match(await page.locator('#status').innerText(), /#DE7248/i, 'Restored orange at '+x+','+y);
      }
    }
    const pace = slug === 'fill-lasso' ? 0.74 : 1;
    const manifest = frames.map(f => "file '" + f.name + "'\nduration " + f.seconds * pace).join('\n');
    await fs.writeFile(path.join(frameDir,'frames.txt'),manifest+"\nfile '"+frames.at(-1).name+"'\n");
    const gif = path.join(frameDir, slug + '.gif');
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i','frames.txt',
      '-filter_complex','scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      '-fps_mode','vfr','-loop','0',gif],{cwd:frameDir});
    await fs.copyFile(gif,path.join(output,'juniper-'+slug+'.gif'));
    console.log(slug, frames.length+' frames', Math.round((await fs.stat(gif)).size/1024)+' KiB');
  }
} finally {
  if (app) {
    await app.evaluate(({app})=>app.exit(0)).catch(()=>{});
    await app.close().catch(()=>{});
  }
  await fs.rm(scratch,{recursive:true,force:true,maxRetries:3});
}
