'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('veilDesktop', {
  getSettings: () => ipcRenderer.invoke('veil:get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('veil:save-settings', settings),
  listPairings: () => ipcRenderer.invoke('veil:list-pairings'),
  addPairing: (pairing) => ipcRenderer.invoke('veil:add-pairing', pairing),
  removePairing: (room) => ipcRenderer.invoke('veil:remove-pairing', room),
  renamePairing: (room, name) => ipcRenderer.invoke('veil:rename-pairing', room, name),
  clearPairings: () => ipcRenderer.invoke('veil:clear-pairings'),
  accountReadJson: (name) => ipcRenderer.invoke('veil:account-read-json', name),
  accountWriteJson: (name, text) => ipcRenderer.invoke('veil:account-write-json', name, text),
  accountReadFile: (relative) => ipcRenderer.invoke('veil:account-read-file', relative),
  accountWriteFile: (relative, data) => ipcRenderer.invoke('veil:account-write-file', relative, data),
  accountDeleteFile: (relative) => ipcRenderer.invoke('veil:account-delete-file', relative),
  accountFolder: () => ipcRenderer.invoke('veil:account-folder'),
  accountOpenFolder: () => ipcRenderer.invoke('veil:account-open-folder'),
  openExternal: (url) => ipcRenderer.invoke('veil:open-external', url),
  notify: (payload) => ipcRenderer.invoke('veil:notify', payload),
  setBadge: (count) => ipcRenderer.invoke('veil:set-badge', count),
  attention: () => ipcRenderer.invoke('veil:attention'),
  onOpenSettings: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('veil:open-settings', listener);
    return () => ipcRenderer.removeListener('veil:open-settings', listener);
  },
  onOpenSession: (callback) => {
    const listener = (_event, room) => callback(room);
    ipcRenderer.on('veil:open-session', listener);
    return () => ipcRenderer.removeListener('veil:open-session', listener);
  }
});
