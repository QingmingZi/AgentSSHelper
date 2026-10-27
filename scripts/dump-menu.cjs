/**
 * 转储 Electron 默认应用菜单（标签 / role / accelerator），用于排查原生菜单加速键冲突。
 * 用法: npx electron scripts/dump-menu.cjs
 */
const { app, Menu } = require('electron')

app.whenReady().then(() => {
  const menu = Menu.getApplicationMenu()
  const dump = (menu?.items ?? []).map((item) => ({
    label: item.label,
    submenu: (item.submenu?.items ?? []).map((s) => ({
      label: s.label,
      role: s.role,
      accelerator: s.accelerator,
      type: s.type
    }))
  }))
  console.log('APPLICATION_MENU=' + JSON.stringify(dump, null, 2))
  app.exit(0)
})
