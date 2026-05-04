const { app, BrowserWindow, Menu, shell, session } = require('electron')
const path = require('path')

const APP_URL = 'https://friendly-jelly-a45a1d.netlify.app/defiligne'

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'OptiQ Admin',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    show: false,
    backgroundColor: '#1A237E'
  })

  // Fenêtre maximisée au lancement
  win.maximize()
  win.show()

  // Ouvrir les liens externes dans le navigateur système
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  win.loadURL(APP_URL)

  // Vider le cache local au chargement → Notion est la seule source de vérité
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(`
      localStorage.removeItem('optiq_ivs_data');
      localStorage.removeItem('optiq_route_order');
      localStorage.removeItem('optiq_vf');
    `).catch(() => {})
  })

  // Recharger si erreur réseau (Netlify cold start)
  win.webContents.on('did-fail-load', (e, code, desc) => {
    if (code === -2 || code === -105 || code === -106) {
      setTimeout(() => win.loadURL(APP_URL), 3000)
    }
  })

  win.on('page-title-updated', (e) => e.preventDefault())
}

// Menu simplifié
function buildMenu() {
  const template = [
    {
      label: 'OptiQ',
      submenu: [
        { label: 'Actualiser', accelerator: 'F5', click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() },
        { type: 'separator' },
        { label: 'Quitter', accelerator: 'Alt+F4', role: 'quit' }
      ]
    },
    {
      label: 'Affichage',
      submenu: [
        { label: 'Plein écran', accelerator: 'F11', role: 'togglefullscreen' },
        { label: 'Zoom +', accelerator: 'CmdOrCtrl+=', role: 'zoomin' },
        { label: 'Zoom -', accelerator: 'CmdOrCtrl+-', role: 'zoomout' },
        { label: 'Zoom normal', accelerator: 'CmdOrCtrl+0', role: 'resetzoom' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  buildMenu()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
