import { Menu, Tray, nativeImage, shell, type MenuItemConstructorOptions } from "electron";
import { LOG_DIR, MODELS_DIR } from "../shared/paths";
import type { AppConfig } from "../shared/config";
import type { Logger } from "../shared/log";
import type { Bridge } from "./bridge";
import { TRAY_ICON_DATA_URL } from "./tray-icon";

export interface TrayOptions {
  bridge: Bridge;
  getConfig: () => AppConfig;
  getWindow: () => Electron.BrowserWindow | null;
  show: () => void;
  quit: () => void;
  logger: Logger;
}

export interface TrayHandle {
  tray: Tray;
  refresh: () => void;
  destroy: () => void;
}

export function createTray(options: TrayOptions): TrayHandle {
  const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  const tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip("Live2D Agent");

  const command = (value: Parameters<Bridge["dispatch"]>[0]) => {
    void options.bridge.dispatch(value).catch((error) => options.logger.warn("tray command failed", String(error)));
  };

  const buildMenu = (): Menu => {
    const win = options.getWindow();
    const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
    const config = options.getConfig();
    const template: MenuItemConstructorOptions[] = [
      {
        label: visible ? "Hide" : "Show",
        click: () => {
          if (visible) {
            win?.hide();
          } else {
            options.show();
          }
        },
      },
      { type: "separator" },
      {
        label: "Always on top",
        type: "checkbox",
        checked: config.window.alwaysOnTop,
        click: (item) => command({ type: "window.set", alwaysOnTop: item.checked }),
      },
      {
        label: "Click-through",
        type: "checkbox",
        checked: config.window.clickThrough,
        click: (item) => command({ type: "window.set", clickThrough: item.checked }),
      },
      {
        label: "Reset pose",
        click: () => command({ type: "reset" }),
      },
      { type: "separator" },
      { label: "Open models folder", click: () => { void shell.openPath(MODELS_DIR); } },
      { label: "Open logs", click: () => { void shell.openPath(LOG_DIR); } },
      { type: "separator" },
      { label: "Quit", click: () => options.quit() },
    ];
    return Menu.buildFromTemplate(template);
  };

  const refresh = () => tray.setContextMenu(buildMenu());
  refresh();
  tray.on("click", () => {
    const win = options.getWindow();
    if (!win || win.isDestroyed()) {
      options.show();
      return;
    }
    if (win.isVisible()) win.hide();
    else options.show();
    refresh();
  });
  tray.on("right-click", refresh);

  return { tray, refresh, destroy: () => tray.destroy() };
}
