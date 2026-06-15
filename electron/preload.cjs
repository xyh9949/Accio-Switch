const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("accioSwitch", {
  invoke(command, args = {}) {
    return ipcRenderer.invoke(`accio-switch:${command}`, args);
  },
});
