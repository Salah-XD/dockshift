const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  send: (channel, data) => {
    const allowedSendChannels = [
      'dock:setExpanded',
    ];
    if (allowedSendChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  
  on: (channel, callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  invoke: (channel, data) => {
    const allowed = [
      // Clipboard
      'clipboard:copy',
      'clipboard:getHistory',
      'clipboard:deleteItem',
      'clipboard:clearAll',
      'clipboard:copyItem',
      // Notifications
      'notify',
      // Workspace
      'workspace:save',
      'workspace:list',
      'workspace:restore',
      'workspace:delete',
      // Dock
      'dock:applyLayout',
      'dock:setExpanded',
      'dock:setMouseIgnore',
      'dock:activate',
      'dock:deactivate',
      'dock:layout:get',
      'dock:layout:save',
      // Notes
      'notes:list',
      'notes:save',
      'notes:delete',
      'notes:togglePin',
      // AI
      'ai:status',
      'ai:providers',
      'ai:listModels',
      'ai:chat',
      'ai:chatStream',
      'ai:transcribe',
      // Voice-to-Text (provider-agnostic transcription)
      'transcription:providers',
      'transcription:transcribe',
      'transcription:test',
      // On-device speech model management (Vosk WASM)
      'stt:voskModel:status',
      'stt:voskModel:download',
      'stt:voskModel:remove',
      // Secrets (encrypted API key storage — names only cross this boundary)
      'secrets:set',
      'secrets:has',
      'secrets:delete',
      'secrets:list',
      // Screenshots
      'screenshot:capture',
      'screenshot:getSources',
      'screenshot:getHistory',
      'screenshot:delete',
      'screenshot:copy',
      'screenshot:open',
      // Settings
      'settings:get',
      'settings:set',
      'settings:hotkey:set',
      // Updater
      'updater:status',
      'updater:check',
      'updater:install',
      'app:getVersion',
      'app:openExternal',
      // Analytics (opt-in heartbeat)
      'analytics:setEnabled',
      'analytics:getStatus',
      // Launcher
      'launcher:search',
      'launcher:open',
      'app:getIcon',
      // Welcome / first-run
      'welcome:complete',
      // Terminal
      'terminal:spawn',
      'terminal:ensure',
      'terminal:getBuffer',
      'terminal:write',
      'terminal:resize',
      'terminal:openLink',
      // Browser
      'browser:getBookmarks',
      'browser:saveBookmark',
      'browser:getHistory',
      'browser:addHistory',
      // Windows shell integration (context menu)
      'shell:rendererReady',
      'shell:integrationStatus',
      'shell:install',
      'shell:uninstall',
    ];
    if (allowed.includes(channel)) {
      return ipcRenderer.invoke(channel, data);
    }
  },
  onNotification: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('show-notification', handler);
    return () => ipcRenderer.removeListener('show-notification', handler);
  },
  onDockLayoutRestore: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('workspace:dockLayoutRestore', handler);
    return () => ipcRenderer.removeListener('workspace:dockLayoutRestore', handler);
  },
  // Main process tells the renderer the window lost focus, so any open panel
  // should collapse (click-outside-to-close).
  onDockBlur: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('dock:blurClose', handler);
    return () => ipcRenderer.removeListener('dock:blurClose', handler);
  },
  // Main process tells the renderer which screen edge the dock should align to
  // (changed from Settings, or applied at startup).
  onDockPosition: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('dock:positionChanged', handler);
    return () => ipcRenderer.removeListener('dock:positionChanged', handler);
  },
  // Auto-updater state pushes — `status` transitions plus download progress.
  // The renderer renders straight from this stream; one subscription, one
  // unsubscribe. Latest snapshot also available via `updater:status` invoke.
  onUpdaterState: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('updater:state', handler);
    return () => ipcRenderer.removeListener('updater:state', handler);
  },
  onClipboardUpdate: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('clipboard:newItem', handler);
    return () => ipcRenderer.removeListener('clipboard:newItem', handler);
  },
  onTerminalData: (callback) => {
    const handler = (event, data) => callback(data);
    ipcRenderer.on('terminal:onData', handler);
    return () => ipcRenderer.removeListener('terminal:onData', handler);
  },
  // Fired when the shell process exits — the renderer shows a "session ended"
  // state with a Restart action.
  onTerminalExit: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('terminal:onExit', handler);
    return () => ipcRenderer.removeListener('terminal:onExit', handler);
  },
  // Streaming AI chat: main pushes chunk/done/error events, each tagged with
  // the streamId returned by the ai:chatStream invoke. One subscription wires
  // up all three; the returned function unsubscribes them together.
  onAiStream: (callbacks) => {
    const onChunk = (event, data) => callbacks.onChunk?.(data);
    const onDone = (event, data) => callbacks.onDone?.(data);
    const onError = (event, data) => callbacks.onError?.(data);
    ipcRenderer.on('ai:streamChunk', onChunk);
    ipcRenderer.on('ai:streamDone', onDone);
    ipcRenderer.on('ai:streamError', onError);
    return () => {
      ipcRenderer.removeListener('ai:streamChunk', onChunk);
      ipcRenderer.removeListener('ai:streamDone', onDone);
      ipcRenderer.removeListener('ai:streamError', onError);
    };
  },
  clipboard: {
    copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  },
  notify: (title, body) => ipcRenderer.invoke('notify', { title, body }),
});
