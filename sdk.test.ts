import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

it("uses only the public SDK and declared third-party libraries", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
    allow: [/^react$/, /^@testing-library\/react$/, /^vitest(?:\/config)?$/],
  });
  expect(scan.privateDependencies).toEqual([]);
  expect(scan.violations).toEqual([]);
});
