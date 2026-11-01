// Ported from t3code (https://github.com/pingdotgg/t3code), packages/client-runtime/src/device/shapeProfile.ts.
// Copyright (c) 2026 T3 Tools Inc. MIT License; see LICENSE-t3code in this folder.
export interface DeviceShapeProfile {
  readonly id: "ios-phone" | "ios-tablet" | "android-phone" | "android-tablet";
  readonly bezel: number;
  readonly bodyRadius: number;
  readonly screenRadius: number;
  readonly depth: number;
  readonly backColor: number;
  readonly buttons: ReadonlyArray<{
    readonly edge: "left" | "right" | "top";
    readonly offset: number;
    readonly length: number;
  }>;
  readonly camera: {
    readonly width: number;
    readonly height: number;
    readonly insetX: number;
    readonly insetY: number;
    readonly lensRadius: number;
    readonly lenses: ReadonlyArray<readonly [number, number]>;
    readonly flash: readonly [number, number] | null;
  };
}

const TABLET_SHAPE: DeviceShapeProfile = {
  id: "android-tablet",
  bezel: 0.065,
  bodyRadius: 0.105,
  screenRadius: 0.045,
  depth: 0.055,
  backColor: 0x697b80,
  buttons: [
    { edge: "top", offset: 0.5, length: 0.15 },
    { edge: "right", offset: 0.78, length: 0.13 },
    { edge: "right", offset: 0.58, length: 0.13 },
  ],
  camera: {
    width: 0.19,
    height: 0.19,
    insetX: 0.15,
    insetY: 0.15,
    lensRadius: 0.045,
    lenses: [[0, 0]],
    flash: null,
  },
};

export const ANDROID_PHONE_SHAPE: DeviceShapeProfile = {
  id: "android-phone",
  bezel: 0.035,
  bodyRadius: 0.115,
  screenRadius: 0.08,
  depth: 0.085,
  backColor: 0x344449,
  buttons: [
    { edge: "right", offset: 0.2, length: 0.24 },
    { edge: "right", offset: 0.65, length: 0.32 },
  ],
  camera: {
    width: 0.24,
    height: 0.47,
    insetX: 0.18,
    insetY: 0.29,
    lensRadius: 0.056,
    lenses: [
      [0, 0.11],
      [0, -0.11],
    ],
    flash: [0.1, 0],
  },
};

/** A tablet by name, or by a screen wider than 0.6 of its height in portrait. */
export function resolveDeviceShape(options: { name?: string; portraitAspect: number }): DeviceShapeProfile {
  const name = options.name ?? "";
  const namedTablet = /\b(tablet)\b/i.test(name);
  const namedPhone = /\b(phone|pixel)\b/i.test(name) && !namedTablet;
  return namedTablet || (!namedPhone && options.portraitAspect >= 0.6) ? TABLET_SHAPE : ANDROID_PHONE_SHAPE;
}
