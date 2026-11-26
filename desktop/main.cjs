const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
let win,
  currentPath = null,
  pendingPath = null,
  dirty = false,
  writing = false,
  closePending = false;
const projectFilter = { name: 'Painter project', extensions: ['stlp'] };
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
    win.setTitle(title + ' v' + app.getVersion());
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
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
  register('write', async (kind, name, data) => {
    if (writing) throw Error('A save is already in progress.');
    writing = true;
    let temporary;
    try {
      const project = kind === 'save' || kind === 'saveAs';
      if (!project && kind !== 'export') throw Error('Unknown file type.');
      let dest = kind === 'save' ? currentPath : null;
      if (!dest) {
        const ext = project ? '.stlp' : '.3mf';
        const stem = currentPath ? path.parse(currentPath).name : clean(name);
        const d = await dialog.showSaveDialog(win, {
          title: project ? 'Save painter project' : 'Export 3MF',
          defaultPath: (project && currentPath) || stem + ext,
          filters: [project ? projectFilter : exportFilter],
        });
        if (d.canceled) return null;
        dest = d.filePath;
        if (!dest.toLowerCase().endsWith(ext))
          throw Error('Choose a filename ending in ' + ext + '.');
      }
      temporary = path.join(path.dirname(dest), '.stlp-' + randomUUID() + '.tmp');
      await fs.writeFile(temporary, data, { flag: 'wx' });
      await fs.rename(temporary, dest);
      temporary = null;
      if (project) currentPath = dest;
      return path.basename(dest);
    } finally {
      if (temporary) await fs.rm(temporary, { force: true }).catch(() => {});
      writing = false;
    }
  });
  register('finish-close', (approved) => {
    closePending = false;
    if (approved && !writing) {
      dirty = false;
      win.close();
    }
  });
  win.on('close', (event) => {
    if (writing || dirty) {
      event.preventDefault();
      if (!writing && !closePending) {
        closePending = true;
        win.webContents.send('request-close');
      }
    }
  });
  win.loadFile(path.join(__dirname, '../dist/index.html'));
});
app.on('window-all-closed', () => app.quit());
