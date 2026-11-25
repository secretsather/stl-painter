const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('painterFiles', {
  open: () => ipcRenderer.invoke('open'),
  readPendingProject: () => ipcRenderer.invoke('read-pending-project'),
  accept: () => ipcRenderer.invoke('accept'),
  dirty: (value) => ipcRenderer.invoke('dirty', value),
  decide: () => ipcRenderer.invoke('decide'),
  confirmLargeModel: (count) => ipcRenderer.invoke('confirm-large-model', count),
  write: (kind, name, data) => ipcRenderer.invoke('write', kind, name, data),
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
