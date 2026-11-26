const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
let win,
  currentPath = null,
  pendingPath = null,
  dirty = false,
  writing = false,
  closePending = false;
const projectFilter = { name: 'Painter project', extensions: ['stlp'] };
const paletteFilter = { name: 'STL Painter palette', extensions: ['stlpalette'] };
const maxPaletteBytes = 256 * 1024;
const exportFilter = { name: '3MF model', extensions: ['3mf'] };
const clean = (name) =>
  String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .slice(0, 120) || 'Untitled';
function register(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame)
      throw Error('Unrecognized window.');
    return fn(...args);
  });
}
async function readModelFile(file) {
  const stat = await fs.stat(file);
  if (stat.size > 256 * 1024 * 1024) throw Error('Choose a file smaller than 256 MB.');
  return fs.readFile(file);
}
async function selectModelFile(file) {
  const bytes = await readModelFile(file);
  pendingPath = /\.stlp$/i.test(file) ? file : null;
  return { name: path.basename(file), bytes };
}
async function decide() {
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'Save changes to this project?',
    detail: 'Your latest edits are only in this window.',
    buttons: ['Save project', 'Discard changes', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
  });
  return ['save', 'discard', 'cancel'][response];
}
let fileWriter;
function writeModel(temporary, project, exporting) {
  if (!fileWriter) {
    const entry = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked/dist/file-writer.cjs')
      : path.join(__dirname, '../dist/file-writer.cjs');
    const worker = fileWriter = new Worker(entry);
    worker.once('exit', () => { if (fileWriter === worker) fileWriter = null; });
    worker.unref();
  }
  const worker = fileWriter;
  // The write IPC handler admits one operation at a time.
  return new Promise((resolve, reject) => {
    function cleanup() {
      worker.off('message', complete);
      worker.off('error', fail);
      worker.off('exit', stopped);
    }
    function complete({ error }) {
      cleanup();
      if (error) reject(Error(error));
      else resolve();
    }
    function fail(error) { cleanup(); reject(error); }
    function stopped() { fail(Error('File writer stopped.')); }
    worker.once('message', complete);
    worker.once('error', fail);
    worker.once('exit', stopped);
    const arrays = [project.vertices, project.faces, project.depth, project.paint, project.splits,
      ...(project.stamps ?? []).flatMap(s => [s.pixels, s.source])].filter(Boolean);
    try {
      worker.postMessage({ temporary, project, exporting }, [...new Set(arrays.map(a => a.buffer))]);
    } catch (error) { fail(error); }
  });
}
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 880,
    minHeight: 620,
    show: false,
    backgroundColor: '#e5e9e5',
    title: 'STL Painter v' + app.getVersion(),
    icon: path.join(__dirname, '../dist/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (!win.isDestroyed()) win.setTitle(title + ' v' + app.getVersion());
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  register('open-palette', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Load color palette', properties: ['openFile'], filters: [paletteFilter],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if ((await fs.stat(file)).size > maxPaletteBytes) throw Error('The palette file is too large.');
    return { name: path.basename(file), text: await fs.readFile(file, 'utf8') };
  });
  register('open-launch-file', () => {
    const args = process.argv.slice(process.defaultApp ? 2 : 1);
    const file = args.find((arg) => !arg.startsWith('-') && /\.stlp?$/i.test(arg));
    return file ? selectModelFile(path.resolve(file)) : null;
  });
  register('open', async () => {
    const d = await dialog.showOpenDialog(win, {
      title: 'Open model or painter project',
      properties: ['openFile'],
      filters: [
        { name: 'Models and projects', extensions: ['stl', 'stlp'] },
        projectFilter,
        { name: 'STL model', extensions: ['stl'] },
      ],
    });
    return d.canceled ? null : selectModelFile(d.filePaths[0]);
  });
  register('read-pending-project', () => {
    if (!pendingPath) throw Error('No project is selected for opening.');
    return readModelFile(pendingPath);
  });
  register('accept', () => {
    currentPath = pendingPath;
    pendingPath = null;
  });
  register('dirty', (value) => {
    dirty = !!value;
  });
  register('decide', decide);
  register('confirm-large-model', async (count) => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'Open this large model?',
      detail: 'This model has ' + count.toLocaleString() + ' source triangles. Opening it may take several seconds, and painting or applying stamps may feel slower.',
      buttons: ['Open model', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    return response === 0;
  });
  let destination, choosing = false;
  register('choose-write', async (kind, name) => {
    if (writing || choosing || destination) throw Error('A save is already in progress.');
    choosing = true;
    try {
      const project = kind === 'save' || kind === 'saveAs';
      const palette = kind === 'palette';
      if (!project && !palette && kind !== 'export') throw Error('Unknown file type.');
      let dest = kind === 'save' ? currentPath : null;
      if (!dest) {
        const filter = palette ? paletteFilter : project ? projectFilter : exportFilter;
        const ext = '.' + filter.extensions[0];
        const stem = currentPath ? path.parse(currentPath).name : clean(name);
        const d = await dialog.showSaveDialog(win, {
          title: palette ? 'Save color palette' : project ? 'Save painter project' : 'Export 3MF',
          defaultPath: (project && currentPath) || stem + ext,
          filters: [filter],
        });
        if (d.canceled) return null;
        dest = d.filePath;
        if (!dest.toLowerCase().endsWith(ext))
          throw Error('Choose a filename ending in ' + ext + '.');
      }
      destination = { dest, project, palette };
      return true;
    } finally {
      choosing = false;
    }
  });
  register('cancel-write', () => { destination = null; });
  register('write', async (model) => {
    if (writing || !destination) throw Error('No destination available.');
    const { dest, project, palette } = destination;
    destination = null;
    writing = true;
    const temporary = path.join(path.dirname(dest), '.stlp-' + randomUUID() + '.tmp');
    try {
      if (palette) {
        if (typeof model !== 'string' || Buffer.byteLength(model) > maxPaletteBytes) throw Error('Invalid palette data.');
        await fs.writeFile(temporary, model, { flag: 'wx' });
      } else await writeModel(temporary, model, !project);
      await fs.rename(temporary, dest);
      if (project) currentPath = dest;
      return path.basename(dest);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
      writing = false;
    }
  });
  register('finish-close', (approved) => {
    closePending = false;
    if (approved && !writing && !choosing && !destination) {
      dirty = false;
      win.close();
    }
  });
  win.webContents.on('render-process-gone', () => { destination = null; dirty = false; });
  win.on('close', (event) => {
    if (choosing || destination || writing || dirty) {
      event.preventDefault();
      if (!choosing && !destination && !writing && !closePending) {
        closePending = true;
        win.webContents.send('request-close');
      }
    }
  });
  win.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
