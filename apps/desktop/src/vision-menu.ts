import type { MenuItemConstructorOptions } from "electron";

import { t } from "./i18n/index.js";
import { warn } from "./logger.js";
import { pauseVision, resumeVision } from "./vision-service.js";
import { getVisionSettings, isVisionPaused } from "./vision-settings.js";

export function createVisionMenuItems(options: {
  readonly includeDisabledStatus?: boolean;
  readonly onChanged?: () => void;
} = {}): MenuItemConstructorOptions[] {
  const settings = getVisionSettings();
  if (!settings.enabled) {
    return options.includeDisabledStatus === true
      ? [{ label: t("tray.visionOff"), enabled: false }]
      : [];
  }

  const invoke = (action: () => Promise<unknown>) => {
    void action()
      .then(() => options.onChanged?.())
      .catch(() => warn("vision", "Vision menu action failed"));
  };

  const submenu: MenuItemConstructorOptions[] = isVisionPaused(settings)
    ? [{
        label: t("tray.resumeVision"),
        click: () => invoke(() => resumeVision()),
      }]
    : [
        { label: t("tray.pauseVision30"), click: () => invoke(() => pauseVision(30)) },
        { label: t("tray.pauseVision60"), click: () => invoke(() => pauseVision(60)) },
        { label: t("tray.pauseVision90"), click: () => invoke(() => pauseVision(90)) },
      ];

  return [{ label: t("tray.vision"), submenu }];
}
