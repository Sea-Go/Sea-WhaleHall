import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_MONITORING_SETTINGS,
  normalizeMonitoringSettings,
} from "../config.js";

test("monitoring and inserted text are disabled by default", () => {
  assert.deepEqual(DEFAULT_MONITORING_SETTINGS, {
    enabled: false,
    includeText: false,
    bridgeDirectory: "",
  });
  assert.deepEqual(
    normalizeMonitoringSettings({
      enabled: false,
      includeText: true,
      bridgeDirectory: "  /tmp/bridge  ",
    }),
    {
      enabled: false,
      includeText: false,
      bridgeDirectory: "/tmp/bridge",
    },
  );
});
test("the VS Code manifest keeps both consent gates off", async () => {
  const packagePath = path.resolve(__dirname, "../../package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8")) as {
    contributes: {
      configuration: {
        properties: Record<string, { default: unknown }>;
      };
    };
  };
  const properties = manifest.contributes.configuration.properties;

  assert.equal(properties["whalehall.monitoring.enabled"]?.default, false);
  assert.equal(properties["whalehall.monitoring.includeText"]?.default, false);
  assert.equal(
    properties["whalehall.monitoring.bridgeDirectory"]?.default,
    "",
  );
});
