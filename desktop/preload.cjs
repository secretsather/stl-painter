const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('painterFiles', {
  open: () => ipcRenderer.invoke('open'),
  openPalette: () => ipcRenderer.invoke('open-palette'),
  openLaunchFile: () => ipcRenderer.invoke('open-launch-file'),
  openSample: () => ipcRenderer.invoke('open-sample'),
  readPendingProject: () => ipcRenderer.invoke('read-pending-project'),
  accept: () => ipcRenderer.invoke('accept'),
  dirty: (value) => ipcRenderer.invoke('dirty', value),
  decide: () => ipcRenderer.invoke('decide'),
  confirmLargeModel: (count) => ipcRenderer.invoke('confirm-large-model', count),
  chooseWrite: (kind, name) => ipcRenderer.invoke('choose-write', kind, name),
  write: async model => {
    try { return await ipcRenderer.invoke('write', model); }
    catch (error) {
      await ipcRenderer.invoke('cancel-write');
      throw error;
    }
  },
  onClose: (fn) =>
    ipcRenderer.on('request-close', async () => {
      let ok = false;
      try {
        ok = await fn();
      } finally {
        await ipcRenderer.invoke('finish-close', ok);
      }
    }),
});
