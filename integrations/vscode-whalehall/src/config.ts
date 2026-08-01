export interface MonitoringSettings {
  enabled: boolean;
  includeText: boolean;
  bridgeDirectory: string;
}
export const DEFAULT_MONITORING_SETTINGS: Readonly<MonitoringSettings> =
  Object.freeze({
    enabled: false,
    includeText: false,
    bridgeDirectory: "",
  });

export function normalizeMonitoringSettings(input: {
  enabled?: unknown;
  includeText?: unknown;
  bridgeDirectory?: unknown;
}): MonitoringSettings {
  const enabled = input.enabled === true;

  return {
    enabled,
    includeText: enabled && input.includeText === true,
    bridgeDirectory:
      typeof input.bridgeDirectory === "string"
        ? input.bridgeDirectory.trim()
        : "",
  };
}
