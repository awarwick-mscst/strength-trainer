'use strict';
const { contextBridge, ipcRenderer } = require('electron');
function storage(method, ...args) {
  const result = ipcRenderer.sendSync('strength-storage', method, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
contextBridge.exposeInMainWorld('StrengthDesktop', {
  getItem: key => storage('getItem', key),
  setItem: (key, value) => storage('setItem', key, value),
  removeItem: key => storage('removeItem', key),
  commitWorkout: (key, value) => storage('commitWorkout', key, value),
  exportExcel: (filename, bytes) => ipcRenderer.invoke('strength-export', filename, bytes),
});
