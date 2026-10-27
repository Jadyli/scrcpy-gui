import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { ArtifactService } from '../src/main/artifactService'
import type { ArtifactRecord, ScrcpySessionEvent } from '../src/shared/types'

const state = vi.hoisted(() => ({
  ready: false, directory: '',
  sessionListener: undefined as ((event: ScrcpySessionEvent) => void) | undefined,
  writeText: vi.fn(), showItemInFolder: vi.fn(),
  appListeners: new Map<string, (...args: any[]) => any>(),
  ipcHandlers: new Map<string, (...args: any[]) => any>(),
  inputListeners: new Map<string, (...args: any[]) => any>(),
  resolveReady: undefined as (() => void) | undefined,
  window: undefined as any,
  showMessageBox: vi.fn(async (_window: unknown, _options: unknown) => ({ response: 0, checkboxChecked: false })),
  register: vi.fn(), listDevices: vi.fn(async (_runtime: unknown) => ({ ok: true, data: [
    { serial: 'PHONE', model: 'Pixel', product: 'pixel', device: 'pixel', state: 'device', connection: 'usb' }
  ] }))
}))

vi.mock('electron', () => ({
  app: {
    on: (name: string, callback: (...args: any[]) => any) => state.appListeners.set(name, callback),
    whenReady: () => new Promise<void>(resolve => { state.resolveReady = resolve }),
    isReady: () => state.ready, isPackaged: false,
    getPath: () => state.directory, getAppPath: () => state.directory
  },
  BrowserWindow: class {
    focused = true
    webContents = {
      mainFrame: { url: '' }, send: vi.fn(),
      on: (name: string, callback: (...args: any[]) => any) => state.inputListeners.set(name, callback),
      setWindowOpenHandler: vi.fn(), getURL: () => this.webContents.mainFrame.url
    }
    constructor() { state.window = this }
    setMenuBarVisibility() {}
    once() {}
    on() {}
    show() {}
    focus() {}
    isDestroyed() { return false }
    isFocused() { return this.focused }
    async loadFile(path: string) { this.webContents.mainFrame.url = pathToFileURL(path).toString() }
  },
  clipboard: { writeText: state.writeText }, dialog: { showMessageBox: state.showMessageBox },
  globalShortcut: { register: state.register },
  ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => state.ipcHandlers.set(name, callback) },
  Menu: { buildFromTemplate: () => ({}) },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  session: { defaultSession: { setPermissionRequestHandler() {} } }, shell: { showItemInFolder: state.showItemInFolder },
  Tray: class { setToolTip() {} setContextMenu() {} on() {} }
}))

vi.mock('../src/main/processes', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/main/processes')>(), listDevices: state.listDevices,
  subscribeScrcpySessionEvents: (listener: (event: ScrcpySessionEvent) => void) => { state.sessionListener = listener; return () => {} }
}))

afterAll(async () => {
  vi.restoreAllMocks()
  if (state.directory) await rm(state.directory, { recursive: true, force: true })
})

describe('main-process file opening and shortcut boundaries', () => {
  it('waits for migrated runtime configuration before processing a cold-start APK', async () => {
    state.directory = await mkdtemp(join(tmpdir(), 'scrcpy-main-open-'))
    const apk = join(state.directory, 'example.apk')
    await writeFile(apk, 'mock APK; never installed')
    await import('../src/main/main.js')
    state.appListeners.get('open-file')!({ preventDefault() {} }, apk)
    expect(state.listDevices).not.toHaveBeenCalled()
    state.ready = true
    state.resolveReady!()
    await vi.waitFor(() => expect(state.window).toBeDefined())
    expect(state.listDevices).not.toHaveBeenCalled()
    expect(state.register).not.toHaveBeenCalled()
    const window = state.window
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    await state.ipcHandlers.get('config:load')!(event,
      JSON.stringify({ runtime: { scrcpyPath: '/custom/scrcpy' } }), 'en')
    await vi.waitFor(() => expect(state.showMessageBox).toHaveBeenCalled())
    expect(state.listDevices).toHaveBeenCalledWith({ scrcpyPath: '/custom/scrcpy' })
    expect(state.showMessageBox.mock.calls[0][1]).toMatchObject({ defaultId: 0, cancelId: 0, checkboxChecked: false })
  })

  it('rejects config loading from an untrusted sender', async () => {
    await expect(state.ipcHandlers.get('config:load')!({ sender: {}, senderFrame: {} }, '', 'en'))
      .rejects.toThrow('untrusted renderer')
  })

  it('does not dispatch device shortcuts from a hidden or untrusted window', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const event = { preventDefault: vi.fn() }
    const input = { type: 'keyDown', key: 'c', meta: true, shift: true, control: false, alt: false }
    const listener = state.inputListeners.get('before-input-event')!
    const window = state.window
    window.webContents.send.mockClear()
    window.focused = false
    listener(event, input)
    expect(window.webContents.send).not.toHaveBeenCalled()
    window.focused = true
    const url = window.webContents.mainFrame.url
    window.webContents.mainFrame.url = 'https://untrusted.example/'
    listener(event, input)
    expect(window.webContents.send).not.toHaveBeenCalled()
    window.webContents.mainFrame.url = url
    listener(event, input)
    expect(window.webContents.send).toHaveBeenCalledWith('app:screenshot-shortcut', 'copy')
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })
})


describe('stopped recording handoff', () => {
  const artifact: ArtifactRecord = {
    id: 'recording', kind: 'recording', status: 'available', name: 'clip.mp4',
    path: '/tmp/recording folder/clip.mp4', size: 1024, metadata: {},
    createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z'
  }
  const event: ScrcpySessionEvent = {
    type: 'state', message: 'Stopped', timestamp: '2026-10-27T00:00:00Z',
    session: { id: 'session', serialAtLaunch: 'PHONE', scene: 'record-only', state: 'stopped',
      stopReason: 'user', args: [], createdAt: '2026-10-27T00:00:00Z' }
  }

  it('waits for the finalized artifact before revealing and copying its exact path', async () => {
    let finish!: (value: ArtifactRecord) => void
    const register = vi.spyOn(ArtifactService.prototype, 'registerRecording')
      .mockImplementation(() => new Promise(resolve => { finish = resolve }))
    state.writeText.mockClear()
    state.showItemInFolder.mockClear()
    state.sessionListener!(event)
    expect(state.writeText).not.toHaveBeenCalled()
    expect(state.showItemInFolder).not.toHaveBeenCalled()
    finish(artifact)
    await vi.waitFor(() => expect(state.showItemInFolder).toHaveBeenCalledWith(artifact.path))
    expect(state.writeText).toHaveBeenCalledExactlyOnceWith(artifact.path)
    register.mockRestore()
  })

  it.each(['missing', 'incomplete', 'empty', 'automatic', 'quit', 'screen', 'failed'])(
    'does not open Finder or replace the clipboard for %s recordings', async (scenario) => {
      const record = { ...artifact }
      const session = { ...event.session }
      if (scenario === 'missing' || scenario === 'incomplete') record.status = scenario
      if (scenario === 'empty') record.size = 0
      if (scenario === 'automatic') session.stopReason = 'process-exit'
      if (scenario === 'quit') session.stopReason = 'app-quit'
      if (scenario === 'screen') session.scene = 'screen'
      if (scenario === 'failed') session.state = 'failed'
      const register = vi.spyOn(ArtifactService.prototype, 'registerRecording').mockResolvedValue(record)
      state.writeText.mockClear()
      state.showItemInFolder.mockClear()
      state.sessionListener!({ ...event, session })
      await Promise.resolve()
      expect(state.showItemInFolder).not.toHaveBeenCalled()
      expect(state.writeText).not.toHaveBeenCalled()
      register.mockRestore()
    })
})
